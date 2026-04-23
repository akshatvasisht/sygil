/**
 * Shared test helpers for scheduler tests.
 *
 * Factories here are consumed by `index.test.ts`, `graph-index.test.ts`,
 * `abort-signal.test.ts`, and `critical-path.test.ts`. When adding a new
 * helper, prefer the most featureful version (e.g. the `createMockAdapter`
 * options shape from `index.test.ts`) so all callers share one surface.
 */

import { randomUUID } from "node:crypto";
import type {
  AdapterType,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
} from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

// ---------------------------------------------------------------------------
// NodeConfig + session factories
// ---------------------------------------------------------------------------

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
