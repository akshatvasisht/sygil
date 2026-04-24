import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  SpawnContext,
} from "@sygil/shared";
import { SygilErrorCode } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";

const DEFAULT_BASE_URL = "http://localhost:11434/v1"; // Ollama default
const DEFAULT_API_KEY = "ollama"; // sentinel; servers ignore but SDKs require a value
const AVAILABILITY_PROBE_TIMEOUT_MS = 1_000;

interface LocalOaiInternal {
  abortController: AbortController;
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  outputText: string;
  tokenUsage?: { input: number; output: number; cacheRead?: number };
  startedAt: number;
  maxQueueSize: number;
  error?: Error;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface OaiDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OaiChunk {
  choices?: Array<{
    delta?: OaiDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * LocalOaiAdapter — OpenAI Chat Completions compatible HTTP adapter.
 *
 * Works with any server that implements the OpenAI streaming /v1/chat/completions
 * contract: Ollama, llama.cpp server, vLLM, LM Studio, LiteLLM gateway, OpenRouter, etc.
 * No child process is spawned — streaming happens over fetch() SSE.
 *
 * Tool support: the model's tool_call requests are surfaced as AgentEvents, but the
 * adapter does not execute tools. Workflow authors handle tool dispatch via downstream
 * nodes or a gated sub-workflow.
 */
export class LocalOaiAdapter implements AgentAdapter {
  readonly name = "local-oai";

  private _resolveEndpoint(config: NodeConfig): { baseUrl: string; apiKey: string } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NodeConfig lacks an adapterOptions surface today; read through unknown
    const opts = (config as any).adapterOptions?.localOai as
      | { baseUrl?: string; apiKey?: string }
      | undefined;
    const baseUrl =
      opts?.baseUrl ?? process.env["SYGIL_LOCAL_OAI_URL"] ?? DEFAULT_BASE_URL;
    const apiKey =
      opts?.apiKey ?? process.env["SYGIL_LOCAL_OAI_KEY"] ?? DEFAULT_API_KEY;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
  }

  async isAvailable(): Promise<boolean> {
    const baseUrl =
      process.env["SYGIL_LOCAL_OAI_URL"]?.replace(/\/+$/, "") ?? DEFAULT_BASE_URL;
    const apiKey = process.env["SYGIL_LOCAL_OAI_KEY"] ?? DEFAULT_API_KEY;
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(AVAILABILITY_PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession> {
    const { baseUrl, apiKey } = this._resolveEndpoint(config);
    const internal: LocalOaiInternal = {
      abortController: new AbortController(),
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      outputText: "",
      startedAt: Date.now(),
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    const session: AgentSession = {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };

    // Fire the request but don't await — stream() drives the SSE reader.
    this._startRequest(config, internal, baseUrl, apiKey, ctx).catch((err: unknown) => {
      // If kill() already finished the stream (e.g. user cancelled), don't
      // overwrite its exitCode (130) with 1 and don't push a spurious error
      // event — the scheduler has already decided this was a kill, not a crash.
      // Symmetric with the stallTimer-vs-kill race guards in cursor/gemini.
      if (internal.done) return;
      internal.error = err instanceof Error ? err : new Error(String(err));
      internal.exitCode = 1;
      pushEvent(internal, { type: "error", message: internal.error.message });
      finishStream(internal);
    });

    return session;
  }

  private async _startRequest(
    config: NodeConfig,
    internal: LocalOaiInternal,
    baseUrl: string,
    apiKey: string,
    ctx?: SpawnContext,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "user", content: config.prompt }],
      stream: true,
      stream_options: { include_usage: true },
    };

    if (config.tools?.length) {
      body["tools"] = config.tools.map((name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      }));
    }

    if (config.outputSchema) {
      // OpenAI strict mode: requires `parallel_tool_calls: false` and a
      // schema name matching `^[a-zA-Z0-9_-]+$`. Derive from role; fall back
      // to "output". The underlying schema is passed verbatim — authors must
      // conform to OpenAI's JSON-Schema subset (documented in CLAUDE.md).
      const sanitizedName = config.role.replace(/[^a-zA-Z0-9_-]/g, "_") || "output";
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: sanitizedName,
          strict: true,
          schema: config.outputSchema,
        },
      };
      body["parallel_tool_calls"] = false;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (ctx?.traceparent) {
      headers["traceparent"] = ctx.traceparent;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: internal.abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}`);
    }

    await this._consumeSse(res.body, internal);
    internal.exitCode = 0;
    finishStream(internal);
  }

  private async _consumeSse(
    body: ReadableStream<Uint8Array>,
    internal: LocalOaiInternal
  ): Promise<void> {
    const toolCalls = new Map<number, ToolCallAccumulator>();

    const parser = createParser({
      onEvent: (event) => {
        const payload = event.data;
        if (!payload || payload === "[DONE]") return;
        let chunk: OaiChunk;
        try {
          chunk = JSON.parse(payload) as OaiChunk;
        } catch {
          return;
        }
        this._handleChunk(chunk, internal, toolCalls);
      },
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }

    // Flush any completed tool-call accumulators that never saw a finish_reason.
    for (const tc of toolCalls.values()) {
      if (tc.name) {
        pushEvent(internal, {
          type: "tool_call",
          tool: tc.name,
          input: this._parseArgs(tc.arguments),
        });
      }
    }
  }

  private _handleChunk(
    chunk: OaiChunk,
    internal: LocalOaiInternal,
    toolCalls: Map<number, ToolCallAccumulator>
  ): void {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content) {
      internal.outputText += delta.content;
      pushEvent(internal, { type: "text_delta", text: delta.content });
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        toolCalls.set(tc.index, existing);
      }
    }

    if (choice?.finish_reason === "tool_calls") {
      for (const tc of toolCalls.values()) {
        if (tc.name) {
          pushEvent(internal, {
            type: "tool_call",
            tool: tc.name,
            input: this._parseArgs(tc.arguments),
          });
        }
      }
      toolCalls.clear();
    }

    if (chunk.usage) {
      internal.tokenUsage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
      };
      // Local servers report no cost — emit zero to keep downstream consumers simple.
      pushEvent(internal, { type: "cost_update", totalCostUsd: 0 });
    }
  }

  private _parseArgs(raw: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { _raw: raw };
    }
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as LocalOaiInternal;
    yield* drainEventQueue(internal);
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as LocalOaiInternal;

    if (!internal.done) {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (internal.done) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    }

    const exitCode = internal.exitCode ?? 1;
    let errorCode: SygilErrorCode | undefined;
    if (exitCode !== 0) errorCode = SygilErrorCode.NODE_CRASHED;

    return {
      output: internal.outputText,
      exitCode,
      durationMs: Date.now() - internal.startedAt,
      costUsd: 0,
      ...(internal.tokenUsage !== undefined ? { tokenUsage: internal.tokenUsage } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as LocalOaiInternal;
    if (!internal.done) {
      internal.abortController.abort();
      internal.exitCode = internal.exitCode ?? 130;
      finishStream(internal);
    }
  }

  async resume(
    config: NodeConfig,
    previousSession: AgentSession,
    feedbackMessage: string,
    ctx?: SpawnContext,
  ): Promise<AgentSession> {
    const prev = previousSession._internal as LocalOaiInternal;
    const newConfig: NodeConfig = {
      ...config,
      prompt: [
        config.prompt,
        prev.outputText ? `\n\nPrevious response:\n${prev.outputText}` : "",
        `\n\nFeedback: ${feedbackMessage}`,
      ].join(""),
    };
    return this.spawn(newConfig, ctx);
  }
}
