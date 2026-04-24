import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CursorCLIAdapter } from "./cursor-cli.js";
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
function makeSession(_adapter: CursorCLIAdapter, proc: ReturnType<typeof makeFakeProc>): AgentSession {
  return makeSessionEnvelope("cursor-cli", {
    proc,
    stdout: [],
    exitCode: null,
    done: false,
    eventQueue: [],
    resolve: null,
    totalCostUsd: 0,
    outputText: "",
    resultEvent: null,
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

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
  };
});

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CursorCLIAdapter", () => {
  let adapter: CursorCLIAdapter;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    adapter = new CursorCLIAdapter();
    vi.clearAllMocks();
    savedApiKey = process.env["CURSOR_API_KEY"];
    delete process.env["CURSOR_API_KEY"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedApiKey === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = savedApiKey;
  });

  // -------------------------------------------------------------------------
  describe("isAvailable()", () => {
    it("returns false when 'agent' binary is not in PATH", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });
      mockExistsSync.mockReturnValue(false);

      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });

    it("returns false when 'agent' is available but credentials file is missing", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(false);

      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });

    it("returns true when 'agent' is available and credentials file exists", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it("returns true when CURSOR_API_KEY is set even without credentials file", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(false);

      const prev = process.env["CURSOR_API_KEY"];
      process.env["CURSOR_API_KEY"] = "test-key";
      try {
        const result = await adapter.isAvailable();
        expect(result).toBe(true);
      } finally {
        if (prev === undefined) delete process.env["CURSOR_API_KEY"];
        else process.env["CURSOR_API_KEY"] = prev;
      }
    });

    it("name is 'cursor-cli'", () => {
      expect(adapter.name).toBe("cursor-cli");
    });
  });

  // -------------------------------------------------------------------------
  describe("spawn()", () => {
    it("throws when adapter is not available", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });
      mockExistsSync.mockReturnValue(false);

      await expect(
        adapter.spawn({ adapter: "cursor", model: "gpt-4o", role: "agent", prompt: "test" })
      ).rejects.toThrow(/not available/);
    });

    it("always passes --force in headless mode regardless of tools", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "cursor",
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
        tools: ["Read"],
      });

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--force");
      expect(args).toContain("--trust");
    });

    it("passes --force even without any tools configured", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "cursor",
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--force");
    });

    it("includes --model when config.model is set", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "cursor",
        model: "claude-3.5-sonnet",
        role: "agent",
        prompt: "test",
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("claude-3.5-sonnet");
    });

    it("warns when NodeConfig.tools is non-empty — no upstream allowlist", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await adapter.spawn({
        adapter: "cursor",
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
        tools: ["Read", "Write"],
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cursor-cli adapter ignores NodeConfig\.tools.*Read.*Write/)
      );
      warnSpy.mockRestore();
    });

    it("does not warn when NodeConfig.tools is omitted or empty", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await adapter.spawn({
        adapter: "cursor",
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
      });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("includes --cwd when config.outputDir is set", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "cursor",
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
        outputDir: "/tmp/workspace",
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--cwd");
      expect(args).toContain("/tmp/workspace");
    });
  });

  // -------------------------------------------------------------------------
  describe("stream() event normalization", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("normalizes text delta events to { type: 'text_delta' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      // Allow stream() to attach listeners in the microtask queue
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello world" }] },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "Hello world" });
    });

    it("normalizes tool_use events to { type: 'tool_call' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "bash",
                input: { command: "ls -la" },
              },
            ],
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

    it("normalizes writeToolCall to { type: 'file_write' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                subtype: "writeToolCall",
                name: "write_file",
                input: { path: "/tmp/output.txt" },
              },
            ],
          },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const writeEvents = events.filter((e) => e.type === "file_write");
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0]).toMatchObject({ type: "file_write", path: "/tmp/output.txt" });
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
      // This promise will be resolved when an event is pushed.
      const nextEventPromise = iterator.next();

      // Close stdout WITHOUT emitting exit — simulates the stall scenario.
      // This registers the STALL_GRACE_MS setTimeout inside the stream handler.
      proc.stdout.emit("end");

      // Advance fake clock past STALL_GRACE_MS so the stall callback fires
      await vi.advanceTimersByTimeAsync(6_000);

      const { value, done } = await nextEventPromise;

      expect(done).toBe(false);
      expect(value).toMatchObject({ type: "stall", reason: "process_stdout_closed_without_exit" });
    });

    it("normalizes result error to { type: 'error' }", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "result",
          subtype: "error",
          error: "agent crashed unexpectedly",
        }),
      ]);
      proc.emit("exit", 1);

      const events = await streamPromise;
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "error",
        message: "agent crashed unexpectedly",
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("stream() — additional edge cases", () => {
    it("skips system events", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "hi" });
    });

    it("normalizes tool result events", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "tool", tool_use_id: "tool-abc", content: "some output" }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool_result",
        tool: "tool-abc",
        output: "some output",
        success: true,
      });
    });

    it("skips readToolCall subtype", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", subtype: "readToolCall", name: "read_file", input: { path: "/tmp/x" } },
            ],
          },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(0);
    });

    it("captures result success event for getResult", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Final output text",
          session_id: "sess-123",
          duration_ms: 5000,
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      // result success events are captured internally, not emitted
      expect(events).toHaveLength(0);

      // Verify the internal state was updated
      const internal = session._internal as { resultEvent: { result: string; session_id: string; duration_ms: number } | null };
      expect(internal.resultEvent).toMatchObject({
        result: "Final output text",
        session_id: "sess-123",
        duration_ms: 5000,
      });
    });

    it("skips invalid JSON lines", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        "not json",
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
    });

    it("handles tool content as non-string (JSON stringified)", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);

      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "tool", tool_use_id: "tool-x", content: { key: "value" } }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool_result",
        output: JSON.stringify({ key: "value" }),
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("getResult()", () => {
    it("uses resultEvent output when available", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "cursor-cli",
        startedAt: new Date(Date.now() - 1000),
        _internal: {
          proc,
          stdout: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: "streaming output",
          resultEvent: { result: "Final result", session_id: "sess-1", duration_ms: 3000 },
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result.output).toBe("Final result");
      expect(result.durationMs).toBe(3000);
      expect(result.exitCode).toBe(0);
    });

    it("falls back to outputText when no resultEvent", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "cursor-cli",
        startedAt: new Date(Date.now() - 500),
        _internal: {
          proc,
          stdout: [],
          exitCode: 1,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: "fallback text",
          resultEvent: null,
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result.output).toBe("fallback text");
      expect(result.exitCode).toBe(1);
    });

    it("extracts structuredOutput from JSON in output", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {
          proc,
          stdout: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: 'Here is the result: {"status": "ok", "count": 42}',
          resultEvent: null,
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result.structuredOutput).toEqual({ status: "ok", count: 42 });
    });

    it("omits structuredOutput when output has no JSON", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {
          proc,
          stdout: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: "plain text only",
          resultEvent: null,
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const result = await adapter.getResult(session);
      expect(result).not.toHaveProperty("structuredOutput");
    });
  });

  // -------------------------------------------------------------------------
  describe("kill()", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends SIGTERM then SIGKILL after grace period", async () => {
      vi.useFakeTimers();

      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const killPromise = adapter.kill(session);

      // SIGTERM should be sent immediately
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

      // Advance past KILL_GRACE_PERIOD_MS (2000ms)
      await vi.advanceTimersByTimeAsync(2100);

      await killPromise;
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("does not SIGKILL if process exits within grace period", async () => {
      vi.useFakeTimers();

      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const killPromise = adapter.kill(session);

      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

      // Process exits quickly
      proc.emit("exit", 0);

      await killPromise;

      // SIGKILL should not have been called
      expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
    });

    // Kill must gate on process liveness (proc.exitCode / proc.killed), NOT
    // on internal.done — the stall path flips internal.done=true BEFORE the
    // process exits, so gating on `done` alone would skip SIGTERM and leak
    // the child.
    it("does not send SIGTERM when the process is already dead", async () => {
      const proc = makeFakeProc();
      proc.exitCode = 0; // simulate a process that already exited
      const session = makeSession(adapter, proc);

      await adapter.kill(session);
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it("still sends SIGTERM when internal.done is true but the process is alive (stall-path leak)", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);
      // Simulate the stall path: internal.done flipped before process exited.
      (session._internal as { done: boolean }).done = true;
      // proc.exitCode stays null (process alive).

      const killPromise = adapter.kill(session);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      // Let the process exit so the grace-period timer doesn't escalate.
      proc.emit("exit", 0);
      await killPromise;
    });
  });

  // -------------------------------------------------------------------------
  describe("resume()", () => {
    it("appends feedbackMessage to prompt in fallback spawn", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "cursor" as const,
        model: "gpt-4o",
        role: "agent",
        prompt: "Original prompt",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id",
        nodeId: "agent",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {},
      };

      await adapter.resume(config, previousSession, "Please fix the bug");

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      const promptIndex = args.indexOf("-p");
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      const promptValue = args[promptIndex + 1];
      expect(promptValue).toContain("Original prompt");
      expect(promptValue).toContain("Please fix the bug");
    });

    it("returns a valid AgentSession", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "cursor" as const,
        model: "gpt-4o",
        role: "agent",
        prompt: "Do something",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id",
        nodeId: "agent",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {},
      };

      const session = await adapter.resume(config, previousSession, "retry with fix");

      expect(session).toMatchObject({
        nodeId: config.role,
        adapter: "cursor-cli",
      });
      expect(typeof session.id).toBe("string");
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session._internal).toBeTruthy();
    });

    it("uses --resume with session_id when resultEvent has session_id", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "cursor" as const,
        model: "gpt-4o",
        role: "agent",
        prompt: "Original prompt",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id",
        nodeId: "agent",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {
          proc: makeFakeProc(),
          stdout: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          outputText: "",
          resultEvent: { result: "done", session_id: "cursor-sess-456", duration_ms: 1000 },
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      await adapter.resume(config, previousSession, "Fix the error");

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--resume");
      const resumeIdx = args.indexOf("--resume");
      expect(args[resumeIdx + 1]).toBe("cursor-sess-456");
    });

    it("throws when adapter is not available during resume", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });
      mockExistsSync.mockReturnValue(false);

      const config = {
        adapter: "cursor" as const,
        model: "gpt-4o",
        role: "agent",
        prompt: "test",
      };

      const previousSession: AgentSession = {
        id: "prev",
        nodeId: "agent",
        adapter: "cursor-cli",
        startedAt: new Date(),
        _internal: {},
      };

      await expect(
        adapter.resume(config, previousSession, "retry")
      ).rejects.toThrow(/not available/);
    });
  });
});
