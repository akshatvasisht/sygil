import type { WsServerEvent } from "@sygil/shared";

/**
 * Hand-rolled Prometheus + OpenTelemetry exporter state.
 *
 * Sygil's approach: zero runtime dependencies, one metric registry. The same
 * Counter / Histogram primitives back both the Prometheus text exposition
 * format (text/plain; version=0.0.4) and OTLP/HTTP JSON. This keeps the metric
 * *set* consistent between exporters and respects the project's existing
 * "hand-roll where possible" convention.
 *
 * Metric naming follows Prometheus best practices:
 *   - snake_case, single-word `sygil_` prefix
 *   - base units (`_seconds`, not `_ms`)
 *   - `_total` suffix on counters
 * See https://prometheus.io/docs/practices/naming/
 *
 * Replay-determinism note (decisions.md 2026-04-16): metrics are pure runtime
 * observation. Exposing `/metrics` does NOT change scheduler behavior, and
 * scraping is not recorded in NDJSON. The exporter reads from the same
 * `WsServerEvent` stream that the monitor broadcasts.
 */

export type MetricLabels = Record<string, string>;

/** Default bucket bounds for node-level durations (seconds). */
export const DEFAULT_NODE_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600, 1800,
]);

/** Default bucket bounds for pool acquire waits (seconds). */
export const DEFAULT_ACQUIRE_WAIT_BUCKETS: readonly number[] = Object.freeze([
  0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 60,
]);

