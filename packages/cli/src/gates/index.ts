import { readFile, access, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute, resolve as pathResolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { GateConfig, GateCondition, NodeResult, WsClientEvent } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import { buildSafeEnv } from "../utils/safe-env.js";

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

export function isContainedIn(child: string, parent: string): boolean {
  // Use realpathSync to follow symlinks — prevents symlink escape attacks
  // where a symlink inside the allowed dir points outside it.
  const realParent = (() => { try { return realpathSync(parent); } catch { return pathResolve(parent); } })() + sep;
  const realChild = (() => { try { return realpathSync(child); } catch { return pathResolve(child); } })();
  return realChild.startsWith(realParent);
}

const BUNDLED_TEMPLATES_DIR = pathResolve(
  fileURLToPath(new URL("../../templates", import.meta.url))
);

/**
 * Resolve a caller-supplied path against a working directory and check that
 * it stays inside the sandbox: the `workingDir` (primary) OR the bundled
 * `templates/<templateSubdir>/` (when `templateSubdir` is non-null). Returns
 * the absolute resolved path, or `null` if the path escapes both. Callers
 * translate `null` into the appropriate throw/return shape.
 */
function resolveSandboxedPath(
  relativePath: string,
  workingDir: string,
  templateSubdir: string | null
): string | null {
  const resolved = isAbsolute(relativePath) ? relativePath : pathResolve(workingDir, relativePath);
  if (isContainedIn(resolved, workingDir)) return resolved;
  if (templateSubdir !== null) {
    const templateDir = pathResolve(BUNDLED_TEMPLATES_DIR, templateSubdir);
    if (isContainedIn(resolved, templateDir)) return resolved;
  }
  return null;
}

function validateScriptPath(scriptPath: string, workingDir: string): void {
  if (resolveSandboxedPath(scriptPath, workingDir, "gates") === null) {
    throw new Error(
      `Gate script path "${scriptPath}" resolves outside the working directory. ` +
      `Script paths must be relative to the workflow's working directory.`
    );
  }
}

/**
 * Resolve a gate script path to a concrete file on disk. Order: absolute →
 * workingDir-relative (if the file exists there) → bundled
 * `templates/<scriptPath>` fallback. The bundled fallback lets workflows like
 * `templates/ralph.json` reference `gates/ralph-done.sh` without requiring
 * users to copy the gates/ directory into their run dir — a usability gap
 * the original design left unfilled for bundled-template script gates (same
 * pattern applies to `optimize.json`'s `gates/check-budget.sh`).
 *
 * Assumes `validateScriptPath` has already run; this function is pure
 * filesystem discovery, not a security check.
 */
function resolveGateScriptPath(scriptPath: string, workingDir: string): string {
  if (isAbsolute(scriptPath)) return scriptPath;
  const local = join(workingDir, scriptPath);
  if (existsSync(local)) return local;
  const bundled = join(BUNDLED_TEMPLATES_DIR, scriptPath);
  if (existsSync(bundled)) return bundled;
  return local; // fall back to local path so the execFile error message stays clear
}

function normalizeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function resolveSpecPath(specPath: string, workingDir: string): string | null {
  return resolveSandboxedPath(specPath, workingDir, "specs");
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
        return this.evaluateRegex(condition.filePath, condition.pattern, outputDir, signal);

      case "script":
        return this.evaluateScript(condition.path, nodeResult, outputDir, signal);

      case "human_review":
        return this.evaluateHumanReview(condition.prompt, nodeId, edgeId, signal);

      case "spec_compliance":
        return this.evaluateSpecCompliance(
          condition.specPath,
          condition.mode,
          nodeResult,
          outputDir
        );

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
    outputDir: string,
    signal?: AbortSignal
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
    if (signal?.aborted) return { passed: false, reason: "Gate evaluation aborted" };

    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      return { passed: false, reason: `regex gate: cannot read file ${resolved}` };
    }
    if (signal?.aborted) return { passed: false, reason: "Gate evaluation aborted" };

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

    // NB: regex.test() is synchronous; the abort signal cannot interrupt
    // catastrophic backtracking once started. ReDoS-prone patterns are
    // rejected at workflow load time by `assertRegexPatternsSafe` in
    // utils/workflow.ts; the signal checks above are defensive only.
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

    const resolved = resolveGateScriptPath(scriptPath, outputDir);

    try {
      await execFileAsync(resolved, [], {
        cwd: outputDir,
        env: buildSafeEnv({
          SYGIL_EXIT_CODE: String(nodeResult.exitCode),
          SYGIL_OUTPUT_DIR: outputDir,
          SYGIL_OUTPUT: nodeResult.output,
        }),
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

  /**
   * Text-based diff gate. Compares a node's text output against a
   * checked-in spec file. Two modes:
   *   - "exact":   normalized content equality (trimmed lines, trailing ws stripped, blank lines dropped)
   *   - "superset": every non-empty normalized line from the spec appears as a
   *                 non-empty normalized line in the output
   *
   * No LLM-based comparison — the gate is pure text, so replay from the
   * NDJSON event log is bit-for-bit deterministic. The spec file must live
   * inside the output directory or the bundled templates/specs/ directory;
   * any path that escapes both is rejected.
   */
  private async evaluateSpecCompliance(
    specPath: string,
    mode: "exact" | "superset",
    nodeResult: NodeResult,
    outputDir: string
  ): Promise<GateResult> {
    const resolved = resolveSpecPath(specPath, outputDir);
    if (resolved === null) {
      return {
        passed: false,
        reason: `spec_compliance gate: path "${specPath}" resolves outside the output directory`,
      };
    }

    const MAX_SPEC_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — match regex gate
    try {
      const info = await stat(resolved);
      if (info.size > MAX_SPEC_FILE_BYTES) {
        return {
          passed: false,
          reason: `spec_compliance gate: spec ${resolved} is too large (${(info.size / 1024 / 1024).toFixed(1)} MB > 10 MB limit)`,
        };
      }
    } catch {
      return { passed: false, reason: `spec_compliance gate: cannot stat spec ${resolved}` };
    }

    let spec: string;
    try {
      spec = await readFile(resolved, "utf8");
    } catch {
      return { passed: false, reason: `spec_compliance gate: cannot read spec ${resolved}` };
    }

    const specLines = normalizeLines(spec);
    const outLines = normalizeLines(nodeResult.output);

    if (mode === "exact") {
      const passed = specLines.length === outLines.length
        && specLines.every((line, i) => line === outLines[i]);
      return {
        passed,
        reason: passed
          ? `spec_compliance (exact) matched ${resolved}`
          : `spec_compliance (exact) differs from ${resolved}`,
      };
    }

    const outSet = new Set(outLines);
    const missing: string[] = [];
    for (const line of specLines) {
      if (!outSet.has(line)) missing.push(line);
    }
    if (missing.length === 0) {
      return { passed: true, reason: `spec_compliance (superset) covers all ${specLines.length} spec line(s) from ${resolved}` };
    }
    const preview = missing.slice(0, 3).map((l) => JSON.stringify(l)).join(", ");
    const suffix = missing.length > 3 ? ` (+${missing.length - 3} more)` : "";
    return {
      passed: false,
      reason: `spec_compliance (superset) missing ${missing.length} line(s) from ${resolved}: ${preview}${suffix}`,
    };
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

      // Save any existing onClientControl handler so we can chain it and restore it.
      // Concurrent human_review gates layer via a LIFO chain: gate B captures
      // gate A's handler as its prevHandler. Restore-on-resolve must NOT blindly
      // reassign prevHandler — if a newer gate is now top-of-chain, that would
      // wipe the newer gate's listener. We therefore (a) guard each restore with
      // `if (monitor.onClientControl === myHandler)`, and (b) latch `closed` so
      // our handler is a no-op if it's still reachable via an outer gate's
      // closure after we resolve.
      const prevHandler = monitor.onClientControl;
      let closed = false;

      const detach = (): void => {
        closed = true;
        if (monitor.onClientControl === myHandler) {
          monitor.onClientControl = prevHandler;
        }
      };

      const myHandler = (event: WsClientEvent): void => {
        // Always chain to prior handler so outer gates still receive events.
        prevHandler?.(event);
        if (closed) return;

        if (
          (event.type === "human_review_approve" || event.type === "human_review_reject") &&
          "edgeId" in event &&
          event.edgeId === edgeId &&
          event.workflowId === workflowId
        ) {
          const approved = event.type === "human_review_approve";
          detach();
          resolveApproval(approved);
        }
      };

      let resolveApproval!: (value: boolean) => void;
      let rejectApproval!: (reason: Error) => void;
      const approvalPromise = new Promise<boolean>((resolve, reject) => {
        resolveApproval = resolve;
        rejectApproval = reject;
        if (signal?.aborted) {
          detach();
          reject(new Error("Gate evaluation cancelled"));
          return;
        }
        monitor.onClientControl = myHandler;

        signal?.addEventListener(
          "abort",
          () => {
            detach();
            rejectApproval(new Error("Gate evaluation cancelled"));
          },
          { once: true }
        );
      });

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          detach();
          reject(new Error(`Human review timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      let approved: boolean;
      try {
        approved = await Promise.race([approvalPromise, timeoutPromise]);
      } catch (err) {
        detach();
        return {
          passed: false,
          reason: err instanceof Error ? err.message : "Human review failed",
        };
      } finally {
        // Clear the timer so the event loop can exit promptly once the race
        // has resolved; without this, an early approval still keeps a 5-min
        // timer pinned until it fires harmlessly.
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        detach();
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

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Human review timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    let answer: string;
    try {
      answer = await Promise.race([answerPromise, timeoutPromise]);
    } catch {
      rl.close();
      return { passed: false, reason: "Human review timed out" };
    } finally {
      // Clear the timer so an early CLI answer doesn't keep a 5-minute handle
      // pinned in the event loop.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      rl.close();
    }

    const approved = answer === "y" || answer === "yes";
    return {
      passed: approved,
      reason: approved ? "human reviewer approved (CLI)" : "human reviewer rejected (CLI)",
    };
  }
}
