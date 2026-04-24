import { randomUUID } from "node:crypto";
import type { AgentSession } from "@sygil/shared";

/**
 * Build the shared outer envelope for an AgentSession. Each adapter provides
 * its adapter-specific `_internal` shape (event queues, token counters, stall
 * timers, etc.); the envelope is `{ id, nodeId, adapter, startedAt }` plus
 * the supplied `_internal`.
 */
export function makeAgentSession<TInternal>(
  adapterName: string,
  nodeId: string,
  internal: TInternal,
  overrides?: { id?: string; startedAt?: Date }
): AgentSession {
  return {
    id: overrides?.id ?? randomUUID(),
    nodeId,
    adapter: adapterName,
    startedAt: overrides?.startedAt ?? new Date(),
    _internal: internal,
  };
}