interface CounterSeries {
  labels: MetricLabels;
  value: number;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly series = new Map<string, CounterSeries>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: MetricLabels, delta = 1): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += delta;
      return;
    }
    this.series.set(key, { labels: { ...labels }, value: delta });
  }

  entries(): readonly CounterSeries[] {
    return [...this.series.values()];
  }

  /**
   * Prometheus text exposition for a counter. Emits `# HELP`, `# TYPE`, and
   * one sample line per label combination. An empty series still emits the
   * header so scrapers can see the metric exists.
   */
  renderPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const s of this.series.values()) {
      lines.push(`${this.name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
    }
    return lines.join("\n");
  }
}

interface HistogramSeries {
  labels: MetricLabels;
  bucketCounts: number[];
  count: number;
  sum: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly bucketBounds: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, bucketBounds: readonly number[]) {
    this.name = name;
    this.help = help;
    this.bucketBounds = bucketBounds;
  }

  observe(labels: MetricLabels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels: { ...labels },
        bucketCounts: new Array(this.bucketBounds.length).fill(0),
        count: 0,
        sum: 0,
      };
      this.series.set(key, s);
    }
    // Store EXCLUSIVE per-bucket counts: each observation goes into exactly one
    // bin (the first bound it's <=). Values above every bound fall into the
    // implicit +Inf bin and are captured by `s.count - sum(bucketCounts)`.
    // Prometheus cumulative text + OTLP exclusive JSON are both derived from
    // this single source of truth in the renderers.
    for (let i = 0; i < this.bucketBounds.length; i++) {
      if (value <= this.bucketBounds[i]!) {
        s.bucketCounts[i]! += 1;
        break;
      }
    }
    s.count += 1;
    s.sum += value;
  }

  entries(): readonly HistogramSeries[] {
    return [...this.series.values()];
  }

  /**
   * Prometheus text exposition for a histogram. Each series produces:
   *   - one `{name}_bucket{le="X"}` per explicit bound + one `le="+Inf"`
   *   - one `{name}_sum`
   *   - one `{name}_count`
   * Buckets are cumulative per Prometheus spec.
   */
  renderPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const s of this.series.values()) {
      // Cumulative bucket counts
      let cumulative = 0;
      for (let i = 0; i < this.bucketBounds.length; i++) {
        cumulative += s.bucketCounts[i]!;
        const bucketLabels = { ...s.labels, le: formatBound(this.bucketBounds[i]!) };
        lines.push(`${this.name}_bucket${renderLabels(bucketLabels)} ${formatNumber(cumulative)}`);
      }
      const infLabels = { ...s.labels, le: "+Inf" };
      lines.push(`${this.name}_bucket${renderLabels(infLabels)} ${formatNumber(s.count)}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${formatNumber(s.sum)}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${formatNumber(s.count)}`);
    }
    return lines.join("\n");
  }
}

/**
 * Registry of all Sygil metrics. Accepts `WsServerEvent`s via `observe()` and
 * explicit callbacks for signals that don't flow through the event stream
 * (pool acquire waits, checkpoint writes).
 */
export class PrometheusMetrics {
  readonly nodeDuration: Histogram;
  readonly nodeTotal: Counter;
  readonly gateTotal: Counter;
  readonly acquireWait: Histogram;
  readonly checkpointWrite: Counter;

  /** Epoch-ms when the registry was constructed; used for OTLP start-time. */
  readonly startTimeMs = Date.now();

  private readonly nodeMeta = new Map<string, { adapter: string; model: string }>();

  constructor(
    options: {
      nodeDurationBuckets?: readonly number[];
      acquireWaitBuckets?: readonly number[];
    } = {}
  ) {
    this.nodeDuration = new Histogram(
      "sygil_node_duration_seconds",
      "Node execution wall-clock duration in seconds, bucketed by adapter and exit status.",
      options.nodeDurationBuckets ?? DEFAULT_NODE_DURATION_BUCKETS,
    );
    this.nodeTotal = new Counter(
      "sygil_node_total",
      "Total completed node executions, labelled by adapter and exit status.",
    );
    this.gateTotal = new Counter(
      "sygil_gate_total",
      "Total gate evaluations, labelled by gate type and pass/fail result.",
    );
    this.acquireWait = new Histogram(
      "sygil_adapter_acquire_wait_seconds",
      "Adapter pool acquire wait time in seconds (0 for uncontended).",
      options.acquireWaitBuckets ?? DEFAULT_ACQUIRE_WAIT_BUCKETS,
    );
    this.checkpointWrite = new Counter(
      "sygil_checkpoint_write_total",
      "Total successful checkpoint writes (debounced background flushes).",
    );
  }

  /**
   * Ingest a server event. Only node / gate events populate metrics;
   * everything else is ignored silently (no switch-exhaustiveness coupling,
   * since this runs alongside the monitor's own switch).
   */
  observe(event: WsServerEvent): void {
    if (event.type === "node_start") {
      this.nodeMeta.set(event.nodeId, {
        adapter: event.config.adapter,
        model: event.config.model ?? "unknown",
      });
      return;
    }
    if (event.type === "node_end") {
      const meta = this.nodeMeta.get(event.nodeId);
      const adapter = meta?.adapter ?? "unknown";
      const model = meta?.model ?? "unknown";
      const status = event.result.exitCode === 0 ? "ok" : "error";
      const durationSec = event.result.durationMs / 1000;
      // Existing Sygil-native labels kept as-is for back-compat dashboards.
      // OTel GenAI semconv labels are added alongside so a standard
      // LLM-observability stack (Langfuse / Phoenix / Grafana GenAI) can
      // correlate these metrics with spans from other tools. Label keys use
      // underscores (Prom-valid); labelsToOtlp expands the `gen_ai_*` whitelist
      // back to dotted form (`gen_ai.system`, etc.) for OTLP output.
      // NOTE: `gen_ai.agent.name` is intentionally omitted — per OTel GenAI
      // semconv v1.30 the attribute is defined on agent *spans*, not metrics,
      // and node IDs are user-authored unbounded strings that would explode
      // Prometheus series cardinality. Agent identity lives on spans/events.
      const labels = {
        adapter,
        status,
        gen_ai_system: mapGenAiSystem(adapter),
        gen_ai_request_model: model,
        gen_ai_operation_name: "chat",
      };
      this.nodeDuration.observe(labels, durationSec);
      this.nodeTotal.inc(labels, 1);
      this.nodeMeta.delete(event.nodeId);
      return;
    }
    if (event.type === "gate_eval") {
      this.gateTotal.inc(
        {
          type: event.gateType ?? "unknown",
          result: event.passed ? "passed" : "failed",
        },
        1,
      );
      return;
    }
  }

  recordAcquireWait(adapterType: string, waitMs: number): void {
    this.acquireWait.observe(
      {
        adapter: adapterType,
        gen_ai_system: mapGenAiSystem(adapterType),
      },
      waitMs / 1000,
    );
  }

  recordCheckpointWrite(): void {
    this.checkpointWrite.inc({}, 1);
  }

  /**
   * Render the full registry in Prometheus 0.0.4 text exposition format.
   * Always ends with a trailing newline per the spec.
   */
  renderPrometheus(): string {
    const parts = [
      this.nodeDuration.renderPrometheus(),
      this.nodeTotal.renderPrometheus(),
      this.gateTotal.renderPrometheus(),
      this.acquireWait.renderPrometheus(),
      this.checkpointWrite.renderPrometheus(),
    ];
    return parts.join("\n") + "\n";
  }

  /**
   * Build an OTLP ExportMetricsServiceRequest payload (JSON form). Histograms
   * use cumulative aggregation temporality (value 2) and counters are monotonic
   * cumulative sums. Exact JSON field naming is lowerCamelCase per the OTLP
   * spec; all integer counts are stringified to preserve 64-bit precision over
   * JSON.
   */
  renderOtlp(serviceName = "sygil", serviceVersion = "0.1.0"): OtlpExportRequest {
    const nowUnixNano = msToUnixNano(Date.now());
    const startUnixNano = msToUnixNano(this.startTimeMs);

    const metrics: OtlpMetric[] = [];

    // Histogram: node duration
    if (this.nodeDuration.entries().length > 0) {
      metrics.push({
        name: this.nodeDuration.name,
        description: this.nodeDuration.help,
        unit: "s",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: this.nodeDuration.entries().map((s) => ({
            attributes: labelsToOtlp(s.labels),
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            count: String(s.count),
            sum: s.sum,
            bucketCounts: otlpBucketCounts(s.bucketCounts, s.count).map(String),
            explicitBounds: [...this.nodeDuration.bucketBounds],
          })),
        },
      });
    }

    // Counter: node total
    if (this.nodeTotal.entries().length > 0) {
      metrics.push(counterToOtlpMetric(this.nodeTotal, "1", startUnixNano, nowUnixNano));
    }

    // Counter: gate total
    if (this.gateTotal.entries().length > 0) {
      metrics.push(counterToOtlpMetric(this.gateTotal, "1", startUnixNano, nowUnixNano));
    }

    // Histogram: acquire wait
    if (this.acquireWait.entries().length > 0) {
      metrics.push({
        name: this.acquireWait.name,
        description: this.acquireWait.help,
        unit: "s",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: this.acquireWait.entries().map((s) => ({
            attributes: labelsToOtlp(s.labels),
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            count: String(s.count),
            sum: s.sum,
            bucketCounts: otlpBucketCounts(s.bucketCounts, s.count).map(String),
            explicitBounds: [...this.acquireWait.bucketBounds],
          })),
        },
      });
    }

    // Counter: checkpoint writes
    if (this.checkpointWrite.entries().length > 0) {
      metrics.push(counterToOtlpMetric(this.checkpointWrite, "1", startUnixNano, nowUnixNano));
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: serviceName } },
              { key: "service.version", value: { stringValue: serviceVersion } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: "sygil", version: serviceVersion },
              metrics,
            },
          ],
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// OTLP JSON types (minimal subset required for our metrics)
// ---------------------------------------------------------------------------

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

interface OtlpNumberDataPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}

interface OtlpHistogramDataPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}

interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  sum?: {
    aggregationTemporality: number;
    isMonotonic: boolean;
    dataPoints: OtlpNumberDataPoint[];
  };
  histogram?: {
    aggregationTemporality: number;
    dataPoints: OtlpHistogramDataPoint[];
  };
}

export interface OtlpExportRequest {
  resourceMetrics: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelKey(labels: MetricLabels): string {
  // JSON-encode each value so label strings containing "=" or "," cannot
  // collide with differently-shaped label sets in the Map dedup key —
  // e.g. {a:"x,b=y"} vs {a:"x", b:"y"} both produced "a=x,b=y" under the
  // naive concat. `gen_ai_request_model` is sourced from user-supplied
  // `NodeConfig.model`, so defense-in-depth is warranted even though no
  // current metric schema exposes the collision.
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(labels[k] ?? "")}`).join(",");
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`);
  return `{${pairs.join(",")}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    if (Number.isNaN(n)) return "NaN";
    return n > 0 ? "+Inf" : "-Inf";
  }
  // Use integer form for whole numbers, decimal otherwise — matches common
  // Prometheus exporter behavior and avoids "1.0" for pure counts.
  if (Number.isInteger(n)) return String(n);
  return n.toString();
}

