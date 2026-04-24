import { describe, it, expect } from "vitest";
import type {
  WsServerEvent,
  WsClientEvent,
  RecordedEvent,
  WorkflowRunState,
} from "./events.js";
import { WsClientEventSchema } from "./events.js";

describe("WsServerEvent discriminated union", () => {
  it("covers workflow_start event", () => {
    const event: WsServerEvent = {
      type: "workflow_start",
      workflowId: "wf-1",
      graph: {
        version: "1",
        name: "test",
        nodes: { a: { adapter: "claude-sdk", model: "m", role: "r", prompt: "p" } },
        edges: [],
      },
    };
    expect(event.type).toBe("workflow_start");
  });

  it("covers node_start event", () => {
    const event: WsServerEvent = {
      type: "node_start",
      workflowId: "wf-1",
      nodeId: "a",
      config: { adapter: "claude-sdk", model: "m", role: "r", prompt: "p" },
      attempt: 1,
    };
    expect(event.type).toBe("node_start");
  });

  it("covers node_event event", () => {
    const event: WsServerEvent = {
      type: "node_event",
      workflowId: "wf-1",
      nodeId: "a",
      event: { type: "text_delta", text: "hi" },
    };
    expect(event.type).toBe("node_event");
  });

  it("covers node_end event", () => {
    const event: WsServerEvent = {
      type: "node_end",
      workflowId: "wf-1",
      nodeId: "a",
      result: { output: "done", exitCode: 0, durationMs: 100 },
    };
    expect(event.type).toBe("node_end");
  });

  it("covers gate_eval event", () => {
    const event: WsServerEvent = {
      type: "gate_eval",
      workflowId: "wf-1",
      edgeId: "e1",
      passed: true,
      reason: "exit code matched",
    };
    expect(event.type).toBe("gate_eval");
  });

  it("covers loop_back event", () => {
    const event: WsServerEvent = {
      type: "loop_back",
      workflowId: "wf-1",
      edgeId: "e1",
      attempt: 2,
      maxRetries: 5,
    };
    expect(event.type).toBe("loop_back");
  });

  it("covers rate_limit event", () => {
    const event: WsServerEvent = {
      type: "rate_limit",
      workflowId: "wf-1",
      nodeId: "a",
      retryAfterMs: 30000,
    };
    expect(event.type).toBe("rate_limit");
  });

  it("covers workflow_end event", () => {
    const event: WsServerEvent = {
      type: "workflow_end",
      workflowId: "wf-1",
      success: true,
      durationMs: 60000,
      totalCostUsd: 1.5,
    };
    expect(event.type).toBe("workflow_end");
  });

  it("covers workflow_error event", () => {
    const event: WsServerEvent = {
      type: "workflow_error",
      workflowId: "wf-1",
      nodeId: "a",
      message: "timeout",
    };
    expect(event.type).toBe("workflow_error");
  });

  it("covers human_review_request event", () => {
    const event: WsServerEvent = {
      type: "human_review_request",
      workflowId: "wf-1",
      nodeId: "a",
      edgeId: "e1",
      prompt: "Approve?",
    };
    expect(event.type).toBe("human_review_request");
  });

  it("covers human_review_response event", () => {
    const event: WsServerEvent = {
      type: "human_review_response",
      workflowId: "wf-1",
      edgeId: "e1",
      approved: false,
    };
    expect(event.type).toBe("human_review_response");
  });

  it("covers circuit_breaker event", () => {
    const event: WsServerEvent = {
      type: "circuit_breaker",
      workflowId: "wf-1",
      adapterType: "claude-cli",
      state: "open",
      reason: "transport",
      openUntil: Date.now() + 60_000,
    };
    expect(event.type).toBe("circuit_breaker");
    if (event.type === "circuit_breaker") {
      expect(event.state).toBe("open");
      expect(event.adapterType).toBe("claude-cli");
    }
  });
});

