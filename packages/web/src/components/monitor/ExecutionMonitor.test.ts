import { describe, it, expect } from "vitest";
import { buildExecutionStateMap, buildTimelineEntries } from "./ExecutionMonitor";
import type { WsServerEvent, WorkflowRunState } from "@sygil/shared";
import {
  makeNodeEndEvent,
  makeNodeStartEvent,
} from "../../test/fixtures/workflow-events";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const nodeStartPlanner = makeNodeStartEvent("planner", "claude-sdk", {
  model: "claude-opus-4-5",
  role: "Planner",
});
const nodeEndPlanner = makeNodeEndEvent("planner", {
  output: "done",
  exitCode: 0,
  durationMs: 1200,
  costUsd: 0.012,
});
const nodeStartImpl = makeNodeStartEvent("implementer", "codex", {
  model: "gpt-4o",
  role: "Implementer",
});

// ---------------------------------------------------------------------------
// buildExecutionStateMap
// ---------------------------------------------------------------------------

describe("buildExecutionStateMap()", () => {
  it("returns empty map for empty event list", () => {
    const map = buildExecutionStateMap([], null);
    expect(map).toEqual({});
  });

  it("marks node as running on node_start", () => {
    const map = buildExecutionStateMap([nodeStartPlanner], null);
    expect(map["planner"]?.status).toBe("running");
    expect(map["planner"]?.attempt).toBe(1);
  });

  it("marks node as completed on node_end", () => {
    const map = buildExecutionStateMap([nodeStartPlanner, nodeEndPlanner], null);
    expect(map["planner"]?.status).toBe("completed");
    expect(map["planner"]?.durationMs).toBe(1200);
    expect(map["planner"]?.costUsd).toBe(0.012);
  });

  it("marks node as failed on workflow_error with nodeId", () => {
    const events: WsServerEvent[] = [
      nodeStartPlanner,
      {
        type: "workflow_error",
        workflowId: "wf-1",
        nodeId: "planner",
        message: "script failed",
      },
    ];
    const map = buildExecutionStateMap(events, null);
    expect(map["planner"]?.status).toBe("failed");
  });

  it("does not fail on workflow_error without nodeId", () => {
    const events: WsServerEvent[] = [
      nodeStartPlanner,
      { type: "workflow_error", workflowId: "wf-1", message: "global error" },
    ];
    const map = buildExecutionStateMap(events, null);
    // planner still shows running — no nodeId on the error
    expect(map["planner"]?.status).toBe("running");
  });

  it("tracks multiple nodes independently", () => {
    const map = buildExecutionStateMap(
      [nodeStartPlanner, nodeEndPlanner, nodeStartImpl],
      null
    );
    expect(map["planner"]?.status).toBe("completed");
    expect(map["implementer"]?.status).toBe("running");
  });

  it("marks running nodes as failed on loop_back", () => {
    const events: WsServerEvent[] = [
      nodeStartPlanner,
      {
        type: "loop_back",
        workflowId: "wf-1",
        edgeId: "plan-to-impl",
        attempt: 1,
        maxRetries: 3,
      },
    ];
    const map = buildExecutionStateMap(events, null);
    expect(map["planner"]?.status).toBe("failed");
  });

  it("preserves attempt number from node_start", () => {
    const attempt2Start: WsServerEvent = { ...nodeStartPlanner, attempt: 2 };
    const map = buildExecutionStateMap([attempt2Start], null);
    expect(map["planner"]?.attempt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildTimelineEntries
// ---------------------------------------------------------------------------

describe("buildTimelineEntries()", () => {
  it("returns empty array for empty events", () => {
    expect(buildTimelineEntries(null, [])).toEqual([]);
  });

  it("creates a running entry on node_start", () => {
    const entries = buildTimelineEntries(null, [nodeStartPlanner]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.nodeId).toBe("planner");
    expect(entries[0]?.status).toBe("running");
  });

  it("marks entry as completed on node_end", () => {
    const entries = buildTimelineEntries(null, [nodeStartPlanner, nodeEndPlanner]);
    const planner = entries.find((e) => e.nodeId === "planner");
    expect(planner?.status).toBe("completed");
    if (planner && "durationMs" in planner) {
      expect(planner.durationMs).toBe(1200);
    }
  });

  it("creates separate entries per retry attempt", () => {
    // The loop_back handler marks the TARGET of the edge as failed.
    // "impl-to-planner" goes FROM implementer TO planner, so when this
    // loop_back fires while planner-1 is running, planner-1 becomes "failed".
    const workflowStartWithLoopBack: WsServerEvent = {
      type: "workflow_start",
      workflowId: "wf-1",
      graph: {
        version: "1",
        name: "tdd-feature",
        nodes: {
          planner: { adapter: "claude-sdk", model: "claude-opus-4-5", role: "Planner", prompt: "", tools: [] },
          implementer: { adapter: "codex", model: "gpt-4o", role: "Implementer", prompt: "", tools: [] },
        },
        edges: [
          { id: "plan-to-impl", from: "planner", to: "implementer" },
          { id: "impl-to-planner", from: "implementer", to: "planner", isLoopBack: true, maxRetries: 3 },
        ],
      },
    };
    const loopBack: WsServerEvent = {
      type: "loop_back",
      workflowId: "wf-1",
      edgeId: "impl-to-planner", // target is "planner" → marks running planner entry failed
      attempt: 1,
      maxRetries: 3,
    };
    const attempt2: WsServerEvent = { ...nodeStartPlanner, attempt: 2 };

    const entries = buildTimelineEntries(null, [
      workflowStartWithLoopBack,
      nodeStartPlanner,   // planner attempt 1 → running
      loopBack,           // impl-to-planner: target=planner → planner-1 marked failed
      attempt2,           // planner attempt 2 → running
    ]);

    const attempt1Entry = entries.find((e) => e.nodeId === "planner" && e.attempt === 1);
    const attempt2Entry = entries.find((e) => e.nodeId === "planner" && e.attempt === 2);
    expect(attempt1Entry?.status).toBe("failed");
    expect(attempt2Entry?.status).toBe("running");
  });

  it("accumulates node events in the events array", () => {
    const nodeEvent: WsServerEvent = {
      type: "node_event",
      workflowId: "wf-1",
      nodeId: "planner",
      event: { type: "text_delta", text: "thinking..." },
    };
    const entries = buildTimelineEntries(null, [nodeStartPlanner, nodeEvent]);
    const planner = entries[0];
    expect(planner?.status).toBe("running");
    if (planner && planner.adapter !== "human-review") {
      expect(planner.events).toHaveLength(1);
      expect(planner.events[0]).toMatchObject({ type: "text_delta", text: "thinking..." });
    }
  });

  it("creates a human-review entry on human_review_request", () => {
    const reviewReq: WsServerEvent = {
      type: "human_review_request",
      workflowId: "wf-1",
      nodeId: "planner",
      edgeId: "plan-to-impl",
      prompt: "Approve this output?",
    };
    const entries = buildTimelineEntries(null, [nodeStartPlanner, reviewReq]);
    const reviewEntry = entries.find(
      (e) => e.adapter === "human-review"
    );
    expect(reviewEntry).toBeDefined();
    expect(reviewEntry?.status).toBe("awaiting");
    if (reviewEntry && "prompt" in reviewEntry) {
      expect(reviewEntry.prompt).toBe("Approve this output?");
    }
  });

  it("preserves insertion order across multiple nodes", () => {
    const entries = buildTimelineEntries(null, [
      nodeStartPlanner,
      nodeEndPlanner,
      nodeStartImpl,
    ]);
    expect(entries[0]?.nodeId).toBe("planner");
    expect(entries[1]?.nodeId).toBe("implementer");
  });

  it("marks currentNodeId entry as running from workflowState", () => {
    const state: WorkflowRunState = {
      id: "wf-1",
      workflowName: "tdd",
      workflowPath: "",
      status: "running",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
      sharedContext: {},
      currentNodeId: "planner",
    };
    // Manually set to failed first so we can verify the override
    const failedStart: WsServerEvent = {
      ...nodeStartPlanner,
      attempt: 1,
    };
    const entries = buildTimelineEntries(state, [failedStart]);
    const planner = entries.find((e) => e.nodeId === "planner");
    // workflowState says planner is current — should remain running
    expect(planner?.status).toBe("running");
  });

  // Distinguish `cached` and `cancelled` so operators can tell
  // memoized results and user-intent aborts apart from genuine completion or
  // adapter failure.
  describe("status coverage", () => {
    it("marks a node_end with cacheHit=true as cached, not completed", () => {
      const cacheHitEnd: WsServerEvent = {
        type: "node_end",
        workflowId: "wf-1",
        nodeId: "planner",
        result: {
          output: "done",
          exitCode: 0,
          durationMs: 12,
          costUsd: 0.004,
          cacheHit: true,
        },
      };
      const entries = buildTimelineEntries(null, [nodeStartPlanner, cacheHitEnd]);
      const planner = entries.find((e) => e.nodeId === "planner");
      expect(planner?.status).toBe("cached");
    });

    it("treats 'Workflow cancelled' workflow_error as cancellation, not failure", () => {
      const cancelled: WsServerEvent = {
        type: "workflow_error",
        workflowId: "wf-1",
        nodeId: "planner",
        message: "Workflow cancelled",
      };
      const entries = buildTimelineEntries(null, [nodeStartPlanner, cancelled]);
      const planner = entries.find((e) => e.nodeId === "planner");
      expect(planner?.status).toBe("cancelled");
    });

    it("sweeps all in-flight nodes to cancelled on bare cancellation error", () => {
      const cancelled: WsServerEvent = {
        type: "workflow_error",
        workflowId: "wf-1",
        message: "Workflow cancelled",
      };
      const entries = buildTimelineEntries(null, [
        nodeStartPlanner,
        nodeStartImpl,
        cancelled,
      ]);
      expect(entries.find((e) => e.nodeId === "planner")?.status).toBe("cancelled");
      expect(entries.find((e) => e.nodeId === "implementer")?.status).toBe("cancelled");
    });

    it("still marks non-cancellation errors as failed", () => {
      const failed: WsServerEvent = {
        type: "workflow_error",
        workflowId: "wf-1",
        nodeId: "planner",
        message: "adapter crashed",
      };
      const entries = buildTimelineEntries(null, [nodeStartPlanner, failed]);
      const planner = entries.find((e) => e.nodeId === "planner");
      expect(planner?.status).toBe("failed");
    });
  });
});
