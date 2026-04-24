import { describe, it, expect } from "vitest";
import type { WsServerEvent } from "@sygil/shared";
import {
  Counter,
  Histogram,
  PrometheusMetrics,
  DEFAULT_NODE_DURATION_BUCKETS,
  mapGenAiSystem,
} from "./prometheus-metrics.js";

describe("Counter", () => {
  it("increments per label combination", () => {
    const c = new Counter("test_total", "test counter");
    c.inc({ a: "x" }, 1);
    c.inc({ a: "x" }, 2);
    c.inc({ a: "y" }, 1);
    const entries = c.entries();
    expect(entries).toHaveLength(2);
    const xSeries = entries.find((e) => e.labels["a"] === "x");
    const ySeries = entries.find((e) => e.labels["a"] === "y");
    expect(xSeries?.value).toBe(3);
    expect(ySeries?.value).toBe(1);
  });

  it("renders Prometheus text with HELP and TYPE headers", () => {
    const c = new Counter("test_total", "test counter");
    c.inc({ a: "x" }, 5);
    const out = c.renderPrometheus();
    expect(out).toContain("# HELP test_total test counter");
    expect(out).toContain("# TYPE test_total counter");
    expect(out).toContain(`test_total{a="x"} 5`);
  });

  it("emits headers even when no series exist", () => {
    const c = new Counter("empty_total", "empty counter");
    const out = c.renderPrometheus();
    expect(out).toContain("# HELP empty_total");
    expect(out).toContain("# TYPE empty_total counter");
  });

  it("escapes label values containing quotes and backslashes", () => {
    const c = new Counter("test_total", "help");
    c.inc({ reason: 'has"quote\\and' }, 1);
    const out = c.renderPrometheus();
    expect(out).toContain(`reason="has\\"quote\\\\and"`);
  });
});

describe("Histogram", () => {
  it("emits cumulative bucket counts ending with +Inf", () => {
    const h = new Histogram("dur_seconds", "help", [1, 5, 10]);
    h.observe({}, 0.5);
    h.observe({}, 3);
    h.observe({}, 7);
    h.observe({}, 50);
    const out = h.renderPrometheus();
    // bucket le="1" catches only 0.5 → 1 cumulative
    expect(out).toMatch(/dur_seconds_bucket\{le="1\.0"\} 1/);
    // bucket le="5" catches 0.5 + 3 → 2 cumulative
    expect(out).toMatch(/dur_seconds_bucket\{le="5\.0"\} 2/);
    // bucket le="10" catches 0.5 + 3 + 7 → 3 cumulative
    expect(out).toMatch(/dur_seconds_bucket\{le="10\.0"\} 3/);
    // le="+Inf" catches all 4
    expect(out).toMatch(/dur_seconds_bucket\{le="\+Inf"\} 4/);
    expect(out).toMatch(/dur_seconds_sum 60\.5/);
    expect(out).toMatch(/dur_seconds_count 4/);
  });

  it("tracks separate series per label set", () => {
    const h = new Histogram("dur", "help", [1, 5]);
    h.observe({ adapter: "claude-cli" }, 0.5);
    h.observe({ adapter: "codex" }, 3);
    const out = h.renderPrometheus();
    expect(out).toMatch(/dur_bucket\{adapter="claude-cli",le="1\.0"\} 1/);
    expect(out).toMatch(/dur_bucket\{adapter="codex",le="5\.0"\} 1/);
  });
});

