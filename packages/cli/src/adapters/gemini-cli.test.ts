import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiCLIAdapter } from "./gemini-cli.js";
import type { AgentSession } from "@sygil/shared";
import {
  collectEvents,
  makeFakeProc,
  makeSession as makeSessionEnvelope,
  pushLines,
} from "./__test-helpers__.js";
import { logger } from "../utils/logger.js";

function makeSession(proc: ReturnType<typeof makeFakeProc>): AgentSession {
  return makeSessionEnvelope(
    "gemini-cli",
    {
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
    },
    { id: "test-session", nodeId: "node" }
  );
}

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execSync: vi.fn(), spawn: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn() };
});

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

describe("GeminiCLIAdapter", () => {
  let adapter: GeminiCLIAdapter;
  let savedKey: string | undefined;

  beforeEach(() => {
    adapter = new GeminiCLIAdapter();
    vi.clearAllMocks();
    savedKey = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedKey === undefined) delete process.env["GEMINI_API_KEY"];
    else process.env["GEMINI_API_KEY"] = savedKey;
  });

  describe("isAvailable()", () => {
    it("returns false when binary missing", async () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("returns true when GEMINI_API_KEY is set", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(false);
      process.env["GEMINI_API_KEY"] = "x";
      expect(await adapter.isAvailable()).toBe(true);
    });

    it("returns true when ~/.gemini exists", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);
      expect(await adapter.isAvailable()).toBe(true);
    });

    it("returns false when binary exists but no auth", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(false);
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe("spawn() args", () => {
    it("passes stream-json, -p, --yolo, and --model", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn({
        adapter: "gemini-cli",
        model: "gemini-2.5-pro",
        role: "agent",
        prompt: "hello",
      });

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("hello");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--yolo");
      expect(args).toContain("--model");
      expect(args).toContain("gemini-2.5-pro");
    });

    it("injects TRACEPARENT into child env when SpawnContext is passed", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      await adapter.spawn(
        { adapter: "gemini-cli", model: "gemini-2.5-pro", role: "agent", prompt: "hi" },
        { traceparent: "00-abc-def-01", traceId: "abc", spanId: "def" },
      );

      const opts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env["TRACEPARENT"]).toBe("00-abc-def-01");
    });

    it("warns when NodeConfig.tools is non-empty — no upstream allowlist", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await adapter.spawn({
        adapter: "gemini-cli",
        model: "gemini-2.5-pro",
        role: "agent",
        prompt: "hi",
        tools: ["Read", "Write"],
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/gemini-cli adapter ignores NodeConfig\.tools.*Read.*Write/)
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
        adapter: "gemini-cli",
        model: "gemini-2.5-pro",
        role: "agent",
        prompt: "hi",
      });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("stream() event normalization", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("maps message → text_delta", async () => {
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const eventsPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "init", session_id: "s1", model: "gemini-2.5-pro" }),
        JSON.stringify({ type: "message", role: "assistant", content: "Hello " }),
        JSON.stringify({ type: "message", role: "assistant", content: "world" }),
      ]);
      proc.emit("exit", 0);

      const events = await eventsPromise;
      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toMatchObject({ type: "text_delta", text: "Hello " });
      expect(deltas[1]).toMatchObject({ type: "text_delta", text: "world" });
    });

    it("maps tool_use → tool_call and tool_result", async () => {
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const eventsPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "tool_use", name: "shell", args: { command: "ls" } }),
        JSON.stringify({ type: "tool_result", name: "shell", output: "file.txt" }),
      ]);
      proc.emit("exit", 0);

      const events = await eventsPromise;
      expect(events[0]).toMatchObject({ type: "tool_call", tool: "shell", input: { command: "ls" } });
      expect(events[1]).toMatchObject({ type: "tool_result", tool: "shell", output: "file.txt", success: true });
    });

    it("marks tool_result success=false when error present", async () => {
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const eventsPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "tool_result", name: "shell", output: "", error: "permission denied" }),
      ]);
      proc.emit("exit", 1);

      const events = await eventsPromise;
      expect(events[0]).toMatchObject({ type: "tool_result", success: false });
    });

    it("captures result event with usage and emits cost_update when cost > 0", async () => {
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const eventsPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({
          type: "result",
          result: "Final",
          session_id: "sid",
          duration_ms: 123,
          cost_usd: 0.0042,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      ]);
      proc.emit("exit", 0);

      const events = await eventsPromise;
      const cost = events.find((e) => e.type === "cost_update");
      expect(cost).toMatchObject({ type: "cost_update", totalCostUsd: 0.0042 });

      const internal = session._internal as {
        resultEvent: { result: string; duration_ms: number; tokenUsage?: { input: number; output: number } };
      };
      expect(internal.resultEvent?.result).toBe("Final");
      expect(internal.resultEvent?.tokenUsage).toEqual({ input: 100, output: 50 });
    });

    it("emits error event for error type", async () => {
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const eventsPromise = collectEvents(adapter, session);
      await new Promise((r) => setTimeout(r, 0));

      pushLines(proc.stdout, [
        JSON.stringify({ type: "error", message: "rate limit" }),
      ]);
      proc.emit("exit", 1);

      const events = await eventsPromise;
      expect(events[0]).toMatchObject({ type: "error", message: "rate limit" });
    });

    it("emits stall when stdout closes without exit", async () => {
      vi.useFakeTimers();
      const proc = makeFakeProc();
      const session = makeSession(proc);

      const iter = adapter.stream(session)[Symbol.asyncIterator]();
      const nextP = iter.next();

      proc.stdout.emit("end");
      await vi.advanceTimersByTimeAsync(6_000);

      const { value, done } = await nextP;
      expect(done).toBe(false);
      expect(value).toMatchObject({ type: "stall" });
    });
  });

  describe("getResult()", () => {
    it("uses resultEvent and tokenUsage", async () => {
      const proc = makeFakeProc();
      const session: AgentSession = {
        id: "s",
        nodeId: "n",
        adapter: "gemini-cli",
        startedAt: new Date(Date.now() - 1000),
        _internal: {
          proc,
          stdout: [],
          exitCode: 0,
          done: true,
          eventQueue: [],
          resolve: null,
          totalCostUsd: 0.01,
          outputText: "stream",
          resultEvent: {
            result: "Final",
            session_id: "sid",
            duration_ms: 999,
            tokenUsage: { input: 10, output: 5 },
          },
          stallTimer: null,
          maxQueueSize: 1000,
        },
      };

      const res = await adapter.getResult(session);
      expect(res.output).toBe("Final");
      expect(res.durationMs).toBe(999);
      expect(res.exitCode).toBe(0);
      expect(res.costUsd).toBe(0.01);
      expect(res.tokenUsage).toEqual({ input: 10, output: 5 });
    });
  });

  describe("resume()", () => {
    it("falls back to cold spawn with feedback appended", async () => {
      mockExecSync.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);
      const proc = makeFakeProc();
      mockSpawn.mockReturnValue(proc);

      const prev: AgentSession = {
        id: "p",
        nodeId: "n",
        adapter: "gemini-cli",
        startedAt: new Date(),
        _internal: {},
      };

      await adapter.resume(
        { adapter: "gemini-cli", model: "gemini-2.5-pro", role: "agent", prompt: "orig" },
        prev,
        "fix it"
      );

      const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
      const promptIdx = args.indexOf("-p");
      const promptValue = args[promptIdx + 1];
      expect(promptValue).toContain("orig");
      expect(promptValue).toContain("fix it");
    });
  });
});
