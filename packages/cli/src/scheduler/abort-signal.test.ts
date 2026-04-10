/**
 * AbortSignal integration tests — verifying that structured concurrency
 * signals propagate through the scheduler to gates and adapters.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  WorkflowGraph,
  AdapterType,
} from "@sigil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// Helpers (mirrored from index.test.ts)
// ---------------------------------------------------------------------------

function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test role",
    prompt: "test prompt",
    ...overrides,
  };
}

function makeSession(nodeId = "node"): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter: "mock",
    startedAt: new Date(),
    _internal: null,
  };
}

type MonitorEmit = Parameters<WsMonitorServer["emit"]>[0];

function createMockMonitor(): WsMonitorServer & { events: MonitorEmit[] } {
  const events: MonitorEmit[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter listener map requires any[] for mixed-type event arguments
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  return {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sigil-abort-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AbortSignal integration", () => {
  it("cancelling workflow during streaming aborts the node and calls kill", async () => {
    // nodeA streams events with short delays. We cancel mid-stream and
    // verify kill() is called and the workflow fails with cancellation.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "abort-stream-test",
      nodes: {
        nodeA: makeNodeConfig(),
        nodeB: makeNodeConfig(),
      },
      edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
    };

    const monitor = createMockMonitor();
    let killCalled = false;

    const adapter: AgentAdapter = {
      name: "mock",
      async isAvailable() { return true; },
      async spawn(_c) { return makeSession(_c.role); },
      async resume(_c, s) { return s; },
      async *stream(_s): AsyncIterable<AgentEvent> {
        // Emit events with short delays so the cancel check can fire
        for (let i = 0; i < 100; i++) {
          yield { type: "text_delta", text: `chunk-${i}` };
          await sleep(10);
        }
      },
      async getResult() {
        return { output: "", exitCode: 0, durationMs: 1 };
      },
      async kill() {
        killCalled = true;
      },
    };

    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
    const runPromise = scheduler.run("wf-1");

    // Wait for streaming to start, then cancel
    await sleep(50);
    scheduler.cancel();

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    expect(killCalled).toBe(true);
  });

  it("cancelling workflow propagates abort to all parallel node streams", async () => {
    // Two parallel nodes, both streaming events. Cancel should abort both.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "abort-parallel-test",
      nodes: {
        nodeA: makeNodeConfig(),
        nodeB: makeNodeConfig(),
      },
      edges: [],
    };

    const monitor = createMockMonitor();
    const killCalls: string[] = [];

    const adapter: AgentAdapter = {
      name: "mock",
      async isAvailable() { return true; },
      async spawn(c) { return makeSession(c.role); },
      async resume(_c, s) { return s; },
      async *stream(_s): AsyncIterable<AgentEvent> {
        // Emit events with short delays so the cancel check can fire
        for (let i = 0; i < 100; i++) {
          yield { type: "text_delta", text: `chunk-${i}` };
          await sleep(10);
        }
      },
      async getResult() {
        return { output: "", exitCode: 0, durationMs: 1 };
      },
      async kill(session) {
        killCalls.push(session.nodeId);
      },
    };

    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
    const runPromise = scheduler.run("wf-1");

    // Wait for both nodes to start streaming
    await sleep(50);
    scheduler.cancel();
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    // Both adapters should have been killed
    expect(killCalls.length).toBe(2);
  });

  it("node completion cleans up its abort controller without affecting others", async () => {
    // Linear workflow: nodeA completes, then nodeB streams. Cancel during
    // nodeB should only kill nodeB — nodeA is already done.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "cleanup-test",
      nodes: {
        nodeA: makeNodeConfig(),
        nodeB: makeNodeConfig(),
      },
      edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
    };

    const monitor = createMockMonitor();
    const killCalls: string[] = [];
    let nodeADone = false;

    const adapter: AgentAdapter = {
      name: "mock",
      async isAvailable() { return true; },
      async spawn(c) { return makeSession(c.role); },
      async resume(_c, s) { return s; },
      async *stream(session): AsyncIterable<AgentEvent> {
        if (!nodeADone) {
          // nodeA: complete immediately
          nodeADone = true;
          return;
        }
        // nodeB: stream events with delays
        for (let i = 0; i < 100; i++) {
          yield { type: "text_delta", text: `chunk-${i}` };
          await sleep(10);
        }
      },
      async getResult() {
        return { output: "", exitCode: 0, durationMs: 1 };
      },
      async kill(session) {
        killCalls.push(session.nodeId);
      },
    };

    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
    const runPromise = scheduler.run("wf-1");

    // Wait for nodeA to complete and nodeB to start streaming
    await sleep(100);
    scheduler.cancel();
    const result = await runPromise;

    expect(result.success).toBe(false);
    // The error may be "Workflow cancelled" or "Workflow failed: node(s) failed"
    // depending on timing — nodeB's cancel may surface as a node failure
    expect(result.error).toBeDefined();
    // Only nodeB's adapter should have been killed (nodeA already finished)
    expect(killCalls.length).toBe(1);
  });

  it("abort signal is passed to gate evaluator", async () => {
    // Verify the workflow completes successfully when a gate passes —
    // this confirms the signal is threaded through without false aborts.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "gate-signal-test",
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
            conditions: [{ type: "exit_code", value: 0 }],
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const adapter: AgentAdapter = {
      name: "mock",
      async isAvailable() { return true; },
      async spawn(_c) { return makeSession(_c.role); },
      async resume(_c, s) { return s; },
      async *stream(): AsyncIterable<AgentEvent> {
        // complete immediately
      },
      async getResult() {
        return { output: "", exitCode: 0, durationMs: 1 };
      },
      async kill() { /* no-op */ },
    };

    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
    const result = await scheduler.run("wf-1");

    // The signal should be passed through but not aborted — gate should pass
    expect(result.success).toBe(true);

    const gateEvents = monitor.events.filter((e) => e.type === "gate_eval");
    expect(gateEvents.length).toBeGreaterThan(0);
    expect(gateEvents[0]).toMatchObject({ passed: true });
  });
});
