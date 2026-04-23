import type { AgentEvent } from "@sygil/shared";

/**
 * Maps one parsed NDJSON event row (plus adapter-local state) to a single
 * `AgentEvent` or null (suppress). Side effects on `internal` are explicitly
 * allowed — some adapters accumulate cost, output text, or result metadata
 * while producing the event.
 */
export type EventMapper<TRaw, TInternal> = (
  raw: TRaw,
  internal: TInternal,
) => AgentEvent | null;

export type EventMapping<TRaw, TInternal> = Record<string, EventMapper<TRaw, TInternal>>;

export interface DispatchOptions {
  onParseError?: (line: string, err: unknown) => void;
}

/**
 * Parses one NDJSON line, looks up its `type` field in the mapping, and
 * invokes the registered handler. Unknown types and malformed lines return
 * null (caller decides whether to log).
 */
export function dispatchEventLine<TRaw extends { type?: unknown }, TInternal>(
  line: string,
  mapping: EventMapping<TRaw, TInternal>,
  internal: TInternal,
  opts?: DispatchOptions,
): AgentEvent | null {
  let parsed: TRaw;
  try {
    parsed = JSON.parse(line) as TRaw;
  } catch (err) {
    opts?.onParseError?.(line, err);
    return null;
  }
  const type = parsed.type;
  if (typeof type !== "string") return null;
  const handler = mapping[type];
  if (!handler) return null;
  return handler(parsed, internal);
}
