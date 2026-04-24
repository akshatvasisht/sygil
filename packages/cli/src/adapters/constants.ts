/**
 * Shared spawn/stream/getResult timing constants used by the NDJSON-emitting
 * CLI adapters (`claude-cli`, `codex-cli`, `cursor-cli`, `gemini-cli`).
 *
 * Adapter-specific graces (e.g. `KILL_GRACE_PERIOD_MS` for cursor's SIGTERM
 * escalation, exported from `@sygil/shared`) stay local to their adapter —
 * this file holds only values that were identically redeclared across files.
 */

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
