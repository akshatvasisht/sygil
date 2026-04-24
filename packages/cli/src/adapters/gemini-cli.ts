import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
} from "@sygil/shared";
import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { dispatchEventLine, type EventMapping } from "./ndjson-event-mapper.js";
import { waitForDoneOrTimeout } from "./await-done.js";
import { logger } from "../utils/logger.js";
import {
  GETRESULT_KILL_GRACE_MS,
  GETRESULT_POLL_INTERVAL_MS as POLL_INTERVAL_MS,
  STALL_GRACE_MS,
} from "./constants.js";
import { createLineDecoder } from "./ndjson-line-decoder.js";
import { makeAgentSession } from "./session.js";

const KILL_GRACE_PERIOD_MS = 2_000;

/** Upper bound on `getResult`'s wait-for-exit poll. */
const GEMINI_GETRESULT_TIMEOUT_MS = 10_000;

interface GeminiInternal {
  proc: ReturnType<typeof spawn>;
  stdout: string[];
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  outputText: string;
  resultEvent: GeminiResultEvent | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  maxQueueSize: number;
}

interface GeminiResultEvent {
  result: string;
  session_id: string;
  duration_ms: number;
  tokenUsage?: { input: number; output: number; cacheRead?: number };
}

/**
 * GeminiCLIAdapter — wraps google-gemini/gemini-cli in headless mode.
 *
 * Spawn: `gemini -p <prompt> --output-format stream-json [--model <id>] --yolo`
 * --yolo is required for non-interactive runs (matches cursor's --force policy):
 * any tool trust prompt without it will hang the process.
 */
export class GeminiCLIAdapter implements AgentAdapter {
  readonly name = "gemini-cli";

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which gemini", { stdio: "ignore" });
    } catch {
      return false;
    }

    if (process.env["GEMINI_API_KEY"]) return true;

    // Fall back to detecting a local auth directory.
    const authCandidates = [".gemini", ".config/gemini"];
    const authed = authCandidates.some((p) => existsSync(join(homedir(), p)));
    if (!authed) {
      logger.warn(
        "Gemini CLI adapter: 'gemini' binary found but no GEMINI_API_KEY and no ~/.gemini directory. " +
        "Run `gemini auth` or set GEMINI_API_KEY."
      );
      return false;
    }
    return true;
  }

  private _buildArgs(prompt: string, config: NodeConfig): string[] {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--yolo",
    ];
    if (config.model) args.push("--model", config.model);
    return args;
  }

  private _spawnWithArgs(config: NodeConfig, prompt: string): AgentSession {
    const args = this._buildArgs(prompt, config);
    const cwd = config.outputDir ?? process.cwd();

    const proc = spawn("gemini", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const internal: GeminiInternal = {
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
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
    };

    return makeAgentSession(this.name, config.role, internal);
  }

  async spawn(config: NodeConfig): Promise<AgentSession> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        "Gemini CLI adapter is not available — ensure 'gemini' is in PATH and GEMINI_API_KEY (or ~/.gemini) is set"
      );
    }

    // Upstream gemini-cli deprecated `--allowed-tools` in v0.30.0 (2026-02-25)
    // in favor of a policy-engine `--policy <file>` flag that requires a
    // structured JSON policy document. Sygil does not yet generate that file,
    // so `NodeConfig.tools` remains a no-op here. Warn so users don't
    // silently assume tools are sandboxed.
    if (config.tools && config.tools.length > 0) {
      logger.warn(
        `gemini-cli adapter ignores NodeConfig.tools (upstream switched to --policy engine; not yet wired): ${config.tools.join(", ")}`
      );
    }

    return this._spawnWithArgs(config, config.prompt);
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as GeminiInternal;
    const { proc } = internal;

    const push = (ev: AgentEvent): boolean => pushEvent(internal, ev);
    const finish = (): void => finishStream(internal);

    proc.stderr?.on("data", () => {
      // Silently consume stderr to prevent back-pressure.
    });

    let stdoutClosed = false;
    const decoder = createLineDecoder();

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const trimmed of decoder.feed(chunk)) {
        internal.stdout.push(trimmed);
        const event = this.parseLine(trimmed, internal);
        if (event) push(event);
      }
    });

    proc.stdout?.on("end", () => {
      const trailing = decoder.flush();
      if (trailing) {
        internal.stdout.push(trailing);
        const event = this.parseLine(trailing, internal);
        if (event) push(event);
      }
      stdoutClosed = true;

      if (internal.exitCode !== null) {
        finish();
      } else {
        internal.stallTimer = setTimeout(() => {
          internal.stallTimer = null;
          if (!internal.done) {
            push({ type: "stall", reason: "process_stdout_closed_without_exit" });
            finish();
          }
        }, STALL_GRACE_MS);
      }
    });

    proc.on("exit", (code) => {
      internal.exitCode = code ?? 1;
      if (internal.stallTimer !== null) {
        clearTimeout(internal.stallTimer);
        internal.stallTimer = null;
      }
      if (stdoutClosed) finish();
    });

    yield* drainEventQueue(internal);
  }

  private parseLine(line: string, internal: GeminiInternal): AgentEvent | null {
    return dispatchEventLine(line, GEMINI_EVENT_MAPPING, internal);
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as GeminiInternal;

    if (!internal.done || internal.exitCode === null) {
      await waitForDoneOrTimeout(internal, {
        timeoutMs: GEMINI_GETRESULT_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        killGraceMs: GETRESULT_KILL_GRACE_MS,
      });
    }

    const outputText = internal.resultEvent?.result ?? internal.outputText;
    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const exitCode = internal.exitCode ?? 1;
    const tokenUsage = internal.resultEvent?.tokenUsage;

    let errorCode: SygilErrorCode | undefined;
    if (exitCode === STALL_EXIT_CODE) {
      errorCode = SygilErrorCode.NODE_STALLED;
    } else if (exitCode === 124) {
      errorCode = SygilErrorCode.NODE_TIMEOUT;
    } else if (exitCode !== 0) {
      errorCode = SygilErrorCode.NODE_CRASHED;
    }

    return {
      output: outputText,
      exitCode,
      durationMs: internal.resultEvent?.duration_ms ?? (Date.now() - session.startedAt.getTime()),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as GeminiInternal;
    // Guard on process liveness rather than internal.done. The stall path sets
    // done=true before the process exits, so an `if (!internal.done)` check
    // would skip termination and leak the child. `proc.killed` only means
    // "signal was sent", not "process exited" — `proc.exitCode === null` is
    // the only reliable liveness signal.
    if (internal.proc.exitCode === null) {
      // Clear any pending stall timer before killing so a stall event can't
      // fire during the SIGTERM→SIGKILL grace window and land in the NDJSON
      // replay stream after the scheduler has already decided to kill.
      if (internal.stallTimer !== null) {
        clearTimeout(internal.stallTimer);
        internal.stallTimer = null;
      }
      internal.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killTimeout = setTimeout(() => {
          if (internal.proc.exitCode === null) {
            internal.proc.kill("SIGKILL");
          }
          resolve();
        }, KILL_GRACE_PERIOD_MS);
        internal.proc.on("exit", () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }
  }

  async resume(
    config: NodeConfig,
    _previousSession: AgentSession,
    feedbackMessage: string
  ): Promise<AgentSession> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error("Gemini CLI adapter is not available");
    }
    // Gemini CLI does not expose a session-resume flag in headless mode yet.
    // Fall back to a cold spawn with the feedback appended to the prompt.
    const newConfig: NodeConfig = {
      ...config,
      prompt: `${config.prompt}\n\nFeedback from previous attempt: ${feedbackMessage}`,
    };
    return this.spawn(newConfig);
  }
}