function formatBound(b: number): string {
  return Number.isInteger(b) ? `${b}.0` : b.toString();
}

/**
 * OTLP HistogramDataPoint.bucketCounts is N+1 exclusive counts for N explicit
 * bounds: one count per (bound[i-1], bound[i]] bin, plus the (bound[N-1], +Inf)
 * overflow bin. The sum of the returned array must equal `count`.
 */
function otlpBucketCounts(exclusive: readonly number[], count: number): number[] {
  let binned = 0;
  for (const c of exclusive) binned += c;
  return [...exclusive, Math.max(0, count - binned)];
}

function labelsToOtlp(labels: MetricLabels): OtlpAttribute[] {
  return Object.entries(labels).map(([key, v]) => ({
    key: OTLP_ATTR_KEY_OVERRIDES[key] ?? key,
    value: { stringValue: v },
  }));
}

/**
 * Prom label names must match `[a-zA-Z_][a-zA-Z0-9_]*` — so we store the OTel
 * GenAI semconv attributes with underscores (`gen_ai_system`) and expand them
 * back to their canonical dotted form (`gen_ai.system`) only in the OTLP
 * payload. This keeps Prometheus scraping happy while matching the spec
 * for tools like Langfuse / Phoenix / Grafana GenAI that match on dotted keys.
 */
