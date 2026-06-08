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
  SpawnContext,
} from "@sygil/shared";
import { STALL_EXIT_CODE } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, wireStdoutBackpressure, wireSpawnError, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { dispatchEventLine, type EventMapping } from "./ndjson-event-mapper.js";
import { waitForDoneOrTimeout } from "./await-done.js";
import { logger } from "../utils/logger.js";
import {
  GETRESULT_KILL_GRACE_MS,
  GETRESULT_POLL_INTERVAL_MS as POLL_INTERVAL_MS,
  GETRESULT_TIMEOUT_MS,
  STALL_GRACE_MS,
  KILL_GRACE_PERIOD_MS,
  exitCodeToSygilError,
  buildSpawnEnv,
  warnOutputSchemaPartial,
  getCliVersion,
} from "./constants.js";
import { makeAgentSession } from "./session.js";
import { extractJsonFromOutput } from "./extract-json.js";

/** Credential file paths checked to verify Cursor authentication. */
const CURSOR_CREDENTIAL_PATHS = [
  ".cursor/credentials.json",
  ".cursor/auth.json",
] as const;

interface CursorInternal {
  proc: ReturnType<typeof spawn>;
  outputLines: string[];
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

  async getVersion(): Promise<string | null> {
    return getCliVersion("agent");
  }

  private buildArgs(prompt: string, config: NodeConfig, resumeSessionId?: string): string[] {
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

  private spawnWithArgs(config: NodeConfig, prompt: string, resumeSessionId?: string, ctx?: SpawnContext): AgentSession {
    const args = this.buildArgs(prompt, config, resumeSessionId);
    const cwd = config.outputDir ?? process.cwd();

    const proc = spawn("agent", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSpawnEnv(ctx),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });

    const internal: CursorInternal = {
      proc,
      outputLines: [],
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

    // Wire up process error handler immediately after spawn.
    // Without this, ENOENT / EACCES errors surface as an unhandled 'error' event.
    wireSpawnError(proc, internal);

    return makeAgentSession(this.name, config.role, internal);
  }

  async spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        "Cursor CLI adapter is not available — ensure 'agent' binary is in PATH and Cursor is authenticated"
      );
    }

    warnOutputSchemaPartial(this.name, config);

    // The cursor CLI has no documented tool allowlist flag; `NodeConfig.tools`
    // is accepted for cross-adapter shape parity but has no runtime effect
    // here. Warn so users don't silently assume tools are sandboxed.
    if (config.tools && config.tools.length > 0) {
      logger.warn(
        `cursor-cli adapter ignores NodeConfig.tools (no upstream allowlist flag): ${config.tools.join(", ")}`
      );
    }

    return this.spawnWithArgs(config, config.prompt, undefined, ctx);
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as CursorInternal;
    const { proc } = internal;

    const finish = (): void => finishStream(internal);

    proc.stderr?.on("data", () => {
      // Silently consume stderr to prevent back-pressure
    });

    let stdoutClosed = false;
    // Centralized: UTF-8-safe line decode, in-order event push, and source
    // pause on backpressure (resumed by drainEventQueue once it drains).
    const stdoutSink = proc.stdout
      ? wireStdoutBackpressure(
          proc.stdout,
          internal,
          (line) => {
            const event = this.parseLine(line, internal);
            return event ? [event] : [];
          },
          (line) => internal.outputLines.push(line),
        )
      : null;

    proc.stdout?.on("end", () => {
      stdoutSink?.flush();
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
            // Classify as NODE_STALLED (not NODE_CRASHED) by giving getResult the
            // stall sentinel exit code before finishing the stream.
            internal.exitCode = STALL_EXIT_CODE;
            pushEvent(internal, { type: "stall", reason: "process_stdout_closed_without_exit" });
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
        timeoutMs: GETRESULT_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        killGraceMs: GETRESULT_KILL_GRACE_MS,
      });
    }

    const outputText = internal.resultEvent?.result ?? internal.outputText;
    // cursor-agent's stream-json emits no dollar-cost field (Cursor bills against
    // the plan, not per-call USD), so costUsd stays undefined rather than a
    // misleading $0. See cursor.com/docs/cli/reference/output-format.
    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const exitCode = internal.exitCode ?? 1;

    // Best-effort structured output: attempt to extract the last JSON object from output
    const structuredOutput = outputText.includes("{")
      ? extractJsonFromOutput(outputText)
      : undefined;

    const errorCode = exitCodeToSygilError(exitCode);

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
        internal.proc.once("exit", () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }
  }

  async resume(
    config: NodeConfig,
    previousSession: AgentSession,
    feedbackMessage: string,
    ctx?: SpawnContext
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
      return this.spawnWithArgs(config, feedbackMessage, sessionId, ctx);
    } else {
      // No session_id available — fall back to cold start with feedback context.
      // Call spawnWithArgs directly to skip the redundant isAvailable() check
      // already performed above; observable behavior is unchanged.
      const newConfig: NodeConfig = {
        ...config,
        prompt: `${config.prompt}\n\nFeedback from previous attempt: ${feedbackMessage}`,
      };
      return this.spawnWithArgs(newConfig, newConfig.prompt, undefined, ctx);
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