describe("PrometheusMetrics.observe", () => {
  it("records node_start → node_end as a duration sample + counter increment", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "node_start",
      workflowId: "wf",
      nodeId: "n1",
      config: { adapter: "claude-cli", model: "sonnet", role: "coder", prompt: "hi" } as never,
    } as unknown as WsServerEvent);
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "n1",
      result: { output: "", exitCode: 0, durationMs: 2500 },
    } as unknown as WsServerEvent);
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_node_total\{adapter="claude-cli",[^}]*status="ok"\} 1/);
    expect(out).toMatch(/sygil_node_duration_seconds_count\{adapter="claude-cli",[^}]*status="ok"\} 1/);
    expect(out).toMatch(/sygil_node_duration_seconds_sum\{adapter="claude-cli",[^}]*status="ok"\} 2\.5/);
    // OTel GenAI semconv labels are attached alongside the existing ones.
    expect(out).toContain(`gen_ai_system="anthropic"`);
    expect(out).toContain(`gen_ai_request_model="sonnet"`);
    expect(out).toContain(`gen_ai_operation_name="chat"`);
    // gen_ai.agent.name is intentionally NOT a metric label — node IDs are
    // user-authored and would explode cardinality; the attribute lives on
    // spans per OTel GenAI semconv v1.30.
    expect(out).not.toContain(`gen_ai_agent_name=`);
  });

  it("marks non-zero exit codes as status=error", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "node_start",
      workflowId: "wf",
      nodeId: "n2",
      config: { adapter: "codex", model: "o3", role: "x", prompt: "p" } as never,
    } as unknown as WsServerEvent);
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "n2",
      result: { output: "", exitCode: 1, durationMs: 100 },
    } as unknown as WsServerEvent);
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_node_total\{adapter="codex",[^}]*status="error"\} 1/);
    // Codex maps to gen_ai.system="openai" per the mapping.
    expect(out).toContain(`gen_ai_system="openai"`);
  });

  it("marks adapter=unknown when node_end arrives without node_start", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "orphan",
      result: { output: "", exitCode: 0, durationMs: 500 },
    } as unknown as WsServerEvent);
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_node_total\{adapter="unknown",[^}]*status="ok"\} 1/);
  });

  it("records gate_eval with gateType + passed/failed labels", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "gate_eval",
      workflowId: "wf",
      edgeId: "e1",
      passed: true,
      gateType: "exit_code",
    } as unknown as WsServerEvent);
    m.observe({
      type: "gate_eval",
      workflowId: "wf",
      edgeId: "e2",
      passed: false,
      gateType: "regex",
    } as unknown as WsServerEvent);
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_gate_total\{result="passed",type="exit_code"\} 1/);
    expect(out).toMatch(/sygil_gate_total\{result="failed",type="regex"\} 1/);
  });

  it("labels gateType=unknown when the event omits it", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "gate_eval",
      workflowId: "wf",
      edgeId: "e1",
      passed: true,
    } as unknown as WsServerEvent);
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_gate_total\{result="passed",type="unknown"\} 1/);
  });

  it("ignores unrelated event types", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "workflow_start",
      workflowId: "wf",
      startedAt: "2026-04-20T00:00:00Z",
    } as unknown as WsServerEvent);
    // No series should have been created.
    expect(m.nodeTotal.entries()).toHaveLength(0);
    expect(m.gateTotal.entries()).toHaveLength(0);
  });
});

describe("PrometheusMetrics explicit callbacks", () => {
  it("recordAcquireWait converts ms → seconds", () => {
    const m = new PrometheusMetrics();
    m.recordAcquireWait("claude-cli", 250); // 0.25s
    m.recordAcquireWait("claude-cli", 1500); // 1.5s
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_adapter_acquire_wait_seconds_count\{adapter="claude-cli",[^}]*\} 2/);
    expect(out).toMatch(/sygil_adapter_acquire_wait_seconds_sum\{adapter="claude-cli",[^}]*\} 1\.75/);
    // acquire-wait also carries gen_ai.system.
    expect(out).toContain(`gen_ai_system="anthropic"`);
  });

  it("recordCheckpointWrite increments the checkpoint counter", () => {
    const m = new PrometheusMetrics();
    m.recordCheckpointWrite();
    m.recordCheckpointWrite();
    const out = m.renderPrometheus();
    expect(out).toMatch(/sygil_checkpoint_write_total 2/);
  });
});

describe("PrometheusMetrics.renderPrometheus", () => {
  it("ends with a newline and includes all five metrics' TYPE headers", () => {
    const m = new PrometheusMetrics();
    const out = m.renderPrometheus();
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("# TYPE sygil_node_duration_seconds histogram");
    expect(out).toContain("# TYPE sygil_node_total counter");
    expect(out).toContain("# TYPE sygil_gate_total counter");
    expect(out).toContain("# TYPE sygil_adapter_acquire_wait_seconds histogram");
    expect(out).toContain("# TYPE sygil_checkpoint_write_total counter");
  });

  it("uses default bucket bounds when none passed", () => {
    const m = new PrometheusMetrics();
    expect(m.nodeDuration.bucketBounds).toEqual(DEFAULT_NODE_DURATION_BUCKETS);
  });
});

