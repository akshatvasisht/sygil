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

/** Grace period before SIGKILL after SIGTERM during kill(). */
const KILL_GRACE_PERIOD_MS = 2_000;

/** Upper bound on `getResult`'s wait-for-exit poll. Post-stream
 * teardown should never legitimately exceed this; if it does, we force-kill so
 * the workflow isn't pinned forever by an MCP server that pins the child. */
const CURSOR_GETRESULT_TIMEOUT_MS = 10_000;

/** Credential file paths checked to verify Cursor authentication. */
const CURSOR_CREDENTIAL_PATHS = [
  ".cursor/credentials.json",
  ".cursor/auth.json",
] as const;

interface CursorInternal {
  proc: ReturnType<typeof spawn>;
  stdout: string[];
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  outputText: string;
  resultEvent: CursorResultEvent | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  maxQueueSize: number;
}

interface CursorResultEvent {
  result: string;
  session_id: string;
  duration_ms: number;
}

/**
 * CursorCLIAdapter — Beta implementation.
 *
 * Cursor's headless CLI uses the `agent` binary (not `cursor`).
 * Known stability issue: the process can hang after stdout closes without exiting
 * in headless mode. Mitigated with a STALL_GRACE_MS timeout before emitting stall.
 */
export class CursorCLIAdapter implements AgentAdapter {
  readonly name = "cursor-cli";

  async isAvailable(): Promise<boolean> {
    // Check if the `agent` binary is in PATH
    try {
      execSync("which agent", { stdio: "ignore" });
    } catch {
      return false;
    }

    // CURSOR_API_KEY bypasses the credential-file check
    if (process.env["CURSOR_API_KEY"]) {
      return true;
    }

    // Check for Cursor authentication credentials
    const credentialsPaths = CURSOR_CREDENTIAL_PATHS.map((p) => join(homedir(), p));

    const isAuthenticated = credentialsPaths.some((p) => existsSync(p));
    if (!isAuthenticated) {
      logger.warn(
        "Cursor CLI adapter: 'agent' binary found but Cursor is not authenticated. " +
        "Please sign in to Cursor first or set CURSOR_API_KEY."
      );
      return false;
    }

    return true;
  }

  private _buildArgs(prompt: string, config: NodeConfig, resumeSessionId?: string): string[] {
    const args: string[] = [];

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    // --force is always required in headless mode: without it, any interactive
    // trust prompt (including MCP tool invocations, not just writes) hangs the
    // process indefinitely. See forum.cursor.com/t/150246 and cursor.com/docs/cli/headless.
    args.push("-p", prompt, "--output-format", "stream-json", "--trust", "--force");

    if (config.model) args.push("--model", config.model);

    if (config.outputDir) args.push("--cwd", config.outputDir);

    return args;
  }

  private _spawnWithArgs(config: NodeConfig, prompt: string, resumeSessionId?: string): AgentSession {
    const args = this._buildArgs(prompt, config, resumeSessionId);
    const cwd = config.outputDir ?? process.cwd();

    const proc = spawn("agent", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const internal: CursorInternal = {
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
        "Cursor CLI adapter is not available — ensure 'agent' binary is in PATH and Cursor is authenticated"
      );
    }

    // The cursor CLI has no documented tool allowlist flag; `NodeConfig.tools`
    // is accepted for cross-adapter shape parity but has no runtime effect
    // here. Warn so users don't silently assume tools are sandboxed.
    if (config.tools && config.tools.length > 0) {
      logger.warn(
        `cursor-cli adapter ignores NodeConfig.tools (no upstream allowlist flag): ${config.tools.join(", ")}`
      );
    }

    return this._spawnWithArgs(config, config.prompt);
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as CursorInternal;
    const { proc } = internal;

    const push = (ev: AgentEvent): boolean => pushEvent(internal, ev);
    const finish = (): void => finishStream(internal);

    proc.stderr?.on("data", () => {
      // Silently consume stderr to prevent back-pressure
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
        // Cursor headless mode can hang after stdout closes without process exit.
        // Emit a stall signal after STALL_GRACE_MS rather than killing immediately —
        // the scheduler decides how to respond (retry, abort, etc.).
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
      if (stdoutClosed) {
        finish();
      }
      // stdout "end" fires before or after "exit" — the last one to arrive calls finish()
    });

    yield* drainEventQueue(internal);
  }

