import { describe, it, expect } from "vitest";
import type {
  WsServerEvent,
  WsClientEvent,
  RecordedEvent,
  WorkflowRunState,
} from "./events.js";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeResult,
} from "./adapter.js";
import type { NodeConfig } from "./workflow.js";

// ---------------------------------------------------------------------------
// These are compile-time type tests. The runtime assertions are minimal;
// the value is that TypeScript checks the structural conformance.
// ---------------------------------------------------------------------------

describe("AgentEvent discriminated union", () => {
  it("covers tool_call event", () => {
    const event: AgentEvent = { type: "tool_call", tool: "Read", input: { path: "/tmp" } };
    expect(event.type).toBe("tool_call");
    if (event.type === "tool_call") {
      expect(event.tool).toBe("Read");
      expect(event.input["path"]).toBe("/tmp");
    }
  });

  it("covers tool_result event", () => {
    const event: AgentEvent = { type: "tool_result", tool: "Read", output: "file content", success: true };
    expect(event.type).toBe("tool_result");
    if (event.type === "tool_result") {
      expect(event.success).toBe(true);
    }
  });

  it("covers file_write event", () => {
    const event: AgentEvent = { type: "file_write", path: "/tmp/out.txt" };
    expect(event.type).toBe("file_write");
  });

  it("covers shell_exec event", () => {
    const event: AgentEvent = { type: "shell_exec", command: "ls", exitCode: 0 };
    expect(event.type).toBe("shell_exec");
    if (event.type === "shell_exec") {
      expect(event.exitCode).toBe(0);
    }
  });

  it("covers text_delta event", () => {
    const event: AgentEvent = { type: "text_delta", text: "Hello" };
    expect(event.type).toBe("text_delta");
  });

  it("covers cost_update event", () => {
    const event: AgentEvent = { type: "cost_update", totalCostUsd: 0.05 };
    expect(event.type).toBe("cost_update");
    if (event.type === "cost_update") {
      expect(event.totalCostUsd).toBe(0.05);
    }
  });

  it("covers stall event", () => {
    const event: AgentEvent = { type: "stall", reason: "no output" };
    expect(event.type).toBe("stall");
  });

  it("covers error event", () => {
    const event: AgentEvent = { type: "error", message: "crash" };
    expect(event.type).toBe("error");
  });
});

describe("NodeResult type", () => {
  it("accepts a minimal result", () => {
    const result: NodeResult = {
      output: "done",
      exitCode: 0,
      durationMs: 1234,
    };
    expect(result.output).toBe("done");
    expect(result.costUsd).toBeUndefined();
    expect(result.tokenUsage).toBeUndefined();
  });

  it("accepts a result with all optional fields", () => {
    const result: NodeResult = {
      output: "done",
      structuredOutput: { summary: "ok" },
      exitCode: 0,
      durationMs: 5000,
      costUsd: 0.12,
      tokenUsage: {
        input: 1000,
        output: 500,
        cacheRead: 200,
      },
    };
    expect(result.costUsd).toBe(0.12);
    expect(result.tokenUsage?.cacheRead).toBe(200);
  });

  it("accepts tokenUsage without cacheRead", () => {
    const result: NodeResult = {
      output: "done",
      exitCode: 0,
      durationMs: 100,
      tokenUsage: { input: 100, output: 50 },
    };
    expect(result.tokenUsage?.cacheRead).toBeUndefined();
  });
});

describe("AgentSession type", () => {
  it("accepts a valid session object", () => {
    const session: AgentSession = {
      id: "sess-123",
      nodeId: "nodeA",
      adapter: "claude-sdk",
      startedAt: new Date(),
      _internal: { pid: 1234 },
    };
    expect(session.id).toBe("sess-123");
    expect(session.adapter).toBe("claude-sdk");
  });
});

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

describe("AgentAdapter interface (structural check)", () => {
  it("can define a mock adapter that satisfies the interface", () => {
    // This is a compile-time check: if this code compiles, the interface is correct
    const mockAdapter: AgentAdapter = {
      name: "mock",
      isAvailable: async () => true,
      spawn: async (_config: NodeConfig) => ({
        id: "s1",
        nodeId: "n1",
        adapter: "mock",
        startedAt: new Date(),
        _internal: null,
      }),
      resume: async (_config, session, _feedback) => session,
      stream: async function* (_session) {
        yield { type: "text_delta" as const, text: "hello" };
      },
      getResult: async (_session) => ({
        output: "done",
        exitCode: 0,
        durationMs: 100,
      }),
      kill: async (_session) => {},
    };

    expect(mockAdapter.name).toBe("mock");
  });
});
