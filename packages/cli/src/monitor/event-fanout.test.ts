import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventFanOut } from "./event-fanout.js";
import type { WsServerEvent } from "@sigil/shared";

/** Minimal mock WebSocket that records sent messages and exposes readyState/bufferedAmount. */
function makeMockWs(overrides?: { bufferedAmount?: number }) {
  const sent: string[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: overrides?.bufferedAmount ?? 0,
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    close: vi.fn(),
    terminate: vi.fn(),
    _sent: sent,
  };
  return ws;
}

describe("EventFanOut", () => {
  let fanOut: EventFanOut;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (fanOut) {
      await fanOut.stop();
    }
    vi.useRealTimers();
  });

  it("emit pushes to all client buffers", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws1 as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c2", ws2 as any);
    fanOut.start();

    const event: WsServerEvent = {
      type: "workflow_start",
      workflowId: "wf-1",
      graph: { version: 1, name: "test", nodes: [], edges: [] } as unknown as WsServerEvent extends { type: "workflow_start"; graph: infer G } ? G : never,
    };
    fanOut.emit(event);

    // Flush
    vi.advanceTimersByTime(50);

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it("flush sends batched events to WebSocket", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    // Emit multiple events before flush
    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });
    fanOut.emit({ type: "node_end", workflowId: "wf-1", nodeId: "n1", result: {} as never });

    vi.advanceTimersByTime(50);

    // Should have been sent as a batch (JSON array)
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
  });

  it("single event in buffer is sent unwrapped (not as array)", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });

    vi.advanceTimersByTime(50);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(payload.type).toBe("node_start");
    expect(Array.isArray(payload)).toBe(false);
  });

  it("client filter — only matching events are buffered", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any, (event: unknown) => {
      return typeof event === "object" && event !== null && "workflowId" in event && (event as Record<string, unknown>).workflowId === "wf-1";
    });
    fanOut.start();

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });
    fanOut.emit({ type: "node_start", workflowId: "wf-2", nodeId: "n2", config: {} as never, attempt: 1 });

    vi.advanceTimersByTime(50);

    // Only the wf-1 event should have been sent
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(payload.workflowId).toBe("wf-1");
  });

  it("slow client (high bufferedAmount) gets disconnected", () => {
    const MAX_BUFFERED = 1024;
    fanOut = new EventFanOut({
      bufferCapacity: 16,
      flushIntervalMs: 50,
      maxBufferedAmount: MAX_BUFFERED,
    });
    const ws = makeMockWs({ bufferedAmount: MAX_BUFFERED + 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });

    vi.advanceTimersByTime(50);

    // Should have been disconnected, not sent
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    expect(fanOut.stats().clients).toBe(0);
  });

  it("text delta coalescing — consecutive text_deltas for same node merge", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    // Emit three consecutive text_delta events for same node
    const base = { type: "node_event" as const, workflowId: "wf-1", nodeId: "n1" };
    fanOut.emit({ ...base, event: { type: "text_delta" as const, text: "Hello " } });
    fanOut.emit({ ...base, event: { type: "text_delta" as const, text: "world" } });
    fanOut.emit({ ...base, event: { type: "text_delta" as const, text: "!" } });

    vi.advanceTimersByTime(50);

    // Should be coalesced into a single event
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(payload.type).toBe("node_event");
    expect(payload.event.type).toBe("text_delta");
    expect(payload.event.text).toBe("Hello world!");
  });

  it("text delta coalescing does not merge across different nodes", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    fanOut.emit({ type: "node_event", workflowId: "wf-1", nodeId: "n1", event: { type: "text_delta", text: "a" } });
    fanOut.emit({ type: "node_event", workflowId: "wf-1", nodeId: "n2", event: { type: "text_delta", text: "b" } });

    vi.advanceTimersByTime(50);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
  });

  it("stats reflect actual sent/dropped counts", () => {
    fanOut = new EventFanOut({ bufferCapacity: 2, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    // Fill buffer beyond capacity
    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });
    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n2", config: {} as never, attempt: 1 });
    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n3", config: {} as never, attempt: 1 }); // drops oldest

    vi.advanceTimersByTime(50);

    const stats = fanOut.stats();
    expect(stats.totalDropped).toBe(1);
    expect(stats.totalSent).toBeGreaterThanOrEqual(1);
    expect(stats.clients).toBe(1);
  });

  it("removeClient cleans up the ring buffer", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);

    expect(fanOut.stats().clients).toBe(1);
    fanOut.removeClient("c1");
    expect(fanOut.stats().clients).toBe(0);

    // Events after removal should not be sent
    fanOut.start();
    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });
    vi.advanceTimersByTime(50);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("stop() flushes remaining events before stopping", async () => {
    vi.useRealTimers(); // need real timers for async stop
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 1000 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });

    // Stop should flush before completing
    await fanOut.stop();

    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("emit with no clients does not throw", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    fanOut.start();

    expect(() => {
      fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });
    }).not.toThrow();

    vi.advanceTimersByTime(50);
    expect(fanOut.stats().clients).toBe(0);
    expect(fanOut.stats().totalSent).toBe(0);
  });

  it("skips sending to clients with non-OPEN readyState", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    ws.readyState = 3; // WebSocket.CLOSED
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });

    vi.advanceTimersByTime(50);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("start() is idempotent — calling twice does not create duplicate timers", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);

    fanOut.start();
    fanOut.start(); // second call should be a no-op

    fanOut.emit({ type: "node_start", workflowId: "wf-1", nodeId: "n1", config: {} as never, attempt: 1 });

    vi.advanceTimersByTime(50);

    // Should only have been sent once, not duplicated by two timers
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("text delta coalescing preserves non-text-delta events between runs", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    // text_delta, then non-text-delta, then text_delta — should NOT merge across the gap
    const base = { type: "node_event" as const, workflowId: "wf-1", nodeId: "n1" };
    fanOut.emit({ ...base, event: { type: "text_delta" as const, text: "Hello " } });
    fanOut.emit({ ...base, event: { type: "tool_call" as const, toolName: "grep", input: "{}" } });
    fanOut.emit({ ...base, event: { type: "text_delta" as const, text: "world" } });

    vi.advanceTimersByTime(50);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws._sent[0]!);
    expect(Array.isArray(payload)).toBe(true);
    // Should be 3 separate events — no coalescing across the tool_call
    expect(payload).toHaveLength(3);
    expect(payload[0].event.type).toBe("text_delta");
    expect(payload[0].event.text).toBe("Hello ");
    expect(payload[1].event.type).toBe("tool_call");
    expect(payload[2].event.type).toBe("text_delta");
    expect(payload[2].event.text).toBe("world");
  });

  it("flush cycle with empty buffers sends nothing", () => {
    fanOut = new EventFanOut({ bufferCapacity: 16, flushIntervalMs: 50 });
    const ws = makeMockWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket object is structurally compatible but TypeScript requires the full ws.WebSocket type
    fanOut.addClient("c1", ws as any);
    fanOut.start();

    // Advance without emitting anything
    vi.advanceTimersByTime(200);

    expect(ws.send).not.toHaveBeenCalled();
  });
});
