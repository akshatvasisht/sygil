import type { NodeConfig } from "./workflow.js";
import type { SigilErrorCode } from "./errors.js";

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
  | { type: "error"; message: string };

export interface NodeResult {
  output: string;
  structuredOutput?: unknown;
  exitCode: number;
  durationMs: number;
  costUsd?: number;
  errorCode?: SigilErrorCode;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead?: number;
  };
}
