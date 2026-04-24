/**
 * WorkflowScheduler — lifecycle hooks tests.
 *
 * Covers `preNode` / `postNode` / `preGate` / `postGate` invocation through
 * the scheduler: hook scripts are discovered via `hooks` config, their
 * exit codes surface as `hook_result` AgentEvents, `preNode` non-zero
 * aborts the node before spawn, and omitting the hooks option is a no-op.
 *
 * Each test writes its hook script into the test's cwd (set by the module-
 * scoped `beforeEach`); cleanup is handled by the temp-dir teardown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type { WorkflowGraph } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import {
  createMockAdapter,
  createMockMonitor,
  makeNodeConfig,
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
