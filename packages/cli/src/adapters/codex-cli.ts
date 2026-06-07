import { spawn, execSync } from "node:child_process";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
  SpawnContext,
} from "@sygil/shared";
import { STALL_EXIT_CODE } from "@sygil/shared";
import { pushEvent, finishStream, drainEventQueue, wireStdoutBackpressure, DEFAULT_QUEUE_HIGH_WATER_MARK } from "./ndjson-stream.js";
import { dispatchEventLine, type EventMapping } from "./ndjson-event-mapper.js";
import { waitForDoneOrTimeout } from "./await-done.js";
import { logger } from "../utils/logger.js";
import {
  GETRESULT_KILL_GRACE_MS,
  GETRESULT_POLL_INTERVAL_MS,
  GETRESULT_TIMEOUT_MS,
  STALL_GRACE_MS,
  exitCodeToSygilError,
} from "./constants.js";
import { makeAgentSession } from "./session.js";
import { extractJsonFromOutput } from "./extract-json.js";

/** Grace period before SIGKILL after SIGTERM during kill(). */
const KILL_GRACE_PERIOD_MS = 2_000;

interface TokenUsage {
  input: number;
  output: number;
}

interface CodexInternal {
  proc: ReturnType<typeof spawn>;
  outputLines: string[];
  exitCode: number | null;
  done: boolean;
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  totalCostUsd: number;
  outputText: string;
  tokenUsage: TokenUsage;
  stallTimer: ReturnType<typeof setTimeout> | null;
  maxQueueSize: number;
  /** Codex's own conversation id, captured from the `thread.started` NDJSON
   * event. Used to resume the SPECIFIC session by id (not `--last`). Null until
   * the event arrives, or if `--ephemeral` suppressed persistence. */
  sessionId: string | null;
}

