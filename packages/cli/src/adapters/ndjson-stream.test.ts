import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@sygil/shared";
import {
  pushEvent,
  finishStream,
  drainEventQueue,
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
