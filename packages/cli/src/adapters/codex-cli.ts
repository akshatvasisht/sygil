import { spawn, execSync } from "node:child_process";
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
import { dispatchEventLine, type EventMapping } from "./ndjson-event-mapper.js";
import { waitForDoneOrTimeout } from "./await-done.js";
import { logger } from "../utils/logger.js";
import {
  GETRESULT_KILL_GRACE_MS,
  GETRESULT_POLL_INTERVAL_MS,
  STALL_GRACE_MS,
} from "./constants.js";
import { createLineDecoder } from "./ndjson-line-decoder.js";
import { makeAgentSession } from "./session.js";

/** Upper bound on `getResult`'s wait-for-exit poll. Post-stream teardown should
 * never legitimately exceed this; if it does, we assume a hung socket or a misbehaving
 * MCP server pinning the child and force-kill so the workflow isn't pinned forever. */
const CODEX_GETRESULT_TIMEOUT_MS = 10_000;

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
}

export class CodexCLIAdapter implements AgentAdapter {
  readonly name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "ignore" });
      return true;
    } catch {
      return false;
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

    const args: string[] = [
      "exec",
      "--json",
      "--sandbox",
      sandbox,
      "--ephemeral",
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

    const args: string[] = [
      "exec",
      "resume",
      "--last",
      feedbackMessage,
      "--json",
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

    const push = (ev: AgentEvent): boolean => pushEvent(internal, ev);
    const finish = (): void => finishStream(internal);

    proc.stderr?.on("data", () => {
      // Silently consume stderr to prevent back-pressure
    });

    let stdoutClosed = false;
    const decoder = createLineDecoder();

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const trimmed of decoder.feed(chunk)) {
        internal.outputLines.push(trimmed);
        const event = this.parseLine(trimmed, internal);
        if (event) push(event);
      }
    });

    proc.stdout?.on("end", () => {
      const trailing = decoder.flush();
      if (trailing) {
        internal.outputLines.push(trailing);
        const event = this.parseLine(trailing, internal);
        if (event) push(event);
      }
      stdoutClosed = true;

      if (internal.exitCode !== null) {
        finish();
      } else {
        // Codex can close stdout before exiting; wait STALL_GRACE_MS before signalling
        // a stall so the scheduler can decide whether to retry or abort.
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
        timeoutMs: CODEX_GETRESULT_TIMEOUT_MS,
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
