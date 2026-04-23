/**
 * ClaudeSDKAdapter — wraps @anthropic-ai/claude-agent-sdk
 *
 * Dynamically imports the SDK at runtime so the package can be installed
 * optionally. If the SDK is not installed, spawn() throws a clear error.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentSession,
  AgentEvent,
  NodeConfig,
  NodeResult,
} from "@sygil/shared";
import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Security helper — path-traversal-safe tool permission check
// ---------------------------------------------------------------------------

// Suffix with path.sep so "/workspace-extra" never accidentally matches "/workspace".
function makeCanUseTool(outputDir: string) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === "Write" || toolName === "Edit") {
      const target = typeof input["path"] === "string" ? input["path"] : "";
      const resolvedTarget = path.resolve(target);
      const resolvedOutputDir = path.resolve(outputDir);
      if (!resolvedTarget.startsWith(resolvedOutputDir + path.sep)) {
        return {
          behavior: "deny" as const,
          message: `Write/Edit restricted to ${resolvedOutputDir}`,
        };
      }
    }
    return { behavior: "allow" as const };
  };
}

// ---------------------------------------------------------------------------
// Typed wrappers for @anthropic-ai/claude-agent-sdk (optional peer dep).
// These interfaces mirror the SDK's actual API surface used by this adapter.
// Update if the SDK changes its public API.
// ---------------------------------------------------------------------------

interface ClaudeSDKModule {
  createSession(config: Record<string, unknown>): Promise<ClaudeSDKSession>;
}

interface ClaudeSDKSession {
  send(message: string): Promise<void>;
  events(): AsyncIterable<Record<string, unknown>>;
  getResult(): Promise<Record<string, unknown>>;
  abort?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class ClaudeSDKAdapter implements AgentAdapter {
  readonly name = "claude-sdk";

  async isAvailable(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore -- optional peer dep, may not be installed
      await import("@anthropic-ai/claude-agent-sdk");
      return Boolean(process.env["ANTHROPIC_API_KEY"]);
    } catch {
      return false;
    }
  }

  async spawn(config: NodeConfig): Promise<AgentSession> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional peer dep, may not be installed
    const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => null) as ClaudeSDKModule | null;
    if (!sdk) {
      throw new Error(
        "Claude SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk"
      );
    }

    const session = await sdk.createSession({
      model: config.model,
      systemPrompt: config.role,
      allowedTools: config.tools ?? [],
      disallowedTools: config.disallowedTools ?? [],
      permissionMode: "dontAsk",
      cwd: config.outputDir ?? process.cwd(),
      outputFormat: config.outputSchema
        ? { type: "json_schema", schema: config.outputSchema }
        : undefined,
      maxTurns: config.maxTurns ?? 250,
      maxBudgetUsd: config.maxBudgetUsd,
      canUseTool: config.outputDir ? makeCanUseTool(config.outputDir) : undefined,
    });

    await session.send(config.prompt);

    return {
      id: randomUUID(),
      nodeId: config.role,
      adapter: this.name,
      startedAt: new Date(),
      _internal: session,
    };
  }

  async *stream(session: AgentSession): AsyncIterable<AgentEvent> {
    const sdkSession = session._internal as ClaudeSDKSession;

    for await (const event of sdkSession.events()) {
      const e = event as Record<string, unknown>;
      const type = e["type"] as string | undefined;

      if (type === "tool_use") {
        yield {
          type: "tool_call",
          tool: String(e["name"] ?? ""),
          input: (e["input"] as Record<string, unknown>) ?? {},
        };
      } else if (type === "tool_result") {
        yield {
          type: "tool_result",
          tool: String(e["name"] ?? ""),
          output: typeof e["output"] === "string" ? e["output"] : JSON.stringify(e["output"]),
          success: e["is_error"] !== true,
        };
      } else if (type === "text" || type === "text_delta") {
        yield {
          type: "text_delta",
          text: String(e["delta"] ?? e["text"] ?? ""),
        };
      } else if (type === "cost" || type === "cost_update") {
        yield {
          type: "cost_update",
          totalCostUsd: Number(e["total_cost_usd"] ?? e["totalCostUsd"] ?? 0),
        };
      } else if (type === "RateLimitEvent" || type === "rate_limit") {
        const retryAfterMs = Number(e["retryAfterMs"] ?? e["retry_after_ms"] ?? 60000);
        yield { type: "error", message: `rate_limit:${retryAfterMs}` };
      }
      // result events are captured by getResult(); skip all others
    }
  }

  async getResult(session: AgentSession): Promise<NodeResult> {
    const sdkSession = session._internal as ClaudeSDKSession;
    const summary = await sdkSession.getResult();

    const costUsd = summary["costUsd"] != null ? Number(summary["costUsd"]) : undefined;
    const tokenUsage = summary["tokenUsage"] as NodeResult["tokenUsage"] | undefined;
    const exitCode = Number(summary["exitCode"] ?? 0);

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
      output: String(summary["output"] ?? ""),
      structuredOutput: summary["structuredOutput"],
      exitCode,
      durationMs: Date.now() - session.startedAt.getTime(),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  async resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string): Promise<AgentSession> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional peer dep, may not be installed
    const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => null);
    if (!sdk) throw new Error("Claude SDK not installed");
    const session = previousSession._internal as ClaudeSDKSession;
    await session.send(feedbackMessage);
    return previousSession;
  }

  async kill(session: AgentSession): Promise<void> {
    const sdkSession = session._internal as ClaudeSDKSession;
    await sdkSession.abort?.().catch(() => undefined);
  }
}
