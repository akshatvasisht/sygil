import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodexCLIAdapter } from "./codex-cli.js";
import type { AgentSession } from "@sygil/shared";
import {
  collectEvents,
  makeFakeProc,
  makeSession as makeSessionEnvelope,
  pushLines,
} from "./__test-helpers__.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake AgentSession backed by a fake process */
function makeSession(_adapter: CodexCLIAdapter, proc: ReturnType<typeof makeFakeProc>): AgentSession {
  return makeSessionEnvelope("codex", {
    proc,
    outputLines: [],
    exitCode: null,
    done: false,
    eventQueue: [],
    resolve: null,
    totalCostUsd: 0,
    outputText: "",
    tokenUsage: { input: 0, output: 0 },
    stallTimer: null,
    maxQueueSize: 1000,
  });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexCLIAdapter", () => {
  let adapter: CodexCLIAdapter;

  beforeEach(() => {
    adapter = new CodexCLIAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("isAvailable()", () => {
    it("returns false when 'codex' binary is not in PATH", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });

      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });

    it("returns true when 'codex' binary is available", async () => {
      mockExecSync.mockReturnValue("");

      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it("name is 'codex'", () => {
      expect(adapter.name).toBe("codex");
    });
  });

  // -------------------------------------------------------------------------
  describe("stream() event normalization", () => {
    it("normalizes item.created with message item to { type: 'text_delta' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: {
            type: "message",
            content: [{ type: "text", text: "Hello from codex" }],
          },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "Hello from codex" });
    });

    it("normalizes item.created with function_call item to { type: 'tool_call' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: {
            type: "function_call",
            name: "bash",
            arguments: JSON.stringify({ command: "ls -la" }),
          },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const toolEvents = events.filter((e) => e.type === "tool_call");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({
        type: "tool_call",
        tool: "bash",
        input: { command: "ls -la" },
      });
    });

    it("normalizes turn.failed to { type: 'error' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "turn.failed", error: "model overloaded" }),
      ]);
      proc.emit("exit", 1);

      const events = await streamPromise;
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "error",
        message: "model overloaded",
      });
    });

    it("emits stall event when stdout closes without process exit", async () => {
      // Install fake timers BEFORE the test so that the stall setTimeout is captured
      vi.useFakeTimers();

      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamIterable = adapter.stream(session);
      const iterator = streamIterable[Symbol.asyncIterator]();

      // Calling iterator.next() starts the generator and runs synchronously through
      // all the listener-setup code up to the first internal await (the event-wait promise).
      const nextEventPromise = iterator.next();

      // Close stdout WITHOUT emitting exit — simulates the stall scenario.
      // This registers the STALL_GRACE_MS setTimeout inside the stream handler.
      proc.stdout.emit("end");

      // Advance fake clock past STALL_GRACE_MS (5_000ms) so the stall callback fires
      await vi.advanceTimersByTimeAsync(6_000);

      const { value, done } = await nextEventPromise;

      vi.useRealTimers();

      expect(done).toBe(false);
      expect(value).toMatchObject({ type: "stall", reason: "process_stdout_closed_without_exit" });
    });
  });

  // -------------------------------------------------------------------------
  describe("spawn()", () => {
    it("passes correct args to child_process.spawn", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "codex",
        model: "o4-mini",
        role: "agent",
        prompt: "Build the feature",
        outputDir: "/tmp/workspace",
        sandbox: "workspace-write",
      });

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [binary, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe("codex");
      expect(args).toContain("exec");
      expect(args).toContain("--json");
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).toContain("--ephemeral");
      expect(args).toContain("--model");
      expect(args).toContain("o4-mini");
      expect(args).toContain("Build the feature");
    });

    it("defaults sandbox to workspace-write when not specified", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "codex",
        model: "o4-mini",
        role: "agent",
        prompt: "task",
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      const sandboxIdx = args.indexOf("--sandbox");
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(args[sandboxIdx + 1]).toBe("workspace-write");
    });

    it("returns a valid AgentSession", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const session = await adapter.spawn({
        adapter: "codex",
        model: "o4-mini",
        role: "test-node",
        prompt: "do work",
      });

      expect(session).toMatchObject({
        nodeId: "test-node",
        adapter: "codex",
      });
      expect(typeof session.id).toBe("string");
      expect(session.startedAt).toBeInstanceOf(Date);
    });

    it("injects TRACEPARENT into child env when SpawnContext is passed", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn(
        { adapter: "codex", model: "o4-mini", role: "agent", prompt: "task" },
        { traceparent: "00-abc-def-01", traceId: "abc", spanId: "def" },
      );

      const opts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env["TRACEPARENT"]).toBe("00-abc-def-01");
    });

    // Cross-adapter "warns on non-empty tools" coverage lives in
    // adapters/tools-allowlist-warns.test.ts (describe.each over codex /
    // cursor / gemini-cli).
  });

  // -------------------------------------------------------------------------
  describe("stream() — edge cases", () => {
    it("skips invalid JSON lines", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        "not json",
        JSON.stringify({ type: "item.created", item: { type: "message", content: [{ type: "text", text: "valid" }] } }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "valid" });
    });

    it("normalizes function_call_output with exit_code to shell_exec", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: { type: "function_call_output", call_id: "ls -la", output: "files", exit_code: 0 },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "shell_exec",
        command: "ls -la",
        exitCode: 0,
      });
    });

    it("normalizes function_call_output without exit_code to tool_result", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: { type: "function_call_output", call_id: "tool-123", output: "result data" },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool_result",
        tool: "tool-123",
        output: "result data",
        success: true,
      });
    });

    it("handles message item with string content", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: { type: "message", content: "plain string content" },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "plain string content" });
    });

    it("handles function_call with invalid JSON arguments gracefully", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "item.created",
          item: { type: "function_call", name: "bash", arguments: "not-json" },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool_call",
        tool: "bash",
        input: { raw: "not-json" },
      });
    });

    it("emits cost_update from turn.completed with usage data", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "turn.completed",
          usage: { total_cost: 0.025, input_tokens: 100, output_tokens: 50 },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "cost_update", totalCostUsd: 0.025 });
    });

    it("skips turn.started events", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "turn.started" }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(0);
    });

    it("handles explicit cost event type", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "cost", total_cost_usd: 0.1 }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "cost_update", totalCostUsd: 0.1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("getResult()", () => {
    it("returns accumulated output text and cost", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "codex",
        startedAt: new Date(Date.now() - 200),
        _internal: {
          proc,
          outputLines: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0.03,
          outputText: "accumulated output",
          tokenUsage: { input: 500, output: 200 },
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result.output).toBe("accumulated output");
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBe(0.03);
      expect(result.tokenUsage).toEqual({ input: 500, output: 200 });
    });

    it("omits costUsd and tokenUsage when zero", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "codex",
        startedAt: new Date(),
        _internal: {
          proc,
          outputLines: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: "",
          tokenUsage: { input: 0, output: 0 },
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result).not.toHaveProperty("costUsd");
      expect(result).not.toHaveProperty("tokenUsage");
    });

    it("force-kills and returns within the timeout budget when the child never marks done", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeFakeProc();
        const session = makeSession(adapter, proc);
        // internal.done stays false, exitCode stays null — simulates the stuck-teardown case.

        const resultPromise = adapter.getResult(session);

        // Advance past CODEX_GETRESULT_TIMEOUT_MS (10_000) so the timeout branch fires.
        await vi.advanceTimersByTimeAsync(10_000);
        // SIGTERM should have been sent immediately on timeout.
        expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

        // The child never exits — advance past GETRESULT_KILL_GRACE_MS (2_000).
        await vi.advanceTimersByTimeAsync(2_000);
        expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

        const result = await resultPromise;
        // Force-teardown path synthesizes exitCode=1 when the child never reported one.
        expect(result.exitCode).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("kill()", () => {
    it("sends SIGTERM to the process", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      await adapter.kill(session);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    // Kill gates on process liveness (proc.exitCode / proc.killed), NOT on
    // internal.done — the stall path flips internal.done=true BEFORE the
    // process exits.
    it("does not send SIGTERM when the process is already dead", async () => {
      const proc = makeFakeProc();
      proc.exitCode = 0;
      const session = makeSession(adapter, proc);

      await adapter.kill(session);
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it("still sends SIGTERM when internal.done is true but the process is alive (stall-path leak)", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);
      (session._internal as { done: boolean }).done = true;

      const killPromise = adapter.kill(session);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      proc.emit("exit", 0);
      await killPromise;
    });
  });

  // -------------------------------------------------------------------------
  describe("resume()", () => {
    it("spawns with 'exec resume --last' arguments", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "codex" as const,
        model: "o4-mini",
        role: "agent",
        prompt: "Original prompt",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id-codex",
        nodeId: "agent",
        adapter: "codex",
        startedAt: new Date(),
        _internal: {},
      };

      await adapter.resume(config, previousSession, "Please try again");

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [binary, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe("codex");
      expect(args[0]).toBe("exec");
      expect(args[1]).toBe("resume");
      expect(args[2]).toBe("--last");
      expect(args[3]).toBe("Please try again");
      expect(args).toContain("--json");
    });

    it("returns a valid AgentSession preserving the previous session id", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "codex" as const,
        model: "o4-mini",
        role: "agent",
        prompt: "Do something",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id-preserved",
        nodeId: "agent",
        adapter: "codex",
        startedAt: new Date(),
        _internal: {},
      };

      const session = await adapter.resume(config, previousSession, "retry");

      expect(session.id).toBe("prev-session-id-preserved");
      expect(session).toMatchObject({
        nodeId: config.role,
        adapter: "codex",
      });
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session._internal).toBeTruthy();
    });
  });
});
