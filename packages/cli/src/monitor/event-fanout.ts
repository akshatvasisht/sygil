import { RingBuffer } from "./ring-buffer.js";

const DEFAULT_BUFFER_CAPACITY = 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 16;

export interface FanOutConfig {
  bufferCapacity: number;
  flushIntervalMs: number;
  maxBufferedAmount?: number;
}

interface ClientEntry {
  ws: WebSocketLike;
  buffer: RingBuffer<string>;
  filter?: (event: unknown) => boolean;
}

/** Minimal WebSocket interface — avoids hard dependency on `ws` types. */
interface WebSocketLike {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(): void;
}

/**
 * Decoupled event fan-out for the monitor WebSocket server.
 *
 * Instead of calling `ws.send()` synchronously for each subscriber in the
 * scheduler's hot path, the scheduler calls `emit()` which serializes once
 * and pushes the string into per-client ring buffers. A periodic flush timer
 * drains each buffer and sends batched payloads, keeping the scheduler's
 * event loop unblocked.
 */
export class EventFanOut {
  private clients = new Map<string, ClientEntry>();
  private config: FanOutConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _totalSent = 0;

  constructor(config?: Partial<FanOutConfig>) {
    this.config = {
      bufferCapacity: config?.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY,
      flushIntervalMs: config?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      ...(config?.maxBufferedAmount !== undefined
        ? { maxBufferedAmount: config.maxBufferedAmount }
        : {}),
    };
  }

  addClient(id: string, ws: WebSocketLike, filter?: (event: unknown) => boolean): void {
    this.clients.set(id, {
      ws,
      buffer: new RingBuffer<string>(this.config.bufferCapacity),
      ...(filter !== undefined ? { filter } : {}),
    });
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  /**
   * Non-blocking emit — serializes the event once with JSON.stringify,
   * then pushes the resulting string into each matching client's ring buffer.
   */
  emit(event: object): void {
    const payload = JSON.stringify(event);
    for (const [, entry] of this.clients) {
      if (entry.filter && !entry.filter(event)) continue;
      entry.buffer.push(payload);
    }
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    // Don't keep the process alive just to flush an empty fanout — matches the
    // WsMonitorServer heartbeat timer and MetricsAggregator tick. Without this,
    // a clean workflow end still holds the event loop for up to flushIntervalMs
    // on a quiet monitor.
    this.timer.unref?.();
  }

  /** Stop the flush timer, performing one final flush of remaining events. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  stats(): { clients: number; totalDropped: number; totalSent: number } {
    let totalDropped = 0;
    for (const [, entry] of this.clients) {
      totalDropped += entry.buffer.dropped;
    }
    return {
      clients: this.clients.size,
      totalDropped,
      totalSent: this._totalSent,
    };
  }

  // --- Private ---

  private flush(): void {
    for (const [id, entry] of this.clients) {
      const { ws, buffer } = entry;

      // Slow client detection
      if (
        this.config.maxBufferedAmount !== undefined &&
        ws.bufferedAmount > this.config.maxBufferedAmount
      ) {
        ws.close();
        this.clients.delete(id);
        continue;
      }

      const items = buffer.drain();
      if (items.length === 0) continue;

      // WebSocket readyState: 1 = OPEN
      if (ws.readyState !== 1) continue;

      // Coalesce text_delta events and build final payload
      const coalesced = this.coalesceTextDeltas(items);

      if (coalesced.length === 1) {
        ws.send(coalesced[0]!);
        this._totalSent++;
      } else {
        ws.send("[" + coalesced.join(",") + "]");
        this._totalSent += coalesced.length;
      }
    }
  }

  /**
   * Merge consecutive `node_event` items whose inner event is `text_delta`
   * for the same nodeId into a single event with concatenated text.
   */
  private coalesceTextDeltas(items: string[]): string[] {
    if (items.length <= 1) return items;

    const result: string[] = [];
    let i = 0;

    while (i < items.length) {
      const parsed = JSON.parse(items[i]!) as Record<string, unknown>;

      if (!isTextDelta(parsed)) {
        result.push(items[i]!);
        i++;
        continue;
      }

      // Accumulate consecutive text_deltas for the same node
      const nodeId = parsed.nodeId as string;
      const innerEvent = parsed.event as { type: string; text: string };
      let mergedText = innerEvent.text;
      let j = i + 1;

      while (j < items.length) {
        const next = JSON.parse(items[j]!) as Record<string, unknown>;
        if (!isTextDelta(next) || next.nodeId !== nodeId) break;
        const nextEvent = next.event as { type: string; text: string };
        mergedText += nextEvent.text;
        j++;
      }

      if (j === i + 1) {
        // No merge happened, use original string
        result.push(items[i]!);
      } else {
        // Rebuild the coalesced event
        parsed.event = { type: "text_delta", text: mergedText };
        result.push(JSON.stringify(parsed));
      }

      i = j;
    }

    return result;
  }
}

function isTextDelta(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== "node_event") return false;
  const event = parsed.event as Record<string, unknown> | undefined;
  return event?.type === "text_delta";
}
