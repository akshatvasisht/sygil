import { isAbsolute, resolve as pathResolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@sygil/shared";
import type { HooksConfig } from "../utils/config.js";
import { isContainedIn } from "../gates/index.js";
import { buildSafeEnv } from "../utils/safe-env.js";

const execFileAsync = promisify(execFile);

/**
 * Hook script timeout. Mirrors the gate-script timeout (30s) since hooks
 * are the same kind of out-of-band shell invocation.
 */
export const HOOK_SCRIPT_TIMEOUT_MS = 30_000;

export type HookType = "preNode" | "postNode" | "preGate" | "postGate";

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HookContext {
  workflowId: string;
  nodeId: string;
  outputDir: string;
  /** postNode only — node's final exit code */
  exitCode?: number;
  /** postNode only — node's final output text */
  output?: string;
  /** preGate / postGate — edge being evaluated */
  edgeId?: string;
  /** postGate — gate result (true == passed) */
  gatePassed?: boolean;
  /** postGate — gate reason string */
  gateReason?: string;
}

function validateHookPath(hookPath: string, workingDir: string): void {
  const resolved = isAbsolute(hookPath) ? hookPath : pathResolve(workingDir, hookPath);
  const templatesHooksDir = pathResolve(
    fileURLToPath(new URL("../../templates/hooks", import.meta.url)),
  );
  if (!isContainedIn(resolved, workingDir) && !isContainedIn(resolved, templatesHooksDir)) {
    throw new Error(
      `Hook script path "${hookPath}" resolves outside the working directory. ` +
      `Hook paths must be relative to the project working directory.`,
    );
  }
}

/**
 * HookRunner — runs optional lifecycle hooks around node execution and
 * gate evaluation. Each configured hook is a path to a shell-executable
 * whose stdout/stderr/exit code is captured into the event log so replay
 * from the NDJSON transcript remains deterministic.
 *
 * Security model (mirrors the `script` gate at `gates/index.ts`):
 *  - Hook path must resolve inside the working directory OR the bundled
 *    `templates/hooks/` directory. Any other path is rejected.
 *  - The parent environment is NOT leaked; only a whitelist of variables
 *    (PATH, HOME, SHELL, …) is forwarded. Hook-specific env vars
 *    (`SYGIL_HOOK_TYPE`, `SYGIL_NODE_ID`, etc.) are always set from the
 *    hook-type-specific fresh-set block — no parent `SYGIL_*` passthrough.
 *  - Each hook runs with a hard 30s timeout (`HOOK_SCRIPT_TIMEOUT_MS`) and
 *    propagates a supplied `AbortSignal` for structured cancellation.
 *
 * Semantics (only preNode may abort the node):
 *  - `preNode`:  non-zero exit aborts the node with the hook's stderr as
 *               the error message — same semantics as a failed gate.
 *  - `postNode`, `preGate`, `postGate`: observational only; non-zero exit
 *               is recorded to the event log but does not alter control
 *               flow. The gate's own pass/fail verdict still rules.
 */
export class HookRunner {
  constructor(
    private readonly hooks: HooksConfig,
    private readonly workingDir: string,
  ) {}

  /** True when the given hook is configured. Cheap; callers can skip event setup. */
  has(type: HookType): boolean {
    return Boolean(this.hooks[type]);
  }

  /**
   * Run a lifecycle hook. Returns `null` if the hook is not configured.
   * Path-containment violations throw synchronously; the script's non-zero
   * exit is returned as part of the result (not thrown).
   */
  async run(
    type: HookType,
    context: HookContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult | null> {
    const scriptPath = this.hooks[type];
    if (!scriptPath) return null;

    validateHookPath(scriptPath, this.workingDir);

    const resolved = isAbsolute(scriptPath)
      ? scriptPath
      : pathResolve(this.workingDir, scriptPath);

    const extra: Record<string, string> = {
      SYGIL_HOOK_TYPE: type,
      SYGIL_WORKFLOW_ID: context.workflowId,
      SYGIL_NODE_ID: context.nodeId,
      SYGIL_OUTPUT_DIR: context.outputDir,
    };
    if (context.exitCode !== undefined) {
      extra["SYGIL_EXIT_CODE"] = String(context.exitCode);
    }
    if (context.output !== undefined) {
      extra["SYGIL_OUTPUT"] = context.output;
    }
    if (context.edgeId !== undefined) {
      extra["SYGIL_EDGE_ID"] = context.edgeId;
    }
    if (context.gatePassed !== undefined) {
      extra["SYGIL_GATE_PASSED"] = context.gatePassed ? "1" : "0";
    }
    if (context.gateReason !== undefined) {
      extra["SYGIL_GATE_REASON"] = context.gateReason;
    }
    const hookEnv = buildSafeEnv(extra);

    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(resolved, [], {
        cwd: this.workingDir,
        env: hookEnv,
        timeout: HOOK_SCRIPT_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        exitCode: 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const maybe = err as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: number | string;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
      };
      const stdout = typeof maybe.stdout === "string"
        ? maybe.stdout
        : Buffer.isBuffer(maybe.stdout)
          ? maybe.stdout.toString("utf8")
          : "";
      const stderrRaw = typeof maybe.stderr === "string"
        ? maybe.stderr
        : Buffer.isBuffer(maybe.stderr)
          ? maybe.stderr.toString("utf8")
          : "";
      const fallbackMsg = err instanceof Error ? err.message : String(err);
      const stderr = stderrRaw || fallbackMsg;
      const codeRaw = maybe.code;
      const exitCode = typeof codeRaw === "number" ? codeRaw : -1;
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

/** Build the NDJSON-recordable AgentEvent for a completed hook invocation. */
export function hookResultToEvent(
  type: HookType,
  result: HookRunResult,
): AgentEvent {
  return {
    type: "hook_result",
    hook: type,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
