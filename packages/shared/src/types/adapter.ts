import type { NodeConfig } from "./workflow.js";
import type { SygilErrorCode } from "./errors.js";

/**
 * Deterministic per-node tracing envelope derived from `runId` + `nodeId`.
 * Adapters propagate this as a W3C `traceparent` so downstream API spans link
 * back to the driving Sigil node. Optional on every surface — adapters that
 * don't spawn subprocesses or HTTP requests may ignore it.
 */
export interface SpawnContext {
  /** W3C traceparent header value: `00-<traceId>-<spanId>-01`. */
  traceparent?: string;
  /** 32-hex trace id. */
  traceId?: string;
  /** 16-hex span id. */
  spanId?: string;
}

export interface AgentAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession>;
  /**
   * Resume a previous session with additional feedback context.
   * Used for loop-back retries — avoids cold-starting a new session.
   * If the adapter doesn't support resume, it should fall back to spawn().
   */
  resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string, ctx?: SpawnContext): Promise<AgentSession>;
  stream(session: AgentSession): AsyncIterable<AgentEvent>;
  getResult(session: AgentSession): Promise<NodeResult>;
  kill(session: AgentSession): Promise<void>;
  /**
   * Optional: return the version string of the underlying tool or SDK.
   * Used by the environment snapshot to capture adapter versions at run start.
   * Returns null when the version cannot be determined (missing binary, network
   * error, etc.). Optional so existing adapters need not implement it.
   */
  getVersion?(): Promise<string | null>;
}

export interface AgentSession {
  id: string;
  nodeId: string;
  adapter: string;
  startedAt: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter-specific handle is intentionally opaque to callers; no safe common type exists
  _internal: any;
}

export type AgentEvent =
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string; success: boolean }
  | { type: "file_write"; path: string }
  | { type: "shell_exec"; command: string; exitCode: number }
  | { type: "text_delta"; text: string }
  | { type: "cost_update"; totalCostUsd: number }
  | { type: "stall"; reason: string }
  | { type: "error"; message: string }
  | { type: "adapter_failover"; fromAdapter: string; toAdapter: string; reason: string }
  | { type: "context_set"; key: string; value: unknown }
  | {
      type: "hook_result";
      hook: "preNode" | "postNode" | "preGate" | "postGate";
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      /**
       * Why this run started. `"new"` from `sygil run`, `"resume"` from
       * `sygil resume`, `"fork"` from `sygil fork`. Optional so replay of
       * NDJSON logs predating this field continues to parse.
       */
      runReason?: "new" | "resume" | "fork";
    }
  | {
      /**
       * Per-node retry policy scheduled a backoff before retrying the same
       * provider. Emitted BEFORE the scheduler sleeps so replay
       * sees the decision in the same order the original run took.
       */
      type: "retry_scheduled";
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      reason: string;
    };

export interface NodeResult {
  output: string;
  structuredOutput?: unknown;
  exitCode: number;
  durationMs: number;
  costUsd?: number;
  errorCode?: SygilErrorCode;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead?: number;
  };
  /**
   * Set by the scheduler when this result was returned from `NodeCache` rather
   * than produced by a fresh adapter run. The monitor UI uses this to
   * render a distinct `cached` status; the original durationMs / costUsd from
   * the recorded run are preserved so audits see the real cost, not 0/0.
   */
  cacheHit?: boolean;
}
