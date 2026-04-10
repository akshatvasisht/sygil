import type { AgentEvent, NodeResult } from "./adapter.js";
import type { NodeConfig, WorkflowGraph } from "./workflow.js";

/** Events emitted by the Sigil server to monitor clients over WebSocket */
export type WsServerEvent =
  | { type: "workflow_start"; workflowId: string; timestamp?: string; graph: WorkflowGraph }
  | { type: "node_start"; workflowId: string; timestamp?: string; nodeId: string; config: NodeConfig; attempt: number }
  | { type: "node_event"; workflowId: string; timestamp?: string; nodeId: string; event: AgentEvent }
  | { type: "node_end"; workflowId: string; timestamp?: string; nodeId: string; result: NodeResult }
  | { type: "gate_eval"; workflowId: string; timestamp?: string; edgeId: string; passed: boolean; reason?: string }
  | { type: "loop_back"; workflowId: string; timestamp?: string; edgeId: string; attempt: number; maxRetries: number }
  | { type: "rate_limit"; workflowId: string; timestamp?: string; nodeId: string; retryAfterMs: number }
  | { type: "workflow_end"; workflowId: string; timestamp?: string; success: boolean; durationMs: number; totalCostUsd?: number }
  | { type: "workflow_error"; workflowId: string; timestamp?: string; nodeId?: string; message: string }
  | { type: "human_review_request"; workflowId: string; timestamp?: string; nodeId: string; edgeId: string; prompt: string }
  | { type: "human_review_response"; workflowId: string; timestamp?: string; edgeId: string; approved: boolean };

/** Events sent by monitor clients to the Sigil server */
export type WsClientEvent =
  | { type: "subscribe"; workflowId: string }
  | { type: "unsubscribe"; workflowId: string }
  | { type: "pause"; workflowId: string }
  | { type: "resume_workflow"; workflowId: string }
  | { type: "cancel"; workflowId: string }
  | { type: "human_review_approve"; workflowId: string; edgeId: string }
  | { type: "human_review_reject"; workflowId: string; edgeId: string };

/** A single recorded agent event with timing and node context — used for replay/debugging. */
export interface RecordedEvent {
  timestamp: number;
  nodeId: string;
  event: AgentEvent;
}

/** Persisted state for a workflow run — written to .sigil/runs/<id>.json */
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
}
