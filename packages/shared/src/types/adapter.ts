import type { NodeConfig } from "./workflow.js";
import type { SygilErrorCode } from "./errors.js";

export interface AgentAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  spawn(config: NodeConfig): Promise<AgentSession>;
  /**
   * Resume a previous session with additional feedback context.
   * Used for loop-back retries — avoids cold-starting a new session.
   * If the adapter doesn't support resume, it should fall back to spawn().
   */
  resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string): Promise<AgentSession>;
  stream(session: AgentSession): AsyncIterable<AgentEvent>;
  getResult(session: AgentSession): Promise<NodeResult>;
  kill(session: AgentSession): Promise<void>;
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
       * `sygil resume`. Optional so replay of NDJSON logs predating this
       * field continues to parse.
       */
      runReason?: "new" | "resume";
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
