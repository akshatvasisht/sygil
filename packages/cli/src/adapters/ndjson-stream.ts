import type { AgentEvent } from "@sygil/shared";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { logger } from "../utils/logger.js";
import { createLineDecoder } from "./ndjson-line-decoder.js";

export const DEFAULT_QUEUE_HIGH_WATER_MARK = 1_000;

/**
 * Fraction of `maxQueueSize` the queue must drain below before a paused source
 * stream is resumed. Resuming at the high-water mark itself would thrash
 * pause/resume on every event; resuming at half-empty gives the producer room
 * to refill without immediately re-tripping backpressure.
 */
const RESUME_LOW_WATER_FRACTION = 0.5;

/** Internal: warn-once guard per-session so a runaway adapter doesn't spam logs. */
const droppedWarned = new WeakSet<object>();

/**
 * Minimal internal state required by the streaming helpers.
 * Each adapter's internal interface must include these fields.
 */
export interface StreamableInternal {
  eventQueue: AgentEvent[];
  resolve: ((event: AgentEvent | null) => void) | null;
  done: boolean;
  maxQueueSize: number;
  /**
   * Set by `wireStdoutBackpressure` when it pauses a source stream because the
   * queue tripped the high-water mark. `drainEventQueue` resumes the stream
   * once the queue drains below the low-water mark, then clears this. Optional
   * so adapters/tests that don't wire a source stream are unaffected.
   */
  pausedSource?: Readable | null;
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
  // Hard cap at 2x high-water mark: drop the event. Warn exactly once per
  // session so operators get observability without log spam — silent drops
  // break NDJSON replay and cost accounting, so a producer hitting the cap
  // is either a bug in the adapter or a stalled downstream consumer.
  if (internal.eventQueue.length >= internal.maxQueueSize * 2) {
    if (!droppedWarned.has(internal)) {
      droppedWarned.add(internal);
      logger.warn(
        `[ndjson-stream] Event queue at hard cap (${internal.maxQueueSize * 2}); ` +
        `dropping events of type "${ev.type}" — downstream consumer is not draining.`,
      );
    }
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
 * Resume a paused source stream once the queue has drained below the
 * low-water mark. No-op when nothing is paused. Called after every queue
 * `shift()` so a paused producer reliably wakes back up — this is what
 * prevents the backpressure pause from deadlocking the stream.
 */
function maybeResumeSource(internal: StreamableInternal): void {
  const source = internal.pausedSource;
  if (!source) return;
  const lowWater = Math.floor(internal.maxQueueSize * RESUME_LOW_WATER_FRACTION);
  if (internal.eventQueue.length <= lowWater) {
    internal.pausedSource = null;
    source.resume();
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
      // Resume a backpressured source as soon as we drain below low-water.
      maybeResumeSource(internal);
      if (ev) yield ev;
      continue;
    }
    if (internal.done) break;
    const next = await new Promise<AgentEvent | null>((resolve) => {
      if (internal.eventQueue.length > 0) {
        const ev = internal.eventQueue.shift() ?? null;
        maybeResumeSource(internal);
        resolve(ev);
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

/**
 * Wire a child process's "error" event into the event queue.
 * Handles ENOENT / EACCES spawn failures that would otherwise surface as an
 * unhandled 'error' event. Matches the inline handler used in claude-cli.ts.
 */
export function wireSpawnError(proc: ChildProcess, internal: StreamableInternal): void {
  proc.on("error", (err) => {
    if (!internal.done) {
      pushEvent(internal, { type: "error", message: `Process spawn failed: ${err.message}` });
      finishStream(internal);
    }
  });
}

/**
 * Wire a child process's stdout stream into the event queue with real
 * backpressure. Centralizes the `proc.stdout.on("data", ...)` block the four
 * stream-json CLI adapters share:
 *
 *   1. Decode chunks UTF-8-safely into trimmed NDJSON lines (shared decoder).
 *   2. For each line, run `onLine` (per-adapter bookkeeping — push raw line to
 *      the adapter's output buffer) then `parseLine` to get 0..n events.
 *   3. Push each event via `pushEvent`. When `pushEvent` returns false the
 *      queue is at/over the high-water mark, so **pause the source stream** and
 *      record it on `internal.pausedSource`. `drainEventQueue` resumes it once
 *      the consumer drains below the low-water mark.
 *
 * Event order is preserved exactly (synchronous in-order push), so replay
 * determinism is unaffected. Pausing only stops *future* `data` events; lines
 * already decoded in the current chunk are fully pushed before returning.
 *
 * Returns a `flush()` to call from the stream's `"end"` handler for the
 * trailing (newline-less) record; it runs the same onLine/parseLine/push path.
 */
export function wireStdoutBackpressure(
  stream: Readable,
  internal: StreamableInternal,
  parseLine: (line: string) => AgentEvent[],
  onLine?: (line: string) => void,
): { flush: () => void } {
  const decoder = createLineDecoder();

  const pushLine = (line: string): void => {
    onLine?.(line);
    for (const event of parseLine(line)) {
      if (!pushEvent(internal, event) && !internal.pausedSource) {
        // Backpressure: pause the source until the consumer catches up.
        internal.pausedSource = stream;
        stream.pause();
      }
    }
  };

  stream.on("data", (chunk: Buffer) => {
    for (const line of decoder.feed(chunk)) {
      pushLine(line);
    }
  });

  return {
    flush(): void {
      const trailing = decoder.flush();
      if (trailing) pushLine(trailing);
    },
  };
}
