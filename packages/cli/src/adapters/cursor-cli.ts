import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
} from "@sigil/shared";
import { SigilErrorCode, STALL_EXIT_CODE } from "@sigil/shared";
import { pushEvent, finishStream, drainEventQueue, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { logger } from "../utils/logger.js";

/** Grace period in ms before emitting a stall event after stdout closes without process exit */
const STALL_GRACE_MS = 5_000;

/** Grace period before SIGKILL after SIGTERM during kill(). */
const KILL_GRACE_PERIOD_MS = 2_000;

/** Polling interval while waiting for process exit in getResult(). */
const POLL_INTERVAL_MS = 50;

/** Credential file paths checked to verify Cursor authentication. */
const CURSOR_CREDENTIAL_PATHS = [
  ".cursor/credentials.json",
  ".cursor/auth.json",
] as const;

/** Tools that require the --force flag in Cursor headless mode. */
const FORCE_TOOLS = ["Write", "Edit", "Bash"] as const;

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

    // Check for Cursor authentication credentials
    const credentialsPaths = CURSOR_CREDENTIAL_PATHS.map((p) => join(homedir(), p));

    const isAuthenticated = credentialsPaths.some((p) => existsSync(p));
    if (!isAuthenticated) {
      logger.warn(
        "Cursor CLI adapter: 'agent' binary found but Cursor is not authenticated. " +
        "Please sign in to Cursor first (~/.cursor/credentials.json not found)."
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

    args.push("-p", prompt, "--output-format", "stream-json", "--trust");

    if (config.model) args.push("--model", config.model);

    if (config.tools?.length) {
      // Cursor doesn't have granular tool flags — only --force for writes.
      // If Write, Edit, or Bash is in allowed tools, add --force.
      if (config.tools.some((t) => (FORCE_TOOLS as readonly string[]).includes(t))) {
        args.push("--force");
      }
    }

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

    const session: AgentSession = {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };

    return session;
  }

  async spawn(config: NodeConfig): Promise<AgentSession> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        "Cursor CLI adapter is not available — ensure 'agent' binary is in PATH and Cursor is authenticated"
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
    let lineBuffer = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        internal.stdout.push(trimmed);

        const event = this.parseLine(trimmed, internal);
        if (event) push(event);
      }
    });

    proc.stdout?.on("end", () => {
      if (lineBuffer.trim()) {
        internal.stdout.push(lineBuffer.trim());
        const event = this.parseLine(lineBuffer.trim(), internal);
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = parsed["type"] as string | undefined;

    switch (type) {
      case "system":
        // { type: "system", subtype: "init" } — skip
        return null;

      case "assistant": {
        const message = parsed["message"] as Record<string, unknown> | undefined;
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

            // writeToolCall subtype — surface as file_write
            const subtype = block["subtype"] as string | undefined;
            if (subtype === "writeToolCall") {
              return { type: "file_write", path: String(input["path"] ?? "") };
            }

            // readToolCall subtype — skip (read-only, no need to surface)
            if (subtype === "readToolCall") {
              return null;
            }

            return { type: "tool_call", tool: toolName, input };
          }
        }
        return null;
      }

      case "tool": {
        // { type: "tool", tool_use_id: "...", content: "..." }
        const content = parsed["content"];
        return {
          type: "tool_result",
          tool: String(parsed["tool_use_id"] ?? ""),
          output: typeof content === "string" ? content : JSON.stringify(content),
          success: true,
        };
      }

      case "result": {
        const subtype = parsed["subtype"] as string | undefined;
        if (subtype === "success") {
          // Capture result event for getResult()
          internal.resultEvent = {
            result: String(parsed["result"] ?? ""),
            session_id: String(parsed["session_id"] ?? ""),
            duration_ms: Number(parsed["duration_ms"] ?? 0),
          };
          return null;
        }
        if (subtype === "error") {
          return { type: "error", message: String(parsed["error"] ?? "unknown error") };
        }
        return null;
      }

      default:
        return null;
    }
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as CursorInternal;

    if (!internal.done || internal.exitCode === null) {
      // Poll rather than listening for "exit" because the stall path marks done=true
      // without the process exiting — we need to handle both cases.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (internal.done) resolve();
          else setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
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
    let errorCode: SigilErrorCode | undefined;
    if (exitCode === STALL_EXIT_CODE) {
      errorCode = SigilErrorCode.NODE_STALLED;
    } else if (exitCode === 124) {
      errorCode = SigilErrorCode.NODE_TIMEOUT;
    } else if (exitCode !== 0) {
      errorCode = SigilErrorCode.NODE_CRASHED;
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
    if (!internal.done) {
      internal.proc.kill("SIGTERM");
      // Wait up to 2s then SIGKILL if still running
      await new Promise<void>((resolve) => {
        const killTimeout = setTimeout(() => {
          if (!internal.done) {
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
