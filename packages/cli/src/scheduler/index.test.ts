/**
 * WorkflowScheduler tests
 *
 * Each test creates its own workflow graph and temp directory so tests are
 * fully isolated. The mock WsMonitorServer records every emitted event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
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
} from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import {
  makeNodeConfig,
  makeSession,
  createMockAdapter,
  createMockMonitor,
  singleNodeWorkflow,
  linearWorkflow,
  loopBackWorkflow,
  parallelWorkflow,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Test setup — temp dir for .sygil/runs checkpoints
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-test-${randomUUID()}`);
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

    it("writes run state to .sygil/runs/ directory", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      const result = await scheduler.run("wf-1");

      const stateFile = join(testDir, ".sygil", "runs", `${result.runId}.json`);
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

    // Regression: every workflow-scoped WsServerEvent must carry the
    // workflowId the caller passed, so the fanout filter (which matches
    // against the web monitor's `subscribe { workflowId }` slug) admits them.
    // Previously run.ts passed the filesystem path while the monitor URL used
    // workflow.name — socket opened, UI claimed "connected", zero events rendered.
    it("stamps all workflow-scoped events with the caller-supplied workflowId", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

      await scheduler.run("my-workflow-name");

      const workflowScoped = monitor.events.filter(
        (e) => "workflowId" in e
      ) as { workflowId: string }[];
      expect(workflowScoped.length).toBeGreaterThan(0);
      for (const e of workflowScoped) {
        expect(e.workflowId).toBe("my-workflow-name");
      }
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
      const stateFile = join(testDir, ".sygil", "runs", `${result.runId}.json`);
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
        sharedContext: {},
      };

      const result = await scheduler.resume(savedState);

      expect(result.success).toBe(true);
      // Only nodeB should have run, not nodeA
      expect(nodesExecuted).not.toContain("nodeA");
      expect(nodesExecuted).toContain("nodeB");
    });

    // Regression: resume() used to stamp workflowId = savedState.id
    // (a UUID), which never matched the web monitor's `subscribe` slug
    // (workflow.name). Every resumed workflow appeared blank in the UI.
    it("uses workflowName as workflowId on resume", async () => {
      const workflow = linearWorkflow(0);
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({ result: { exitCode: 0 } });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);

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
        sharedContext: {},
      };

      await scheduler.resume(savedState);

      const workflowScoped = monitor.events.filter(
        (e) => "workflowId" in e
      ) as { workflowId: string }[];
      expect(workflowScoped.length).toBeGreaterThan(0);
      for (const e of workflowScoped) {
        expect(e.workflowId).toBe(workflow.name);
        expect(e.workflowId).not.toBe(savedState.id);
      }
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

  // -------------------------------------------------------------------------
  // describe: provider-failover routing
  // -------------------------------------------------------------------------

  describe("provider-failover routing", () => {
    function failoverWorkflow(
      primary: AdapterType,
      fallback: AdapterType,
    ): WorkflowGraph {
      return {
        version: "1",
        name: "failover",
        nodes: {
          nodeA: makeNodeConfig({
            adapter: primary,
            providers: [
              { adapter: primary, priority: 0 },
              { adapter: fallback, priority: 1 },
            ],
          }),
        },
        edges: [],
      };
    }

    it("falls over to the next provider when the primary throws a transport error", async () => {
      const workflow = failoverWorkflow("claude-sdk", "claude-cli");
      const monitor = createMockMonitor();

      const primary = createMockAdapter({ failOnSpawn: false });
      // Override spawn to throw ECONNREFUSED
      primary.spawn = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "fb" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-fo-1");

      expect(result.success).toBe(true);

      // Assert the adapter_failover event was emitted
      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const failoverEvent = nodeEvents.find((e) => e.event.type === "adapter_failover");
      expect(failoverEvent).toBeDefined();
      if (failoverEvent && failoverEvent.event.type === "adapter_failover") {
        expect(failoverEvent.event.fromAdapter).toBe("claude-sdk");
        expect(failoverEvent.event.toAdapter).toBe("claude-cli");
        expect(failoverEvent.event.reason).toBe("transport");
      }
    });

    it("falls over when the primary emits a rate_limit:<ms> error and a fallback exists", async () => {
      const workflow = failoverWorkflow("claude-sdk", "echo");
      const monitor = createMockMonitor();

      const primary = createMockAdapter({
        events: [{ type: "error", message: "rate_limit:1" }],
      });
      const fallback = createMockAdapter({ result: { exitCode: 0 } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-fo-2");

      expect(result.success).toBe(true);

      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const failoverEvent = nodeEvents.find((e) => e.event.type === "adapter_failover");
      expect(failoverEvent).toBeDefined();
      if (failoverEvent && failoverEvent.event.type === "adapter_failover") {
        expect(failoverEvent.event.reason).toBe("rate_limit");
      }
    });

    it("does NOT fail over on a deterministic (non-retryable) error", async () => {
      const workflow = failoverWorkflow("claude-sdk", "echo");
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      primary.spawn = async () => {
        throw new Error("Invalid prompt: bad input");
      };
      const fallback = createMockAdapter({ result: { exitCode: 0 } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-fo-3");

      expect(result.success).toBe(false);

      // No adapter_failover event should have been emitted
      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const failoverEvent = nodeEvents.find((e) => e.event.type === "adapter_failover");
      expect(failoverEvent).toBeUndefined();
    });

    it("fails the node after exhausting all providers with retryable errors", async () => {
      const workflow = failoverWorkflow("claude-sdk", "claude-cli");
      const monitor = createMockMonitor();

      const makeBrokenAdapter = () => {
        const a = createMockAdapter();
        a.spawn = async () => {
          throw new Error("HTTP 503 Service Unavailable");
        };
        return a;
      };

      const primary = makeBrokenAdapter();
      const fallback = makeBrokenAdapter();
      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-fo-4");

      expect(result.success).toBe(false);

      // Exactly one failover event (primary → fallback); the second failure has no next provider.
      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const failovers = nodeEvents.filter((e) => e.event.type === "adapter_failover");
      expect(failovers).toHaveLength(1);
    });

    it("stays on the legacy single-adapter path when `providers` is not set", async () => {
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      adapter.spawn = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      };
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-fo-5");

      expect(result.success).toBe(false);

      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const failovers = nodeEvents.filter((e) => e.event.type === "adapter_failover");
      expect(failovers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // describe: retry policy
  // -------------------------------------------------------------------------

  describe("retry policy", () => {
    /**
     * Single-node workflow where the node's spawn throws `transportError` on
     * the first `failUntilAttempt - 1` calls, then returns a healthy session.
     * Exposes `spawnCount` for assertions.
     */
    function makeFlakyAdapter(
      failUntilAttempt: number,
      transportError: () => Error,
    ): AgentAdapter & { spawnCount: number } {
      const base = createMockAdapter({ result: { exitCode: 0, output: "ok" } });
      let spawnCount = 0;
      const wrapped = {
        ...base,
        async spawn(config: NodeConfig) {
          spawnCount++;
          if (spawnCount < failUntilAttempt) {
            throw transportError();
          }
          return base.spawn(config);
        },
        get spawnCount() {
          return spawnCount;
        },
      } as AgentAdapter & { spawnCount: number };
      return wrapped;
    }

    function retryNodeWorkflow(retryPolicy: NodeConfig["retryPolicy"]): WorkflowGraph {
      return {
        version: "1",
        name: "retry",
        nodes: {
          nodeA: makeNodeConfig({
            ...(retryPolicy !== undefined ? { retryPolicy } : {}),
          }),
        },
        edges: [],
      };
    }

    it("retries a retryable error and succeeds within maxAttempts", async () => {
      const workflow = retryNodeWorkflow({
        maxAttempts: 3,
        initialDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 10,
      });
      const monitor = createMockMonitor();

      const adapter = makeFlakyAdapter(3, () =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        }),
      );

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-1");

      expect(result.success).toBe(true);
      expect(adapter.spawnCount).toBe(3);

      const retryEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
      );
      expect(retryEvents).toHaveLength(2);
      if (retryEvents[0] && retryEvents[0].event.type === "retry_scheduled") {
        expect(retryEvents[0].event.attempt).toBe(1);
        expect(retryEvents[0].event.nextAttempt).toBe(2);
        expect(retryEvents[0].event.reason).toBe("transport");
        expect(retryEvents[0].event.delayMs).toBeGreaterThanOrEqual(1);
      }
    });

    it("fails the node when retries are exhausted", async () => {
      const workflow = retryNodeWorkflow({
        maxAttempts: 2,
        initialDelayMs: 1,
        backoffMultiplier: 1,
        maxDelayMs: 1,
      });
      const monitor = createMockMonitor();

      const adapter = makeFlakyAdapter(Number.POSITIVE_INFINITY, () =>
        Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" }),
      );

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-2");

      expect(result.success).toBe(false);
      expect(adapter.spawnCount).toBe(2); // maxAttempts reached

      const retryEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
      );
      expect(retryEvents).toHaveLength(1); // one retry before giving up
    });

    it("does NOT retry errors that aren't in retryableErrors whitelist", async () => {
      const workflow = retryNodeWorkflow({
        maxAttempts: 5,
        initialDelayMs: 1,
        backoffMultiplier: 1,
        maxDelayMs: 1,
        retryableErrors: ["server_5xx"], // excludes transport
      });
      const monitor = createMockMonitor();

      const adapter = makeFlakyAdapter(Number.POSITIVE_INFINITY, () =>
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-3");

      expect(result.success).toBe(false);
      expect(adapter.spawnCount).toBe(1); // no retries

      const retryEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
      );
      expect(retryEvents).toHaveLength(0);
    });

    it("does NOT retry deterministic (non-retryable) errors", async () => {
      const workflow = retryNodeWorkflow({
        maxAttempts: 5,
        initialDelayMs: 1,
        backoffMultiplier: 1,
        maxDelayMs: 1,
      });
      const monitor = createMockMonitor();

      const adapter = makeFlakyAdapter(Number.POSITIVE_INFINITY, () =>
        new Error("Invalid prompt"),
      );

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-4");

      expect(result.success).toBe(false);
      expect(adapter.spawnCount).toBe(1);

      const retryEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
      );
      expect(retryEvents).toHaveLength(0);
    });

    it("composes retry with provider failover: exhausted retries fall over to next provider", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "retry-failover",
        nodes: {
          nodeA: makeNodeConfig({
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
            retryPolicy: {
              maxAttempts: 2,
              initialDelayMs: 1,
              backoffMultiplier: 1,
              maxDelayMs: 1,
            },
          }),
        },
        edges: [],
      };
      const monitor = createMockMonitor();

      const primary = makeFlakyAdapter(Number.POSITIVE_INFINITY, () =>
        new Error("HTTP 503 Service Unavailable"),
      );
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "fb" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-5");

      expect(result.success).toBe(true);
      // Primary spawn attempted maxAttempts times, then failover.
      expect(primary.spawnCount).toBe(2);

      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const retries = nodeEvents.filter((e) => e.event.type === "retry_scheduled");
      const failovers = nodeEvents.filter((e) => e.event.type === "adapter_failover");
      expect(retries).toHaveLength(1);
      expect(failovers).toHaveLength(1);
    });

    it("emits retry_scheduled.delayMs within [base, maxDelayMs]", async () => {
      // Low-level determinism of delayMs is covered in retry-policy.test.ts.
      // Here we verify the scheduler-emitted events carry sensible values.
      const workflow = retryNodeWorkflow({
        maxAttempts: 4,
        initialDelayMs: 5,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      });

      const monitor = createMockMonitor();
      const adapter = makeFlakyAdapter(4, () =>
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );
      const scheduler = new WorkflowScheduler(
        workflow,
        () => adapter,
        monitor as WsMonitorServer,
      );
      await scheduler.run("wf-retry-6");

      const retries = monitor.events
        .filter((e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
        )
        .map((e) => (e.event.type === "retry_scheduled" ? e.event.delayMs : 0));

      expect(retries).toHaveLength(3);
      for (const d of retries) {
        expect(d).toBeGreaterThanOrEqual(5);
        expect(d).toBeLessThanOrEqual(100);
      }
    });

    it("legacy single-attempt behaviour: no retryPolicy means one attempt", async () => {
      const workflow = retryNodeWorkflow(undefined);
      const monitor = createMockMonitor();

      const adapter = makeFlakyAdapter(Number.POSITIVE_INFINITY, () =>
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-retry-7");

      expect(result.success).toBe(false);
      expect(adapter.spawnCount).toBe(1);

      const retryEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "retry_scheduled",
      );
      expect(retryEvents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // describe: circuit breaker
  // -------------------------------------------------------------------------

  describe("circuit breaker", () => {
    function cbFailoverWorkflow(): WorkflowGraph {
      return {
        version: "1",
        name: "cb-failover",
        nodes: {
          nodeA: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
        },
        edges: [],
      };
    }

    it("emits circuit_breaker WsServerEvents via the monitor when the breaker trips", async () => {
      const workflow = cbFailoverWorkflow();
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      primary.spawn = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      // Tight breaker: trip on the first failure so a single failing node
      // exercises the full transition.
      const result = await scheduler.run("wf-cb-1", {}, {
        pool: {
          maxConcurrency: 5,
          circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 60_000 },
        },
      });

      expect(result.success).toBe(true);

      // The monitor should have seen a circuit_breaker event with state "open"
      // for the failing adapter.
      const cbEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "circuit_breaker" }> =>
          e.type === "circuit_breaker",
      );
      expect(cbEvents.length).toBeGreaterThanOrEqual(1);
      expect(cbEvents[0]?.adapterType).toBe("claude-sdk");
      expect(cbEvents[0]?.state).toBe("open");
    });

    it("fails a subsequent node fast via CircuitOpenError and fails over to the next provider", async () => {
      // Two nodes fanning out, same providers list, so the 2nd node acquires
      // after the 1st has already tripped the breaker.
      const workflow: WorkflowGraph = {
        version: "1",
        name: "cb-fanout",
        nodes: {
          nodeA: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
          nodeB: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
        },
        edges: [],
      };
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      let primarySpawnCount = 0;
      primary.spawn = async () => {
        primarySpawnCount++;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-cb-2", {}, {
        pool: {
          maxConcurrency: 5,
          circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 60_000 },
        },
      });

      expect(result.success).toBe(true);
      // Primary attempted on node A (1 call). Once breaker opens, node B's
      // acquire fails fast WITHOUT calling spawn on the primary. So total
      // primary spawns is exactly 1.
      expect(primarySpawnCount).toBe(1);

      // Both nodes completed via the fallback.
      const nodeEnds = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_end" }> => e.type === "node_end",
      );
      expect(nodeEnds).toHaveLength(2);
      expect(nodeEnds.every((e) => e.result.exitCode === 0)).toBe(true);

      // An adapter_failover event was emitted for each node (primary → fallback).
      const failovers = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "adapter_failover",
      );
      expect(failovers).toHaveLength(2);
    });

    it("does not trip the breaker when the pool is created without circuitBreaker config", async () => {
      const workflow = cbFailoverWorkflow();
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      primary.spawn = async () => {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-cb-3", {}, {
        pool: { maxConcurrency: 5 }, // no circuitBreaker
      });

      expect(result.success).toBe(true);
      const cbEvents = monitor.events.filter((e) => e.type === "circuit_breaker");
      expect(cbEvents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // describe: sharedContext
  // -------------------------------------------------------------------------

  describe("sharedContext", () => {
    it("writes allowlisted context_set keys through to runState", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-write",
        nodes: {
          writer: makeNodeConfig({
            prompt: "write context",
            writesContext: ["summary", "count"],
          }),
        },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({
        events: [
          { type: "context_set", key: "summary", value: "hello" },
          { type: "context_set", key: "count", value: 42 },
        ],
      });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-ctx-1");

      expect(result.success).toBe(true);
      const ctxEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "context_set",
      );
      expect(ctxEvents).toHaveLength(2);
    });

    it("rejects context_set for keys not in writesContext and emits an error event", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-reject",
        nodes: {
          writer: makeNodeConfig({
            prompt: "unauthorised",
            writesContext: ["allowed_key"],
          }),
        },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({
        events: [
          { type: "context_set", key: "allowed_key", value: "ok" },
          { type: "context_set", key: "forbidden_key", value: "nope" },
        ],
      });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      await scheduler.run("wf-ctx-2");

      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      const contextSets = nodeEvents.filter((e) => e.event.type === "context_set");
      const errors = nodeEvents.filter(
        (e) => e.event.type === "error" && e.event.message.includes("forbidden_key"),
      );
      expect(contextSets).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });

    it("drops context_set entirely when node has no writesContext allowlist", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-no-allowlist",
        nodes: {
          writer: makeNodeConfig({ prompt: "no allowlist" }),
        },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter({
        events: [{ type: "context_set", key: "anything", value: 1 }],
      });
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      await scheduler.run("wf-ctx-3");

      const nodeEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> => e.type === "node_event",
      );
      expect(nodeEvents.filter((e) => e.event.type === "context_set")).toHaveLength(0);
      expect(
        nodeEvents.filter((e) => e.event.type === "error" && e.event.message.includes("anything")),
      ).toHaveLength(1);
    });

    it("interpolates {{ctx.<key>}} in downstream prompts", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-read",
        nodes: {
          writer: makeNodeConfig({
            prompt: "writer",
            writesContext: ["summary"],
          }),
          reader: makeNodeConfig({
            prompt: "Please process: {{ctx.summary}}",
            readsContext: ["summary"],
          }),
        },
        edges: [{ id: "e1", from: "writer", to: "reader" }],
      };

      const capturedPrompts: string[] = [];
      const monitor = createMockMonitor();
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(config: NodeConfig) {
          capturedPrompts.push(config.prompt);
          return makeSession(config.role);
        },
        async resume(_c: NodeConfig, s: AgentSession) { return s; },
        async *stream(_s: AgentSession): AsyncIterable<AgentEvent> {
          if (capturedPrompts.length === 1) {
            yield { type: "context_set", key: "summary", value: "GREETING" };
          }
        },
        async getResult(): Promise<NodeResult> {
          return { output: "ok", exitCode: 0, durationMs: 1 };
        },
        async kill() {},
      };
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-ctx-4");

      expect(result.success).toBe(true);
      expect(capturedPrompts[1]).toBe("Please process: GREETING");
    });

    it("interpolates missing ctx keys as empty string", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-missing",
        nodes: {
          reader: makeNodeConfig({
            prompt: "value=[{{ctx.absent}}]",
            readsContext: ["absent"],
          }),
        },
        edges: [],
      };
      const captured: string[] = [];
      const monitor = createMockMonitor();
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(config: NodeConfig) { captured.push(config.prompt); return makeSession(config.role); },
        async resume(_c: NodeConfig, s: AgentSession) { return s; },
        async *stream(): AsyncIterable<AgentEvent> {},
        async getResult(): Promise<NodeResult> {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() {},
      };
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      await scheduler.run("wf-ctx-5");
      expect(captured[0]).toBe("value=[]");
    });

    it("serialises non-string context values as JSON for interpolation", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "ctx-json",
        nodes: {
          writer: makeNodeConfig({ prompt: "w", writesContext: ["obj"] }),
          reader: makeNodeConfig({
            prompt: "got: {{ctx.obj}}",
            readsContext: ["obj"],
          }),
        },
        edges: [{ id: "e1", from: "writer", to: "reader" }],
      };
      const captured: string[] = [];
      const monitor = createMockMonitor();
      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(config: NodeConfig) { captured.push(config.prompt); return makeSession(config.role); },
        async resume(_c: NodeConfig, s: AgentSession) { return s; },
        async *stream(): AsyncIterable<AgentEvent> {
          if (captured.length === 1) {
            yield { type: "context_set", key: "obj", value: { a: 1, b: ["x"] } };
          }
        },
        async getResult(): Promise<NodeResult> {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() {},
      };
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      await scheduler.run("wf-ctx-6");
      expect(captured[1]).toBe('got: {"a":1,"b":["x"]}');
    });
  });

  // -------------------------------------------------------------------------
  // describe: lifecycle hooks
  // -------------------------------------------------------------------------

  describe("lifecycle hooks", () => {
    async function writeHookScript(name: string, body: string): Promise<string> {
      const path = join(process.cwd(), name);
      await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, "utf8");
      await chmod(path, 0o755);
      return name;
    }

    it("runs preNode and postNode hooks and records hook_result events", async () => {
      await writeHookScript("pre.sh", "exit 0");
      await writeHookScript("post.sh", "exit 0");
      const workflow: WorkflowGraph = {
        version: "1",
        name: "hooks-basic",
        nodes: { a: makeNodeConfig() },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-h1", {}, {
        hooks: { preNode: "pre.sh", postNode: "post.sh" },
      });

      expect(result.success).toBe(true);

      const hookEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "hook_result",
      );
      expect(hookEvents).toHaveLength(2);
      const hookTypes = hookEvents.map((e) =>
        e.event.type === "hook_result" ? e.event.hook : null,
      );
      expect(hookTypes).toEqual(["preNode", "postNode"]);
    });

    it("aborts the node when preNode exits non-zero", async () => {
      await writeHookScript("fail.sh", "echo 'nope' >&2\nexit 2");
      const workflow: WorkflowGraph = {
        version: "1",
        name: "hooks-abort",
        nodes: { a: makeNodeConfig() },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-h2", {}, {
        hooks: { preNode: "fail.sh" },
      });

      expect(result.success).toBe(false);

      // per-node error emitted on monitor carries the hook's failure reason
      const workflowErrors = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "workflow_error" }> => e.type === "workflow_error",
      );
      expect(workflowErrors.some((e) => e.message.includes("preNode hook failed"))).toBe(true);

      // preNode hook_result was recorded
      const hookEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "hook_result",
      );
      expect(hookEvents).toHaveLength(1);
      if (hookEvents[0]?.event.type === "hook_result") {
        expect(hookEvents[0].event.hook).toBe("preNode");
        expect(hookEvents[0].event.exitCode).toBe(2);
      }

      // No adapter.spawn happened — the node never started
      const startEvents = monitor.events.filter((e) => e.type === "node_start");
      expect(startEvents).toHaveLength(0);
    });

    it("runs preGate and postGate around gate evaluation", async () => {
      await writeHookScript("pre-gate.sh", "exit 0");
      await writeHookScript("post-gate.sh", "exit 0");
      const workflow: WorkflowGraph = {
        version: "1",
        name: "hooks-gates",
        nodes: {
          a: makeNodeConfig(),
          b: makeNodeConfig(),
        },
        edges: [
          {
            id: "e1",
            from: "a",
            to: "b",
            gate: { conditions: [{ type: "exit_code", value: 0 }] },
          },
        ],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      await scheduler.run("wf-h3", {}, {
        hooks: { preGate: "pre-gate.sh", postGate: "post-gate.sh" },
      });

      const hookEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "hook_result",
      );
      const gateHooks = hookEvents
        .map((e) => (e.event.type === "hook_result" ? e.event.hook : null))
        .filter((h) => h === "preGate" || h === "postGate");
      expect(gateHooks).toEqual(["preGate", "postGate"]);
    });

    it("no-ops when hooks option is omitted", async () => {
      const workflow: WorkflowGraph = {
        version: "1",
        name: "hooks-none",
        nodes: { a: makeNodeConfig() },
        edges: [],
      };
      const monitor = createMockMonitor();
      const adapter = createMockAdapter();
      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-h4");
      expect(result.success).toBe(true);
      const hookEvents = monitor.events.filter(
        (e) => e.type === "node_event" && e.event.type === "hook_result",
      );
      expect(hookEvents).toHaveLength(0);
    });
  });
});
