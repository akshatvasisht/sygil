import type { spawn } from "node:child_process";

/**
 * Minimal shape of the per-adapter `*Internal` state needed by
 * `waitForDoneOrTimeout`.
 */
export interface AwaitDoneTarget {
  proc: ReturnType<typeof spawn>;
  done: boolean;
  exitCode: number | null;
}

export interface WaitForDoneOptions {
  /** Upper bound on how long to wait for `target.done` before force-killing. */
  timeoutMs: number;
  /** How often to re-check `target.done` while the child is still alive. */
  pollIntervalMs: number;
  /** SIGTERM → (grace) → SIGKILL ladder used after `timeoutMs` elapses. */
  killGraceMs: number;
}

/**
 * Wait for `target.done === true` with an upper bound. The adapters poll rather
 * than listen for the child's `"exit"` event because the stall path flips
 * `done = true` without the process exiting — both paths have to be observable.
 * If neither completes within `timeoutMs`, force-terminate the child
 * (SIGTERM → `killGraceMs` → SIGKILL) so a hung child can't pin the workflow.
 *
 * Extracted from three byte-identical copies in codex/cursor/gemini adapters.
 */
export function waitForDoneOrTimeout(
  target: AwaitDoneTarget,
  opts: WaitForDoneOptions,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      clearTimeout(timeoutTimer);
      resolve();
    };

    const timeoutTimer = setTimeout(() => {
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      try { target.proc.kill("SIGTERM"); } catch { /* already dead */ }
      const killTimer = setTimeout(() => {
        if (!target.done) {
          try { target.proc.kill("SIGKILL"); } catch { /* already dead */ }
        }
        if (target.exitCode === null) target.exitCode = 1;
        target.done = true;
        resolve();
      }, opts.killGraceMs);
      target.proc.once("exit", () => {
        clearTimeout(killTimer);
        if (target.exitCode === null) target.exitCode = 1;
        target.done = true;
        resolve();
      });
    }, opts.timeoutMs);

    const check = (): void => {
      if (target.done) { finish(); return; }
      pollTimer = setTimeout(check, opts.pollIntervalMs);
    };
    check();
  });
}
