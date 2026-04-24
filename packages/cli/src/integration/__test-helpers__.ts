/**
 * Shared test helpers for integration tests.
 *
 * Provides factory functions for creating mock adapters, workflow graphs,
 * temporary git repos, and common assertions used across integration tests.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
  AdapterType,
  WorkflowRunState,
  WsServerEvent,
} from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

export async function makeTempDir(prefix = "sygil-integ-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Temp git repo
// ---------------------------------------------------------------------------

export async function createTempGitRepo(): Promise<string> {
  const dir = await makeTempDir("sygil-git-");
  await execFileAsync("git", ["init", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@sygil.dev"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Sygil Test"]);
  // Create an initial commit so HEAD exists
  await writeFile(join(dir, "README.md"), "# test repo\n");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-m", "initial commit"]);
  return dir;
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

export function makeSession(nodeId = "node", adapter = "mock"): AgentSession {
  return {
    id: randomUUID(),
    nodeId,
    adapter,
    startedAt: new Date(),
    _internal: null,
  };
}

// ---------------------------------------------------------------------------
// Node config factory
// ---------------------------------------------------------------------------

export function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test-role",
    prompt: "test prompt",
    ...overrides,
  };
}

/**
 * Build a NodeConfig whose `role` equals the graph node ID and whose default
 * `prompt` embeds the node ID. Used by tests that rely on per-node adapter
 * routing via `session.nodeId == config.role`.
 */
