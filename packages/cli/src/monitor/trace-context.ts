import { createHash } from "node:crypto";
import type { SpawnContext } from "@sygil/shared";

/**
 * Deterministic W3C trace-context derivation for per-node adapter spawns.
 *
 * `traceId` is a 16-byte value derived from `runId`; every node in a run
 * shares the same `traceId` so external tracing backends (Jaeger, Honeycomb,
 * Tempo) group the run's adapter API calls under one trace. `spanId` is
 * derived from `runId` + `nodeId` so each node maps to a stable 8-byte span.
 *
 * Hash derivation mirrors `scheduler/retry-policy.ts > deterministicJitter`
 * — same `createHash("sha256")` primitive, same replay-determinism contract.
 */
export function deriveTraceContext(runId: string, nodeId: string): Required<SpawnContext> {
  const traceId = createHash("sha256").update(runId).digest("hex").slice(0, 32);
  const spanId = createHash("sha256").update(`${runId}/${nodeId}`).digest("hex").slice(0, 16);
  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}
