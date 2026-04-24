import type {
  AdapterMetrics,
  CircuitBreakerMetrics,
  MetricsSnapshot,
  PoolMetrics,
  WsServerEvent,
} from "@sygil/shared";
import type { AdapterPool } from "../adapters/adapter-pool.js";

const DEFAULT_TICK_INTERVAL_MS = 1000;
const ADAPTER_SAMPLE_CAPACITY = 1000;

/**
 * Per-workflow aggregate state. One entry per workflowId seen via
 * `observe(event)`. `adapterSamples` is a bounded ring per adapter — we only
 * need enough for reasonable percentile resolution, and cross-run history is
 * explicitly a non-goal.
 */
interface WorkflowState {
  adapterSamples: Map<string, number[]>;
  /**
   * NodeResult does not carry an adapter tag, so track the adapter each node
   * was started with from its `node_start.config.adapter`, and overwrite it on
   * any `adapter_failover` node_event so the duration sample ends up bucketed
   * under the adapter that actually produced the result (not the primary one
   * that failed). Retries stay on the same adapter and don't need an update.
   */
  nodeAdapter: Map<string, string>;
  gatePassed: number;
  gateFailed: number;
  inFlight: Set<string>;
}

export interface MetricsAggregatorConfig {
  tickIntervalMs?: number;
}

/**
 * Subscribes to the same monitor event stream to maintain rolling per-workflow
 * aggregates (duration percentiles per adapter, gate pass/fail counts, in-flight
 * count, adapter-pool acquire-wait percentiles) and emits a `metrics_tick`
 * event at a fixed cadence.
 *
 * Pure observer: does not mutate incoming events and never calls back into
 * `WsMonitorServer.emit` for anything other than `metrics_tick`. Safe to start
 * and stop alongside the fanout timer.
 */
export class MetricsAggregator {
  private readonly tickIntervalMs: number;
  private readonly byWorkflow = new Map<string, WorkflowState>();
  private adapterPool: AdapterPool | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emitFn: ((event: WsServerEvent) => void) | null = null;

  constructor(config?: MetricsAggregatorConfig) {
    this.tickIntervalMs = config?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  setAdapterPool(pool: AdapterPool | null): void {
    this.adapterPool = pool;
  }

  /**
   * Consume a WsServerEvent and update aggregates. Returns silently for event
   * types that do not affect metrics (no-op switch branch).
   */
  observe(event: WsServerEvent): void {
    if (event.type === "workflow_start") {
      this.byWorkflow.set(event.workflowId, {
        adapterSamples: new Map(),
        nodeAdapter: new Map(),
        gatePassed: 0,
        gateFailed: 0,
        inFlight: new Set(),
      });
      return;
    }

    const ws = this.byWorkflow.get(event.workflowId);
    if (!ws) return;

    switch (event.type) {
      case "node_start":
        ws.inFlight.add(event.nodeId);
        ws.nodeAdapter.set(event.nodeId, event.config.adapter);
        return;
      case "node_end": {
        ws.inFlight.delete(event.nodeId);
        const adapter = ws.nodeAdapter.get(event.nodeId) ?? "unknown";
        const samples = ws.adapterSamples.get(adapter) ?? [];
        samples.push(event.result.durationMs);
        if (samples.length > ADAPTER_SAMPLE_CAPACITY) {
          samples.splice(0, samples.length - ADAPTER_SAMPLE_CAPACITY);
        }
        ws.adapterSamples.set(adapter, samples);
        return;
      }
      case "gate_eval":
        if (event.passed) ws.gatePassed++;
        else ws.gateFailed++;
        return;
      case "node_event":
        // Keep the nodeAdapter map in sync with mid-execution provider
        // failover. Without this, a node that starts on the primary
        // and fails over to the fallback would have its duration attributed to
        // the adapter that actually *failed* — skewing per-adapter percentiles.
        if (event.event.type === "adapter_failover") {
          ws.nodeAdapter.set(event.nodeId, event.event.toAdapter);
        }
        return;
      case "workflow_end":
      case "workflow_error":
        // Keep the workflow's aggregates around so a final tick after
        // completion reflects terminal counts. Callers can `dropWorkflow` if
        // they need to free memory for long-running monitor servers.
        return;
      default:
        return;
    }
  }

  /** Remove all aggregates for a workflowId. Safe to call multiple times. */
  dropWorkflow(workflowId: string): void {
    this.byWorkflow.delete(workflowId);
  }

  /**
   * Build a snapshot for a given workflowId. Exposed so tests and
   * command-layer callers can read metrics without waiting for a tick.
   */
  snapshot(workflowId: string): MetricsSnapshot | null {
    const ws = this.byWorkflow.get(workflowId);
    if (!ws) return null;

    const adapters: Record<string, AdapterMetrics> = {};
    for (const [adapter, samples] of ws.adapterSamples) {
      if (samples.length === 0) continue;
      adapters[adapter] = {
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
        count: samples.length,
      };
    }

    let pool: PoolMetrics | null = null;
    let circuitBreakers: Record<string, CircuitBreakerMetrics> | undefined;
    if (this.adapterPool) {
      const stats = this.adapterPool.stats();
      const waitStats = this.adapterPool.waitStats();
      pool = {
        p50WaitMs: percentile(waitStats.samples, 0.5),
        p95WaitMs: percentile(waitStats.samples, 0.95),
        p99WaitMs: percentile(waitStats.samples, 0.99),
        waitCount: waitStats.samples.length,
        active: stats.active,
        waiting: stats.waiting,
        maxConcurrency: stats.maxConcurrency,
      };
      // Include circuit breaker state only when the pool was configured with
      // a `circuitBreaker` block — otherwise `circuitStates()` returns {} and
      // we omit the field so existing monitors don't render empty state.
      const cbStates = this.adapterPool.circuitStates();
      if (Object.keys(cbStates).length > 0) {
        circuitBreakers = {};
        for (const [adapterType, snap] of Object.entries(cbStates)) {
          circuitBreakers[adapterType] = {
            state: snap.state,
            recentFailures: snap.recentFailures,
            ...(snap.openUntil !== undefined ? { openUntil: snap.openUntil } : {}),
          };
        }
      }
    }

    return {
      adapters,
      pool,
      gates: { passed: ws.gatePassed, failed: ws.gateFailed },
      inFlightNodes: ws.inFlight.size,
      ...(circuitBreakers !== undefined ? { circuitBreakers } : {}),
    };
  }

  /**
   * Start the tick timer. `emitFn` receives a `metrics_tick` event per active
   * workflow each tick. Idempotent — calling twice is a no-op while running.
   */
  start(emitFn: (event: WsServerEvent) => void): void {
    if (this.timer !== null) return;
    this.emitFn = emitFn;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    // Don't keep the process alive just to emit metrics ticks — matches the
    // WsMonitorServer heartbeat timer and retry-policy sleepWithAbort.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emitFn = null;
  }

  /** Force a single tick now (useful for tests). */
  tick(): void {
    if (!this.emitFn) return;
    for (const workflowId of this.byWorkflow.keys()) {
      const snap = this.snapshot(workflowId);
      if (!snap) continue;
      this.emitFn({ type: "metrics_tick", workflowId, data: snap });
    }
  }
}

/**
 * Nearest-rank percentile on an unsorted array. `q` in [0, 1]. Returns 0 for
 * empty input so downstream monitors never have to defend against NaN. Sorts a
 * copy so the caller's buffer stays intact.
 */
function percentile(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx]!;
}
