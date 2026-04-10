import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { CodexCLIAdapter } from "./codex-cli.js";
import type { AgentSession } from "@sigil/shared";
import { makeFakeProc, pushLines } from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake AgentSession backed by a fake process */
function makeSession(adapter: CodexCLIAdapter, proc: ReturnType<typeof makeFakeProc>): AgentSession {
  return {
    id: "test-session-id",
    nodeId: "test-node",
    adapter: "codex",
    startedAt: new Date(),
    _internal: {
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
    },
  };
}

/** Collect all events from the stream, waiting for it to finish */
async function collectEvents(
  adapter: CodexCLIAdapter,
  session: AgentSession
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of adapter.stream(session)) {
    events.push(ev as { type: string; [k: string]: unknown });
  }
  return events;
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
