/**
 * Shared test helpers for scheduler tests.
 *
 * Factories here are consumed by `index.test.ts`, `graph-index.test.ts`,
 * `abort-signal.test.ts`, and `critical-path.test.ts`. When adding a new
 * helper, prefer the most featureful version (e.g. the `createMockAdapter`
 * options shape from `index.test.ts`) so all callers share one surface.
 */

import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AdapterType,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
  WorkflowRunState,
} from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// NodeConfig + session factories
// ---------------------------------------------------------------------------

/** Minimal WorkflowRunState factory. */
export function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: randomUUID(),
    workflowName: "test-workflow",
    workflowPath: "",
    status: "running",
    startedAt: new Date().toISOString(),
    completedNodes: [],
    nodeResults: {},
    totalCostUsd: 0,
    retryCounters: {},
    sharedContext: {},
    ...overrides,
  };
}

/** Minimal NodeResult factory. */
export function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    output: "test output",
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

/**
 * AgentEvent factory keyed by the discriminator. Returns a minimal-valid
 * event for common variants used across scheduler and event-recorder tests;
 * the fallback case covers `shell_exec` for anything unmapped.
 */
export function makeEvent(
  type: AgentEvent["type"],
  extra?: Record<string, unknown>
): AgentEvent {
  switch (type) {
    case "tool_call":
      return { type: "tool_call", tool: "bash", input: { cmd: "ls" }, ...extra };
    case "tool_result":
      return { type: "tool_result", tool: "bash", output: "file.txt", success: true, ...extra };
    case "file_write":
      return { type: "file_write", path: "/tmp/out.txt", ...extra };
    case "text_delta":
      return { type: "text_delta", text: "hello", ...extra };
    case "cost_update":
      return { type: "cost_update", totalCostUsd: 0.05, ...extra };
    case "error":
      return { type: "error", message: "something broke", ...extra };
    case "stall":
      return { type: "stall", reason: "no output for 60s", ...extra };
    default:
      return { type: "shell_exec", command: "ls", exitCode: 0, ...extra };
  }
}

/**
 * Create a tmpdir with the given prefix and track it in `tempDirs` for the
 * caller's `afterEach` cleanup. Each test file still owns its own tempDirs
 * array — this just centralizes the `mkdtemp` + push boilerplate.
 */
export async function makeTempDir(tempDirs: string[], prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Minimal NodeConfig factory. */
export function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test role",
    prompt: "test prompt",
    ...overrides,
  };
}

/** Minimal session factory. */
export function makeSession(nodeId = "node"): AgentSession {
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

export interface MockAdapterOptions {
  available?: boolean;
  events?: AgentEvent[];
  result?: Partial<NodeResult>;
  failOnSpawn?: boolean;
  spawnDelay?: number;
}

export function createMockAdapter(options: MockAdapterOptions = {}): AgentAdapter {
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

export type MonitorEmit = Parameters<WsMonitorServer["emit"]>[0];

export function createMockMonitor(): WsMonitorServer & { events: MonitorEmit[] } {
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
    setAdapterPool() {},
  } as unknown as WsMonitorServer & { events: MonitorEmit[] };

  return monitor;
}

// ---------------------------------------------------------------------------
// Workflow graph builders
// ---------------------------------------------------------------------------

export function singleNodeWorkflow(): WorkflowGraph {
  return {
    version: "1",
    name: "single-node",
    nodes: {
      nodeA: makeNodeConfig(),
    },
    edges: [],
  };
}

export function linearWorkflow(exitCode = 0): WorkflowGraph {
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

export function loopBackWorkflow(maxRetries = 2): WorkflowGraph {
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

export function parallelWorkflow(): WorkflowGraph {
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
