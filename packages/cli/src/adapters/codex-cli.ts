import { spawn, execSync } from "node:child_process";
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

/** Grace period in ms before emitting a stall event after stdout closes without process exit */
const STALL_GRACE_MS = 5_000;

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

  async spawn(config: NodeConfig): Promise<AgentSession> {
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
      env: process.env,
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

    const session: AgentSession = {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };

    return session;
  }

  async resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string): Promise<AgentSession> {
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
      env: process.env,
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

    return {
      id: previousSession.id,
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: internal,
    };
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (process.env["SIGIL_DEBUG"]) {
        process.stderr.write(`[codex-cli] malformed NDJSON (first 200 chars): ${line.slice(0, 200)}\n`);
      }
      return null;
    }

    const type = parsed["type"] as string | undefined;

    switch (type) {
      case "turn.started":
        return null; // No user-facing event for this

      case "turn.completed":
      case "item.done": {
        // Extract cost/usage information from completed turn events
        const usage = (parsed["usage"] ?? parsed["cost"] ?? (parsed["data"] as Record<string, unknown> | undefined)?.["usage"]) as Record<string, unknown> | undefined;
        if (usage) {
          internal.totalCostUsd = Number(usage["total_cost"] ?? usage["cost_usd"] ?? internal.totalCostUsd);
          internal.tokenUsage = {
            input: Number(usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0),
            output: Number(usage["output_tokens"] ?? usage["completion_tokens"] ?? 0),
          };
          if (internal.totalCostUsd > 0) {
            return { type: "cost_update", totalCostUsd: internal.totalCostUsd };
          }
        }
        return null;
      }

      case "turn.failed":
        return { type: "error", message: String(parsed["error"] ?? "turn failed") };

      case "item.created":
      case "item.updated": {
        const item = parsed["item"] as Record<string, unknown> | undefined;
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
          return {
            type: "tool_call",
            tool: String(item["name"] ?? ""),
            input,
          };
        }

        if (itemType === "function_call_output") {
          const output = String(item["output"] ?? "");
          // Heuristic: detect shell exec by checking for exit code field
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
      }

      case "cost": {
        const cost = Number(parsed["total_cost_usd"] ?? 0);
        internal.totalCostUsd = cost;
        return { type: "cost_update", totalCostUsd: cost };
      }

      default:
        return null;
    }
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const internal = session._internal as CodexInternal;

    if (!internal.done || internal.exitCode === null) {
      // Poll rather than listening for "exit" because the stall path marks done=true
      // without the process exiting — we need to handle both cases.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (internal.done) resolve();
          else setTimeout(check, 50);
        };
        check();
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
    let errorCode: SigilErrorCode | undefined;
    if (exitCode === STALL_EXIT_CODE) {
      errorCode = SigilErrorCode.NODE_STALLED;
    } else if (exitCode === 124) {
      errorCode = SigilErrorCode.NODE_TIMEOUT;
    } else if (exitCode !== 0) {
      errorCode = SigilErrorCode.NODE_CRASHED;
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
    if (!internal.done) {
      if (internal.stallTimer !== null) {
        clearTimeout(internal.stallTimer);
        internal.stallTimer = null;
      }
      internal.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          internal.proc.kill("SIGKILL");
          resolve();
        }, 5000);
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
