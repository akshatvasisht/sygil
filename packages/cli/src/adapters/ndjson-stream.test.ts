import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { AgentEvent } from "@sygil/shared";
import {
  pushEvent,
  finishStream,
  drainEventQueue,
  wireStdoutBackpressure,
  DEFAULT_QUEUE_HIGH_WATER_MARK,
  type StreamableInternal,
} from "./ndjson-stream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInternal(overrides?: Partial<StreamableInternal>): StreamableInternal {
  return {
    eventQueue: [],
    resolve: null,
    done: false,
    maxQueueSize: overrides?.maxQueueSize ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
    ...overrides,
  };
}

async function drain(internal: StreamableInternal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of drainEventQueue(internal)) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// pushEvent
// ---------------------------------------------------------------------------

describe("pushEvent", () => {
  it("delivers directly to a waiting consumer when resolve is set", () => {
    let delivered: AgentEvent | null = null;
    const internal = makeInternal({
      resolve: (ev) => { delivered = ev; },
    });

    const ev: AgentEvent = { type: "text_delta", text: "hello" };
    const ok = pushEvent(internal, ev);

    expect(ok).toBe(true);
    expect(delivered).toEqual(ev);
    expect(internal.resolve).toBeNull();
    expect(internal.eventQueue).toHaveLength(0);
  });

  it("queues the event when no consumer is waiting", () => {
    const internal = makeInternal();

    const ev: AgentEvent = { type: "text_delta", text: "queued" };
    const ok = pushEvent(internal, ev);

    expect(ok).toBe(true);
    expect(internal.eventQueue).toHaveLength(1);
    expect(internal.eventQueue[0]).toEqual(ev);
  });

  it("returns false (soft backpressure) when queue reaches high-water mark", () => {
    const internal = makeInternal({ maxQueueSize: 3 });

    // Fill queue to exactly maxQueueSize
    for (let i = 0; i < 3; i++) {
      pushEvent(internal, { type: "text_delta", text: `msg-${i}` });
    }

    expect(internal.eventQueue).toHaveLength(3);
    // Next push should return false (at high-water mark)
    const ok = pushEvent(internal, { type: "text_delta", text: "over" });
    expect(ok).toBe(false);
    expect(internal.eventQueue).toHaveLength(4);
  });

  it("drops events silently at 2x high-water mark (hard cap)", () => {
    const internal = makeInternal({ maxQueueSize: 2 });

    // Fill to 2x = 4
    for (let i = 0; i < 4; i++) {
      pushEvent(internal, { type: "text_delta", text: `msg-${i}` });
    }
    expect(internal.eventQueue).toHaveLength(4);

    // This one should be dropped
    const ok = pushEvent(internal, { type: "text_delta", text: "dropped" });
    expect(ok).toBe(false);
    expect(internal.eventQueue).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// finishStream
// ---------------------------------------------------------------------------

describe("finishStream", () => {
  it("sets done = true", () => {
    const internal = makeInternal();
    finishStream(internal);
    expect(internal.done).toBe(true);
  });

  it("resolves a waiting consumer with null", () => {
    let delivered: AgentEvent | null = { type: "text_delta", text: "sentinel" };
    const internal = makeInternal({
      resolve: (ev) => { delivered = ev; },
    });

    finishStream(internal);
    expect(delivered).toBeNull();
    expect(internal.resolve).toBeNull();
    expect(internal.done).toBe(true);
  });

  it("does not throw when no consumer is waiting", () => {
    const internal = makeInternal();
    expect(() => finishStream(internal)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// drainEventQueue
// ---------------------------------------------------------------------------

describe("drainEventQueue", () => {
  it("yields pre-queued events then completes on done", async () => {
    const internal = makeInternal();
    pushEvent(internal, { type: "text_delta", text: "first" });
    pushEvent(internal, { type: "text_delta", text: "second" });
    finishStream(internal);

    const events = await drain(internal);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("text_delta");
  });

  it("waits for pushed events when queue is initially empty", async () => {
    const internal = makeInternal();

    // Start draining in background
    const drainPromise = drain(internal);

    // Push events after a microtask
    await new Promise((r) => setTimeout(r, 0));
    pushEvent(internal, { type: "error", message: "oops" });
    finishStream(internal);

    const events = await drainPromise;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: "oops" });
  });

  it("terminates immediately when stream is already done and queue is empty", async () => {
    const internal = makeInternal();
    finishStream(internal);

    const events = await drain(internal);
    expect(events).toHaveLength(0);
  });

  it("yields all events interleaved with waits", async () => {
    const internal = makeInternal();

    const drainPromise = drain(internal);

    await new Promise((r) => setTimeout(r, 0));
    pushEvent(internal, { type: "text_delta", text: "a" });

    await new Promise((r) => setTimeout(r, 0));
    pushEvent(internal, { type: "cost_update", totalCostUsd: 0.01 });

    await new Promise((r) => setTimeout(r, 0));
    finishStream(internal);

    const events = await drainPromise;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "text_delta", text: "a" });
    expect(events[1]).toMatchObject({ type: "cost_update", totalCostUsd: 0.01 });
  });

  it("handles events queued before done is signaled", async () => {
    const internal = makeInternal();

    // Pre-queue events, then mark done
    pushEvent(internal, { type: "text_delta", text: "first" });
    pushEvent(internal, { type: "text_delta", text: "second" });

    // Start draining — it should yield queued events
    const iter = drainEventQueue(internal)[Symbol.asyncIterator]();
    const { value: v1 } = await iter.next();
    expect(v1).toMatchObject({ type: "text_delta", text: "first" });

    const { value: v2 } = await iter.next();
    expect(v2).toMatchObject({ type: "text_delta", text: "second" });

    // Now mark done — next iteration should terminate
    finishStream(internal);
    const final = await iter.next();
    expect(final.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_QUEUE_HIGH_WATER_MARK
// ---------------------------------------------------------------------------

describe("DEFAULT_QUEUE_HIGH_WATER_MARK", () => {
  it("is 1000", () => {
    expect(DEFAULT_QUEUE_HIGH_WATER_MARK).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// wireStdoutBackpressure
// ---------------------------------------------------------------------------

describe("wireStdoutBackpressure", () => {
  /**
   * A controllable Readable that records pause/resume transitions. Chunks are
   * delivered synchronously via `emit("data", ...)` so each test drives the
   * exact handler code path deterministically (real adapters get the same
   * `data` events, just asynchronously). `pause`/`resume` are the real stream
   * methods, wrapped to count transitions and track the flowing flag.
   */
  function makeSource(): Readable & {
    flowing: boolean;
    pauseCount: number;
    resumeCount: number;
    feed(chunk: Buffer): void;
  } {
    const src = new Readable({ read() {} }) as Readable & {
      flowing: boolean;
      pauseCount: number;
      resumeCount: number;
      feed(chunk: Buffer): void;
    };
    src.flowing = true;
    src.pauseCount = 0;
    src.resumeCount = 0;
    const origPause = src.pause.bind(src);
    const origResume = src.resume.bind(src);
    src.pause = () => {
      src.flowing = false;
      src.pauseCount++;
      return origPause();
    };
    src.resume = () => {
      src.flowing = true;
      src.resumeCount++;
      return origResume();
    };
    // Deliver a chunk only while flowing (mirrors a paused stream withholding data).
    src.feed = (chunk: Buffer): void => {
      if (src.flowing) src.emit("data", chunk);
    };
    return src;
  }

  function makeInternalWithSource(maxQueueSize: number): StreamableInternal {
    return {
      eventQueue: [],
      resolve: null,
      done: false,
      maxQueueSize,
      pausedSource: null,
    };
  }

  it("decodes lines and pushes one event per line in order", async () => {
    const internal = makeInternalWithSource(100);
    const src = makeSource();
    wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
    );

    src.feed(Buffer.from("a\nb\nc\n"));
    finishStream(internal);

    const events: AgentEvent[] = [];
    for await (const ev of drainEventQueue(internal)) events.push(ev);

    expect(events.map((e) => (e as { text: string }).text)).toEqual(["a", "b", "c"]);
    expect(src.pauseCount).toBe(0);
  });

  it("invokes onLine for each decoded line (adapter bookkeeping)", () => {
    const internal = makeInternalWithSource(100);
    const src = makeSource();
    const seen: string[] = [];
    wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
      (line) => seen.push(line),
    );

    src.feed(Buffer.from("one\ntwo\n"));
    expect(seen).toEqual(["one", "two"]);
  });

  it("preserves UTF-8 multi-byte chars split across chunk boundaries", () => {
    const internal = makeInternalWithSource(100);
    const src = makeSource();
    wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
    );

    // "héllo" — the é (0xC3 0xA9) is split across two chunks.
    const full = Buffer.from("héllo\n", "utf8");
    const splitAt = full.indexOf(0xa9); // byte boundary inside é
    src.feed(full.subarray(0, splitAt));
    src.feed(full.subarray(splitAt));

    expect(internal.eventQueue).toHaveLength(1);
    expect((internal.eventQueue[0] as { text: string }).text).toBe("héllo");
  });

  it("pauses the source when the queue reaches the high-water mark", () => {
    const internal = makeInternalWithSource(4);
    const src = makeSource();
    wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
    );

    // Push 6 lines without anyone draining the queue. The queue trips the
    // high-water mark (pushEvent returns false), so the source pauses.
    src.feed(Buffer.from("l0\nl1\nl2\nl3\nl4\nl5\n"));

    expect(src.flowing).toBe(false);
    expect(src.pauseCount).toBe(1);
    expect(internal.pausedSource).toBe(src);
    // No events were dropped — all 6 are queued (well under the 2x hard cap).
    expect(internal.eventQueue).toHaveLength(6);
  });

  it("resumes the source on drain below low-water, without dropping or reordering", async () => {
    const internal = makeInternalWithSource(4);
    const src = makeSource();
    wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
    );
    // Attaching the "data" listener inside wireStdoutBackpressure auto-resumes
    // the stream once (Node switches a paused Readable to flowing when the first
    // "data" listener is added). Reset so the counters below measure only the
    // backpressure-induced pause/resume cycle, not that wire-time transition.
    src.resumeCount = 0;
    src.pauseCount = 0;

    // Producer floods 6 lines -> queue trips high-water -> source pauses.
    src.feed(Buffer.from("l0\nl1\nl2\nl3\nl4\nl5\n"));
    expect(src.flowing).toBe(false);
    // A paused source withholds further data (feed is a no-op while paused).
    src.feed(Buffer.from("ignored-while-paused\n"));
    expect(internal.eventQueue).toHaveLength(6);

    // Consumer drains. Once the queue falls to/below low-water (floor(4*0.5)=2),
    // drainEventQueue resumes the source.
    const drained: string[] = [];
    const iter = drainEventQueue(internal)[Symbol.asyncIterator]();
    for (let i = 0; i < 6; i++) {
      const { value } = await iter.next();
      drained.push((value as { text: string }).text);
      if (internal.eventQueue.length <= 2) {
        expect(src.resumeCount).toBeGreaterThanOrEqual(1);
        expect(internal.pausedSource).toBeNull();
      }
    }

    expect(src.flowing).toBe(true);
    expect(src.resumeCount).toBe(1);

    // The resumed source delivers more lines, which are appended in order.
    src.feed(Buffer.from("l6\nl7\n"));
    finishStream(internal);
    for (;;) {
      const { value, done } = await iter.next();
      if (done) break;
      drained.push((value as { text: string }).text);
    }

    // No drops, no reordering across the pause/resume cycle.
    expect(drained).toEqual(["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
  });

  it("flush() emits the trailing newline-less record through the same path", () => {
    const internal = makeInternalWithSource(100);
    const src = makeSource();
    const seen: string[] = [];
    const sink = wireStdoutBackpressure(
      src,
      internal,
      (line) => [{ type: "text_delta", text: line }],
      (line) => seen.push(line),
    );

    src.feed(Buffer.from("done\ntrailing-no-newline"));
    // "trailing-no-newline" is buffered in the decoder until flush().
    expect(seen).toEqual(["done"]);

    sink.flush();
    expect(seen).toEqual(["done", "trailing-no-newline"]);
    expect(internal.eventQueue).toHaveLength(2);
  });
});
