import type { AgentEvent } from "@sigil/shared";

export const DEFAULT_QUEUE_HIGH_WATER_MARK = 1_000;

/**
 * Minimal internal state required by the streaming helpers.
 * Each adapter's internal interface must include these fields.
 */
export interface StreamableInternal {
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  done: boolean;
  maxQueueSize: number;
}

/**
 * Push an event to the waiting consumer or the queue.
 * Returns false when the queue is at the high-water mark — callers should
 * pause emitting if possible (soft backpressure signal).
 */
export function pushEvent(internal: StreamableInternal, ev: AgentEvent): boolean {
  if (internal.resolve) {
    const res = internal.resolve;
    internal.resolve = null;
    res(ev);
    return true;
  }
  // Drop events silently if queue is at 2x high-water mark (hard cap)
  if (internal.eventQueue.length >= internal.maxQueueSize * 2) {
    return false;
  }
  internal.eventQueue.push(ev);
  return internal.eventQueue.length < internal.maxQueueSize;
}

/**
 * Signal that the stream is finished (no more events).
 * Call this once stdout closes and the process has exited.
 */
export function finishStream(internal: StreamableInternal): void {
  internal.done = true;
  if (internal.resolve) {
    const res = internal.resolve;
    internal.resolve = null;
    res(null);
  }
}

/**
 * Async generator that consumes the event queue.
 * Yields all queued events, then waits for new ones, until done.
 */
export async function* drainEventQueue(
  internal: StreamableInternal
): AsyncIterable<AgentEvent> {
  while (true) {
    if (internal.eventQueue.length > 0) {
      const ev = internal.eventQueue.shift();
      if (ev) yield ev;
      continue;
    }
    if (internal.done) break;
    const next = await new Promise<AgentEvent | null>((resolve) => {
      if (internal.eventQueue.length > 0) {
        resolve(internal.eventQueue.shift() ?? null);
      } else if (internal.done) {
        resolve(null);
      } else {
        internal.resolve = resolve;
      }
    });
    if (next === null) break;
    yield next;
  }
}
