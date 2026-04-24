/**
 * WorkflowScheduler — sharedContext read/write tests.
 *
 * Load-bearing invariants exercised here: (a) shared-context writes flow
 * through `context_set` AgentEvents (never direct state pokes), (b) the
 * `writesContext` allowlist is enforced and unauthorised writes become
 * `error` events, (c) downstream nodes read via `{{ctx.<key>}}`
 * interpolation, with missing keys resolving to empty string and non-string
 * values serialised as JSON.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  NodeConfig,
  NodeResult,
  WorkflowGraph,
} from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import {
  createMockAdapter,
  createMockMonitor,
  makeNodeConfig,
  makeSession,
} from "./__test-helpers__.js";

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

describe("WorkflowScheduler", () => {
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
});
