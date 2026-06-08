/**
 * EchoAdapter — deterministic stub adapter for E2E testing.
 *
 * Spawns `echo-adapter.mjs` as a child process, which outputs NDJSON events
 * in the same wire format as claude-cli. Behavior is controlled via env vars
 * set on the NodeConfig (passed through process.env).
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  SpawnContext,
} from "@sygil/shared";
import { finishStream, drainEventQueue, wireStdoutBackpressure, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { makeAgentSession } from "./session.js";
import { exitCodeToSygilError } from "./constants.js";
import { extractJsonFromOutput } from "./extract-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the echo-adapter.mjs script. */
const ECHO_SCRIPT = resolve(__dirname, "../../test-fixtures/echo-adapter.mjs");

interface EchoInternal {
  proc: ReturnType<typeof spawn>;
  outputLines: string[];
  outputText: string;
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  maxQueueSize: number;
}

export class EchoAdapter implements AgentAdapter {
  readonly name = "echo";

  async isAvailable(): Promise<boolean> {
    try {
      const { access } = await import("node:fs/promises");
      await access(ECHO_SCRIPT);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    return "test-fixture";
  }

  async spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession> {
    const cwd = config.outputDir ?? process.cwd();

    const proc = spawn("node", [ECHO_SCRIPT], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ECHO_PROMPT: config.prompt,
        ECHO_ROLE: config.role,
        ECHO_NODE_ID: config.role,
        ECHO_OUTPUT_DIR: cwd,
        ...(ctx?.traceparent ? { TRACEPARENT: ctx.traceparent } : {}),
      },
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });

    const internal: EchoInternal = {
      proc,
      outputLines: [],
      outputText: "",
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    return makeAgentSession(this.name, config.role, internal);
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as EchoInternal;
    const { proc } = internal;

    const finish = (): void => finishStream(internal);

    const stdoutSink = proc.stdout
      ? wireStdoutBackpressure(
          proc.stdout,
          internal,
          (line) => {
            internal.outputLines.push(line);
            const ev = this.parseLine(line, internal);
            return ev ? [ev] : [];
          },
        )
      : null;

    // finish() must wait for BOTH stdout "end" and process "exit" — whichever
    // arrives last triggers it. The two events have no guaranteed order;
    // finishing on the first would let "exit" resolve the stream before "end"
    // flushes the trailing (newline-less) NDJSON line, dropping it. Mirrors the
    // cursor/codex/gemini adapters' coordination.
    let stdoutClosed = proc.stdout == null;

    proc.stdout?.on("end", () => {
      stdoutSink?.flush();
      stdoutClosed = true;
      if (internal.exitCode !== null) finish();
    });

    proc.on("exit", (code) => {
      internal.exitCode = code ?? 1;
      if (stdoutClosed) finish();
    });

    yield* drainEventQueue(internal);
  }

  private parseLine(line: string, internal: EchoInternal): AgentEvent | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = parsed["type"] as string | undefined;

    switch (type) {
      case "text":
      case "assistant": {
        const text = String(parsed["text"] ?? parsed["content"] ?? "");
        internal.outputText += text;
        return { type: "text_delta", text };
      }

      case "tool_use":
        return {
          type: "tool_call",
          tool: String(parsed["name"] ?? ""),
          input: (parsed["input"] as Record<string, unknown>) ?? {},
        };

      case "tool_result": {
        const content = parsed["content"];
        return {
          type: "tool_result",
          tool: String(parsed["name"] ?? ""),
          output: typeof content === "string" ? content : JSON.stringify(content),
          success: parsed["is_error"] !== true,
        };
      }

      case "cost": {
        const cost = Number(parsed["total_cost_usd"] ?? 0);
        internal.totalCostUsd = cost;
        return { type: "cost_update", totalCostUsd: cost };
      }

      case "error":
        return { type: "error", message: String(parsed["message"] ?? line) };

      default:
        return null;
    }
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as EchoInternal;

    if (!internal.done || internal.exitCode === null) {
      await new Promise<void>((resolve) => {
        internal.proc.on("exit", () => resolve());
      });
    }

    const output = internal.outputText;

    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const exitCode = internal.exitCode ?? 1;

    // Best-effort structured output: attempt to extract the last JSON object from output
    const structuredOutput = output.includes("{")
      ? extractJsonFromOutput(output)
      : undefined;

    const errorCode = exitCodeToSygilError(exitCode);

    return {
      output,
      exitCode,
      durationMs: Date.now() - session.startedAt.getTime(),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async resume(config: NodeConfig, _previousSession: AgentSession, _feedbackMessage: string, ctx?: SpawnContext): Promise<AgentSession> {
    return this.spawn(config, ctx);
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as EchoInternal;
    if (!internal.done) {
      internal.proc.kill("SIGTERM");
    }
  }
}

