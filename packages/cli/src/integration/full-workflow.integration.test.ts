/**
 * Capstone integration tests for the full WorkflowScheduler.
 *
 * Exercises multi-node DAG execution with gates, loop-backs, cancellation,
 * pause/resume, cost tracking, and checkpoint persistence — all through the
 * real scheduler stack with mock adapters and a mock monitor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "../scheduler/index.js";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
  AdapterType,
  WsServerEvent,
} from "@sigil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(nodeId: string, adapter = "mock"): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter,
    startedAt: new Date(),
    _internal: null,
  };
}

function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test-role",
    prompt: "test prompt",
    ...overrides,
  };
}

function createSimpleAdapter(result: Partial<NodeResult> = {}, events: AgentEvent[] = []): AgentAdapter {
  return {
    name: "mock",
    async isAvailable() { return true; },
    async spawn(config) { return makeSession(config.prompt.slice(0, 20)); },
    async resume(_c, prev, _f) { return prev; },
    async *stream(): AsyncGenerator<AgentEvent> {
      for (const e of events) yield e;
    },
    async getResult() {
      return { output: "mock output", exitCode: 0, durationMs: 10, ...result };
    },
    async kill() {},
  };
}

type MockMonitor = WsMonitorServer & { events: WsServerEvent[] };

function createMockMonitor(): MockMonitor {
  const events: WsServerEvent[] = [];
  return {
    events,
    emit(event: WsServerEvent) { events.push(event); },
    async start() { return 0; },
    async stop() {},
    getPort() { return null; },
    getAuthToken() { return "test-token"; },
    onClientControl: undefined,
  } as unknown as MockMonitor;
}

function eventsOfType<T extends WsServerEvent["type"]>(
  events: WsServerEvent[],
  type: T
): Extract<WsServerEvent, { type: T }>[] {
  return events.filter((e): e is Extract<WsServerEvent, { type: T }> => e.type === type);
}

// ---------------------------------------------------------------------------
// Test lifecycle — temp dir + process.chdir
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sigil-fullwf-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("full workflow integration", () => {
  // --------------------------------------------------------------------------
  // 1. Single node completes successfully
  // --------------------------------------------------------------------------
  it("single node completes successfully", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "single-node",
      nodes: { nodeA: makeNodeConfig() },
      edges: [],
    };

    const adapter = createSimpleAdapter({ exitCode: 0 });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-1");

    expect(result.success).toBe(true);

    const starts = eventsOfType(monitor.events, "workflow_start");
    const nodeStarts = eventsOfType(monitor.events, "node_start");
    const nodeEnds = eventsOfType(monitor.events, "node_end");
    const ends = eventsOfType(monitor.events, "workflow_end");

    expect(starts).toHaveLength(1);
    expect(nodeStarts).toHaveLength(1);
    expect(nodeStarts[0]!.nodeId).toBe("nodeA");
    expect(nodeEnds).toHaveLength(1);
    expect(nodeEnds[0]!.nodeId).toBe("nodeA");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 2. Linear 2-node workflow with exit_code gate
  // --------------------------------------------------------------------------
  it("linear 2-node workflow with exit_code gate", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "linear",
      nodes: {
        nodeA: makeNodeConfig({ prompt: "step A" }),
        nodeB: makeNodeConfig({ prompt: "step B" }),
      },
      edges: [
        {
          id: "e-a-b",
          from: "nodeA",
          to: "nodeB",
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
      ],
    };

    const adapter = createSimpleAdapter({ exitCode: 0 });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-2");

    expect(result.success).toBe(true);

    const nodeStarts = eventsOfType(monitor.events, "node_start");
    expect(nodeStarts.map((e) => e.nodeId)).toContain("nodeA");
    expect(nodeStarts.map((e) => e.nodeId)).toContain("nodeB");

    const gateEvals = eventsOfType(monitor.events, "gate_eval");
    expect(gateEvals.length).toBeGreaterThanOrEqual(1);
    expect(gateEvals[0]!.passed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. Forward gate failure prevents downstream node
  // --------------------------------------------------------------------------
  it("forward gate failure prevents downstream node", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "gate-fail",
      nodes: {
        nodeA: makeNodeConfig({ prompt: "step A" }),
        nodeB: makeNodeConfig({ prompt: "step B" }),
      },
      edges: [
        {
          id: "e-a-b",
          from: "nodeA",
          to: "nodeB",
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
      ],
    };

    // nodeA returns exit code 1 — gate expects 0, so it should fail
    const adapter = createSimpleAdapter({ exitCode: 1 });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-3");

    expect(result.success).toBe(false);

    const gateEvals = eventsOfType(monitor.events, "gate_eval");
    expect(gateEvals.length).toBeGreaterThanOrEqual(1);
    expect(gateEvals[0]!.passed).toBe(false);

    // nodeB should never have started
    const nodeStarts = eventsOfType(monitor.events, "node_start");
    const nodeBStarted = nodeStarts.some((e) => e.nodeId === "nodeB");
    expect(nodeBStarted).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 4. Diamond DAG runs parallel branches then merges
  // --------------------------------------------------------------------------
  it("diamond DAG runs parallel branches then merges", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "diamond",
      nodes: {
        start: makeNodeConfig({ prompt: "start" }),
        left: makeNodeConfig({ prompt: "left" }),
        right: makeNodeConfig({ prompt: "right" }),
        merge: makeNodeConfig({ prompt: "merge" }),
      },
      edges: [
        { id: "e-start-left", from: "start", to: "left" },
        { id: "e-start-right", from: "start", to: "right" },
        { id: "e-left-merge", from: "left", to: "merge" },
        { id: "e-right-merge", from: "right", to: "merge" },
      ],
    };

    const adapter = createSimpleAdapter({ exitCode: 0 });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-4");

    expect(result.success).toBe(true);

    const nodeStarts = eventsOfType(monitor.events, "node_start");
    const startedIds = nodeStarts.map((e) => e.nodeId);
    expect(startedIds).toContain("start");
    expect(startedIds).toContain("left");
    expect(startedIds).toContain("right");
    expect(startedIds).toContain("merge");

    // left and right must both appear before merge
    const mergeIdx = startedIds.lastIndexOf("merge");
    const leftIdx = startedIds.indexOf("left");
    const rightIdx = startedIds.indexOf("right");
    expect(leftIdx).toBeLessThan(mergeIdx);
    expect(rightIdx).toBeLessThan(mergeIdx);
  });

  // --------------------------------------------------------------------------
  // 5. Loop-back retries on gate failure up to maxRetries
  // --------------------------------------------------------------------------
  it("loop-back retries on gate failure up to maxRetries", async () => {
    // The scheduler's loop-back pattern: a node has a self-loop edge.
    // When the gate on the self-loop fails, the node re-runs (up to maxRetries).
    // When the gate passes, the node completes normally.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "loop-back",
      nodes: {
        writer: makeNodeConfig({ prompt: "write code" }),
        reviewer: makeNodeConfig({ prompt: "review code" }),
      },
      edges: [
        { id: "e-write-review", from: "writer", to: "reviewer" },
        {
          id: "e-reviewer-self",
          from: "reviewer",
          to: "reviewer",
          isLoopBack: true,
          maxRetries: 2,
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
      ],
    };

    // Reviewer: first call returns exitCode 1 (gate fails → retry), second returns 0.
    // We use a shared call counter to track getResult invocations.
    let getResultCallCount = 0;
    const statefulAdapter: AgentAdapter = {
      name: "stateful",
      async isAvailable() { return true; },
      async spawn(config) { return makeSession(config.prompt.slice(0, 20)); },
      async resume(_c, prev, _f) { return prev; },
      async *stream(): AsyncGenerator<AgentEvent> {
        yield { type: "text_delta", text: "processing" };
      },
      async getResult() {
        getResultCallCount++;
        // call 1 = writer (exitCode 0)
        // call 2 = reviewer attempt 1 (exitCode 1 → gate fails → retry)
        // call 3 = reviewer attempt 2 (exitCode 0 → gate passes → done)
        if (getResultCallCount === 1) return { output: "written", exitCode: 0, durationMs: 5 };
        return { output: "reviewed", exitCode: getResultCallCount <= 2 ? 1 : 0, durationMs: 5 };
      },
      async kill() {},
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => statefulAdapter, monitor);

    const result = await scheduler.run("wf-5");

    expect(result.success).toBe(true);

    const loopBacks = eventsOfType(monitor.events, "loop_back");
    expect(loopBacks.length).toBeGreaterThanOrEqual(1);
    expect(loopBacks[0]!.edgeId).toBe("e-reviewer-self");
  });

  // --------------------------------------------------------------------------
  // 6. Loop-back exceeds maxRetries and fails
  // --------------------------------------------------------------------------
  it("loop-back exceeds maxRetries and fails", async () => {
    // Same self-loop topology as test 5, but the reviewer always fails.
    // maxRetries=1: after 2 executions (1 initial + 1 retry), retryCount exceeds
    // maxRetries and the workflow fails. The "exceeded maxRetries" message
    // appears in the monitor's workflow_error event.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "loop-back-fail",
      nodes: {
        writer: makeNodeConfig({ prompt: "write code" }),
        reviewer: makeNodeConfig({ prompt: "review code" }),
      },
      edges: [
        { id: "e-write-review", from: "writer", to: "reviewer" },
        {
          id: "e-reviewer-self",
          from: "reviewer",
          to: "reviewer",
          isLoopBack: true,
          maxRetries: 1,
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
      ],
    };

    // Writer succeeds; reviewer always returns exitCode 1 (gate always fails).
    let getResultCallCount = 0;
    const alwaysFailAdapter: AgentAdapter = {
      name: "always-fail",
      async isAvailable() { return true; },
      async spawn(config) { return makeSession(config.prompt.slice(0, 20)); },
      async resume(_c, prev, _f) { return prev; },
      async *stream(): AsyncGenerator<AgentEvent> {
        yield { type: "text_delta", text: "processing" };
      },
      async getResult() {
        getResultCallCount++;
        // call 1 = writer → exitCode 0
        // calls 2+ = reviewer → exitCode 1 always
        return { output: "out", exitCode: getResultCallCount === 1 ? 0 : 1, durationMs: 5 };
      },
      async kill() {},
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => alwaysFailAdapter, monitor);

    const result = await scheduler.run("wf-6");

    expect(result.success).toBe(false);
    // Top-level error reports node failure; "exceeded maxRetries" detail is in
    // the workflow_error monitor event (same behavior as scheduler unit tests)
    expect(result.error).toMatch(/node\(s\) failed/i);
    const errorEvent = monitor.events.find(
      (e) => e.type === "workflow_error" && "message" in e &&
        typeof (e as { message?: unknown }).message === "string" &&
        (e as { message: string }).message.includes("exceeded maxRetries")
    );
    expect(errorEvent).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 7. Cancel mid-execution aborts the workflow
  // --------------------------------------------------------------------------
  it("cancel mid-execution aborts the workflow", async () => {
    // Use a 2-node workflow: nodeA runs slowly, nodeB is downstream.
    // When nodeA is cancelled, the main scheduler loop iterates and sees
    // state === "cancelled", throwing "Workflow cancelled" before nodeB starts.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "cancel-test",
      nodes: {
        nodeA: makeNodeConfig({ prompt: "node A" }),
        nodeB: makeNodeConfig({ prompt: "node B" }),
      },
      edges: [{ id: "e-a-b", from: "nodeA", to: "nodeB" }],
    };

    // Adapter streams slowly — cancel will arrive while nodeA is streaming
    const slowAdapter: AgentAdapter = {
      name: "slow",
      async isAvailable() { return true; },
      async spawn(config) { return makeSession(config.prompt); },
      async resume(_c, prev) { return prev; },
      async *stream(): AsyncGenerator<AgentEvent> {
        // Yield events with delays to give cancel a window
        await new Promise((r) => setTimeout(r, 30));
        yield { type: "text_delta", text: "chunk 1" };
        await new Promise((r) => setTimeout(r, 30));
        yield { type: "text_delta", text: "chunk 2" };
        await new Promise((r) => setTimeout(r, 30));
        yield { type: "text_delta", text: "chunk 3" };
      },
      async getResult() {
        return { output: "slow output", exitCode: 0, durationMs: 100 };
      },
      async kill() {},
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => slowAdapter, monitor);

    // Start the run and cancel after 50ms (mid-stream for nodeA)
    const runPromise = scheduler.run("wf-7");
    setTimeout(() => scheduler.cancel(), 50);

    const result = await runPromise;

    expect(result.success).toBe(false);
    // The scheduler propagates "Workflow cancelled" through the main loop
    // once the in-flight node finishes and wake() fires
    expect(result.error).toMatch(/cancelled/i);

    // nodeB must never have started
    const nodeStarts = eventsOfType(monitor.events, "node_start");
    expect(nodeStarts.some((e) => e.nodeId === "nodeB")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 8. Pause and resume
  // --------------------------------------------------------------------------
  it("pause and resume completes the workflow successfully", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "pause-resume",
      nodes: {
        nodeA: makeNodeConfig({ prompt: "node A" }),
        nodeB: makeNodeConfig({ prompt: "node B" }),
      },
      edges: [{ id: "e-a-b", from: "nodeA", to: "nodeB" }],
    };

    // nodeA takes a moment to finish so pause arrives while it's running
    const delayedAdapter: AgentAdapter = {
      name: "delayed",
      async isAvailable() { return true; },
      async spawn(config) { return makeSession(config.prompt); },
      async resume(_c, prev) { return prev; },
      async *stream(): AsyncGenerator<AgentEvent> {
        await new Promise((r) => setTimeout(r, 30));
        yield { type: "text_delta", text: "done" };
      },
      async getResult() {
        return { output: "out", exitCode: 0, durationMs: 30 };
      },
      async kill() {},
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => delayedAdapter, monitor);

    const runPromise = scheduler.run("wf-8");

    // Pause, then resume after a short delay
    setTimeout(() => {
      scheduler.pause();
      setTimeout(() => scheduler.resumeExecution(), 60);
    }, 20);

    const result = await runPromise;

    expect(result.success).toBe(true);

    const ends = eventsOfType(monitor.events, "workflow_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 9. Cost tracking accumulates across nodes
  // --------------------------------------------------------------------------
  it("cost tracking accumulates across nodes", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "cost-tracking",
      nodes: {
        nodeA: makeNodeConfig({ prompt: "node A" }),
        nodeB: makeNodeConfig({ prompt: "node B" }),
      },
      edges: [{ id: "e-a-b", from: "nodeA", to: "nodeB" }],
    };

    let callIndex = 0;
    const costs = [0.05, 0.03];
    const costAdapter: AgentAdapter = {
      name: "costed",
      async isAvailable() { return true; },
      async spawn(config) { return makeSession(config.prompt); },
      async resume(_c, prev) { return prev; },
      async *stream(): AsyncGenerator<AgentEvent> {},
      async getResult() {
        const costUsd = costs[callIndex++] ?? 0;
        return { output: "out", exitCode: 0, durationMs: 5, costUsd };
      },
      async kill() {},
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => costAdapter, monitor);

    const result = await scheduler.run("wf-9");

    expect(result.success).toBe(true);
    expect(result.totalCostUsd).toBeDefined();
    expect(result.totalCostUsd!).toBeCloseTo(0.08, 5);

    const ends = eventsOfType(monitor.events, "workflow_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.totalCostUsd).toBeCloseTo(0.08, 5);
  });

  // --------------------------------------------------------------------------
  // 10. Checkpoint written to disk on completion
  // --------------------------------------------------------------------------
  it("checkpoint written to disk on completion", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "checkpoint-test",
      nodes: { nodeA: makeNodeConfig() },
      edges: [],
    };

    const adapter = createSimpleAdapter({ exitCode: 0 });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-10");

    expect(result.success).toBe(true);

    // Read the checkpoint file from disk
    const checkpointPath = join(testDir, ".sigil", "runs", `${result.runId}.json`);
    const raw = await readFile(checkpointPath, "utf8");
    const saved = JSON.parse(raw) as {
      workflowName: string;
      status: string;
      completedNodes: string[];
    };

    expect(saved.workflowName).toBe("checkpoint-test");
    expect(saved.status).toBe("completed");
    expect(saved.completedNodes).toContain("nodeA");
  });
});
