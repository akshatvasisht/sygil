/**
 * EchoAdapter — deterministic stub adapter for E2E testing.
 *
 * Spawns `echo-adapter.mjs` as a child process, which outputs NDJSON events
 * in the same wire format as claude-cli. Behavior is controlled via env vars
 * set on the NodeConfig (passed through process.env).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the echo-adapter.mjs script. */
const ECHO_SCRIPT = resolve(__dirname, "../../test-fixtures/echo-adapter.mjs");

interface EchoInternal {
  proc: ReturnType<typeof spawn>;
  outputLines: string[];
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
    });

    const internal: EchoInternal = {
      proc,
      outputLines: [],
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    return {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as EchoInternal;
    const { proc } = internal;

    const push = (ev: AgentEvent): boolean => pushEvent(internal, ev);
    const finish = (): void => finishStream(internal);

    let lineBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        internal.outputLines.push(trimmed);
        const event = this.parseLine(trimmed, internal);
        if (event) push(event);
      }
    });

    proc.stdout?.on("end", () => {
      if (lineBuffer.trim()) {
        internal.outputLines.push(lineBuffer.trim());
        const event = this.parseLine(lineBuffer.trim(), internal);
        if (event) push(event);
      }
      finish();
    });

    proc.on("exit", (code) => {
      internal.exitCode = code ?? 1;
      finish();
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
      case "assistant":
        return { type: "text_delta", text: String(parsed["text"] ?? parsed["content"] ?? "") };

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

    const output = internal.outputLines
      .filter((l) => {
        try {
          const p = JSON.parse(l) as Record<string, unknown>;
          return p["type"] === "text" || p["type"] === "assistant";
        } catch {
          return false;
        }
      })
      .map((l) => {
        try {
          const p = JSON.parse(l) as Record<string, unknown>;
          return String(p["text"] ?? p["content"] ?? "");
        } catch {
          return l;
        }
      })
      .join("");

    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const exitCode = internal.exitCode ?? 1;

    // Best-effort structured output: attempt to extract the last JSON object from output
    const structuredOutput = output.includes("{")
      ? extractJsonFromOutput(output)
      : undefined;

    // Map exit code to structured error code
    let errorCode: SygilErrorCode | undefined;
    if (exitCode === STALL_EXIT_CODE) {
      errorCode = SygilErrorCode.NODE_STALLED;
    } else if (exitCode === 124) {
      errorCode = SygilErrorCode.NODE_TIMEOUT;
    } else if (exitCode !== 0) {
      errorCode = SygilErrorCode.NODE_CRASHED;
    }

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

/**
 * Best-effort: try to extract the last JSON object from a text string.
 * Iterates candidate matches from last to first, returning the first that parses.
 */
function extractJsonFromOutput(text: string): unknown | undefined {
  const matches = text.match(/\{[\s\S]*\}/g);
  if (!matches) return undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i]!);
    } catch {
      continue;
    }
  }
  return undefined;
}
