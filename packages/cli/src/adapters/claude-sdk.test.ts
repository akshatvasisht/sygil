import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeSDKAdapter } from "./claude-sdk.js";

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/claude-agent-sdk with a minimal in-process stub
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  class FakeSession {
    private _aborted = false;
    get finished() { return this._aborted; }

    async send(_msg: string) { /* no-op */ }

    async *events() {
      yield { type: "text_delta", delta: "Hello from stub" };
      yield { type: "cost_update", total_cost_usd: 0.001 };
    }

    async getResult() {
      return { output: "stub output", exitCode: 0, costUsd: 0.001 };
    }

    async abort() {
      this._aborted = true;
    }
  }

  return {
    createSession: vi.fn(async () => new FakeSession()),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeSDKAdapter", () => {
  let adapter: ClaudeSDKAdapter;

  beforeEach(() => {
    adapter = new ClaudeSDKAdapter();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  it("name is 'claude-sdk'", () => {
    expect(adapter.name).toBe("claude-sdk");
  });

  it("isAvailable() returns true when SDK is importable and API key is set", async () => {
    const available = await adapter.isAvailable();
    expect(available).toBe(true);
  });

  it("isAvailable() returns false when ANTHROPIC_API_KEY is not set", async () => {
    const orig = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
    if (orig !== undefined) process.env["ANTHROPIC_API_KEY"] = orig;
  });

  it("spawn() returns a session with correct shape", async () => {
    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Do a test task",
    });
    expect(session).toMatchObject({ nodeId: "test-agent", adapter: "claude-sdk" });
    expect(typeof session.id).toBe("string");
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session._internal).toBeTruthy();
  });

  it("spawn() passes outputSchema to the SDK as outputFormat.json_schema", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional peer dep, not installed in test environment
    const sdkMod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      createSession: ReturnType<typeof vi.fn>;
    };
    sdkMod.createSession.mockClear();
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "schema-node",
      prompt: "emit json",
      outputSchema: schema,
    });
    expect(sdkMod.createSession).toHaveBeenCalledOnce();
    const opts = sdkMod.createSession.mock.calls[0]![0] as { outputFormat?: { type: string; schema: unknown } };
    expect(opts.outputFormat).toEqual({ type: "json_schema", schema });
  });

  it("spawn() threads traceparent as a defaultHeaders entry when SpawnContext is passed", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional peer dep, not installed in test environment
    const sdkMod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      createSession: ReturnType<typeof vi.fn>;
    };
    sdkMod.createSession.mockClear();
    await adapter.spawn(
      { adapter: "claude-sdk", model: "claude-opus-4-5", role: "agent", prompt: "hi" },
      { traceparent: "00-abc-def-01", traceId: "abc", spanId: "def" },
    );
    const opts = sdkMod.createSession.mock.calls[0]![0] as { defaultHeaders?: Record<string, string> };
    expect(opts.defaultHeaders).toEqual({ traceparent: "00-abc-def-01" });
  });

  it("stream() yields text_delta and cost_update events", async () => {
    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Short stub prompt",
    });

    const events = [];
    for await (const event of adapter.stream(session)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "cost_update")).toBe(true);
  });

  it("getResult() returns exitCode 0 and string output", async () => {
    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Stub task",
    });
    for await (const _ of adapter.stream(session)) { /* drain */ }
    const result = await adapter.getResult(session);
    expect(result.exitCode).toBe(0);
    expect(typeof result.output).toBe("string");
    expect(typeof result.durationMs).toBe("number");
  });

  it("kill() calls abort on the session", async () => {
    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Task to kill",
    });
    await expect(adapter.kill(session)).resolves.toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FakeSession internals not typed via AgentSession
    expect((session._internal as any).finished).toBe(true);
  });

  it("stream() yields rate_limit as error event with retryAfterMs", async () => {
    // Override the mock to emit a rate_limit event
    // @ts-ignore -- optional peer dep, not installed in test environment
    const { createSession } = await import("@anthropic-ai/claude-agent-sdk") as { createSession: ReturnType<typeof vi.fn> };
    createSession.mockImplementationOnce(async () => ({
      async send(_msg: string) { /* no-op */ },
      async *events() {
        yield { type: "rate_limit", retryAfterMs: 30000 };
      },
      async getResult() { return { output: "", exitCode: 0 }; },
      async abort() {},
    }));

    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Rate limited",
    });

    const events = [];
    for await (const event of adapter.stream(session)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.message).toContain("rate_limit:30000");
    }
  });

  it("stream() normalizes tool_use and tool_result events", async () => {
    // @ts-ignore -- optional peer dep, not installed in test environment
    const { createSession } = await import("@anthropic-ai/claude-agent-sdk") as { createSession: ReturnType<typeof vi.fn> };
    createSession.mockImplementationOnce(async () => ({
      async send(_msg: string) { /* no-op */ },
      async *events() {
        yield { type: "tool_use", name: "bash", input: { command: "ls" } };
        yield { type: "tool_result", name: "bash", output: "file.txt", is_error: false };
      },
      async getResult() { return { output: "", exitCode: 0 }; },
      async abort() {},
    }));

    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Tool test",
    });

    const events = [];
    for await (const event of adapter.stream(session)) {
      events.push(event);
    }

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toMatchObject({ type: "tool_call", tool: "bash", input: { command: "ls" } });

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ type: "tool_result", tool: "bash", output: "file.txt", success: true });
  });

  it("getResult() includes costUsd and tokenUsage when present", async () => {
    // @ts-ignore -- optional peer dep, not installed in test environment
    const { createSession } = await import("@anthropic-ai/claude-agent-sdk") as { createSession: ReturnType<typeof vi.fn> };
    createSession.mockImplementationOnce(async () => ({
      async send(_msg: string) { /* no-op */ },
      async *events() { /* nothing */ },
      async getResult() {
        return {
          output: "result text",
          exitCode: 0,
          costUsd: 0.05,
          tokenUsage: { input: 1000, output: 500 },
        };
      },
      async abort() {},
    }));

    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Cost test",
    });
    for await (const _ of adapter.stream(session)) { /* drain */ }
    const result = await adapter.getResult(session);

    expect(result.costUsd).toBe(0.05);
    expect(result.tokenUsage).toEqual({ input: 1000, output: 500 });
  });

  it("getResult() omits costUsd when null", async () => {
    // @ts-ignore -- optional peer dep, not installed in test environment
    const { createSession } = await import("@anthropic-ai/claude-agent-sdk") as { createSession: ReturnType<typeof vi.fn> };
    createSession.mockImplementationOnce(async () => ({
      async send(_msg: string) { /* no-op */ },
      async *events() { /* nothing */ },
      async getResult() {
        return { output: "no cost", exitCode: 0 };
      },
      async abort() {},
    }));

    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "No cost",
    });
    for await (const _ of adapter.stream(session)) { /* drain */ }
    const result = await adapter.getResult(session);

    expect(result).not.toHaveProperty("costUsd");
    expect(result).not.toHaveProperty("tokenUsage");
  });

  it("resume() sends a feedback message to the existing session", async () => {
    const session = await adapter.spawn({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "test-agent",
      prompt: "Original task",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FakeSession internals not typed via AgentSession
    const sendSpy = vi.spyOn(session._internal as any, "send");
    const resumed = await adapter.resume(
      { adapter: "claude-sdk", model: "claude-opus-4-5", role: "test-agent", prompt: "Original task" },
      session,
      "Please fix the error"
    );

    expect(sendSpy).toHaveBeenCalledWith("Please fix the error");
    // resume() returns the same session object
    expect(resumed).toBe(session);
  });
});