export class CodexCLIAdapter implements AgentAdapter {
  readonly name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "ignore" });
    } catch {
      return false;
    }
    // Codex CLI authenticates via OPENAI_API_KEY (see docs/SETUP.md). Without
    // it, `codex exec` fails immediately at spawn time — report unavailable
    // up front rather than surfacing a crashed-node after a failed spawn.
    if (!process.env["OPENAI_API_KEY"]) return false;
    return true;
  }

  async getVersion(): Promise<string | null> {
    try {
      const out = execSync("codex --version", {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const firstLine = out.split("\n")[0]?.trim();
      return firstLine ?? null;
    } catch {
      return null;
    }
  }

  async spawn(config: NodeConfig, ctx?: SpawnContext): Promise<AgentSession> {
    if (config.outputSchema) {
      logger.info(
        `codex: outputSchema present but adapter has no upstream strict-mode flag — relying on post-hoc validation.`,
      );
    }

    // Codex exposes `--sandbox` but no tool-name allowlist flag; `NodeConfig.tools`
    // is accepted for cross-adapter shape parity but has no runtime effect here
    // Warn so users don't silently assume tools are sandboxed.
    if (config.tools && config.tools.length > 0) {
      logger.warn(
        `codex adapter ignores NodeConfig.tools (no upstream allowlist flag): ${config.tools.join(", ")}`
      );
    }

    const sandbox = config.sandbox ?? "workspace-write";
    const cwd = config.outputDir ?? process.cwd();

    // NOTE: we intentionally do NOT pass `--ephemeral` here. `--ephemeral`
    // skips persisting the session rollout file to disk, which makes the
    // session unresumable — `codex exec resume <thread_id>` then silently
    // starts a fresh thread with no prior context (openai/codex#15538). Since
    // resume() relies on the persisted rollout to reuse the conversation on
    // loop-back retries, the rollout must survive the spawn process exiting.
    const args: string[] = [
      "exec",
      "--json",
      "--sandbox",
      sandbox,
      "--model",
      config.model,
      config.prompt,
    ];

    const proc = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: ctx?.traceparent ? { ...process.env, TRACEPARENT: ctx.traceparent } : process.env,
    });

    const internal: CodexInternal = {
      proc,
      outputLines: [],
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      outputText: "",
      tokenUsage: { input: 0, output: 0 },
      stallTimer: null,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
      sessionId: null,
    };

    proc.on("error", (err) => {
      if (!internal.done) {
        pushEvent(internal, { type: "error", message: `Process spawn failed: ${err.message}` });
        finishStream(internal);
      }
    });

    return makeAgentSession(this.name, config.role, internal);
  }

  async resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string, ctx?: SpawnContext): Promise<AgentSession> {
    const cwd = config.outputDir ?? process.cwd();

    // Resume the SPECIFIC codex session by its thread id (captured from the
    // `thread.started` event during the prior spawn) rather than `--last`.
    // `--last` resumes the most-recent session in this cwd, which on loop-back
    // retries across a multi-node workflow can resume the wrong conversation.
    // Syntax: `codex exec resume <SESSION_ID> "<prompt>"`
    // (https://developers.openai.com/codex/cli/reference). Mirrors the
    // cursor-cli adapter's captured-session-id resume pattern.
    const prev = previousSession._internal as Partial<CodexInternal> | undefined;
    const sessionId = prev?.sessionId ?? null;

    const args: string[] = sessionId
      ? ["exec", "resume", sessionId, feedbackMessage, "--json"]
      : // No thread id captured (e.g. resuming from a checkpoint whose internal
        // state wasn't retained) — fall back to the most-recent session.
        ["exec", "resume", "--last", feedbackMessage, "--json"];

    const proc = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: ctx?.traceparent ? { ...process.env, TRACEPARENT: ctx.traceparent } : process.env,
    });

    const internal: CodexInternal = {
      proc,
      outputLines: [],
      exitCode: null,
      done: false,
      eventQueue: [],
      resolve: null,
      totalCostUsd: 0,
      outputText: "",
      tokenUsage: { input: 0, output: 0 },
      stallTimer: null,
      maxQueueSize: DEFAULT_QUEUE_HIGH_WATER_MARK,
      sessionId,
    };

    proc.on("error", (err) => {
      if (!internal.done) {
        pushEvent(internal, { type: "error", message: `Process spawn failed: ${err.message}` });
        finishStream(internal);
      }
    });

    return makeAgentSession(this.name, config.role, internal, { id: previousSession.id });
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const internal = session._internal as CodexInternal;
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
        // Codex can close stdout before exiting; wait STALL_GRACE_MS before signalling
        // a stall so the scheduler can decide whether to retry or abort.
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

  private parseLine(line: string, internal: CodexInternal): AgentEvent | null {
    return dispatchEventLine(line, CODEX_EVENT_MAPPING, internal, {
      onParseError: (bad) => {
        if (process.env["SYGIL_DEBUG"]) {
          process.stderr.write(`[codex-cli] malformed NDJSON (first 200 chars): ${bad.slice(0, 200)}\n`);
        }
      },
    });
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as CodexInternal;

    if (!internal.done || internal.exitCode === null) {
      await waitForDoneOrTimeout(internal, {
        timeoutMs: GETRESULT_TIMEOUT_MS,
        pollIntervalMs: GETRESULT_POLL_INTERVAL_MS,
        killGraceMs: GETRESULT_KILL_GRACE_MS,
      });
    }

    const costUsd = internal.totalCostUsd > 0 ? internal.totalCostUsd : undefined;
    const hasTokens = internal.tokenUsage.input > 0 || internal.tokenUsage.output > 0;
    const exitCode = internal.exitCode ?? 1;

    // Best-effort structured output: attempt to extract the last JSON object from output
    const structuredOutput = internal.outputText.includes("{")
      ? extractJsonFromOutput(internal.outputText)
      : undefined;

    const errorCode = exitCodeToSygilError(exitCode);

    return {
      output: internal.outputText,
      exitCode,
      durationMs: Date.now() - session.startedAt.getTime(),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(hasTokens ? { tokenUsage: internal.tokenUsage } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async kill(session: AgentSession): Promise<void> {
    const internal = session._internal as CodexInternal;
    // Guard on process liveness rather than internal.done. The stall path sets
    // done=true before the process exits, so an `if (!internal.done)` check
    // would skip termination and leak the child. `proc.killed` only means
    // "signal was sent", not "process exited" — `proc.exitCode === null` is
    // the only reliable liveness signal.
    if (internal.proc.exitCode === null) {
      if (internal.stallTimer !== null) {
        clearTimeout(internal.stallTimer);
        internal.stallTimer = null;
      }
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

const handleTurnCompleted = (
  raw: Record<string, unknown>,
  internal: CodexInternal,
): AgentEvent | null => {
  const usage = (raw["usage"] ??
    raw["cost"] ??
    (raw["data"] as Record<string, unknown> | undefined)?.["usage"]) as
    | Record<string, unknown>
    | undefined;
  if (usage) {
    internal.totalCostUsd = Number(
      usage["total_cost"] ?? usage["cost_usd"] ?? internal.totalCostUsd,
    );
    internal.tokenUsage = {
      input: Number(usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0),
      output: Number(usage["output_tokens"] ?? usage["completion_tokens"] ?? 0),
    };
    if (internal.totalCostUsd > 0) {
      return { type: "cost_update", totalCostUsd: internal.totalCostUsd };
    }
  }
  return null;
};

const handleItemEvent = (
  raw: Record<string, unknown>,
  internal: CodexInternal,
): AgentEvent | null => {
  const item = raw["item"] as Record<string, unknown> | undefined;
  if (!item) return null;
  const itemType = item["type"] as string | undefined;

  if (itemType === "message") {
    const content = item["content"];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Array<Record<string, unknown>>)
        .filter((c) => c["type"] === "text")
        .map((c) => String(c["text"] ?? ""))
        .join("");
    }
    if (text) {
      internal.outputText += text;
      return { type: "text_delta", text };
    }
    return null;
  }

  if (itemType === "function_call") {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(String(item["arguments"] ?? "{}")) as Record<string, unknown>;
    } catch {
      input = { raw: item["arguments"] };
    }
    return { type: "tool_call", tool: String(item["name"] ?? ""), input };
  }

  if (itemType === "function_call_output") {
    const output = String(item["output"] ?? "");
    if (typeof item["exit_code"] === "number") {
      return {
        type: "shell_exec",
        command: String(item["call_id"] ?? ""),
        exitCode: item["exit_code"] as number,
      };
    }
    return {
      type: "tool_result",
      tool: String(item["call_id"] ?? ""),
      output,
      success: true,
    };
  }

  return null;
};

const CODEX_EVENT_MAPPING: EventMapping<Record<string, unknown>, CodexInternal> = {
  // First event of a `codex exec --json` run: { type: "thread.started",
  // thread_id: "<uuid>" }. Capture the thread id so resume() can target this
  // exact session by id instead of `--last`.
  "thread.started": (raw, internal) => {
    const threadId = raw["thread_id"];
    if (typeof threadId === "string" && threadId.length > 0) {
      internal.sessionId = threadId;
    }
    return null;
  },
  "turn.started": () => null,
  "turn.completed": handleTurnCompleted,
  "item.done": handleTurnCompleted,
  "turn.failed": (raw) => ({
    type: "error",
    message: String(raw["error"] ?? "turn failed"),
  }),
  "item.created": handleItemEvent,
  "item.updated": handleItemEvent,
  cost: (raw, internal) => {
    const cost = Number(raw["total_cost_usd"] ?? 0);
    internal.totalCostUsd = cost;
    return { type: "cost_update", totalCostUsd: cost };
  },
};

// extractJsonFromOutput moved to adapters/extract-json.ts (cycle 20: greedy-regex bug fix + dedup across 4 adapters).
