/**
 * Integration tests for multi-node contract validation (outputSchema + inputMapping)
 * exercised through the full WorkflowScheduler stack.
 *
 * Verifies that validateStructuredOutput() is invoked on edges that carry a
 * contract.outputSchema, that failures surface as a failed RunResult, and that
 * edges without a contract are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
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
} from "@sigil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a NodeConfig. Set role equal to the graph node ID so that session
 * routing by session.nodeId works correctly in per-node adapter factories.
 */
function makeNodeConfig(nodeId: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test",
    role: nodeId,
    prompt: `prompt for ${nodeId}`,
    ...overrides,
  };
}

function makeSession(nodeId: string): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter: "mock",
    startedAt: new Date(),
    _internal: null,
  };
}

interface MockAdapterOptions {
  result?: Partial<NodeResult>;
}

function createMockAdapter(options: MockAdapterOptions = {}): AgentAdapter {
  const result: NodeResult = {
    output: "mock output",
    exitCode: 0,
    durationMs: 1,
    ...options.result,
  };

  return {
    name: "mock",
    async isAvailable() { return true; },
    async spawn(config) { return makeSession(config.role); },
    async resume(_config, session) { return session; },
    async *stream(_session): AsyncGenerator<AgentEvent> { /* no events */ },
    async getResult(_session) { return result; },
    async kill(_session) { /* no-op */ },
  };
}

/**
 * Build a routing adapter factory that dispatches per-node adapter calls
 * using session.nodeId (which equals config.role when makeNodeConfig is used).
 */
function makeRoutingAdapterFactory(
  adaptersByNodeId: Record<string, AgentAdapter>
): (_type: AdapterType) => AgentAdapter {
  return (_type: AdapterType): AgentAdapter => ({
    name: "mock",
    async isAvailable() { return true; },
    async spawn(config) {
      // config.role == nodeId (per makeNodeConfig convention)
      const a = adaptersByNodeId[config.role];
      return a ? a.spawn(config) : makeSession(config.role);
    },
    async resume(config, session, feedback) {
      const a = adaptersByNodeId[session.nodeId];
      return a ? a.resume(config, session, feedback) : session;
    },
    async *stream(session): AsyncGenerator<AgentEvent> {
      const a = adaptersByNodeId[session.nodeId];
      if (a) yield* a.stream(session);
    },
    async getResult(session) {
      const a = adaptersByNodeId[session.nodeId];
      return a
        ? a.getResult(session)
        : { output: "", exitCode: 0, durationMs: 1 };
    },
    async kill(session) {
      const a = adaptersByNodeId[session.nodeId];
      if (a) await a.kill(session);
    },
  });
}

function createMockMonitor(): WsMonitorServer & { events: Array<{ type: string }> } {
  const events: Array<{ type: string }> = [];
  return {
    events,
    emit(event: { type: string }) { events.push(event); },
    on() { /* no-op */ },
    off() { /* no-op */ },
    async start() { return 0; },
    async stop() { /* no-op */ },
    getPort() { return null; },
    getAuthToken() { return "t"; },
    onClientControl: undefined,
  } as unknown as WsMonitorServer & { events: Array<{ type: string }> };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sigil-contract-${randomUUID()}`);
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

describe("contract validation integration", () => {
  it("valid structured output passes contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-valid",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-produce-consume",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { name: "Alice" } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-contract-valid");

    expect(result.success).toBe(true);
  });

  it("missing required field fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-missing-field",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-missing-field",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns structuredOutput missing the required "name" field
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { age: 30 } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-missing-field");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The top-level error names the failing node; the detailed reason is in monitor events
    expect(result.error).toContain("producer");

    // The detailed contract validation error is emitted as a workflow_error event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("wrong type fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-wrong-type",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-wrong-type",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns name as a number instead of a string
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { name: 42 } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-wrong-type");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("producer");

    // The detailed type-mismatch error is in the workflow_error monitor event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("null structured output fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-null-output",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-null-output",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns no structuredOutput — undefined
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { output: "done", exitCode: 0, durationMs: 1 } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-null-output");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("producer");

    // The detailed "null or undefined" error is in the workflow_error monitor event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("multiple nodes — only the edge with a contract is validated", async () => {
    // Three-node chain: A → B (no contract) → C (with contract on B→C).
    // nodeA has no structuredOutput — fine because A→B carries no contract.
    // nodeB returns valid structuredOutput satisfying the B→C contract.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-selective",
      nodes: {
        nodeA: makeNodeConfig("nodeA"),
        nodeB: makeNodeConfig("nodeB"),
        nodeC: makeNodeConfig("nodeC"),
      },
      edges: [
        {
          id: "e-a-b",
          from: "nodeA",
          to: "nodeB",
          // No contract on this edge — nodeA's structuredOutput is irrelevant
        },
        {
          id: "e-b-c",
          from: "nodeB",
          to: "nodeC",
          contract: {
            outputSchema: {
              properties: { status: { type: "string" } },
              required: ["status"],
            },
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        nodeA: createMockAdapter({ result: { output: "A done", exitCode: 0, durationMs: 1 } }),
        nodeB: createMockAdapter({ result: { structuredOutput: { status: "ready" }, exitCode: 0, durationMs: 1 } }),
        nodeC: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-selective-contract");

    expect(result.success).toBe(true);
  });

  it("contract validation error includes edge and node IDs in message", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-error-ids",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "edge-producer-consumer",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { result: { type: "string" } },
              required: ["result"],
            },
          },
        },
      ],
    };

    // Producer returns structuredOutput missing the required "result" field
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      makeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { unrelated: true } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-error-ids");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The top-level result error names the node
    expect(result.error).toContain("producer");

    // The detailed workflow_error monitor event must name both the node and the edge
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const detailedMessage = errorEvents[0]!.message;
    expect(detailedMessage).toContain("producer");
    expect(detailedMessage).toContain("edge-producer-consumer");
  });
});
