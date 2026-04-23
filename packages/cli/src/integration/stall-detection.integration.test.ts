/**
 * Integration tests for stall detection, kill, and checkpoint working together
 * through the WorkflowScheduler.
 *
 * These tests use real async timing (no fake timers) because the scheduler's
 * stall detection is driven by real setTimeout/setInterval internally.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  WsServerEvent,
} from "@sygil/shared";
import { STALL_EXIT_CODE } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import {
  createMockMonitor,
  linearWorkflow,
  singleNodeWorkflow,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-stall-integ-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock adapter builders
// ---------------------------------------------------------------------------

// Adapter whose stream emits text_delta then a stall event.
function createStallAdapter(nodeId = "test"): AgentAdapter {
  return {
    name: "stall-mock",
    async isAvailable() { return true; },
    async spawn(config: NodeConfig): Promise<AgentSession> {
      return {
        id: randomUUID(),
        nodeId: config.prompt.slice(0, 20),
        adapter: "stall-mock",
        startedAt: new Date(),
        _internal: null,
      };
    },
    async resume(_c: NodeConfig, prev: AgentSession, _f: string) { return prev; },
    async *stream(): AsyncIterable<AgentEvent> {
      yield { type: "text_delta", text: "working..." };
      yield { type: "stall", reason: "no progress for 60s" };
    },
    async getResult(): Promise<{ output: string; exitCode: number; durationMs: number }> {
      return { output: "", exitCode: STALL_EXIT_CODE, durationMs: 100 };
    },
    async kill() {},
  };
}

// Adapter that streams slowly with real async delays (for cancel test).
function createSlowAdapter(killCalls: AgentSession[]): AgentAdapter {
  return {
    name: "slow-mock",
    async isAvailable() { return true; },
    async spawn(config: NodeConfig): Promise<AgentSession> {
      return {
        id: randomUUID(),
        nodeId: config.prompt.slice(0, 20),
        adapter: "slow-mock",
        startedAt: new Date(),
        _internal: null,
      };
    },
    async resume(_c: NodeConfig, prev: AgentSession, _f: string) { return prev; },
    async *stream(): AsyncIterable<AgentEvent> {
      // Yield events slowly so the scheduler has time to receive a cancel()
      for (let i = 0; i < 100; i++) {
        yield { type: "text_delta", text: `chunk-${i}` };
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    async getResult(): Promise<{ output: string; exitCode: number; durationMs: number }> {
      return { output: "done", exitCode: 0, durationMs: 500 };
    },
    async kill(session: AgentSession) {
      killCalls.push(session);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stall detection integration", () => {
  it("stall event from adapter causes node failure with STALL_EXIT_CODE", async () => {
    const workflow = singleNodeWorkflow("nodeA");
    const monitor = createMockMonitor();
    const stallAdapter = createStallAdapter("nodeA");
    const scheduler = new WorkflowScheduler(workflow, () => stallAdapter, monitor as WsMonitorServer);

    const result = await scheduler.run("wf-stall-1");

    expect(result.success).toBe(false);

    // The monitor should have received a workflow_error event referencing nodeA
    const errorEvents = monitor.events.filter(
      (e): e is Extract<WsServerEvent, { type: "workflow_error" }> => e.type === "workflow_error"
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    // At least one error event should mention the stalled node ID
    const mentionsNodeA = errorEvents.some(
      (e) =>
        ("nodeId" in e && e.nodeId === "nodeA") ||
        e.message.includes("nodeA")
    );
    expect(mentionsNodeA).toBe(true);
  });

  it("stall in first node of linear workflow prevents second node from running", async () => {
    const workflow = linearWorkflow();
    const monitor = createMockMonitor();

    // Route by spawn order: first spawn is nodeA (stalls), second would be
    // nodeB (should never happen because nodeA's failure blocks the workflow).
    let spawnCount = 0;
    const routingAdapter: AgentAdapter = {
      name: "routing-mock",
      async isAvailable() { return true; },
      async spawn(config: NodeConfig): Promise<AgentSession> {
        spawnCount++;
        return { id: randomUUID(), nodeId: config.prompt, adapter: "routing-mock", startedAt: new Date(), _internal: null };
      },
      async resume(_c: NodeConfig, prev: AgentSession, _f: string) { return prev; },
      async *stream(_session: AgentSession): AsyncIterable<AgentEvent> {
        if (spawnCount <= 1) {
          // nodeA: emit stall
          yield { type: "text_delta", text: "working..." };
          yield { type: "stall", reason: "no progress" };
        } else {
          // nodeB: would succeed (should never run)
          yield { type: "text_delta", text: "nodeB output" };
        }
      },
      async getResult(): Promise<{ output: string; exitCode: number; durationMs: number }> {
        return { output: "", exitCode: STALL_EXIT_CODE, durationMs: 100 };
      },
      async kill() {},
    };

    const scheduler = new WorkflowScheduler(workflow, () => routingAdapter, monitor as WsMonitorServer);
    const result = await scheduler.run("wf-stall-linear");

    expect(result.success).toBe(false);

    // nodeB must never have received a node_start event
    const nodeStartEvents = monitor.events.filter(
      (e): e is Extract<WsServerEvent, { type: "node_start" }> => e.type === "node_start"
    );
    const nodeBStarted = nodeStartEvents.some((e) => e.nodeId === "nodeB");
    expect(nodeBStarted).toBe(false);
  });

  it("checkpoint is written even when workflow fails due to stall", async () => {
    const workflow = singleNodeWorkflow("nodeA");
    const monitor = createMockMonitor();
    const stallAdapter = createStallAdapter("nodeA");
    const scheduler = new WorkflowScheduler(workflow, () => stallAdapter, monitor as WsMonitorServer);

    const result = await scheduler.run("wf-stall-checkpoint");

    expect(result.success).toBe(false);

    // CheckpointManager writes to <cwd>/.sygil/runs/<runId>.json
    const checkpointPath = join(testDir, ".sygil", "runs", `${result.runId}.json`);
    const raw = await readFile(checkpointPath, "utf8");
    const state = JSON.parse(raw) as { status: string; id: string };

    expect(state.id).toBe(result.runId);
    expect(state.status).toBe("failed");
  });

  it("cancel during streaming aborts the node", async () => {
    const workflow = singleNodeWorkflow("nodeA");
    const monitor = createMockMonitor();
    const killCalls: AgentSession[] = [];
    const slowAdapter = createSlowAdapter(killCalls);

    const scheduler = new WorkflowScheduler(workflow, () => slowAdapter, monitor as WsMonitorServer);

    // Cancel the scheduler after 50ms — the slow adapter yields one event every 20ms
    // so at least a couple events will have been emitted before cancellation.
    setTimeout(() => scheduler.cancel(), 50);

    const result = await scheduler.run("wf-cancel");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The error is either "Workflow cancelled" (caught at the graph level) or
    // "Workflow failed: N node(s) failed: nodeA" (when cancel fires mid-stream
    // and the node is treated as failed). Both indicate the run was aborted.
    expect(result.error).toMatch(/cancel|failed/i);

    // kill() must have been called on the adapter session
    expect(killCalls.length).toBeGreaterThan(0);
  });
});
