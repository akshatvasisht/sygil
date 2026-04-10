/**
 * WorkflowScheduler tests
 *
 * Each test creates its own workflow graph and temp directory so tests are
 * fully isolated. The mock WsMonitorServer records every emitted event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
  AdapterType,
} from "@sigil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal NodeConfig factory. */
function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test role",
    prompt: "test prompt",
    ...overrides,
  };
}

/** Minimal session factory. */
function makeSession(nodeId = "node"): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter: "mock",
    startedAt: new Date(),
    _internal: null,
  };
}

// ---------------------------------------------------------------------------
// MockAdapter factory
// ---------------------------------------------------------------------------

interface MockAdapterOptions {
  available?: boolean;
  events?: AgentEvent[];
  result?: Partial<NodeResult>;
  failOnSpawn?: boolean;
  spawnDelay?: number;
}

function createMockAdapter(options: MockAdapterOptions = {}): AgentAdapter {
  const {
    available = true,
    events = [],
    result = {},
    failOnSpawn = false,
    spawnDelay = 0,
  } = options;

  const adapter: AgentAdapter = {
    name: "mock",

    async isAvailable() {
      return available;
    },

    async spawn(config: NodeConfig) {
      if (spawnDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, spawnDelay));
      }
      if (failOnSpawn) {
        throw new Error("spawn failed");
      }
      return makeSession(config.role);
    },

    async resume(_config: NodeConfig, previousSession: AgentSession, _feedback: string) {
      return previousSession;
    },

    async *stream(_session: AgentSession): AsyncIterable<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },

    async getResult(_session: AgentSession): Promise<NodeResult> {
      return {
        output: "mock output",
        exitCode: 0,
        durationMs: 1,
        ...result,
      };
    },

    async kill(_session: AgentSession) {
      // no-op
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Mock WsMonitorServer
// ---------------------------------------------------------------------------

type MonitorEmit = Parameters<WsMonitorServer["emit"]>[0];

function createMockMonitor(): WsMonitorServer & { events: MonitorEmit[] } {
  const events: MonitorEmit[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter listener map requires any[] for mixed-type event arguments
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  const monitor = {
    events,
    emit(event: MonitorEmit) {
      events.push(event);
    },
    on(eventName: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName)!.add(listener);
    },
    off(eventName: string, listener: (...args: unknown[]) => void) {
      listeners.get(eventName)?.delete(listener);
    },
    async start() {
      return 0;
    },
    async stop() {
      // no-op
    },
    getPort() {
      return null;
    },
    onClientControl: undefined as WsMonitorServer["onClientControl"],
  } as unknown as WsMonitorServer & { events: MonitorEmit[] };

  return monitor;
}

// ---------------------------------------------------------------------------
// Workflow graph builders
// ---------------------------------------------------------------------------

function singleNodeWorkflow(): WorkflowGraph {
  return {
    version: "1",
    name: "single-node",
    nodes: {
      nodeA: makeNodeConfig(),
    },
    edges: [],
  };
}

function linearWorkflow(exitCode = 0): WorkflowGraph {
  return {
    version: "1",
    name: "linear",
    nodes: {
      nodeA: makeNodeConfig(),
      nodeB: makeNodeConfig(),
    },
    edges: [
      {
        id: "a-to-b",
        from: "nodeA",
        to: "nodeB",
        gate: {
          conditions: [{ type: "exit_code", value: exitCode }],
        },
      },
    ],
  };
}

function loopBackWorkflow(maxRetries = 2): WorkflowGraph {
  return {
    version: "1",
    name: "loop-back",
    nodes: {
      nodeA: makeNodeConfig(),
      nodeB: makeNodeConfig(),
    },
    edges: [
      {
        id: "a-to-b",
        from: "nodeA",
        to: "nodeB",
      },
      {
        id: "b-loop-to-b",
        from: "nodeB",
        to: "nodeB",
        isLoopBack: true,
        maxRetries,
        gate: {
          // Loop-back triggers retry when gate FAILS.
          // Gate expects exit_code 0. When nodeB returns exitCode 1, the gate
          // fails (1 ≠ 0) and the scheduler retries nodeB. When nodeB finally
          // returns exitCode 0, the gate passes and no retry is triggered.
          conditions: [{ type: "exit_code", value: 0 }],
        },
      },
    ],
  };
}

function parallelWorkflow(): WorkflowGraph {
  return {
    version: "1",
    name: "parallel",
    nodes: {
      nodeA: makeNodeConfig(),
      nodeB: makeNodeConfig(),
      merge: makeNodeConfig(),
    },
    edges: [
      { id: "a-to-merge", from: "nodeA", to: "merge" },
      { id: "b-to-merge", from: "nodeB", to: "merge" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test setup — temp dir for .sigil/runs checkpoints
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sigil-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// describe: single-node workflow
// ---------------------------------------------------------------------------

describe("WorkflowScheduler", () => {
  describe("single-node workflow", () => {
    it("executes a single node and completes", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
    });

    it("emits node_start, node_end, workflow_end events", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();

      const nodeStartEvents: string[] = [];
      const nodeEndEvents: string[] = [];

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => nodeStartEvents.push(nodeId));
      scheduler.on("node_end", (nodeId) => nodeEndEvents.push(nodeId));

      await scheduler.run("wf-1");

      expect(nodeStartEvents).toContain("nodeA");
      expect(nodeEndEvents).toContain("nodeA");

      const wsTypes = monitor.events.map((e) => e.type);
      expect(wsTypes).toContain("workflow_start");
      expect(wsTypes).toContain("node_start");
      expect(wsTypes).toContain("node_end");
      expect(wsTypes).toContain("workflow_end");
    });

    it("writes run state to .sigil/runs/ directory", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      const stateFile = join(testDir, ".sigil", "runs", `${result.runId}.json`);
      const raw = await readFile(stateFile, "utf8");
      const state = JSON.parse(raw);

      expect(state.id).toBe(result.runId);
      expect(state.status).toBe("completed");
      expect(state.completedNodes).toContain("nodeA");
    });

    it("handles node failure (adapter throws on spawn)", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ failOnSpawn: true });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const wsTypes = monitor.events.map((e) => e.type);
      expect(wsTypes).toContain("workflow_error");
    });
  });

  // -------------------------------------------------------------------------
  // describe: multi-node linear workflow
  // -------------------------------------------------------------------------

  describe("multi-node linear workflow", () => {
    it("executes nodes in topological order", async () => {
      const workflow = linearWorkflow(0);
      const monitor = createMockMonitor();
      const order: string[] = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => order.push(nodeId));

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      expect(order.indexOf("nodeA")).toBeLessThan(order.indexOf("nodeB"));
    });

    it("passes gate evaluation between nodes", async () => {
      const workflow = linearWorkflow(0); // gate expects exit_code 0
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);

      const gateEvents = monitor.events.filter((e) => e.type === "gate_eval");
      expect(gateEvents.length).toBeGreaterThan(0);
      expect(gateEvents[0]).toMatchObject({ type: "gate_eval", passed: true });
    });

    it("fails workflow when a forward edge gate fails", async () => {
      // Gate expects exit_code 0 but adapter returns exit_code 1
      const workflow = linearWorkflow(0);
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 1 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);

      const gateEvents = monitor.events.filter((e) => e.type === "gate_eval");
      expect(gateEvents.some((e) => "passed" in e && !e.passed)).toBe(true);
    });

    it("emits gate_eval events", async () => {
      const workflow = linearWorkflow(0);
      const monitor = createMockMonitor();
      const gateEvalEvents: Array<{ edgeId: string; passed: boolean }> = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("gate_eval", (edgeId, passed) => gateEvalEvents.push({ edgeId, passed }));

      await scheduler.run("wf-1");

      expect(gateEvalEvents.length).toBeGreaterThan(0);
      expect(gateEvalEvents[0]?.edgeId).toBe("a-to-b");
      expect(gateEvalEvents[0]?.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // describe: loop-back retries
  // -------------------------------------------------------------------------

  describe("loop-back retries", () => {
    it("re-runs a node when loop-back gate fails, up to maxRetries", async () => {
      // The loop-back gate expects exit_code 0.
      // - nodeB getResult() returns exitCode 1 on first two calls → gate fails → retry
      // - nodeB getResult() returns exitCode 0 on third call → gate passes → completes
      // On retry the scheduler calls adapter.resume() (not spawn), so we track
      // node_start events to count nodeB executions.
      const workflow = loopBackWorkflow(2);
      const monitor = createMockMonitor();

      let nodeBExecutions = 0;
      const nodeStartOrder: string[] = [];

      // The scheduler always calls adapterFactory(nodeConfig.adapter) to get an
      // adapter instance, then either spawn (fresh) or uses a pre-resumed session.
      // We use one shared adapter and track getResult calls.
      let getResultCallCount = 0;
      const sharedAdapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) { return makeSession(_c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> { /* no events */ },
        async getResult() {
          getResultCallCount++;
          // calls 1 = nodeA (exitCode 0)
          // calls 2,3 = nodeB attempts 1,2 (exitCode 1 → gate fails → retry)
          // call  4   = nodeB attempt 3    (exitCode 0 → gate passes → done)
          if (getResultCallCount === 1) return { output: "", exitCode: 0, durationMs: 1 };
          return { output: "", exitCode: getResultCallCount <= 3 ? 1 : 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(
        workflow,
        () => sharedAdapter,
        monitor as WsMonitorServer
      );

      scheduler.on("node_start", (nodeId) => {
        nodeStartOrder.push(nodeId);
        if (nodeId === "nodeB") nodeBExecutions++;
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      // nodeB should have been executed 3 times (initial + 2 retries)
      expect(nodeBExecutions).toBe(3);
    });

    it("fails the workflow when maxRetries is exceeded", async () => {
      // Loop-back gate expects exit_code 0. Adapter always returns exitCode 1,
      // so the gate always fails → retry fires every time.
      // maxRetries=1: after 2 nodeB executions (1 initial + 1 retry), the
      // retryCount exceeds maxRetries and the workflow fails.
      const workflow = loopBackWorkflow(1); // maxRetries = 1
      const monitor = createMockMonitor();

      const adapter = createMockAdapter({ result: { exitCode: 1 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      // The top-level error wraps node failures; the inner "exceeded maxRetries"
      // detail is emitted as a workflow_error event to the monitor.
      expect(result.error).toMatch(/node\(s\) failed/);
      const errorEvent = monitor.events.find(
        (e) => e.type === "workflow_error" && "message" in e && String(e.message).includes("exceeded maxRetries")
      );
      expect(errorEvent).toBeDefined();
    });

    it("emits loop_back events with correct attempt count", async () => {
      const workflow = loopBackWorkflow(1); // maxRetries = 1
      const monitor = createMockMonitor();
      const loopBackEvents: Array<{ edgeId: string; attempt: number; maxRetries: number }> = [];

      // exitCode 1 always — will trigger loop once then fail
      const adapter = createMockAdapter({ result: { exitCode: 1 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("loop_back", (edgeId, attempt, maxRetries) =>
        loopBackEvents.push({ edgeId, attempt, maxRetries })
      );

      await scheduler.run("wf-1");

      expect(loopBackEvents.length).toBeGreaterThan(0);
      expect(loopBackEvents[0]?.edgeId).toBe("b-loop-to-b");
      expect(loopBackEvents[0]?.attempt).toBe(1);
      expect(loopBackEvents[0]?.maxRetries).toBe(1);
    });

    it("calls adapter.resume() on retry with a pre-stored session", async () => {
      // The scheduler calls adapter.resume() after a loop-back when a previous
      // session is available in the session store.
      //
      // Sequence (loopBackWorkflow maxRetries=1, gate expects exit_code 0):
      //   getResult call 1 = nodeA   → exitCode 0 (nodeA has no gate, proceeds)
      //   getResult call 2 = nodeB   → exitCode 1 (gate fails → retry, resume() called)
      //   getResult call 3 = nodeB   → exitCode 0 (gate passes → no retry, done)
      const workflow = loopBackWorkflow(1);
      const monitor = createMockMonitor();

      let resumeCallCount = 0;
      let callCount = 0;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) { return makeSession(_c.role); },
        async resume(_c, s) {
          resumeCallCount++;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> { /* no events */ },
        async getResult() {
          callCount++;
          // call 1: nodeA → exitCode 0 (ungated edge, value irrelevant)
          // call 2: nodeB attempt 1 → exitCode 1 → gate (expects 0) fails → retry
          // call 3: nodeB attempt 2 → exitCode 0 → gate passes → complete
          if (callCount <= 2) return { output: "", exitCode: callCount === 1 ? 0 : 1, durationMs: 1 };
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      // resume() should have been called for the loop-back retry of nodeB
      expect(resumeCallCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // describe: rate limit handling
  // -------------------------------------------------------------------------

  describe("rate limit handling", () => {
    // Helper to robustly advance time, interleaving macro/microtasks with fake timer advancement
    const advanceThroughRateLimit = async () => {
      // Advance in 100ms increments for a total of 6 seconds (to cover 5000ms delay)
      for (let i = 0; i < 60; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
    };

    it("pauses execution when rate_limit error event is received and resumes after delay", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      // After a rate limit, the scheduler now calls adapter.resume() first (to preserve
      // conversation history), falling back to spawn() only if resume throws.
      // Track calls via a shared counter on the session state.
      let resumeCount = 0;
      let spawnCount = 0;
      const rateLimitMs = 5000;

      // Use a flag on the session to let stream() know it's past the rate limit
      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          spawnCount++;
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          resumeCount++;
          rateLimitHandled = true;
          return s;
        },
        async *stream(_s): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: `rate_limit:${rateLimitMs}` };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();

      const result = await runPromise;

      expect(result.success).toBe(true);
      // Scheduler should have called resume() to continue the conversation
      expect(resumeCount).toBe(1);
      // spawn() called only once (initial session)
      expect(spawnCount).toBe(1);
    });

    it("falls back to spawn when resume throws during rate limit recovery", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let spawnCount = 0;
      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          spawnCount++;
          return makeSession(_c.role);
        },
        async resume(_c, _s) {
          // Simulate adapters (e.g. claude-cli) that don't support resume
          throw new Error("resume not supported");
        },
        async *stream(_s): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            rateLimitHandled = true;
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      const result = await runPromise;

      expect(result.success).toBe(true);
      // spawn() should be called twice: initial + fallback after failed resume
      expect(spawnCount).toBe(2);
    });

    it("emits rate_limit monitor event", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          rateLimitHandled = true;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      await runPromise;

      const rateLimitEvents = monitor.events.filter((e) => e.type === "rate_limit");
      expect(rateLimitEvents.length).toBeGreaterThan(0);
    });

    it("does not count rate limit pauses as retries", async () => {
      vi.useFakeTimers();

      // Loop-back workflow but the rate limit happens during nodeA (no loop-back on nodeA)
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          rateLimitHandled = true;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      const result = await runPromise;

      expect(result.success).toBe(true);

      // retryCounters should be empty — rate limits don't count as retries
      const stateFile = join(testDir, ".sigil", "runs", `${result.runId}.json`);
      const raw = await readFile(stateFile, "utf8");
      const state = JSON.parse(raw);
      expect(Object.keys(state.retryCounters)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // describe: parallel execution
  // -------------------------------------------------------------------------

  describe("parallel execution", () => {
    it("executes independent nodes concurrently", async () => {
      // nodeA and nodeB are both start nodes (no incoming forward edges)
      const workflow: WorkflowGraph = {
        version: "1",
        name: "two-starts",
        nodes: {
          nodeA: makeNodeConfig(),
          nodeB: makeNodeConfig(),
        },
        edges: [],
      };

      const monitor = createMockMonitor();

      // Stagger start: nodeA takes 50ms, nodeB takes 10ms
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(c) {
          return makeSession(c.role);
        },
        async resume(_c, s) { return s; },
        async *stream(_s): AsyncIterable<AgentEvent> {
          // no-op
        },
        async getResult(_s) {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const nodeStartOrder: string[] = [];
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => {
        nodeStartOrder.push(nodeId);
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      // Both nodes should have started
      expect(nodeStartOrder).toContain("nodeA");
      expect(nodeStartOrder).toContain("nodeB");
    });

    it("waits for all parallel branches before advancing merge node", async () => {
      const workflow = parallelWorkflow();
      const monitor = createMockMonitor();
      const nodeEndOrder: string[] = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_end", (nodeId) => nodeEndOrder.push(nodeId));

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      // merge node must start after both nodeA and nodeB have completed
      const mergeIdx = nodeEndOrder.indexOf("merge");
      const aIdx = nodeEndOrder.indexOf("nodeA");
      const bIdx = nodeEndOrder.indexOf("nodeB");
      expect(aIdx).toBeLessThan(mergeIdx);
      expect(bIdx).toBeLessThan(mergeIdx);
    });
  });

  // -------------------------------------------------------------------------
  // describe: cancel
  // -------------------------------------------------------------------------

  describe("cancel", () => {
    it("stops execution when cancel() is called mid-run", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "cancel-test",
        nodes: {
          nodeA: makeNodeConfig(),
          nodeB: makeNodeConfig(),
        },
        edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
      };

      const monitor = createMockMonitor();
      let nodeBStarted = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(c) { return makeSession(c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> { /* nothing */ },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => {
        if (nodeId === "nodeA") {
          // Cancel before nodeB starts
          scheduler.cancel();
        }
        if (nodeId === "nodeB") {
          nodeBStarted = true;
        }
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cancel/i);
      expect(nodeBStarted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // describe: resume from checkpoint
  // -------------------------------------------------------------------------

  describe("resume from checkpoint", () => {
    it("skips already-completed nodes when resuming from a saved state", async () => {
      const workflow = linearWorkflow(0);
      const monitor = createMockMonitor();
      const nodesExecuted: string[] = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => nodesExecuted.push(nodeId));

      // Simulate a saved state where nodeA is already completed
      const savedState = {
        id: randomUUID(),
        workflowName: workflow.name,
        workflowPath: "",
        status: "running" as const,
        startedAt: new Date().toISOString(),
        completedNodes: ["nodeA"],
        nodeResults: {
          nodeA: { output: "cached", exitCode: 0, durationMs: 1 },
        },
        totalCostUsd: 0,
        retryCounters: {},
      };

      const result = await scheduler.resume(savedState);

      expect(result.success).toBe(true);
      // Only nodeB should have run, not nodeA
      expect(nodesExecuted).not.toContain("nodeA");
      expect(nodesExecuted).toContain("nodeB");
    });
  });

  // -------------------------------------------------------------------------
  // describe: completion-driven dispatch
  // -------------------------------------------------------------------------

  describe("completion-driven dispatch", () => {
    it("a fast node completing unlocks its dependent immediately, even if a slow sibling is still running", async () => {
      // Graph:
      //   A (fast, 10ms) ──→ C
      //   B (slow, 200ms) ──→ C
      // A and B are both start nodes. C depends on both.
      // But we also add a node D that depends only on A.
      // D should start as soon as A completes, without waiting for B.
      //
      //   A (fast) ──→ D
      //   A (fast) ──→ C
      //   B (slow) ──→ C
      //
      // Expected: D starts while B is still running.
      // Each node gets a unique role so the session factory can map back to nodeId
      const workflow: WorkflowGraph = {
        version: "1",
        name: "fast-unlock",
        nodes: {
          A: makeNodeConfig({ role: "role-A" }),
          B: makeNodeConfig({ role: "role-B" }),
          C: makeNodeConfig({ role: "role-C" }),
          D: makeNodeConfig({ role: "role-D" }),
        },
        edges: [
          { id: "a-to-d", from: "A", to: "D" },
          { id: "a-to-c", from: "A", to: "C" },
          { id: "b-to-c", from: "B", to: "C" },
        ],
      };

      const monitor = createMockMonitor();
      const nodeStartTimes = new Map<string, number>();
      const nodeEndTimes = new Map<string, number>();

      // Map role -> nodeId for session identification
      const roleToNodeId = new Map<string, string>();
      for (const [nodeId, config] of Object.entries(workflow.nodes)) {
        roleToNodeId.set(config.role, nodeId);
      }

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(c) {
          const nodeId = roleToNodeId.get(c.role) ?? "unknown";
          return {
            id: randomUUID(),
            nodeId,
            adapter: "mock",
            startedAt: new Date(),
            _internal: null,
          };
        },
        async resume(_c, s) { return s; },
        async *stream(session): AsyncIterable<AgentEvent> {
          // Introduce delay based on nodeId embedded in session
          const nodeId = session.nodeId;
          if (nodeId === "B") {
            await new Promise<void>((r) => setTimeout(r, 200));
          } else {
            await new Promise<void>((r) => setTimeout(r, 10));
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(
        workflow,
        () => adapter,
        monitor as WsMonitorServer
      );
      scheduler.on("node_start", (nodeId) => {
        nodeStartTimes.set(nodeId, Date.now());
      });
      scheduler.on("node_end", (nodeId) => {
        nodeEndTimes.set(nodeId, Date.now());
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);

      // D should have started before B ended
      const dStart = nodeStartTimes.get("D")!;
      const bEnd = nodeEndTimes.get("B")!;
      expect(dStart).toBeLessThan(bEnd);
    });

    it("concurrent dispatch still respects edge dependencies", async () => {
      // A -> B -> C (linear). Must execute in order.
      const workflow: WorkflowGraph = {
        version: "1",
        name: "respect-deps",
        nodes: {
          A: makeNodeConfig(),
          B: makeNodeConfig(),
          C: makeNodeConfig(),
        },
        edges: [
          { id: "a-to-b", from: "A", to: "B" },
          { id: "b-to-c", from: "B", to: "C" },
        ],
      };

      const monitor = createMockMonitor();
      const order: string[] = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_end", (nodeId) => order.push(nodeId));

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      expect(order).toEqual(["A", "B", "C"]);
    });

    it("terminates correctly when all nodes complete", async () => {
      // Wide graph: A, B, C, D all independent
      const workflow: WorkflowGraph = {
        version: "1",
        name: "all-parallel",
        nodes: {
          A: makeNodeConfig(),
          B: makeNodeConfig(),
          C: makeNodeConfig(),
          D: makeNodeConfig(),
        },
        edges: [],
      };

      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);

      // All four nodes should have completed
      const nodeEndEvents = monitor.events.filter((e) => e.type === "node_end");
      expect(nodeEndEvents).toHaveLength(4);
    });
  });

  // -------------------------------------------------------------------------
  // describe: critical-path priority scheduling
  // -------------------------------------------------------------------------

  describe("critical-path priority scheduling", () => {
    it("dispatches higher critical-path-weight nodes first among ready nodes", async () => {
      // Graph: A -> C, B -> C (A and B are both start nodes)
      // Add D -> E chain to make one path longer.
      // A -> D -> E -> C and B -> C
      // Critical path weights: E=2, D=3, A=4, B=2
      // So A should start before B (higher weight).
      //
      // Actually, simpler test: just verify ordering.
      // A -> C -> D (chain of 3)
      // B -> D (chain of 2 to D)
      // A weight=3, B weight=2. Both are start nodes.
      // A should dispatch before B.
      const workflow: WorkflowGraph = {
        version: "1",
        name: "priority",
        nodes: {
          A: makeNodeConfig(),
          B: makeNodeConfig(),
          C: makeNodeConfig(),
          D: makeNodeConfig(),
        },
        edges: [
          { id: "a-to-c", from: "A", to: "C" },
          { id: "c-to-d", from: "C", to: "D" },
          { id: "b-to-d", from: "B", to: "D" },
        ],
      };

      const monitor = createMockMonitor();
      const startOrder: string[] = [];

      // Use a slow adapter to ensure ordering is visible
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(c) { return makeSession(c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> {
          await new Promise<void>((r) => setTimeout(r, 5));
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      scheduler.on("node_start", (nodeId) => startOrder.push(nodeId));

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      // A (weight 3) should start before B (weight 2) among the initial ready set
      expect(startOrder.indexOf("A")).toBeLessThan(startOrder.indexOf("B"));
    });
  });

  // -------------------------------------------------------------------------
  // describe: pause/resume cycle
  // -------------------------------------------------------------------------

  describe("pause/resume cycle", () => {
    it("pauses between nodes and resumes when resumeExecution is called", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "pause-test",
        nodes: {
          nodeA: makeNodeConfig(),
          nodeB: makeNodeConfig(),
        },
        edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
      };

      const monitor = createMockMonitor();
      const nodeStartOrder: string[] = [];

      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      scheduler.on("node_start", (nodeId) => {
        nodeStartOrder.push(nodeId);
      });

      scheduler.on("node_end", (nodeId) => {
        if (nodeId === "nodeA") {
          // Pause after nodeA completes — nodeB should wait
          scheduler.pause();
          // Resume after a short delay
          setTimeout(() => scheduler.resumeExecution(), 50);
        }
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      expect(nodeStartOrder).toContain("nodeA");
      expect(nodeStartOrder).toContain("nodeB");

      // Verify workflow completed successfully
      const endEvents = monitor.events.filter(
        (e) => e.type === "workflow_end" && "success" in e && e.success === true
      );
      expect(endEvents).toHaveLength(1);
    });

    it("cancel during pause resolves the pause and fails the workflow", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "cancel-pause-test",
        nodes: {
          nodeA: makeNodeConfig(),
          nodeB: makeNodeConfig(),
        },
        edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
      };

      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      scheduler.on("node_end", (nodeId) => {
        if (nodeId === "nodeA") {
          scheduler.pause();
          // Cancel while paused
          setTimeout(() => scheduler.cancel(), 30);
        }
      });

      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cancel/i);
    });
  });

  // -------------------------------------------------------------------------
  // describe: error propagation from adapter failures
  // -------------------------------------------------------------------------

  describe("error propagation from adapter failures", () => {
    it("fails workflow when adapter.stream throws an error", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) { return makeSession(_c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> {
          throw new Error("stream exploded");
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const errorEvents = monitor.events.filter((e) => e.type === "workflow_error");
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it("fails workflow when adapter.getResult throws an error", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) { return makeSession(_c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> {
          // stream completes normally
        },
        async getResult() {
          throw new Error("getResult failed");
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("propagates cost tracking across multiple nodes", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "cost-tracking",
        nodes: {
          nodeA: makeNodeConfig(),
          nodeB: makeNodeConfig(),
        },
        edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
      };

      const monitor = createMockMonitor();

      let callCount = 0;
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) { return makeSession(_c.role); },
        async resume(_c, s) { return s; },
        async *stream(): AsyncIterable<AgentEvent> { /* no events */ },
        async getResult() {
          callCount++;
          return {
            output: "",
            exitCode: 0,
            durationMs: 1,
            costUsd: callCount === 1 ? 0.03 : 0.07,
          };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-1");

      expect(result.success).toBe(true);
      expect(result.totalCostUsd).toBeCloseTo(0.10, 2);
    });
  });
});
