import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeCLIAdapter } from "./claude-cli.js";
import type { AgentSession } from "@sygil/shared";
import {
  collectEvents,
  makeFakeProc,
  makeSession as makeSessionEnvelope,
  pushLines,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Helpers — Claude Code CLI v2.1 stream-json event factories
// ---------------------------------------------------------------------------

/** Wrap text in an assistant message (Claude Code v2.1 format) */
function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    session_id: "test",
  });
}

/** Wrap a tool_use in an assistant message */
function assistantToolUse(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input, id: "tu_1" }] },
    session_id: "test",
  });
}

/** Tool result as a user message */
function userToolResult(toolUseId: string, content: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
    session_id: "test",
  });
}

/** Final result event */
function resultEvent(result: string, cost: number, isError = false): string {
  return JSON.stringify({
    type: "result",
    subtype: isError ? "error" : "success",
    result,
    total_cost_usd: cost,
    is_error: isError,
    session_id: "test",
  });
}

/** Build a fake AgentSession backed by a fake process */
function makeSession(_adapter: ClaudeCLIAdapter, proc: ReturnType<typeof makeFakeProc>): AgentSession {
  return makeSessionEnvelope("claude-cli", {
    proc,
    outputLines: [],
    exitCode: null,
    done: false,
    eventQueue: [],
    resolve: null,
    totalCostUsd: 0,
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

describe("ClaudeCLIAdapter", () => {
  let adapter: ClaudeCLIAdapter;

  beforeEach(() => {
    adapter = new ClaudeCLIAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("isAvailable()", () => {
    it("returns false when 'claude' binary is not in PATH", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });

      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });

    it("returns true when 'claude' binary is available", async () => {
      mockExecSync.mockReturnValue("");

      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it("name is 'claude-cli'", () => {
      expect(adapter.name).toBe("claude-cli");
    });
  });

  // -------------------------------------------------------------------------
  describe("stream() event normalization", () => {
    it("normalizes assistant text content to text_delta", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [assistantText("Hello from claude")]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "Hello from claude" });
    });

    it("normalizes assistant tool_use content to tool_call", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        assistantToolUse("bash", { command: "echo hello" }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const toolEvents = events.filter((e) => e.type === "tool_call");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({
        type: "tool_call",
        tool: "bash",
        input: { command: "echo hello" },
      });
    });

    it("normalizes user tool_result to tool_result event", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [userToolResult("tu_1", "output here")]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({
        type: "tool_result",
        output: "output here",
        success: true,
      });
    });

    // Regression where chunk boundaries can split a multi-byte
    // UTF-8 character (emoji, CJK, etc.). Without StringDecoder the adapter
    // decodes each chunk independently, producing U+FFFD replacement chars
    // at the split and silently corrupting the final output text.
    it("preserves multi-byte UTF-8 characters split across stdout chunks", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      // "🎉" is F0 9F 8E 89 — split after the first two bytes across chunks.
      const line = assistantText("party 🎉 time") + "\n";
      const fullBuf = Buffer.from(line, "utf8");
      // Split somewhere in the middle of the emoji's byte sequence.
      const emojiStart = Buffer.from("party ", "utf8").length;
      const splitAt = emojiStart + 2; // after "F0 9F", before "8E 89"
      proc.stdout.emit("data", fullBuf.subarray(0, splitAt));
      proc.stdout.emit("data", fullBuf.subarray(splitAt));
      proc.stdout.emit("end");
      proc.emit("exit", 0);

      const events = await streamPromise;
      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "party 🎉 time" });
      // Assert no replacement-char corruption.
      expect((textEvents[0] as unknown as { text: string }).text).not.toContain("�");
    });

    // Regression where claude-cli's stream() previously called
    // finish() unconditionally from both the 'end' and 'exit' handlers. If
    // 'exit' fired first, finishStream set done=true and resolved the
    // drainEventQueue waiter with null — the generator broke BEFORE the
    // 'end' handler's trailing-line parseLine events were yielded. Events
    // pushed to the queue post-finish sat until GC. Now both handlers track
    // stdoutClosed/exitCode and only the LAST one to arrive calls finish(),
    // matching codex/cursor/gemini.
    it("preserves trailing-line events when 'exit' fires before 'end'", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      // Emit a non-terminated line (no \n) — it lives in lineBuffer until 'end'.
      const partial = assistantText("final trailing message");
      proc.stdout.emit("data", Buffer.from(partial, "utf8"));

      // Exit fires FIRST (fast-exiting process, e.g. auth failure).
      proc.emit("exit", 0);
      await new Promise((r) => setTimeout(r, 0));
      // Then 'end' fires, draining the trailing buffer and parsing the event.
      proc.stdout.emit("end");

      const events = await streamPromise;
      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({
        type: "text_delta",
        text: "final trailing message",
      });
    });

    it("marks tool_result as unsuccessful when is_error is true", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [userToolResult("tu_1", "error output", true)]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "tool_result", success: false });
    });

    it("extracts cost from result event", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [resultEvent("Done", 0.0042)]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      const costEvents = events.filter((e) => e.type === "cost_update");
      expect(costEvents).toHaveLength(1);
      expect(costEvents[0]).toMatchObject({ type: "cost_update", totalCostUsd: 0.0042 });
    });

    it("emits error event for error result", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [resultEvent("something went wrong", 0, true)]);
      proc.emit("exit", 1);

      const events = await streamPromise;
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "error",
        message: "something went wrong",
      });
    });

    it("normalizes {type: 'error'} to error event", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "error", message: "something went wrong" }),
      ]);
      proc.emit("exit", 1);

      const events = await streamPromise;
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "error",
        message: "something went wrong",
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("spawn()", () => {
    it("passes correct args to child_process.spawn", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "claude-cli",
        model: "claude-sonnet-4-20250514",
        role: "agent",
        prompt: "Do the thing",
        outputDir: "/tmp/work",
        tools: ["Read", "Write"],
        maxTurns: 10,
      });

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("Do the thing");
      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-20250514");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
      expect(args).toContain("--allowedTools");
      expect(args).toContain("Read,Write");
      expect(args).toContain("--max-turns");
      expect(args).toContain("10");
      // cwd is set via spawn options, not a CLI flag
      expect(args).not.toContain("--cwd");
      // Uses process cwd, not --bare
      expect(args).not.toContain("--bare");
    });

    it("passes role as --append-system-prompt", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "claude-cli",
        model: "sonnet",
        role: "You are a code reviewer.",
        prompt: "Review the code.",
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--append-system-prompt");
      const idx = args.indexOf("--append-system-prompt");
      expect(args[idx + 1]).toBe("You are a code reviewer.");
    });

    it("passes disallowedTools when provided", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "claude-cli",
        model: "claude-sonnet-4-20250514",
        role: "agent",
        prompt: "test",
        disallowedTools: ["Bash", "Edit"],
      });

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--disallowedTools");
      expect(args).toContain("Bash,Edit");
    });

    it("returns a valid AgentSession", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const session = await adapter.spawn({
        adapter: "claude-cli",
        model: "claude-sonnet-4-20250514",
        role: "test-agent",
        prompt: "do work",
      });

      expect(session).toMatchObject({
        nodeId: "test-agent",
        adapter: "claude-cli",
      });
      expect(typeof session.id).toBe("string");
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session._internal).toBeTruthy();
    });

    it("injects TRACEPARENT into child env when SpawnContext is passed", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn(
        {
          adapter: "claude-cli",
          model: "sonnet",
          role: "agent",
          prompt: "hi",
        },
        {
          traceparent: "00-abc-def-01",
          traceId: "abc",
          spanId: "def",
        },
      );

      const opts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env["TRACEPARENT"]).toBe("00-abc-def-01");
    });

    it("does not set TRACEPARENT when SpawnContext is omitted", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const prev = process.env["TRACEPARENT"];
      delete process.env["TRACEPARENT"];
      try {
        await adapter.spawn({
          adapter: "claude-cli",
          model: "sonnet",
          role: "agent",
          prompt: "hi",
        });
        const opts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string | undefined> };
        expect(opts.env["TRACEPARENT"]).toBeUndefined();
      } finally {
        if (prev !== undefined) process.env["TRACEPARENT"] = prev;
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("stream() — edge cases", () => {
    it("skips invalid JSON lines without crashing", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        "this is not JSON",
        assistantText("valid"),
        "{malformed json",
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "valid" });
    });

    it("skips empty lines", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      proc.stdout.emit("data", Buffer.from("\n\n" + assistantText("hi") + "\n\n"));
      proc.stdout.emit("end");
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "hi" });
    });

    it("handles partial lines buffered across chunks", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      const line = assistantText("split");
      const mid = Math.floor(line.length / 2);
      proc.stdout.emit("data", Buffer.from(line.slice(0, mid)));
      proc.stdout.emit("data", Buffer.from(line.slice(mid) + "\n"));
      proc.stdout.emit("end");
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "split" });
    });

    it("skips unknown event types", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp" }),
        assistantText("real"),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "real" });
    });

    it("flushes remaining buffer on stdout end", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      proc.stdout.emit("data", Buffer.from(assistantText("flushed")));
      proc.stdout.emit("end");
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "flushed" });
    });

    it("handles assistant message with multiple content blocks", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);

      const streamPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me check. " },
              { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" }, id: "tu_2" },
            ],
          },
          session_id: "test",
        }),
      ]);
      proc.emit("exit", 0);

      const events = await streamPromise;
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "Let me check. " });
      expect(events[1]).toMatchObject({ type: "tool_call", tool: "Read" });
    });
  });

  // -------------------------------------------------------------------------
  describe("getResult()", () => {
    it("returns fullOutput from result event", async () => {
      const proc = makeFakeProc();
      const internal = {
        proc,
        outputLines: [],
        exitCode: 0,
        done: true,
        eventQueue: [],
        resolve: null,
        totalCostUsd: 0.05,
        maxQueueSize: 1000,
        fullOutput: "Hello world",
      };

      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "claude-cli",
        startedAt: new Date(Date.now() - 500),
        _internal: internal,
      };

      const result = await adapter.getResult(session);
      expect(result.output).toBe("Hello world");
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBe(0.05);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("omits costUsd when totalCostUsd is 0", async () => {
      const proc = makeFakeProc();
      const internal = {
        proc,
        outputLines: [],
        exitCode: 0,
        done: true,
        eventQueue: [],
        resolve: null,
        totalCostUsd: 0,
        maxQueueSize: 1000,
      };

      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "claude-cli",
        startedAt: new Date(),
        _internal: internal,
      };

      const result = await adapter.getResult(session);
      expect(result).not.toHaveProperty("costUsd");
    });

    it("defaults exitCode to 1 when null", async () => {
      const proc = makeFakeProc();
      const internal = {
        proc,
        outputLines: [],
        exitCode: null,
        done: true,
        eventQueue: [],
        resolve: null,
        totalCostUsd: 0,
        maxQueueSize: 1000,
      };

      const session: AgentSession = {
        id: "test",
        nodeId: "node",
        adapter: "claude-cli",
        startedAt: new Date(),
        _internal: internal,
      };

      // Trigger exit so getResult doesn't hang
      setTimeout(() => proc.emit("exit", null), 10);

      const result = await adapter.getResult(session);
      expect(result.exitCode).toBe(1);
    });

    it("force-kills and returns when child hangs past the getResult timeout", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeFakeProc();
        const internal = {
          proc,
          outputLines: [],
          exitCode: null as number | null,
          done: false,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0,
          maxQueueSize: 1000,
        };

        const session: AgentSession = {
          id: "test",
          nodeId: "node",
          adapter: "claude-cli",
          startedAt: new Date(),
          _internal: internal,
        };

        const resultPromise = adapter.getResult(session);

        // Advance past CLAUDE_CLI_GETRESULT_TIMEOUT_MS (10_000) so the timeout branch fires.
        await vi.advanceTimersByTimeAsync(10_050);
        // SIGTERM issued; grace window (2_000) then SIGKILL.
        await vi.advanceTimersByTimeAsync(2_050);

        const result = await resultPromise;
        expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
        expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
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

    it("does not send SIGTERM when already done", async () => {
      const proc = makeFakeProc();
      const session = makeSession(adapter, proc);
      (session._internal as { done: boolean }).done = true;

      await adapter.kill(session);
      expect(proc.kill).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("resume()", () => {
    it("uses --resume with the previous session id", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "claude-cli" as const,
        model: "claude-3-5-sonnet-20241022",
        role: "agent",
        prompt: "Original prompt",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id-abc",
        nodeId: "agent",
        adapter: "claude-cli",
        startedAt: new Date(),
        _internal: {},
      };

      await adapter.resume(config, previousSession, "Please fix the issue");

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--resume");
      const resumeIndex = args.indexOf("--resume");
      expect(args[resumeIndex + 1]).toBe("prev-session-id-abc");
      // No --bare in resume either
      expect(args).not.toContain("--bare");
    });

    it("passes feedbackMessage as the -p prompt argument", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "claude-cli" as const,
        model: "claude-3-5-sonnet-20241022",
        role: "agent",
        prompt: "Original prompt",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id-xyz",
        nodeId: "agent",
        adapter: "claude-cli",
        startedAt: new Date(),
        _internal: {},
      };

      await adapter.resume(config, previousSession, "Please fix the bug");

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      const promptIndex = args.indexOf("-p");
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(args[promptIndex + 1]).toBe("Please fix the bug");
    });

    it("returns a valid AgentSession preserving the previous session id", async () => {
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const config = {
        adapter: "claude-cli" as const,
        model: "claude-3-5-sonnet-20241022",
        role: "agent",
        prompt: "Do something",
      };

      const previousSession: AgentSession = {
        id: "prev-session-id-preserved",
        nodeId: "agent",
        adapter: "claude-cli",
        startedAt: new Date(),
        _internal: {},
      };

      const session = await adapter.resume(config, previousSession, "retry");

      expect(session.id).toBe("prev-session-id-preserved");
      expect(session).toMatchObject({
        nodeId: config.role,
        adapter: "claude-cli",
      });
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session._internal).toBeTruthy();
    });
  });
});
