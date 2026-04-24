import type { AdapterType, WsServerEvent } from "@sygil/shared";

/**
 * Shared WsServerEvent fixtures for web monitor tests. Each factory returns
 * the specific discriminated-union variant (not the wider `WsServerEvent`),
 * so callers can spread and override narrow fields (`attempt`, etc.) without
 * losing type narrowing.
 */

type WorkflowStart = Extract<WsServerEvent, { type: "workflow_start" }>;
type NodeStart = Extract<WsServerEvent, { type: "node_start" }>;
type NodeEnd = Extract<WsServerEvent, { type: "node_end" }>;
type WorkflowEnd = Extract<WsServerEvent, { type: "workflow_end" }>;

export function makeWorkflowStartEvent(
  workflowId: string,
  name: string,
  overrides?: Partial<WorkflowStart>
): WorkflowStart {
  return {
    type: "workflow_start",
    workflowId,
    graph: { version: "1", name, nodes: {}, edges: [] },
    ...overrides,
  };
}

export function makeNodeStartEvent(
  nodeId: string,
  adapter: AdapterType,
  opts?: { model?: string; role?: string; prompt?: string; attempt?: number; workflowId?: string }
): NodeStart {
  return {
    type: "node_start",
    workflowId: opts?.workflowId ?? "wf-1",
    nodeId,
    config: {
      adapter,
      model: opts?.model ?? "test-model",
      role: opts?.role ?? nodeId,
      prompt: opts?.prompt ?? "",
    },
    attempt: opts?.attempt ?? 1,
  };
}

export function makeNodeEndEvent(
  nodeId: string,
  result: { output: string; exitCode: number; durationMs: number; costUsd?: number },
  overrides?: Partial<NodeEnd>
): NodeEnd {
  return {
    type: "node_end",
    workflowId: "wf-1",
    nodeId,
    result,
    ...overrides,
  };
}

export function makeWorkflowEndEvent(
  overrides?: Partial<WorkflowEnd>
): WorkflowEnd {
  return {
    type: "workflow_end",
    workflowId: "wf-1",
    success: true,
    durationMs: 1000,
    totalCostUsd: 0,
    ...overrides,
  };
}
