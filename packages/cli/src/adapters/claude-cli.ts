import { spawn, execSync } from "node:child_process";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  SpawnContext,
} from "@sygil/shared";
import { finishStream, drainEventQueue, wireStdoutBackpressure, wireSpawnError, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { waitForDoneOrTimeout } from "./await-done.js";
import { buildSpawnEnv, warnOutputSchemaPartial, getCliVersion, KILL_GRACE_PERIOD_MS, GETRESULT_KILL_GRACE_MS, GETRESULT_POLL_INTERVAL_MS, GETRESULT_TIMEOUT_MS, exitCodeToSygilError } from "./constants.js";
import { makeAgentSession } from "./session.js";
import { extractJsonFromOutput } from "./extract-json.js";

interface ClaudeCLIInternal {
  proc: ReturnType<typeof spawn>;
  outputLines: string[];
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  maxQueueSize: number;
  fullOutput?: string;
}

export class ClaudeCLIAdapter implements AgentAdapter {
  readonly name = "claude-cli";

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which claude", { stdio: "ignore" });
    } catch {
      return false;
    }
    // Require an API key — spawning the CLI without one surfaces an auth
    // failure only after the process starts, which the scheduler treats as
    // a crashed node. Better to report unavailable up front.
    if (!process.env["ANTHROPIC_API_KEY"]) return false;
    return true;
  }

  async getVersion(): Promise<string | null> {
    return getCliVersion("claude");
  }

  async spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession> {
    warnOutputSchemaPartial(this.name, config);

    const cwd = config.outputDir ?? process.cwd();
    const tools = (config.tools ?? []).join(",");

    const args: string[] = [
      "-p",
      config.prompt,
      "--model",
      config.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
    ];

    if (tools.length > 0) {
      args.push("--allowedTools", tools);
    }

    if (config.disallowedTools && config.disallowedTools.length > 0) {
      args.push("--disallowedTools", config.disallowedTools.join(","));
    }

    if (config.maxTurns != null) {
      args.push("--max-turns", String(config.maxTurns));
    }

    if (config.role) {
      args.push("--append-system-prompt", config.role);
    }

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSpawnEnv(ctx),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });

    const internal: ClaudeCLIInternal = {
      proc,
      outputLines: [],
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    // Wire up process error handler immediately after spawn.
    // Without this, ENOENT / EACCES errors surface as an unhandled 'error' event.
    wireSpawnError(proc, internal);

    return makeAgentSession(this.name, config.role, internal);
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as ClaudeCLIInternal;
    const { proc } = internal;

    const finish = (): void => finishStream(internal);

    const stderrBuf: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString());
    });

    let stdoutClosed = false;
    // Centralized: decodes UTF-8-safe lines, pushes parsed events in order, and
    // pauses stdout on backpressure (resumed by drainEventQueue on drain).
    const stdoutSink = proc.stdout
      ? wireStdoutBackpressure(
          proc.stdout,
          internal,
          (line) => this.parseLine(line, internal),
          (line) => internal.outputLines.push(line),
        )
      : null;

    // Only the later of `end` and `exit` calls finish(). Calling finish() from
    // both handlers drops the trailing-line events when 'exit' fires first:
    // finish() sets done=true and resolves the drainEventQueue waiter with
    // null, so the generator breaks before a subsequent pushEvent is yielded.
    // The trailing buffer can hold the final NDJSON record for fast-exiting
    // runs (e.g. auth failures that end without a newline).
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

  private parseLine(line: string, internal: ClaudeCLIInternal): AgentEvent[] {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (process.env["SYGIL_DEBUG"]) {
        process.stderr.write(`[claude-cli] malformed NDJSON (first 200 chars): ${line.slice(0, 200)}\n`);
      }
      return [];
    }

    const type = parsed["type"] as string | undefined;
    const events: AgentEvent[] = [];

    switch (type) {
      // Claude Code CLI v2.1+ stream-json format: assistant messages contain content blocks
      case "assistant": {
        const message = parsed["message"] as Record<string, unknown> | undefined;
        const contentBlocks = (message?.["content"] as Array<Record<string, unknown>>) ?? [];
        for (const block of contentBlocks) {
          const blockType = block["type"] as string;
          if (blockType === "text") {
            events.push({ type: "text_delta", text: String(block["text"] ?? "") });
          } else if (blockType === "tool_use") {
            events.push({
              type: "tool_call",
              tool: String(block["name"] ?? ""),
              input: (block["input"] as Record<string, unknown>) ?? {},
            });
          }
        }
        break;
      }

      // Tool results come as "user" messages with tool_result content blocks
      case "user": {
        const message = parsed["message"] as Record<string, unknown> | undefined;
        const contentBlocks = (message?.["content"] as Array<Record<string, unknown>>) ?? [];
        for (const block of contentBlocks) {
          if (block["type"] === "tool_result") {
            const content = block["content"];
            events.push({
              type: "tool_result",
              tool: String(block["tool_use_id"] ?? ""),
              output: typeof content === "string" ? content : JSON.stringify(content),
              success: block["is_error"] !== true,
            });
          }
        }
        break;
      }

      // Final result event — extract output text and cost
      case "result": {
        const cost = Number(parsed["total_cost_usd"] ?? 0);
        if (cost > 0) {
          internal.totalCostUsd = cost;
          events.push({ type: "cost_update", totalCostUsd: cost });
        }
        const resultText = parsed["result"];
        if (typeof resultText === "string" && resultText.length > 0) {
          internal.fullOutput = resultText;
        }
        if (parsed["is_error"] === true) {
          events.push({ type: "error", message: String(parsed["result"] ?? "Unknown error") });
        }
        break;
      }

      case "error":
        events.push({ type: "error", message: String(parsed["message"] ?? parsed["error"] ?? line) });
        break;

      // system, rate_limit_event — ignored
      default:
        break;
    }

    return events;
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as ClaudeCLIInternal;

    if (!internal.done || internal.exitCode === null) {
      await waitForDoneOrTimeout(internal, {
        timeoutMs: GETRESULT_TIMEOUT_MS,
        pollIntervalMs: GETRESULT_POLL_INTERVAL_MS,
        killGraceMs: GETRESULT_KILL_GRACE_MS,
      });
    }

    // Prefer the final result text (from the "result" event) over reconstructed output
    const output = internal.fullOutput ?? "";

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

  async resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string, ctx?: SpawnContext): Promise<AgentSession> {
    const cwd = config.outputDir ?? process.cwd();

    const args: string[] = [
      "--resume",
      previousSession.id,
      "-p",
      feedbackMessage,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
    ];

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSpawnEnv(ctx),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });

    const internal: ClaudeCLIInternal = {
      proc,
      outputLines: [],
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    // Wire up process error handler immediately after spawn.
    wireSpawnError(proc, internal);

    return makeAgentSession(this.name, config.role, internal, { id: previousSession.id });
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as ClaudeCLIInternal;
    if (!internal.done) {
      internal.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (internal.proc.exitCode === null) {
            internal.proc.kill("SIGKILL");
          }
          resolve();
        }, KILL_GRACE_PERIOD_MS);
        internal.proc.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
}
