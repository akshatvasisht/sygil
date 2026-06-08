/**
 * Shared spawn/stream/getResult timing constants used by the NDJSON-emitting
 * CLI adapters (`claude-cli`, `codex-cli`, `cursor-cli`, `gemini-cli`).
 *
 * Adapter-specific graces (e.g. `KILL_GRACE_PERIOD_MS` for cursor's SIGTERM
 * escalation, exported from `@sygil/shared`) stay local to their adapter —
 * this file holds only values that were identically redeclared across files.
 */

import { execSync } from "node:child_process";
import type { NodeConfig, SpawnContext } from "@sygil/shared";
import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";
import { logger } from "../utils/logger.js";

/**
 * Upper bound on `getResult`'s wait-for-exit poll. Post-stream teardown should
 * never legitimately exceed this; if it does, the adapter assumes a hung socket
 * or a misbehaving MCP server pinning the child and force-kills so the workflow
 * isn't pinned forever. Identically redeclared across the four stream-json CLI
 * adapters (`claude-cli`, `codex-cli`, `cursor-cli`, `gemini-cli`).
 */
export const GETRESULT_TIMEOUT_MS = 10_000;

/**
 * Map a process exit code to the corresponding structured `SygilErrorCode`,
 * or `undefined` for a clean exit (0). `STALL_EXIT_CODE` → `NODE_STALLED`,
 * `124` (POSIX timeout convention) → `NODE_TIMEOUT`, any other non-zero →
 * `NODE_CRASHED`. Shared verbatim by every adapter's `getResult`.
 */
export function exitCodeToSygilError(exitCode: number): SygilErrorCode | undefined {
  if (exitCode === STALL_EXIT_CODE) return SygilErrorCode.NODE_STALLED;
  if (exitCode === 124) return SygilErrorCode.NODE_TIMEOUT;
  if (exitCode !== 0) return SygilErrorCode.NODE_CRASHED;
  return undefined;
}

/**
 * When an adapter's stdout closes without the child having exited, emit a
 * `stall` event after this grace period instead of killing immediately. The
 * scheduler decides whether to retry or abort.
 */
export const STALL_GRACE_MS = 5_000;

/**
 * Poll interval used by `await-done` (inside `getResult`) to check for
 * process exit after stream drain.
 */
export const GETRESULT_POLL_INTERVAL_MS = 50;

/**
 * Grace window between SIGTERM and SIGKILL when `await-done` force-terminates
 * a still-running child during `getResult`. Distinct from cursor's
 * `KILL_GRACE_PERIOD_MS` in `@sygil/shared`, which governs the streaming-path
 * kill, not the getResult force-kill.
 */
export const GETRESULT_KILL_GRACE_MS = 2_000;

/** Shared timeout for gate and lifecycle-hook scripts. */
export const SCRIPT_TIMEOUT_MS = 30_000;

/** SIGTERM->SIGKILL grace in adapter kill() (shared by the stream-json CLI adapters). */
export const KILL_GRACE_PERIOD_MS = 2_000;

/**
 * Runs `<binary> --version`, returns the first line trimmed, or `null` on any
 * error (binary not found, timeout, non-zero exit). Used by CLI adapters that
 * populate `AgentAdapter.getVersion()`.
 */
export async function getCliVersion(binary: string): Promise<string | null> {
  try {
    const out = execSync(`${binary} --version`, {
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

/**
 * Returns a copy of `process.env` with `TRACEPARENT` set to
 * `ctx.traceparent` when that field is present, otherwise returns
 * `process.env` unchanged. Shared by all process-spawning adapters.
 */
export function buildSpawnEnv(ctx?: SpawnContext): NodeJS.ProcessEnv {
  return ctx?.traceparent ? { ...process.env, TRACEPARENT: ctx.traceparent } : process.env;
}

/**
 * Emits the standard info log for adapters that accept `outputSchema` but
 * have no upstream strict-mode flag, falling back to post-hoc validation.
 * Guard-checked: no-ops when `config.outputSchema` is absent.
 */
export function warnOutputSchemaPartial(adapterName: string, config: NodeConfig): void {
  if (config.outputSchema) {
    logger.info(
      `${adapterName}: outputSchema present but adapter has no upstream strict-mode flag — relying on post-hoc validation.`,
    );
  }
}
