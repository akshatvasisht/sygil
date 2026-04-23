import { z } from "zod";
import type { AgentEvent, NodeResult } from "./adapter.js";
import type { NodeConfig, WorkflowGraph } from "./workflow.js";

/** Events emitted by the Sygil server to monitor clients over WebSocket */
export type WsServerEvent =
  | { type: "workflow_start"; workflowId: string; timestamp?: string; graph: WorkflowGraph }
  | { type: "node_start"; workflowId: string; timestamp?: string; nodeId: string; config: NodeConfig; attempt: number }
  | { type: "node_event"; workflowId: string; timestamp?: string; nodeId: string; event: AgentEvent }
  | { type: "node_end"; workflowId: string; timestamp?: string; nodeId: string; result: NodeResult }
  | { type: "gate_eval"; workflowId: string; timestamp?: string; edgeId: string; passed: boolean; reason?: string; gateType?: string }
  | { type: "loop_back"; workflowId: string; timestamp?: string; edgeId: string; attempt: number; maxRetries: number }
  | { type: "rate_limit"; workflowId: string; timestamp?: string; nodeId: string; retryAfterMs: number }
  | { type: "workflow_end"; workflowId: string; timestamp?: string; success: boolean; durationMs: number; totalCostUsd?: number }
  | { type: "workflow_error"; workflowId: string; timestamp?: string; nodeId?: string; message: string }
  | { type: "human_review_request"; workflowId: string; timestamp?: string; nodeId: string; edgeId: string; prompt: string }
  | { type: "human_review_response"; workflowId: string; timestamp?: string; edgeId: string; approved: boolean }
  | { type: "metrics_tick"; workflowId: string; timestamp?: string; data: MetricsSnapshot }
  | {
      /**
       * Per-adapter-type circuit breaker state transition. Emitted
       * by `AdapterPool` when the rolling failure rate crosses the threshold,
       * when the cooldown elapses (open → half-open), or when a probe request
       * succeeds/fails (half-open → closed/open). The circuit breaker is a
       * runtime capacity signal; transitions are NOT recorded to NDJSON (the
       * underlying failures already are via `error` / `adapter_failover`
       * events).
       */
      type: "circuit_breaker";
      workflowId: string;
      timestamp?: string;
      adapterType: string;
      state: "closed" | "open" | "half_open";
      reason?: string;
      openUntil?: number;
    };

/**
 * Aggregated in-run metrics emitted ~1Hz by the MetricsAggregator.
 *
 * - `adapters` — per-adapter node duration percentiles (only adapters with at
 *   least one completed node are included)
 * - `pool` — adapter pool acquire-wait percentiles + live occupancy. `null` if
 *   the run was started without `--pool` (no pool is attached)
 * - `gates` — running pass/fail totals across all gates this run
 * - `inFlightNodes` — count of nodes currently executing (node_start seen, no
 *   node_end yet)
 */
export interface MetricsSnapshot {
  adapters: Record<string, AdapterMetrics>;
  pool: PoolMetrics | null;
  gates: { passed: number; failed: number };
  inFlightNodes: number;
  /**
   * Per-adapter-type circuit breaker state. Present only when the
   * pool was configured with `circuitBreaker`. Keys are adapter types that
   * have ever observed a failure or success; adapters with no recorded
   * activity are omitted.
   */
  circuitBreakers?: Record<string, CircuitBreakerMetrics>;
}

export interface CircuitBreakerMetrics {
  state: "closed" | "open" | "half_open";
  /** Epoch ms when the circuit will transition to half-open. Present when state === "open". */
  openUntil?: number;
  /** Count of failures recorded in the current rolling window. */
  recentFailures: number;
}

export interface AdapterMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  count: number;
}

export interface PoolMetrics {
  p50WaitMs: number;
  p95WaitMs: number;
  p99WaitMs: number;
  waitCount: number;
  active: number;
  waiting: number;
  maxConcurrency: number;
}

/** Events sent by monitor clients to the Sygil server */
export type WsClientEvent =
  | { type: "subscribe"; workflowId: string }
  | { type: "unsubscribe"; workflowId: string }
  | { type: "pause"; workflowId: string }
  | { type: "resume_workflow"; workflowId: string }
  | { type: "cancel"; workflowId: string }
  | { type: "human_review_approve"; workflowId: string; edgeId: string }
  | { type: "human_review_reject"; workflowId: string; edgeId: string };

/**
 * Zod schema for validating inbound client messages — protects the monitor
 * from malformed / hostile payloads before dispatch.
 */
export const WsClientEventSchema: z.ZodType<WsClientEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), workflowId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), workflowId: z.string() }),
  z.object({ type: z.literal("pause"), workflowId: z.string() }),
  z.object({ type: z.literal("resume_workflow"), workflowId: z.string() }),
  z.object({ type: z.literal("cancel"), workflowId: z.string() }),
  z.object({
    type: z.literal("human_review_approve"),
    workflowId: z.string(),
    edgeId: z.string(),
  }),
  z.object({
    type: z.literal("human_review_reject"),
    workflowId: z.string(),
    edgeId: z.string(),
  }),
]);

/** A single recorded agent event with timing and node context — used for replay/debugging. */
export interface RecordedEvent {
  timestamp: number;
  nodeId: string;
  event: AgentEvent;
}

/** Persisted state for a workflow run — written to .sygil/runs/<id>.json */
export interface WorkflowRunState {
  id: string;
  workflowName: string;
  workflowPath?: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  startedAt: string; // ISO8601
  completedAt?: string;
  currentNodeId?: string;
  completedNodes: string[];
  nodeResults: Record<string, NodeResult>;
  totalCostUsd: number;
  retryCounters: Record<string, number>; // edgeId -> attempt count
  /**
   * Typed map of cross-node context values written by nodes via `context_set`
   * events. Values are arbitrary JSON. Keys are allowlisted per-node via
   * `NodeConfig.writesContext`. Interpolated into downstream node prompts via
   * `{{ctx.<key>}}` when listed in `NodeConfig.readsContext`. Persisted in
   * checkpoints so replay reconstructs the same map.
   */
  sharedContext: Record<string, unknown>;
}

const NodeResultSchema = z.object({
  output: z.string(),
  structuredOutput: z.unknown().optional(),
  exitCode: z.number(),
  durationMs: z.number(),
  costUsd: z.number().optional(),
  errorCode: z.string().optional(),
  tokenUsage: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
    })
    .optional(),
  cacheHit: z.boolean().optional(),
}).passthrough();

/**
 * Runtime validator for persisted workflow checkpoints — guards against
 * corrupted or schema-drifted state before the scheduler touches it.
 * Permissive (`.passthrough()`) so new fields don't break old checkpoints.
 */
export const WorkflowRunStateSchema = z.object({
  id: z.string(),
  workflowName: z.string(),
  workflowPath: z.string().optional(),
  status: z.enum(["running", "paused", "completed", "failed", "cancelled"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  currentNodeId: z.string().optional(),
  completedNodes: z.array(z.string()),
  nodeResults: z.record(NodeResultSchema),
  totalCostUsd: z.number(),
  retryCounters: z.record(z.number()),
  // sharedContext is backfilled by the scheduler for pre-sharedContext checkpoints —
  // optional at the schema level but always present after resume().
  sharedContext: z.record(z.unknown()).optional(),
}).passthrough();
