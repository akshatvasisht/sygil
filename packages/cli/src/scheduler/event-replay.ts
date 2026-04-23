import type { RecordedEvent } from "@sygil/shared";
import { EventRecorder } from "./event-recorder.js";

interface ReplayOptions {
  /** Only replay events for this node. */
  nodeId?: string;
  /** Speed multiplier: 1 = real-time, 0 = instant, 2 = double speed. Default: 1. */
  speed?: number;
  /** AbortSignal to cancel replay early. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Replay recorded events, yielding them with timing delays matching the original recording.
 *
 * - speed=0: instant (no delays)
 * - speed=1: real-time delays between events
 * - speed=2: double speed (half the delay)
 * - If nodeId is specified, only that node's events are replayed
 */
export async function* replayEvents(
  runDir: string,
  options?: ReplayOptions
): AsyncGenerator<RecordedEvent> {
  const speed = options?.speed ?? 1;
  const signal = options?.signal;

  let events: RecordedEvent[];
  if (options?.nodeId !== undefined) {
    events = await EventRecorder.readNodeEvents(runDir, options.nodeId);
  } else {
    events = await EventRecorder.readAllEvents(runDir);
  }

  if (events.length === 0) return;

  let prevTimestamp = events[0]!.timestamp;

  for (const event of events) {
    if (signal?.aborted) return;

    // Apply timing delay based on speed
    if (speed > 0) {
      const delta = event.timestamp - prevTimestamp;
      if (delta > 0) {
        const delayMs = delta / speed;
        try {
          await sleep(delayMs, signal);
        } catch {
          // AbortError — stop replay
          return;
        }
      }
    }

    prevTimestamp = event.timestamp;
    yield event;
  }
}