  private parseLine(line: string, internal: CursorInternal): AgentEvent | null {
    return dispatchEventLine(line, CURSOR_EVENT_MAPPING, internal);
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as CursorInternal;

    if (!internal.done || internal.exitCode === null) {
      await waitForDoneOrTimeout(internal, {
        timeoutMs: CURSOR_GETRESULT_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        killGraceMs: GETRESULT_KILL_GRACE_MS,
      });
    }

    const outputText = internal.resultEvent?.result ?? internal.outputText;
    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const exitCode = internal.exitCode ?? 1;

    // Best-effort structured output: attempt to extract the last JSON object from output
    const structuredOutput = outputText.includes("{")
      ? extractJsonFromOutput(outputText)
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
      output: outputText,
      exitCode,
      durationMs: internal.resultEvent?.duration_ms ?? (Date.now() - session.startedAt.getTime()),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as CursorInternal;
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
    previousSession: AgentSession,
    feedbackMessage: string
  ): Promise<AgentSession> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        "Cursor CLI adapter is not available — ensure 'agent' binary is in PATH and Cursor is authenticated"
      );
    }

    const prev = previousSession._internal as CursorInternal;
    const sessionId = prev.resultEvent?.session_id;

    if (sessionId) {
      // Resume the previous conversation using --resume <session_id>
      return this._spawnWithArgs(config, feedbackMessage, sessionId);
    } else {
      // No session_id available — fall back to cold start with feedback context
      const newConfig: NodeConfig = {
        ...config,
        prompt: `${config.prompt}\n\nFeedback from previous attempt: ${feedbackMessage}`,
      };
      return this.spawn(newConfig);
    }
  }
}

const CURSOR_EVENT_MAPPING: EventMapping<Record<string, unknown>, CursorInternal> = {
  system: () => null,

  assistant: (raw, internal) => {
    const message = raw["message"] as Record<string, unknown> | undefined;
    if (!message) return null;
    const content = message["content"];
    if (!Array.isArray(content)) return null;

    for (const block of content as Array<Record<string, unknown>>) {
      const blockType = block["type"] as string | undefined;

      if (blockType === "text") {
        const text = String(block["text"] ?? "");
        if (text) {
          internal.outputText += text;
          return { type: "text_delta", text };
        }
      }

      if (blockType === "tool_use") {
        const toolName = String(block["name"] ?? "");
        const input = (block["input"] as Record<string, unknown>) ?? {};
        const subtype = block["subtype"] as string | undefined;
        if (subtype === "writeToolCall") {
          return { type: "file_write", path: String(input["path"] ?? "") };
        }
        if (subtype === "readToolCall") return null;
        return { type: "tool_call", tool: toolName, input };
      }
    }
    return null;
  },

  tool: (raw) => {
    const content = raw["content"];
    return {
      type: "tool_result",
      tool: String(raw["tool_use_id"] ?? ""),
      output: typeof content === "string" ? content : JSON.stringify(content),
      success: true,
    };
  },

  result: (raw, internal) => {
    const subtype = raw["subtype"] as string | undefined;
    if (subtype === "success") {
      internal.resultEvent = {
        result: String(raw["result"] ?? ""),
        session_id: String(raw["session_id"] ?? ""),
        duration_ms: Number(raw["duration_ms"] ?? 0),
      };
      return null;
    }
    if (subtype === "error") {
      return { type: "error", message: String(raw["error"] ?? "unknown error") };
    }
    return null;
  },
};

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