describe("PrometheusMetrics.renderOtlp", () => {
  it("produces a resourceMetrics/scopeMetrics tree when there is data", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "node_start",
      workflowId: "wf",
      nodeId: "n",
      config: { adapter: "claude-cli", model: "s", role: "r", prompt: "p" } as never,
    } as unknown as WsServerEvent);
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "n",
      result: { output: "", exitCode: 0, durationMs: 1000 },
    } as unknown as WsServerEvent);
    const payload = m.renderOtlp("sygil-test", "9.9.9");
    expect(payload.resourceMetrics).toHaveLength(1);
    const rm = payload.resourceMetrics[0]!;
    const svc = rm.resource.attributes.find((a) => a.key === "service.name");
    expect(svc?.value.stringValue).toBe("sygil-test");
    const ver = rm.resource.attributes.find((a) => a.key === "service.version");
    expect(ver?.value.stringValue).toBe("9.9.9");
    const scope = rm.scopeMetrics[0]!;
    const names = scope.metrics.map((x) => x.name);
    expect(names).toContain("sygil_node_duration_seconds");
    expect(names).toContain("sygil_node_total");
  });

  it("emits histogram dataPoints with cumulative bucketCounts ending in count", () => {
    const m = new PrometheusMetrics({ nodeDurationBuckets: [1, 5] });
    m.observe({
      type: "node_start",
      workflowId: "wf",
      nodeId: "n",
      config: { adapter: "codex", model: "s", role: "r", prompt: "p" } as never,
    } as unknown as WsServerEvent);
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "n",
      result: { output: "", exitCode: 0, durationMs: 3000 },
    } as unknown as WsServerEvent);
    const payload = m.renderOtlp();
    const hist = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find(
      (m) => m.name === "sygil_node_duration_seconds",
    );
    expect(hist?.histogram?.aggregationTemporality).toBe(2);
    const dp = hist!.histogram!.dataPoints[0]!;
    // OTLP semantics: N+1 exclusive bins for N bounds. 3s → (1, 5] bin.
    expect(dp.bucketCounts).toEqual(["0", "1", "0"]);
    expect(dp.explicitBounds).toEqual([1, 5]);
    expect(dp.count).toBe("1");
    expect(dp.sum).toBe(3);
  });

  it("counters render as monotonic cumulative sums", () => {
    const m = new PrometheusMetrics();
    m.recordCheckpointWrite();
    const payload = m.renderOtlp();
    const ckpt = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find(
      (x) => x.name === "sygil_checkpoint_write_total",
    );
    expect(ckpt?.sum?.aggregationTemporality).toBe(2);
    expect(ckpt?.sum?.isMonotonic).toBe(true);
    expect(ckpt?.sum?.dataPoints[0]?.asInt).toBe("1");
  });

  it("stringifies nanosecond timestamps to preserve 64-bit precision", () => {
    const m = new PrometheusMetrics();
    m.recordCheckpointWrite();
    const payload = m.renderOtlp();
    const dp = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum!.dataPoints[0]!;
    // startTimeUnixNano is a stringified nanosecond since epoch;
    // a sane ms-to-ns multiply should have 19 digits as of ~2025 and 6 trailing zeros.
    expect(typeof dp.startTimeUnixNano).toBe("string");
    expect(dp.startTimeUnixNano).toMatch(/^\d{18,20}$/);
    expect(dp.startTimeUnixNano.endsWith("000000")).toBe(true);
  });

  it("skips metrics that have zero series to keep the payload compact", () => {
    const m = new PrometheusMetrics();
    // No observations at all.
    const payload = m.renderOtlp();
    expect(payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics).toHaveLength(0);
  });

  it("expands gen_ai_* underscored label keys back to dotted OTel semconv keys", () => {
    const m = new PrometheusMetrics();
    m.observe({
      type: "node_start",
      workflowId: "wf",
      nodeId: "planner",
      config: { adapter: "claude-cli", model: "opus", role: "r", prompt: "p" } as never,
    } as unknown as WsServerEvent);
    m.observe({
      type: "node_end",
      workflowId: "wf",
      nodeId: "planner",
      result: { output: "", exitCode: 0, durationMs: 1200 },
    } as unknown as WsServerEvent);
    const payload = m.renderOtlp();
    const nodeTotal = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find(
      (x) => x.name === "sygil_node_total",
    );
    const attrs = nodeTotal!.sum!.dataPoints[0]!.attributes;
    const keys = attrs.map((a) => a.key).sort();
    // Underscored keys are rewritten to the canonical dotted form.
    expect(keys).toContain("gen_ai.system");
    expect(keys).toContain("gen_ai.request.model");
    expect(keys).toContain("gen_ai.operation.name");
    // Sygil-native labels are unchanged.
    expect(keys).toContain("adapter");
    expect(keys).toContain("status");
    // gen_ai.agent.name is intentionally NOT emitted on metrics (see
    // prometheus-metrics.ts node_end comment). Per OTel GenAI semconv v1.30
    // it's a span attribute and node IDs are unbounded.
    expect(keys).not.toContain("gen_ai.agent.name");
    // Values survive the rename.
    const get = (k: string): string | undefined =>
      attrs.find((a) => a.key === k)?.value.stringValue;
    expect(get("gen_ai.system")).toBe("anthropic");
    expect(get("gen_ai.request.model")).toBe("opus");
    expect(get("gen_ai.operation.name")).toBe("chat");
  });
});

describe("mapGenAiSystem", () => {
  it("maps Claude-family wrappers to 'anthropic'", () => {
    expect(mapGenAiSystem("claude-cli")).toBe("anthropic");
    expect(mapGenAiSystem("claude-sdk")).toBe("anthropic");
    expect(mapGenAiSystem("cursor")).toBe("anthropic");
  });

  it("maps codex, gemini-cli, and local-oai to their respective OTel systems", () => {
    expect(mapGenAiSystem("codex")).toBe("openai");
    expect(mapGenAiSystem("gemini-cli")).toBe("gcp.gemini");
    expect(mapGenAiSystem("local-oai")).toBe("openai-compat");
  });

  it("falls through unknown adapter names verbatim", () => {
    expect(mapGenAiSystem("echo")).toBe("echo");
    expect(mapGenAiSystem("brand-new-adapter")).toBe("brand-new-adapter");
  });
});