const OTLP_ATTR_KEY_OVERRIDES: Record<string, string> = {
  gen_ai_system: "gen_ai.system",
  gen_ai_request_model: "gen_ai.request.model",
  gen_ai_operation_name: "gen_ai.operation.name",
};

/**
 * Sygil adapter → OTel GenAI semconv `gen_ai.system` value. Claude-family
 * wrappers report `anthropic`, Codex reports `openai`, Gemini reports
 * `gcp.gemini` (per the OTel v1.30 enum — `"google"` is NOT in the spec
 * list), local-oai reports `openai-compat` (a spec-permitted custom value —
 * no enum entry fits self-hosted OpenAI-compatible endpoints). Unknown
 * adapters fall back to the adapter string verbatim so operators still see
 * a label value.
 *
 * Authoritative enum as of v1.30:
 *   anthropic, aws.bedrock, azure.ai.inference, azure.ai.openai, cohere,
 *   deepseek, gcp.gemini, gcp.gen_ai, gcp.vertex_ai, groq, ibm.watsonx.ai,
 *   mistral_ai, openai, perplexity, xai.
 */
export function mapGenAiSystem(adapter: string): string {
  switch (adapter) {
    case "claude-cli":
    case "claude-sdk":
    case "cursor":
      return "anthropic";
    case "codex":
      return "openai";
    case "gemini-cli":
      return "gcp.gemini";
    case "local-oai":
      return "openai-compat";
    default:
      return adapter;
  }
}

function counterToOtlpMetric(
  counter: Counter,
  unit: string,
  startUnixNano: string,
  nowUnixNano: string,
): OtlpMetric {
  return {
    name: counter.name,
    description: counter.help,
    unit,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: counter.entries().map((s) => ({
        attributes: labelsToOtlp(s.labels),
        startTimeUnixNano: startUnixNano,
        timeUnixNano: nowUnixNano,
        asInt: String(Math.trunc(s.value)),
      })),
    },
  };
}

function msToUnixNano(ms: number): string {
  // Multiply with BigInt to stay precise past 2^53.
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}
