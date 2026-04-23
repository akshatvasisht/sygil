import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
} from "@sygil/shared";
import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { waitForDoneOrTimeout } from "./await-done.js";

/** Upper bound on `getResult`'s wait-for-exit poll. Mirrors codex/cursor/gemini
 * adapters. Post-stream teardown should never legitimately
 * exceed this; if it does, force-kill so a hung MCP server can't pin the workflow. */
const CLAUDE_CLI_GETRESULT_TIMEOUT_MS = 10_000;
const GETRESULT_KILL_GRACE_MS = 2_000;
const GETRESULT_POLL_INTERVAL_MS = 50;
/** Grace period after SIGTERM before SIGKILL during explicit `kill()`. Matches
 * `cursor-cli.ts` and `gemini-cli.ts` KILL_GRACE_PERIOD_MS — claude was the
 * outlier at 5_000ms, which made the scheduler's cancel path wait 2.5× longer
 * on this adapter than the others for no documented reason. */
const KILL_GRACE_PERIOD_MS = 2_000;

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
      return true;
    } catch {
      return false;
    }
  }

  async spawn(config: NodeConfig): Promise<AgentSession> {
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
      env: process.env,
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
    proc.on("error", (err) => {
      if (!internal.done) {
        pushEvent(internal, { type: "error", message: `Process spawn failed: ${err.message}` });
        finishStream(internal);
      }
    });

    const session: AgentSession = {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };

    return session;
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as ClaudeCLIInternal;
    const { proc } = internal;

    const push = (ev: AgentEvent): boolean => pushEvent(internal, ev);
    const finish = (): void => finishStream(internal);

    const stderrBuf: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString());
    });

    // StringDecoder buffers incomplete multi-byte UTF-8 sequences across
    // chunk boundaries. Without it, `chunk.toString()` on a chunk that
    // splits mid-emoji (or any multi-byte char) produces U+FFFD replacement
    // characters and corrupts the NDJSON payload — JSON.parse usually still
    // succeeds for string values (replacement char is valid in strings) but
    // the final output text carries permanent mojibake for any non-ASCII
    // content that unluckily lands on a chunk boundary.
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutClosed = false;
    let lineBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += stdoutDecoder.write(chunk);
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        internal.outputLines.push(trimmed);

        for (const event of this.parseLine(trimmed, internal)) {
          push(event);
        }
      }
    });

    // Use the same "last of end+exit calls finish" pattern as codex/cursor/
    // gemini. Calling finish() unconditionally from both handlers drops the
    // 'end' handler's trailing-line events when 'exit' fires first: finish
    // sets `done=true` and resolves the drainEventQueue waiter with null,
    // so the generator breaks before a subsequent pushEvent from the 'end'
    // handler is ever yielded. The trailing line buffer includes the final
    // NDJSON record for fast-exiting runs (e.g. auth failures that end
    // without a newline), which would be silently lost.
    proc.stdout?.on("end", () => {
      lineBuffer += stdoutDecoder.end();
      if (lineBuffer.trim()) {
        internal.outputLines.push(lineBuffer.trim());
        for (const event of this.parseLine(lineBuffer.trim(), internal)) {
          push(event);
        }
      }
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
        // Capture final output text
        const resultText = parsed["result"];
        if (typeof resultText === "string" && resultText.length > 0) {
          internal.fullOutput = resultText;
        }
        // Detect error results
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
        timeoutMs: CLAUDE_CLI_GETRESULT_TIMEOUT_MS,
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

  async resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string): Promise<AgentSession> {
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
      env: process.env,
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
    proc.on("error", (err) => {
      if (!internal.done) {
        pushEvent(internal, { type: "error", message: `Process spawn failed: ${err.message}` });
        finishStream(internal);
      }
    });

    return {
      id: previousSession.id,
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as ClaudeCLIInternal;
    if (!internal.done) {
      internal.proc.kill("SIGTERM");
      // SIGTERM → grace → SIGKILL to guarantee teardown; symmetric with cursor
      // and gemini adapters.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          internal.proc.kill("SIGKILL");
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