export function makeNodeConfigForNode(
  nodeId: string,
  overrides: Partial<NodeConfig> = {}
): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test",
    role: nodeId,
    prompt: `prompt for ${nodeId}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Node result factory
// ---------------------------------------------------------------------------

export function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    output: "test output",
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Run state factory
// ---------------------------------------------------------------------------

export function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: randomUUID(),
    workflowName: "test-workflow",
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

// ---------------------------------------------------------------------------
// Scripted mock adapter
// ---------------------------------------------------------------------------

export interface ScriptedAdapterOptions {
  name?: string;
  available?: boolean;
  events?: AgentEvent[];
  result?: Partial<NodeResult>;
  failOnSpawn?: boolean;
  spawnDelay?: number;
  /** If provided, called on each stream yield to simulate real async work. */
  eventDelay?: number;
  /** Track calls for assertions. */
  spawnCalls?: NodeConfig[];
  resumeCalls?: Array<{ config: NodeConfig; session: AgentSession; feedback: string }>;
  killCalls?: AgentSession[];
}

export function createScriptedAdapter(options: ScriptedAdapterOptions = {}): AgentAdapter {
  const {
    name = "mock",
    available = true,
    events = [],
    result = {},
    failOnSpawn = false,
    spawnDelay = 0,
    eventDelay = 0,
    spawnCalls = [],
    resumeCalls = [],
    killCalls = [],
  } = options;

  return {
    name,
    async isAvailable() { return available; },
    async spawn(config) {
      spawnCalls.push(config);
      if (spawnDelay > 0) await new Promise((r) => setTimeout(r, spawnDelay));
      if (failOnSpawn) throw new Error("Spawn failed");
      return makeSession(config.prompt.slice(0, 20), name);
    },
    async resume(config, previousSession, feedbackMessage) {
      resumeCalls.push({ config, session: previousSession, feedback: feedbackMessage });
      return previousSession;
    },
    async *stream(_session) {
      for (const event of events) {
        if (eventDelay > 0) await new Promise((r) => setTimeout(r, eventDelay));
        yield event;
      }
    },
    async getResult(_session) {
      return { output: "mock output", exitCode: 0, durationMs: 1, ...result };
    },
    async kill(session) {
      killCalls.push(session);
    },
  };
}

// ---------------------------------------------------------------------------
// Routing adapter factory — returns different adapters per AdapterType
// ---------------------------------------------------------------------------

export function createRoutingAdapterFactory(
  adapters: Partial<Record<AdapterType, AgentAdapter>>
): (type: AdapterType) => AgentAdapter {
  const fallback = createScriptedAdapter();
  return (type: AdapterType) => adapters[type] ?? fallback;
}

// ---------------------------------------------------------------------------
// Simple mock adapter — minimal surface used by contract/node-output tests
// ---------------------------------------------------------------------------

export interface MockAdapterOptions {
  result?: Partial<NodeResult>;
  /** Called on spawn with the resolved config — use to capture the prompt. */
  onSpawn?: (config: NodeConfig) => void;
}

/**
 * Minimal mock adapter: no streamed events, single `getResult`, session's
 * `nodeId` is set to `config.role` so per-node routing factories can dispatch.
 */
export function createMockAdapter(options: MockAdapterOptions = {}): AgentAdapter {
  const result: NodeResult = {
    output: "mock output",
    exitCode: 0,
    durationMs: 1,
    ...options.result,
  };

  return {
    name: "mock",
    async isAvailable() { return true; },
    async spawn(config) {
      options.onSpawn?.(config);
      return makeSession(config.role);
    },
    async resume(_config, session) { return session; },
    async *stream(_session): AsyncGenerator<AgentEvent> { /* no events */ },
    async getResult(_session) { return result; },
    async kill(_session) { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Routing adapter factory — dispatches per-node adapter calls by session.nodeId
// ---------------------------------------------------------------------------

/**
 * Build a routing adapter factory that dispatches per-node adapter calls
 * using `config.role` on spawn and `session.nodeId` on subsequent calls.
 * Pairs with `makeNodeConfigForNode` (which sets `role == nodeId`) to allow
 * tests to wire a distinct adapter per graph node.
 */
export function createNodeRoutingAdapterFactory(
  adaptersByNodeId: Record<string, AgentAdapter>
): (_type: AdapterType) => AgentAdapter {
  return (_type: AdapterType): AgentAdapter => ({
    name: "mock",
    async isAvailable() { return true; },
    async spawn(config) {
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

// ---------------------------------------------------------------------------
// Mock monitor
// ---------------------------------------------------------------------------

type MonitorEmit = WsServerEvent;

export function createMockMonitor(): WsMonitorServer & { events: MonitorEmit[] } {
  const events: MonitorEmit[] = [];
  return {
    events,
    emit(event: MonitorEmit) { events.push(event); },
    async start() { return 0; },
    async stop() {},
    getPort() { return null; },
    getAuthToken() { return "test-token"; },
    setAdapterPool() {},
    onClientControl: undefined,
  } as unknown as WsMonitorServer & { events: MonitorEmit[] };
}

// ---------------------------------------------------------------------------
// Workflow graph builders
// ---------------------------------------------------------------------------

export function singleNodeWorkflow(
  nodeId = "nodeA",
  overrides: Partial<NodeConfig> = {}
): WorkflowGraph {
  return {
    version: "1",
    name: "single-node",
    nodes: { [nodeId]: makeNodeConfig(overrides) },
    edges: [],
  };
}

export function linearWorkflow(
  gateExitCode = 0
): WorkflowGraph {
  return {
    version: "1",
    name: "linear",
    nodes: {
      nodeA: makeNodeConfig({ prompt: "node A" }),
      nodeB: makeNodeConfig({ prompt: "node B" }),
    },
    edges: [
      {
        id: "e1",
        from: "nodeA",
        to: "nodeB",
        gate: { conditions: [{ type: "exit_code", value: gateExitCode }] },
      },
    ],
  };
}

export function diamondWorkflow(): WorkflowGraph {
  return {
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
}

export function loopBackWorkflow(maxRetries = 2): WorkflowGraph {
  return {
    version: "1",
    name: "loop-back",
    nodes: {
      writer: makeNodeConfig({ prompt: "write code" }),
      reviewer: makeNodeConfig({ prompt: "review code" }),
    },
    edges: [
      { id: "e-write-review", from: "writer", to: "reviewer" },
      {
        id: "e-review-loop",
        from: "reviewer",
        to: "writer",
        isLoopBack: true,
        maxRetries,
        gate: { conditions: [{ type: "exit_code", value: 0 }] },
      },
    ],
  };
}

export function contractWorkflow(
  outputSchema: Record<string, unknown>,
  inputMapping?: Record<string, string>
): WorkflowGraph {
  return {
    version: "1",
    name: "contract",
    nodes: {
      producer: makeNodeConfig({ prompt: "produce data" }),
      consumer: makeNodeConfig({ prompt: "consume data with {{result}}" }),
    },
    edges: [
      {
        id: "e-produce-consume",
        from: "producer",
        to: "consumer",
        contract: {
          outputSchema,
          ...(inputMapping !== undefined ? { inputMapping } : {}),
        },
      },
    ],
  };
}

/** Multi-node workflow: start -> [impl, test] -> validate (diamond with gates). */
export function fullDagWorkflow(): WorkflowGraph {
  return {
    version: "1",
    name: "full-dag",
    nodes: {
      plan: makeNodeConfig({ prompt: "plan the feature" }),
      impl: makeNodeConfig({ prompt: "implement the feature" }),
      test: makeNodeConfig({ prompt: "write tests" }),
      validate: makeNodeConfig({ prompt: "validate everything" }),
    },
    edges: [
      { id: "e-plan-impl", from: "plan", to: "impl" },
      { id: "e-plan-test", from: "plan", to: "test" },
      {
        id: "e-impl-validate",
        from: "impl",
        to: "validate",
        gate: { conditions: [{ type: "exit_code", value: 0 }] },
      },
      {
        id: "e-test-validate",
        from: "test",
        to: "validate",
        gate: { conditions: [{ type: "exit_code", value: 0 }] },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function monitorEventsOfType<T extends WsServerEvent["type"]>(
  events: WsServerEvent[],
  type: T
): Extract<WsServerEvent, { type: T }>[] {
  return events.filter((e): e is Extract<WsServerEvent, { type: T }> => e.type === type);
}

/** Wait for a condition with timeout. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