describe("WsClientEvent discriminated union", () => {
  it("covers subscribe event", () => {
    const event: WsClientEvent = { type: "subscribe", workflowId: "wf-1" };
    expect(event.type).toBe("subscribe");
  });

  it("covers unsubscribe event", () => {
    const event: WsClientEvent = { type: "unsubscribe", workflowId: "wf-1" };
    expect(event.type).toBe("unsubscribe");
  });

  it("covers pause event", () => {
    const event: WsClientEvent = { type: "pause", workflowId: "wf-1" };
    expect(event.type).toBe("pause");
  });

  it("covers resume_workflow event", () => {
    const event: WsClientEvent = { type: "resume_workflow", workflowId: "wf-1" };
    expect(event.type).toBe("resume_workflow");
  });

  it("covers cancel event", () => {
    const event: WsClientEvent = { type: "cancel", workflowId: "wf-1" };
    expect(event.type).toBe("cancel");
  });

  it("covers human_review_approve event", () => {
    const event: WsClientEvent = { type: "human_review_approve", workflowId: "wf-1", edgeId: "e1" };
    expect(event.type).toBe("human_review_approve");
  });

  it("covers human_review_reject event", () => {
    const event: WsClientEvent = { type: "human_review_reject", workflowId: "wf-1", edgeId: "e1" };
    expect(event.type).toBe("human_review_reject");
  });
});

describe("WsClientEventSchema", () => {
  it.each<WsClientEvent>([
    { type: "subscribe", workflowId: "wf-1" },
    { type: "unsubscribe", workflowId: "wf-1" },
    { type: "pause", workflowId: "wf-1" },
    { type: "resume_workflow", workflowId: "wf-1" },
    { type: "cancel", workflowId: "wf-1" },
    { type: "human_review_approve", workflowId: "wf-1", edgeId: "e1" },
    { type: "human_review_reject", workflowId: "wf-1", edgeId: "e1" },
  ])("accepts valid variant $type", (c) => {
    expect(WsClientEventSchema.safeParse(c).success).toBe(true);
  });

  it("rejects missing type", () => {
    expect(WsClientEventSchema.safeParse({ workflowId: "wf-1" }).success).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(WsClientEventSchema.safeParse({ type: "delete_run", workflowId: "wf-1" }).success).toBe(
      false,
    );
  });

  it("rejects non-string workflowId", () => {
    expect(
      WsClientEventSchema.safeParse({ type: "pause", workflowId: { hax: true } }).success,
    ).toBe(false);
    expect(WsClientEventSchema.safeParse({ type: "pause", workflowId: 42 }).success).toBe(false);
    expect(WsClientEventSchema.safeParse({ type: "pause" }).success).toBe(false);
  });

  it("rejects human_review_* missing edgeId", () => {
    expect(
      WsClientEventSchema.safeParse({ type: "human_review_approve", workflowId: "wf-1" }).success,
    ).toBe(false);
    expect(
      WsClientEventSchema.safeParse({ type: "human_review_reject", workflowId: "wf-1" }).success,
    ).toBe(false);
  });

  it("rejects top-level non-objects", () => {
    expect(WsClientEventSchema.safeParse(null).success).toBe(false);
    expect(WsClientEventSchema.safeParse("pause").success).toBe(false);
    expect(WsClientEventSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});

describe("RecordedEvent type", () => {
  it("accepts a valid recorded event", () => {
    const recorded: RecordedEvent = {
      timestamp: Date.now(),
      nodeId: "nodeA",
      event: { type: "text_delta", text: "output" },
    };
    expect(recorded.nodeId).toBe("nodeA");
    expect(recorded.event.type).toBe("text_delta");
  });
});

describe("WorkflowRunState type", () => {
  it("accepts a minimal running state", () => {
    const state: WorkflowRunState = {
      id: "run-1",
      workflowName: "test",
      status: "running",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
      sharedContext: {},
    };
    expect(state.status).toBe("running");
    expect(state.completedNodes).toHaveLength(0);
  });

  it("accepts a completed state with all optional fields", () => {
    const state: WorkflowRunState = {
      id: "run-2",
      workflowName: "test",
      workflowPath: "/workflows/test.json",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:05:00Z",
      currentNodeId: "nodeC",
      completedNodes: ["nodeA", "nodeB", "nodeC"],
      nodeResults: {
        nodeA: { output: "planned", exitCode: 0, durationMs: 5000, costUsd: 0.05 },
        nodeB: { output: "implemented", exitCode: 0, durationMs: 10000, costUsd: 0.10 },
        nodeC: { output: "reviewed", exitCode: 0, durationMs: 3000 },
      },
      totalCostUsd: 0.15,
      retryCounters: { "loop-edge": 2 },
      sharedContext: {},
    };
    expect(state.status).toBe("completed");
    expect(state.completedNodes).toHaveLength(3);
    expect(state.retryCounters["loop-edge"]).toBe(2);
  });

  it("accepts all valid status values", () => {
    const statuses: WorkflowRunState["status"][] = [
      "running", "paused", "completed", "failed", "cancelled",
    ];
    expect(statuses).toHaveLength(5);
  });
});