const handleToolCall = (raw: Record<string, unknown>): AgentEvent | null => {
  const name = String(raw["name"] ?? raw["tool"] ?? "");
  const input = (raw["args"] ?? raw["input"] ?? {}) as Record<string, unknown>;
  if (!name) return null;
  return { type: "tool_call", tool: name, input };
};

const GEMINI_EVENT_MAPPING: EventMapping<Record<string, unknown>, GeminiInternal> = {
  init: () => null,

  message: (raw, internal) => {
    const role = raw["role"] as string | undefined;
    if (role && role !== "assistant") return null;
    const content = raw["content"] ?? raw["text"];
    if (typeof content === "string" && content) {
      internal.outputText += content;
      return { type: "text_delta", text: content };
    }
    if (Array.isArray(content)) {
      let concatenated = "";
      for (const block of content as Array<Record<string, unknown>>) {
        const t = block["type"] as string | undefined;
        if (t === "text" && typeof block["text"] === "string") {
          concatenated += block["text"] as string;
        }
      }
      if (concatenated) {
        internal.outputText += concatenated;
        return { type: "text_delta", text: concatenated };
      }
    }
    return null;
  },

  tool_use: handleToolCall,
  tool_call: handleToolCall,

  tool_result: (raw) => {
    const name = String(raw["name"] ?? raw["tool_use_id"] ?? "");
    const output = raw["output"] ?? raw["content"] ?? "";
    const error = raw["error"];
    return {
      type: "tool_result",
      tool: name,
      output: typeof output === "string" ? output : JSON.stringify(output),
      success: !error,
    };
  },

  error: (raw) => ({
    type: "error",
    message: String(raw["message"] ?? raw["error"] ?? "unknown error"),
  }),

  result: (raw, internal) => {
    const usage = raw["usage"] as Record<string, unknown> | undefined;
    const cost = Number(raw["cost_usd"] ?? raw["costUsd"] ?? 0);
    const tokenUsage = usage
      ? {
          input: Number(usage["input_tokens"] ?? usage["inputTokens"] ?? 0),
          output: Number(usage["output_tokens"] ?? usage["outputTokens"] ?? 0),
          ...(usage["cache_read_tokens"] !== undefined
            ? { cacheRead: Number(usage["cache_read_tokens"]) }
            : {}),
        }
      : undefined;

    internal.resultEvent = {
      result: String(raw["result"] ?? raw["response"] ?? internal.outputText),
      session_id: String(raw["session_id"] ?? ""),
      duration_ms: Number(raw["duration_ms"] ?? 0),
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    };

    if (cost > 0) {
      internal.totalCostUsd = cost;
      return { type: "cost_update", totalCostUsd: cost };
    }
    return null;
  },
};
