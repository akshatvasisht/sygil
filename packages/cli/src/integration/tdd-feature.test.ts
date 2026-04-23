/**
 * Integration tests for the tdd-feature workflow template.
 *
 * These tests exercise the full scheduler + gate evaluator stack against
 * the actual tdd-feature.json template (for validation) and against a
 * simplified in-memory variant (for execution) so they do not depend on
 * external agent runtimes or OS-level script interpreters.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "../scheduler/index.js";
import { loadWorkflow } from "../utils/workflow.js";
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = pathResolve(__dirname, "../../templates/tdd-feature.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(nodeId: string): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter: "mock",
    startedAt: new Date(),
    _internal: null,
  };
}

function createMockMonitor(): WsMonitorServer & { events: Array<{ type: string }> } {
  const events: Array<{ type: string }> = [];

  const monitor = {
    events,
    emit(event: { type: string }) {
      events.push(event);
    },
    on() { /* no-op */ },
    off() { /* no-op */ },
    async start() { return 0; },
    async stop() { /* no-op */ },
    getPort() { return null; },
    setAdapterPool() {},
    onClientControl: undefined,
  } as unknown as WsMonitorServer & { events: Array<{ type: string }> };

  return monitor;
}

// Minimal no-op adapter.
function noopAdapter(resultOverride: Partial<NodeResult> = {}): AgentAdapter {
  return {
    name: "mock",
    async isAvailable() { return true; },
    async spawn(c) { return makeSession(c.role); },
    async resume(_c, s) { return s; },
    async *stream(): AsyncIterable<AgentEvent> { /* no events */ },
    async getResult() {
      return { output: "", exitCode: 0, durationMs: 1, ...resultOverride };
    },
    async kill() { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-int-${randomUUID()}`);
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

describe("tdd-feature template integration", () => {
  // -------------------------------------------------------------------------
  // 1. Validate the template
  // -------------------------------------------------------------------------

  it("loads and validates the template", async () => {
    const workflow = await loadWorkflow(TEMPLATE_PATH);

    expect(workflow.name).toBe("tdd-feature");
    expect(workflow.version).toBe("1");

    // Must contain the three expected nodes
    const nodeIds = Object.keys(workflow.nodes);
    expect(nodeIds).toContain("planner");
    expect(nodeIds).toContain("implementer");
    expect(nodeIds).toContain("reviewer");

    // All loop-back edges must declare maxRetries
    const loopBackEdges = workflow.edges.filter((e) => e.isLoopBack);
    expect(loopBackEdges.length).toBeGreaterThan(0);
    for (const edge of loopBackEdges) {
      expect(
        edge.maxRetries,
        `loop-back edge "${edge.id}" must declare maxRetries`
      ).toBeDefined();
      expect(typeof edge.maxRetries).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // 2. Run the full workflow with mock adapters
  //
  // We construct a workflow equivalent to tdd-feature but replace the
  // script-based gate conditions with file_exists + exit_code conditions
  // so the test runs without a real shell and without adapter runtimes.
  //
  // Scenario:
  //   - planner runs successfully
  //   - implementer runs: attempt 1 writes verdict.txt = "CHANGES_REQUESTED"
  //   - reviewer runs: loop-back gate sees CHANGES_REQUESTED → implementer retries
  //   - implementer runs: attempt 2 writes verdict.txt = "APPROVED"
  //   - reviewer runs again: loop-back gate sees no CHANGES_REQUESTED → forward to done
  //   - done runs successfully
  // -------------------------------------------------------------------------

  it("runs the full workflow with mock adapters", async () => {
    // Build an absolute outputDir for each node to keep gates predictable
    const planningDir = join(testDir, "planning");
    const srcDir = join(testDir, "src");
    const reviewDir = join(testDir, "review");

    await mkdir(planningDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await mkdir(reviewDir, { recursive: true });

    // Simplified tdd-feature workflow using file_exists + exit_code gates only
    const workflow: WorkflowGraph = {
      version: "1",
      name: "tdd-feature-mock",
      nodes: {
        planner: {
          adapter: "claude-sdk" as AdapterType,
          model: "test",
          role: "planner",
          prompt: "plan it",
          outputDir: planningDir,
        },
        implementer: {
          adapter: "codex" as AdapterType,
          model: "test",
          role: "implementer",
          prompt: "implement it",
          outputDir: srcDir,
        },
        reviewer: {
          adapter: "claude-sdk" as AdapterType,
          model: "test",
          role: "reviewer",
          prompt: "review it",
          outputDir: reviewDir,
        },
        done: {
          adapter: "claude-sdk" as AdapterType,
          model: "test",
          role: "done",
          prompt: "done",
          outputDir: reviewDir,
        },
      },
      edges: [
        {
          id: "planner-to-implementer",
          from: "planner",
          to: "implementer",
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
        {
          id: "implementer-to-reviewer",
          from: "implementer",
          to: "reviewer",
          gate: { conditions: [{ type: "exit_code", value: 0 }] },
        },
        // Loop-back: fire retry when verdict.txt does NOT exist
        // (exit_code gate with value 1 will fail since adapter always exits 0 —
        // actually we need a gate that fails to trigger retry on 1st pass)
        // We use file_exists for "review/approved.flag" — absent on first pass,
        // present on second, so:
        //   - 1st reviewer run: approved.flag absent → gate fails → retry
        //   - 2nd reviewer run: approved.flag present → gate passes → no retry
        {
          id: "reviewer-to-implementer-loop",
          from: "reviewer",
          to: "implementer",
          isLoopBack: true,
          maxRetries: 2,
          gate: {
            conditions: [
              { type: "file_exists", path: "approved.flag" },
            ],
          },
        },
        {
          id: "reviewer-to-done",
          from: "reviewer",
          to: "done",
          gate: {
            conditions: [
              { type: "file_exists", path: "approved.flag" },
            ],
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const loopBackEvents: Array<{ edgeId: string; attempt: number }> = [];
    let implementerCallCount = 0;

    // Per-node adapter implementations
    const adapters: Record<string, AgentAdapter> = {
      planner: noopAdapter(),
      implementer: {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          implementerCallCount++;
          return makeSession("implementer");
        },
        async resume(_c, s) {
          implementerCallCount++;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> { /* no-op */ },
        async getResult() {
          // On second call (retry), write the approved flag
          if (implementerCallCount >= 2) {
            await writeFile(join(reviewDir, "approved.flag"), "1", "utf8");
          }
          return { output: "implemented", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      },
      reviewer: noopAdapter(),
      done: noopAdapter(),
    };

    function adapterFactory(_type: AdapterType): AgentAdapter {
      // We differentiate by checking which adapter was requested per-node
      // The scheduler calls adapterFactory with the node's adapter type.
      // Since multiple nodes share the same type, we use a counter approach:
      // Return a routing adapter that delegates based on session.nodeId
      return {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(c) {
          const a = adapters[c.role];
          if (a) return a.spawn(c);
          return makeSession(c.role);
        },
        async resume(c, s, fb) {
          const a = adapters[c.role];
          if (a) return a.resume(c, s, fb);
          return s;
        },
        async *stream(s): AsyncIterable<AgentEvent> {
          // route by session.nodeId
          const a = adapters[s.nodeId];
          if (a) yield* a.stream(s);
        },
        async getResult(s) {
          const a = adapters[s.nodeId];
          if (a) return a.getResult(s);
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill(s) {
          const a = adapters[s.nodeId];
          if (a) await a.kill(s);
        },
      };
    }

    const scheduler = new WorkflowScheduler(
      workflow,
      adapterFactory,
      monitor as WsMonitorServer
    );

    scheduler.on("loop_back", (edgeId, attempt) => {
      loopBackEvents.push({ edgeId, attempt });
    });

    const result = await scheduler.run("int-run-full");

    // Workflow should complete successfully
    expect(result.success).toBe(true);

    // Implementer was called twice (once initial, once retry)
    expect(implementerCallCount).toBe(2);

    // loop_back event was emitted exactly once
    expect(loopBackEvents.length).toBe(1);
    expect(loopBackEvents[0]?.edgeId).toBe("reviewer-to-implementer-loop");
    expect(loopBackEvents[0]?.attempt).toBe(1);

    // Final run state is "completed"
    const stateFile = join(testDir, ".sygil", "runs", `${result.runId}.json`);
    const raw = await readFile(stateFile, "utf8");
    const state = JSON.parse(raw);
    expect(state.status).toBe("completed");

    // Monitor emits workflow_end with success
    const endEvent = monitor.events.find((e) => e.type === "workflow_end");
    expect(endEvent).toMatchObject({ type: "workflow_end", success: true });
  });

  // -------------------------------------------------------------------------
  // 3. Fails gracefully when a gate condition references a non-existent file
  // -------------------------------------------------------------------------

  it("fails gracefully when a gate script is not found", async () => {
    // Build a minimal two-node workflow where the forward gate uses a
    // file_exists condition pointing at a file that will never be created.
    const outputDir = join(testDir, "out");
    await mkdir(outputDir, { recursive: true });

    const workflow: WorkflowGraph = {
      version: "1",
      name: "tdd-missing-gate",
      nodes: {
        nodeA: {
          adapter: "claude-sdk" as AdapterType,
          model: "test",
          role: "nodeA",
          prompt: "do something",
          outputDir,
        },
        nodeB: {
          adapter: "claude-sdk" as AdapterType,
          model: "test",
          role: "nodeB",
          prompt: "finish",
          outputDir,
        },
      },
      edges: [
        {
          id: "a-to-b",
          from: "nodeA",
          to: "nodeB",
          gate: {
            // This file will never be created — gate always fails
            conditions: [{ type: "file_exists", path: "does-not-exist.txt" }],
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const adapter = noopAdapter({ exitCode: 0 });

    const scheduler = new WorkflowScheduler(
      workflow,
      () => adapter,
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("int-missing-gate");

    // Gate fails → nodeB goes into "failed" set → workflow fails
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // workflow_error and workflow_end(failure) are emitted — no unhandled throw
    const wsTypes = monitor.events.map((e) => e.type);
    expect(wsTypes).toContain("workflow_end");
    const endEvent = monitor.events.find((e) => e.type === "workflow_end");
    expect(endEvent).toMatchObject({ type: "workflow_end", success: false });
  });
});
