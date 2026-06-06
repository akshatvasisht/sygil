/**
 * Shared spawn/stream/getResult timing constants used by the NDJSON-emitting
 * CLI adapters (`claude-cli`, `codex-cli`, `cursor-cli`, `gemini-cli`).
 *
 * Adapter-specific graces (e.g. `KILL_GRACE_PERIOD_MS` for cursor's SIGTERM
 * escalation, exported from `@sygil/shared`) stay local to their adapter —
 * this file holds only values that were identically redeclared across files.
 */

import { SygilErrorCode, STALL_EXIT_CODE } from "@sygil/shared";

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
