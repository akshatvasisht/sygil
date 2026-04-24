import type { AdapterType, NodeConfig, ProviderConfig } from "@sygil/shared";

/**
 * ProviderRouter — multi-provider failover with priority list.
 *
 * Resolves a NodeConfig into an ordered list of (adapter, model) attempts and
 * classifies errors/events as retryable (transient) vs. deterministic.
 *
 * Determinism note: failover *decisions* are recorded as `adapter_failover`
 * AgentEvents so replay from the NDJSON log reconstructs which adapter served
 * each request.
 */

/**
 * Resolve the effective list of providers for a node.
 *
 * - When `providers` is set, it is sorted by ascending `priority` (stable ties
 *   by declaration order). Entries with no explicit `model` inherit the
 *   node-level `model`.
 * - When `providers` is not set, returns a single-entry list from the node's
 *   top-level `adapter`/`model` — the legacy single-adapter case.
 */
export function resolveProviders(
  nodeConfig: NodeConfig,
): Array<{ adapter: AdapterType; model: string }> {
  if (!nodeConfig.providers || nodeConfig.providers.length === 0) {
    return [{ adapter: nodeConfig.adapter, model: nodeConfig.model }];
  }

  const indexed: Array<ProviderConfig & { _idx: number }> = nodeConfig.providers.map(
    (p, i) => ({ ...p, _idx: i }),
  );
  indexed.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a._idx - b._idx;
  });

  return indexed.map((p) => ({
    adapter: p.adapter,
    model: p.model ?? nodeConfig.model,
  }));
}

/**
 * Error-message patterns that indicate a transient transport failure.
 *
 * These are deliberately conservative — we only want to match clear networking
 * errors, not generic "error" strings. Node.js system errors use the ECONNX
 * / ETIMEDOUT family on the `code` property, and many SDKs include the code in
 * the thrown Error's message.
 */
const TRANSPORT_PATTERNS: readonly RegExp[] = [
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENETUNREACH\b/i,
  /\bENOTFOUND\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bEAI_AGAIN\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork error\b/i,
  /\bfetch failed\b/i,
];

/** HTTP 5xx server errors are retryable; 4xx (except 429) are not. */
const SERVER_5XX_PATTERNS: readonly RegExp[] = [
  /\bHTTP\s+5\d\d\b/i,
  /\bstatus\s*:\s*5\d\d\b/i,
  /\b5\d\d\s+(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
  /\bserver_error\b/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /^rate_limit:/i,
  /\brate[\s_-]?limit(ed)?\b/i,
  /\b429\b/,
  /\bToo Many Requests\b/i,
];

/**
 * Circuit-breaker trip. When the pool rejects an acquire because
 * the circuit is open, the rejection is classified as retryable so provider
 * failover can pick the next adapter in the priority list.
 */
const CIRCUIT_OPEN_PATTERNS: readonly RegExp[] = [
  /\bCircuitOpenError\b/,
  /\bCircuit open for adapter\b/i,
];

export type FailoverReason = "rate_limit" | "transport" | "server_5xx" | "circuit_open";

export interface ClassifiedError {
  retryable: boolean;
  reason?: FailoverReason;
}

/**
 * Classify an error (thrown object or error-event message) as retryable or not.
 *
 * - Matches `rate_limit:*` / `429` → retryable:rate_limit.
 * - Matches transport/network error codes → retryable:transport.
 * - Matches HTTP 5xx patterns → retryable:server_5xx.
 * - Everything else → not retryable. Workflow gates, deterministic exit codes,
 *   stalls, and plain `error` events without a recognized sentinel stay on the
 *   current adapter so we don't paper over real bugs.
 */
export function classifyError(err: unknown): ClassifiedError {
  // instanceof check short-circuits the string-pattern scan when the error is
  // already a typed CircuitOpenError — cheaper than regex and avoids
  // depending on the `.name` being preserved across rethrows.
  if (err instanceof Error && err.name === "CircuitOpenError") {
    return { retryable: true, reason: "circuit_open" };
  }

  const msg = extractMessage(err);
  if (!msg) return { retryable: false };

  for (const re of CIRCUIT_OPEN_PATTERNS) {
    if (re.test(msg)) return { retryable: true, reason: "circuit_open" };
  }
  for (const re of RATE_LIMIT_PATTERNS) {
    if (re.test(msg)) return { retryable: true, reason: "rate_limit" };
  }
  for (const re of TRANSPORT_PATTERNS) {
    if (re.test(msg)) return { retryable: true, reason: "transport" };
  }
  for (const re of SERVER_5XX_PATTERNS) {
    if (re.test(msg)) return { retryable: true, reason: "server_5xx" };
  }
  return { retryable: false };
}

function extractMessage(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${err.message} ${code}` : err.message;
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
