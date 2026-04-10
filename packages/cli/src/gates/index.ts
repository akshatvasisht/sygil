import { readFile, access, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, isAbsolute, resolve as pathResolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { GateConfig, GateCondition, NodeResult } from "@sigil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";

const execFileAsync = promisify(execFile);

export interface GateResult {
  passed: boolean;
  reason: string;
}

/** Timeout for gate scripts to prevent runaway processes. */
export const GATE_SCRIPT_TIMEOUT_MS = 30_000;

/** Default timeout for human review gates (5 minutes). */
export const HUMAN_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Script path injection guard
// ---------------------------------------------------------------------------

function isContainedIn(child: string, parent: string): boolean {
  // Use realpathSync to follow symlinks — prevents symlink escape attacks
  // where a symlink inside the allowed dir points outside it.
  const realParent = (() => { try { return realpathSync(parent); } catch { return pathResolve(parent); } })() + sep;
  const realChild = (() => { try { return realpathSync(child); } catch { return pathResolve(child); } })();
  return realChild.startsWith(realParent);
}

function validateScriptPath(scriptPath: string, workingDir: string): void {
  const resolved = pathResolve(workingDir, scriptPath);
  const templatesGatesDir = pathResolve(
    fileURLToPath(new URL("../../templates/gates", import.meta.url))
  );

  if (!isContainedIn(resolved, workingDir) && !isContainedIn(resolved, templatesGatesDir)) {
    throw new Error(
      `Gate script path "${scriptPath}" resolves outside the working directory. ` +
      `Script paths must be relative to the workflow's working directory.`
    );
  }
}

// ---------------------------------------------------------------------------
// GateEvaluator
// ---------------------------------------------------------------------------

export class GateEvaluator {
  private readonly regexCache = new Map<string, RegExp>();

  constructor(
    private readonly monitorServer?: WsMonitorServer,
    private readonly workflowId?: string
  ) { }

  /**
   * Evaluate all conditions in a GateConfig.
   * All conditions must pass (AND logic).
   */
  async evaluate(
    gate: GateConfig,
    nodeResult: NodeResult,
    outputDir: string,
    nodeId?: string,
    edgeId?: string,
    signal?: AbortSignal
  ): Promise<GateResult> {
    let lastResult: GateResult = { passed: true, reason: "all conditions passed" };
    for (const condition of gate.conditions) {
      const result = await this.evaluateCondition(
        condition,
        nodeResult,
        outputDir,
        nodeId,
        edgeId,
        signal
      );
      if (!result.passed) {
        return result;
      }
      lastResult = result;
    }
    return lastResult;
  }

  private async evaluateCondition(
    condition: GateCondition,
    nodeResult: NodeResult,
    outputDir: string,
    nodeId?: string,
    edgeId?: string,
    signal?: AbortSignal
  ): Promise<GateResult> {
    // Check abort signal before evaluating each condition
    if (signal?.aborted) {
      return { passed: false, reason: "Gate evaluation aborted" };
    }

    switch (condition.type) {
      case "exit_code":
        return this.evaluateExitCode(condition.value, nodeResult.exitCode);

      case "file_exists":
        return this.evaluateFileExists(condition.path, outputDir);

      case "regex":
        return this.evaluateRegex(condition.filePath, condition.pattern, outputDir);

      case "script":
        return this.evaluateScript(condition.path, nodeResult, outputDir, signal);

      case "human_review":
        return this.evaluateHumanReview(condition.prompt, nodeId, edgeId, signal);

      default: {
        const _exhaustive: never = condition;
        return {
          passed: false,
          reason: `Unknown gate condition type: ${JSON.stringify(_exhaustive)}`,
        };
      }
    }
  }

  private evaluateExitCode(expected: number, actual: number): GateResult {
    const passed = actual === expected;
    return {
      passed,
      reason: passed
        ? `exit code ${actual} matches expected ${expected}`
        : `exit code ${actual} does not match expected ${expected}`,
    };
  }

  private async evaluateFileExists(
    filePath: string,
    outputDir: string
  ): Promise<GateResult> {
    const resolved = isAbsolute(filePath) ? filePath : join(outputDir, filePath);
    // Path containment guard — prevent reading arbitrary files outside outputDir
    if (!isContainedIn(resolved, outputDir)) {
      return {
        passed: false,
        reason: `file_exists gate: path "${filePath}" resolves outside the output directory`,
      };
    }
    try {
      await access(resolved);
      return { passed: true, reason: `file exists: ${resolved}` };
    } catch {
      return { passed: false, reason: `file not found: ${resolved}` };
    }
  }

  private async evaluateRegex(
    filePath: string,
    pattern: string,
    outputDir: string
  ): Promise<GateResult> {
    const resolved = isAbsolute(filePath) ? filePath : join(outputDir, filePath);
    // Path containment guard — prevent reading arbitrary files outside outputDir
    if (!isContainedIn(resolved, outputDir)) {
      return {
        passed: false,
        reason: `regex gate: path "${filePath}" resolves outside the output directory`,
      };
    }
    // Guard against OOM from huge or binary files
    const MAX_REGEX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
    try {
      const info = await stat(resolved);
      if (info.size > MAX_REGEX_FILE_BYTES) {
        return { passed: false, reason: `regex gate: file ${resolved} is too large (${(info.size / 1024 / 1024).toFixed(1)} MB > 10 MB limit)` };
      }
    } catch {
      return { passed: false, reason: `regex gate: cannot stat file ${resolved}` };
    }

    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      return { passed: false, reason: `regex gate: cannot read file ${resolved}` };
    }

    let regex = this.regexCache.get(pattern);
    if (!regex) {
      try {
        regex = new RegExp(pattern);
        this.regexCache.set(pattern, regex);
      } catch (err) {
        return {
          passed: false,
          reason: `regex gate: invalid pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const passed = regex.test(content);
    return {
      passed,
      reason: passed
        ? `pattern /${pattern}/ matched in ${resolved}`
        : `pattern /${pattern}/ did not match in ${resolved}`,
    };
  }

  private async evaluateScript(
    scriptPath: string,
    nodeResult: NodeResult,
    outputDir: string,
    signal?: AbortSignal
  ): Promise<GateResult> {
    // Reject any script path that escapes the workflow output directory (path traversal guard)
    validateScriptPath(scriptPath, outputDir);

    const resolved = isAbsolute(scriptPath)
      ? scriptPath
      : join(outputDir, scriptPath);

    // Whitelist environment variables passed to gate scripts.
    // We never leak the full parent env (which may contain API keys, SSH creds, etc.).
    const ALLOWED_ENV_KEYS = ["PATH", "HOME", "SHELL", "TERM", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP"];
    const safeEnv: Record<string, string> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      const val = process.env[key];
      if (val !== undefined) safeEnv[key] = val;
    }
    // Also pass through any SIGIL_* vars from the parent environment
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("SIGIL_") && val !== undefined) safeEnv[key] = val;
    }

    try {
      await execFileAsync(resolved, [], {
        cwd: outputDir,
        env: {
          ...safeEnv,
          SIGIL_EXIT_CODE: String(nodeResult.exitCode),
          SIGIL_OUTPUT_DIR: outputDir,
          SIGIL_OUTPUT: nodeResult.output,
        },
        timeout: GATE_SCRIPT_TIMEOUT_MS,
        signal,
      });
      return { passed: true, reason: `script ${resolved} exited with code 0` };
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : "?";
      return {
        passed: false,
        reason: `script ${resolved} failed (exit ${code})`,
      };
    }
  }

  private async evaluateHumanReview(
    prompt: string | undefined,
    nodeId?: string,
    edgeId?: string,
    signal?: AbortSignal,
    timeoutMs = HUMAN_REVIEW_TIMEOUT_MS
  ): Promise<GateResult> {
    const reviewPrompt = prompt ?? "Please review the output";

    // If a monitor server is available and a workflowId is set, use WebSocket
    if (this.monitorServer && this.workflowId && edgeId && nodeId) {
      const workflowId = this.workflowId;
      const monitor = this.monitorServer;

      // Emit the review request
      monitor.emit({
        type: "human_review_request",
        workflowId,
        nodeId,
        edgeId,
        prompt: reviewPrompt,
      });

      // Save any existing onClientControl handler so we can chain it and restore it
      const prevHandler = monitor.onClientControl;

      const approvalPromise = new Promise<boolean>((resolve, reject) => {
        if (signal?.aborted) {
          monitor.onClientControl = prevHandler;
          reject(new Error("Gate evaluation cancelled"));
          return;
        }

        monitor.onClientControl = (event) => {
          // Chain existing handler
          prevHandler?.(event);

          if (
            (event.type === "human_review_approve" || event.type === "human_review_reject") &&
            "edgeId" in event &&
            event.edgeId === edgeId &&
            event.workflowId === workflowId
          ) {
            // Restore previous handler and resolve
            monitor.onClientControl = prevHandler;
            resolve(event.type === "human_review_approve");
          }
        };

        signal?.addEventListener(
          "abort",
          () => {
            monitor.onClientControl = prevHandler;
            reject(new Error("Gate evaluation cancelled"));
          },
          { once: true }
        );
      });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(() => {
          // Ensure handler is restored on timeout
          monitor.onClientControl = prevHandler;
          reject(new Error(`Human review timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      );

      let approved: boolean;
      try {
        approved = await Promise.race([approvalPromise, timeoutPromise]);
      } catch (err) {
        // timeout or abort — always ensure handler is restored (idempotent)
        monitor.onClientControl = prevHandler;
        return {
          passed: false,
          reason: err instanceof Error ? err.message : "Human review failed",
        };
      } finally {
        // Always restore handler (idempotent safety net)
        monitor.onClientControl = prevHandler;
      }

      monitor.emit({
        type: "human_review_response",
        workflowId,
        edgeId,
        approved,
      });

      return {
        passed: approved,
        reason: approved ? "human reviewer approved" : "human reviewer rejected",
      };
    }

    // CLI-only mode: use readline to prompt the user
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const answerPromise = new Promise<string>((resolve) => {
      rl.question(
        `? [Gate: human review] ${reviewPrompt}. Approve? (y/n): `,
        (ans) => {
          resolve(ans.trim().toLowerCase());
        }
      );
    });

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Human review timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    );

    let answer: string;
    try {
      answer = await Promise.race([answerPromise, timeoutPromise]);
    } catch {
      rl.close();
      return { passed: false, reason: "Human review timed out" };
    } finally {
      rl.close();
    }

    const approved = answer === "y" || answer === "yes";
    return {
      passed: approved,
      reason: approved ? "human reviewer approved (CLI)" : "human reviewer rejected (CLI)",
    };
  }
}
