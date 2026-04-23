import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalOaiAdapter } from "./local-oai.js";
import type { AgentSession } from "@sygil/shared";

function sseChunks(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        const line = c === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(c)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

async function drain(adapter: LocalOaiAdapter, session: AgentSession): Promise<Array<{ type: string } & Record<string, unknown>>> {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const ev of adapter.stream(session)) {
    events.push(ev as { type: string } & Record<string, unknown>);
  }
  return events;
}

describe("LocalOaiAdapter", () => {
  let adapter: LocalOaiAdapter;
  let savedUrl: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    adapter = new LocalOaiAdapter();
    savedUrl = process.env["SYGIL_LOCAL_OAI_URL"];
    savedKey = process.env["SYGIL_LOCAL_OAI_KEY"];
    delete process.env["SYGIL_LOCAL_OAI_URL"];
    delete process.env["SYGIL_LOCAL_OAI_KEY"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedUrl === undefined) delete process.env["SYGIL_LOCAL_OAI_URL"];
    else process.env["SYGIL_LOCAL_OAI_URL"] = savedUrl;
    if (savedKey === undefined) delete process.env["SYGIL_LOCAL_OAI_KEY"];
    else process.env["SYGIL_LOCAL_OAI_KEY"] = savedKey;
  });

  describe("isAvailable()", () => {
    it("returns true when /models responds 200", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true } as Response));
      vi.stubGlobal("fetch", fetchMock);
      expect(await adapter.isAvailable()).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:11434/v1/models",
        expect.any(Object)
      );
    });

    it("returns false when fetch throws (timeout / offline)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("uses SYGIL_LOCAL_OAI_URL override", async () => {
      process.env["SYGIL_LOCAL_OAI_URL"] = "http://localhost:8080/v1";
      const fetchMock = vi.fn(async () => ({ ok: true } as Response));
      vi.stubGlobal("fetch", fetchMock);
      await adapter.isAvailable();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/models",
        expect.any(Object)
      );
    });
  });

  describe("streaming", () => {
    it("accumulates text_delta events and exposes outputText in getResult", async () => {
      const body = sseChunks([
        { choices: [{ delta: { role: "assistant", content: "Hello " } }] },
        { choices: [{ delta: { content: "world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 2 } },
        "[DONE]",
      ]);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body, status: 200 } as unknown as Response)));

      const session = await adapter.spawn({
        adapter: "local-oai",
        model: "llama3.2",
        role: "agent",
        prompt: "hi",
      });

      const events = await drain(adapter, session);
      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas).toHaveLength(2);
      expect(deltas.map((e) => e["text"]).join("")).toBe("Hello world");

      const cost = events.find((e) => e.type === "cost_update");
      expect(cost).toMatchObject({ type: "cost_update", totalCostUsd: 0 });

      const result = await adapter.getResult(session);
      expect(result.output).toBe("Hello world");
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBe(0);
      expect(result.tokenUsage).toEqual({ input: 3, output: 2 });
    });

    it("merges tool_call fragments across multiple deltas and emits tool_call on finish_reason=tool_calls", async () => {
      const body = sseChunks([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calc" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ",\"b\":2}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body, status: 200 } as unknown as Response)));

      const session = await adapter.spawn({
        adapter: "local-oai",
        model: "llama3.2",
        role: "agent",
        prompt: "use calc",
        tools: ["calc"],
      });

      const events = await drain(adapter, session);
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({ type: "tool_call", tool: "calc", input: { a: 1, b: 2 } });
    });

    it("emits error event on non-OK response", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, body: null } as unknown as Response)));

      const session = await adapter.spawn({
        adapter: "local-oai",
        model: "llama3.2",
        role: "agent",
        prompt: "hi",
      });

      const events = await drain(adapter, session);
      expect(events.some((e) => e.type === "error")).toBe(true);

      const result = await adapter.getResult(session);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("kill()", () => {
    it("aborts the fetch and marks done", async () => {
      // Build a body that never closes on its own so kill is the thing that ends it.
      const body = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue; wait for abort.
        },
      });
      const fetchMock = vi.fn(async (_url: string, opts: { signal: AbortSignal }) => {
        return new Promise<Response>((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
          // Also resolve after a tick to start body consumption.
          setTimeout(() => resolve({ ok: true, body, status: 200 } as unknown as Response), 5);
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const session = await adapter.spawn({
        adapter: "local-oai",
        model: "llama3.2",
        role: "agent",
        prompt: "hi",
      });

      // Yield once for spawn() microtasks.
      await new Promise((r) => setTimeout(r, 10));
      await adapter.kill(session);

      const internal = session._internal as { done: boolean; exitCode: number | null };
      expect(internal.done).toBe(true);
      expect(internal.exitCode).not.toBe(0);
    });
  });
});
