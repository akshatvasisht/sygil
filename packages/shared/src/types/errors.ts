// Structured error codes for programmatic error handling across Sigil.
export const SigilErrorCode = {
  // Gate errors
  GATE_TIMEOUT: "GATE_TIMEOUT",
  GATE_SCRIPT_FAILED: "GATE_SCRIPT_FAILED",
  GATE_CONDITION_FAILED: "GATE_CONDITION_FAILED",
  GATE_PATH_TRAVERSAL: "GATE_PATH_TRAVERSAL",

  // Node errors
  NODE_TIMEOUT: "NODE_TIMEOUT",
  NODE_IDLE_TIMEOUT: "NODE_IDLE_TIMEOUT",
  NODE_STALLED: "NODE_STALLED",
  NODE_CRASHED: "NODE_CRASHED",

  // Adapter errors
  ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE",
  ADAPTER_SPAWN_FAILED: "ADAPTER_SPAWN_FAILED",
  ADAPTER_RATE_LIMITED: "ADAPTER_RATE_LIMITED",

  // Workflow errors
  WORKFLOW_CANCELLED: "WORKFLOW_CANCELLED",
  WORKFLOW_VALIDATION_FAILED: "WORKFLOW_VALIDATION_FAILED",
  WORKFLOW_NODE_FAILED: "WORKFLOW_NODE_FAILED",

  // Checkpoint errors
  CHECKPOINT_WRITE_FAILED: "CHECKPOINT_WRITE_FAILED",
  CHECKPOINT_LOAD_FAILED: "CHECKPOINT_LOAD_FAILED",
} as const;

export type SigilErrorCode = (typeof SigilErrorCode)[keyof typeof SigilErrorCode];

export interface SigilError {
  code: SigilErrorCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  details?: Record<string, unknown>;
}
