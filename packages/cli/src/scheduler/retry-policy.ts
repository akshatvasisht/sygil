import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { RetryPolicy, RetryableErrorClass } from "@sygil/shared";
import type { FailoverReason } from "../adapters/provider-router.js";

/**
 * Deterministic jitter cap (milliseconds): `jitter = hash(runId + nodeId + attempt) % 500`.
 * Keeping the cap at 500ms matches the "tens to hundreds of ms of decorrelation"
 * guidance from [AWS's exponential-backoff blog post](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
 * without letting the jitter dominate small initial delays.
 */
export const RETRY_JITTER_CAP_MS = 500;

/**
 * Default `retryableErrors` whitelist when a RetryPolicy omits the field.
 * Matches the classification strings produced by
 * `adapters/provider-router.ts > classifyError`.
 */
export const DEFAULT_RETRYABLE_ERRORS: readonly RetryableErrorClass[] = [
  "transport",
  "rate_limit",
  "server_5xx",
];

/**
 * Compute the next retry delay (in milliseconds) for the given attempt.
 *
 * Base formula (Temporal-style exponential backoff):
 *   `base = min(initialDelayMs * backoffMultiplier^(attemptNum - 1), maxDelayMs)`
 *
 * Jitter (deterministic, replayable — NOT random):
 *   `jitter = sha256(runId + "/" + nodeId + "/" + attemptNum) % RETRY_JITTER_CAP_MS`
 *
 * The jitter is additive (base + jitter), but the final delay is clamped to
 * `maxDelayMs` to respect the author's upper bound even after jitter.
 *
 * `attemptNum` is 1-based and refers to the attempt THAT JUST FAILED — the
 * delay returned is the wait before the next attempt (attemptNum + 1).
 * Deterministic jitter means replay from the NDJSON log sees the same
 * `retry_scheduled{ delayMs }` value the original run recorded.
 */
export function computeRetryDelay(
  policy: RetryPolicy,
  attemptNum: number,
  runId: string,
  nodeId: string,
): number {
  const exp = Math.pow(policy.backoffMultiplier, Math.max(0, attemptNum - 1));
  const base = Math.min(policy.initialDelayMs * exp, policy.maxDelayMs);
  const jitter = deterministicJitter(runId, nodeId, attemptNum);
  return Math.min(Math.floor(base + jitter), policy.maxDelayMs);
}

/**
 * Exposed for tests. Returns an integer in [0, RETRY_JITTER_CAP_MS).
 */
export function deterministicJitter(runId: string, nodeId: string, attemptNum: number): number {
  const hash = createHash("sha256")
    .update(`${runId}/${nodeId}/${attemptNum}`)
    .digest();
  const raw = hash.readUInt32BE(0);
  return raw % RETRY_JITTER_CAP_MS;
}

/**
 * Return true iff the RetryPolicy opts in to retrying this error class.
 */
export function isRetryableReason(
  policy: RetryPolicy,
  reason: FailoverReason | undefined,
): boolean {
  if (!reason) return false;
  const allowed = policy.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS;
  return (allowed as readonly string[]).includes(reason);
}

/**
 * Sleep for `ms` milliseconds. Resolves early (without throwing) when the
 * provided AbortSignal aborts — caller should re-check cancellation state
 * after await. Uses `ref: false` so a leftover timer during cancellation
 * doesn't keep the process alive.
 *
 * Delegates to `node:timers/promises > setTimeout`, which handles the
 * race window (abort-between-check-and-listener) natively.
 */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  try {
    await sleep(ms, undefined, { signal, ref: false });
  } catch (err) {
    // timersPromises.setTimeout rejects with an AbortError on cancel; callers
    // already re-check signal state, so we swallow the rejection to preserve
    // the "resolves early on abort" contract.
    if ((err as NodeJS.ErrnoException).name !== "AbortError") throw err;
  }
}
