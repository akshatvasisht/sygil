/**
 * Integration test: scheduler perf modules working together.
 *
 * Verifies that GraphIndex, AbortTree, CheckpointManager, critical-path
 * weights, and EventRecorder compose correctly end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  WorkflowGraph,
  NodeConfig,
  NodeResult,
  WorkflowRunState,
  AgentEvent,
  AdapterType,
} from "@sigil/shared";
import { GraphIndex } from "../scheduler/graph-index.js";
import { AbortTree } from "../scheduler/abort-tree.js";
import { CheckpointManager, CHECKPOINT_DEBOUNCE_MS } from "../scheduler/checkpoint-manager.js";
import { computeCriticalPathWeights } from "../scheduler/critical-path.js";
import { EventRecorder } from "../scheduler/event-recorder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test",
    role: "test",
    prompt: "test",
    ...overrides,
  };
}

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: randomUUID(),
    workflowName: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    completedNodes: [],
    nodeResults: {},
    totalCostUsd: 0,
    retryCounters: {},
    ...overrides,
  };
}

function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    output: "output",
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

function makeTextDeltaEvent(text = "hello"): AgentEvent {
  return { type: "text_delta", text };
}

function makeToolCallEvent(): AgentEvent {
  return { type: "tool_call", tool: "bash", input: { cmd: "ls" } };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "sigil-perf-integ-"));
  originalCwd = process.cwd();
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduler perf modules integration", () => {
  it("GraphIndex + critical-path weights produce correct priority for diamond DAG", () => {
    // Diamond: start -> left, start -> right, left -> merge, right -> merge
    const graph: WorkflowGraph = {
      version: "1",
      name: "diamond",
      nodes: {
        start: makeNodeConfig(),
        left: makeNodeConfig(),
        right: makeNodeConfig(),
        merge: makeNodeConfig(),
      },
      edges: [
        { id: "e-start-left", from: "start", to: "left" },
        { id: "e-start-right", from: "start", to: "right" },
        { id: "e-left-merge", from: "left", to: "merge" },
        { id: "e-right-merge", from: "right", to: "merge" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    // start has the longest path (start->left->merge = 3, start->right->merge = 3)
    const startWeight = weights.get("start")!;
    const leftWeight = weights.get("left")!;
    const rightWeight = weights.get("right")!;
    const mergeWeight = weights.get("merge")!;

    expect(startWeight).toBeGreaterThan(leftWeight);
    expect(startWeight).toBeGreaterThan(rightWeight);
    expect(leftWeight).toEqual(rightWeight);
    expect(leftWeight).toBeGreaterThan(mergeWeight);

    // Concrete values: merge=1, left=right=2, start=3
    expect(mergeWeight).toBe(1);
    expect(leftWeight).toBe(2);
    expect(rightWeight).toBe(2);
    expect(startWeight).toBe(3);
  });

  it("AbortTree cascades root abort to all children", () => {
    const tree = new AbortTree();

    const signalA = tree.createChild("nodeA");
    const signalB = tree.createChild("nodeB");
    const signalC = tree.createChild("nodeC");

    expect(signalA.aborted).toBe(false);
    expect(signalB.aborted).toBe(false);
    expect(signalC.aborted).toBe(false);

    tree.abortAll("workflow cancelled");

    expect(tree.signal.aborted).toBe(true);
    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(true);
    expect(signalC.aborted).toBe(true);
  });

  it("AbortTree child abort does not affect siblings", () => {
    const tree = new AbortTree();

    const signalA = tree.createChild("A");
    const signalB = tree.createChild("B");
    const signalC = tree.createChild("C");

    tree.abortChild("B");

    expect(signalB.aborted).toBe(true);
    expect(signalA.aborted).toBe(false);
    expect(signalC.aborted).toBe(false);
    expect(tree.signal.aborted).toBe(false);
  });

  it("CheckpointManager writes state and per-node results to disk", async () => {
    process.chdir(testDir);

    const mgr = new CheckpointManager(testDir);
    const state = makeRunState({ status: "completed", completedNodes: ["nodeA", "nodeB"] });
    const resultA = makeNodeResult({ output: "output-a", durationMs: 200 });
    const resultB = makeNodeResult({ output: "output-b", exitCode: 0, durationMs: 400 });

    mgr.markDirty(state);
    mgr.markNodeResult(state.id, "nodeA", resultA);
    mgr.markNodeResult(state.id, "nodeB", resultB);
    await mgr.flush();
    mgr.dispose();

    const loaded = await CheckpointManager.loadState(testDir, state.id);

    expect(loaded.id).toBe(state.id);
    expect(loaded.status).toBe("completed");
    expect(loaded.completedNodes).toEqual(["nodeA", "nodeB"]);
    expect(loaded.nodeResults["nodeA"]?.output).toBe("output-a");
    expect(loaded.nodeResults["nodeA"]?.durationMs).toBe(200);
    expect(loaded.nodeResults["nodeB"]?.output).toBe("output-b");
    expect(loaded.nodeResults["nodeB"]?.durationMs).toBe(400);
  });

  it("EventRecorder persists events that survive CheckpointManager.loadState round-trip", async () => {
    process.chdir(testDir);

    // Build a run directory structure matching what CheckpointManager uses:
    // .sigil/runs/<runId>/  — checkpoint dir
    // We use testDir as the event recorder's runDir directly (independent of checkpoint path).
    const runDir = testDir;
    const recorder = new EventRecorder(runDir);

    const runId = randomUUID();
    recorder.record("node-alpha", makeTextDeltaEvent("step one"));
    recorder.record("node-alpha", makeToolCallEvent());
    await recorder.flushNode("node-alpha");

    // In parallel, write a checkpoint for the same run
    const mgr = new CheckpointManager(testDir);
    const state = makeRunState({ id: runId, status: "running" });
    mgr.markDirty(state);
    await mgr.flush();
    mgr.dispose();

    // Events are readable after flush
    const events = await EventRecorder.readNodeEvents(runDir, "node-alpha");
    expect(events).toHaveLength(2);
    expect(events[0]!.event.type).toBe("text_delta");
    expect(events[0]!.nodeId).toBe("node-alpha");
    expect(events[1]!.event.type).toBe("tool_call");

    // Checkpoint is independently loadable
    const loaded = await CheckpointManager.loadState(testDir, runId);
    expect(loaded.id).toBe(runId);
    expect(loaded.status).toBe("running");
  });

  it("full pipeline: GraphIndex → priority sort → abort → checkpoint → events", async () => {
    process.chdir(testDir);

    // 1. Build a 3-node linear workflow and index it
    const graph: WorkflowGraph = {
      version: "1",
      name: "linear-pipeline",
      nodes: {
        nodeFirst: makeNodeConfig(),
        nodeSecond: makeNodeConfig(),
        nodeThird: makeNodeConfig(),
      },
      edges: [
        { id: "e-first-second", from: "nodeFirst", to: "nodeSecond" },
        { id: "e-second-third", from: "nodeSecond", to: "nodeThird" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    // 2. Verify priority order: nodeFirst has highest weight (3), nodeThird lowest (1)
    const firstWeight = weights.get("nodeFirst")!;
    const secondWeight = weights.get("nodeSecond")!;
    const thirdWeight = weights.get("nodeThird")!;

    expect(firstWeight).toBe(3);
    expect(secondWeight).toBe(2);
    expect(thirdWeight).toBe(1);

    // Sort nodes by descending priority — nodeFirst should come first
    const sorted = [...index.nodeIds].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
    expect(sorted[0]).toBe("nodeFirst");
    expect(sorted[1]).toBe("nodeSecond");
    expect(sorted[2]).toBe("nodeThird");

    // 3. Create AbortTree and spawn children for all three nodes
    const tree = new AbortTree();
    const signalFirst = tree.createChild("nodeFirst");
    const signalSecond = tree.createChild("nodeSecond");
    const signalThird = tree.createChild("nodeThird");

    expect(signalFirst.aborted).toBe(false);
    expect(signalSecond.aborted).toBe(false);
    expect(signalThird.aborted).toBe(false);

    // 4. Simulate: record events for nodeFirst, flush, then checkpoint run state
    const runDir = testDir;
    const recorder = new EventRecorder(runDir);

    recorder.record("nodeFirst", makeTextDeltaEvent("thinking…"));
    recorder.record("nodeFirst", makeToolCallEvent());
    await recorder.flushNode("nodeFirst");

    const runId = randomUUID();
    const mgr = new CheckpointManager(testDir);
    const state = makeRunState({
      id: runId,
      completedNodes: ["nodeFirst"],
      nodeResults: {},
    });
    mgr.markNodeResult(runId, "nodeFirst", makeNodeResult({ durationMs: 150 }));
    mgr.markDirty(state);
    await mgr.flush();
    mgr.dispose();

    // 5. Abort nodeSecond (simulating a gate failure mid-run)
    tree.abortChild("nodeSecond");

    // 6. Assertions —

    // nodeFirst events exist on disk
    const firstEvents = await EventRecorder.readNodeEvents(runDir, "nodeFirst");
    expect(firstEvents).toHaveLength(2);
    expect(firstEvents[0]!.event.type).toBe("text_delta");
    expect(firstEvents[1]!.event.type).toBe("tool_call");

    // Checkpoint is loadable and contains nodeFirst result
    const loaded = await CheckpointManager.loadState(testDir, runId);
    expect(loaded.id).toBe(runId);
    expect(loaded.completedNodes).toContain("nodeFirst");
    expect(loaded.nodeResults["nodeFirst"]?.durationMs).toBe(150);

    // nodeSecond's signal is aborted, nodeThird and root are not
    expect(signalSecond.aborted).toBe(true);
    expect(signalThird.aborted).toBe(false);
    expect(tree.signal.aborted).toBe(false);

    tree.dispose();
  });
});
