/**
 * Shared safe-environment construction for gate scripts and lifecycle hooks.
 *
 * Gates and hooks are the two user-script entry points in Sygil; both must
 * avoid leaking the parent environment (which may carry API keys or credentials
 * from nested runs) while still letting the child process resolve binaries and
 * honor terminal / tempdir conventions.
 */

export const ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

/**
 * Build an env object containing only the whitelisted parent vars plus
 * any caller-supplied `extra` entries. Undefined parent vars are skipped.
 * Parent `SYGIL_*` vars are intentionally NOT forwarded — callers pass the
 * documented contract through `extra` on every invocation.
 */
export function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      env[k] = v;
    }
  }
  return env;
}
