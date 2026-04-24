import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkflowMonitor } from "./useWorkflowMonitor";
import type { WsServerEvent } from "@sygil/shared";
import {
  makeNodeEndEvent,
  makeNodeStartEvent,
  makeWorkflowEndEvent,
  makeWorkflowStartEvent,
} from "../test/fixtures/workflow-events";

// ── WebSocket mock ────────────────────────────────────────────────────────────

type WsHandler = (ev: MessageEvent | Event) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = 0; // CONNECTING

  onopen: WsHandler | null = null;
  onmessage: WsHandler | null = null;
  onclose: WsHandler | null = null;
  onerror: WsHandler | null = null;

  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }

  simulateMessage(event: WsServerEvent) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) })
    );
  }

  simulateClose() {
    this.readyState = 3;
    this.onclose?.(new Event("close"));
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useWorkflowMonitor", () => {
  it("sets status to 'mock' immediately when wsUrl is null", () => {
    const { result } = renderHook(() => useWorkflowMonitor(null, null));
    expect(result.current.status).toBe("mock");
  });

  it("initializes with empty events array", () => {
    const { result } = renderHook(() => useWorkflowMonitor(null, null));
    expect(result.current.events).toEqual([]);
  });

  it("builds workflowState from workflow_start event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage(makeWorkflowStartEvent("wf-1", "my-workflow")));

    expect(result.current.workflowState?.workflowName).toBe("my-workflow");
    expect(result.current.workflowState?.status).toBe("running");
  });

  it("updates currentNodeId on node_start event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage(makeWorkflowStartEvent("wf-1", "wf")));

    act(() =>
      ws.simulateMessage(
        makeNodeStartEvent("planner", "claude-sdk", {
          model: "claude-opus-4-5",
          role: "Planner",
          prompt: "plan it",
        })
      )
    );

    expect(result.current.workflowState?.currentNodeId).toBe("planner");
  });

  it("adds to completedNodes on node_end event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage(makeWorkflowStartEvent("wf-1", "wf")));

    act(() =>
      ws.simulateMessage(
        makeNodeEndEvent("planner", {
          output: "done",
          exitCode: 0,
          durationMs: 1000,
          costUsd: 0.01,
        })
      )
    );

    expect(result.current.workflowState?.completedNodes).toContain("planner");
  });

  it("sets status to 'completed' on workflow_end event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage(makeWorkflowStartEvent("wf-1", "wf")));

    act(() =>
      ws.simulateMessage(
        makeWorkflowEndEvent({ durationMs: 5000, totalCostUsd: 0.05 })
      )
    );

    expect(result.current.workflowState?.status).toBe("completed");
  });

  it("sets status to 'failed' on workflow_error event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage(makeWorkflowStartEvent("wf-1", "wf")));

    act(() =>
      ws.simulateMessage({
        type: "workflow_error",
        workflowId: "wf-1",
        message: "something went wrong",
      })
    );

    expect(result.current.workflowState?.status).toBe("failed");
  });

  // The events array used to grow without bound. Long runs with
  // frequent text_delta / metrics_tick broadcasts accumulated tens of thousands
  // of entries and re-rendered the whole list on every message. Now capped at
  // MAX_MONITOR_EVENTS (2000) with a `truncatedCount` on state.
  describe("event buffer bound", () => {
    it("caps events at MAX_MONITOR_EVENTS when the feed is long-running", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      const TOTAL = 5000;
      act(() => {
        for (let i = 0; i < TOTAL; i++) {
          ws.simulateMessage({
            type: "rate_limit",
            workflowId: "wf-1",
            nodeId: "n",
            retryAfterMs: i,
          });
        }
      });

      expect(result.current.events.length).toBe(2000);
      // Oldest entries were evicted, not the newest
      const last = result.current.events[result.current.events.length - 1]!;
      expect(last.type).toBe("rate_limit");
      if (last.type === "rate_limit") {
        expect(last.retryAfterMs).toBe(TOTAL - 1);
      }
    });

    it("tracks how many events were dropped in `truncatedCount`", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      const TOTAL = 3500;
      act(() => {
        for (let i = 0; i < TOTAL; i++) {
          ws.simulateMessage({
            type: "rate_limit",
            workflowId: "wf-1",
            nodeId: "n",
            retryAfterMs: i,
          });
        }
      });

      // total - cap = truncated
      expect(result.current.truncatedCount).toBe(TOTAL - 2000);
    });

    it("stays at truncatedCount=0 below the cap", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      act(() => {
        for (let i = 0; i < 100; i++) {
          ws.simulateMessage({
            type: "rate_limit",
            workflowId: "wf-1",
            nodeId: "n",
            retryAfterMs: i,
          });
        }
      });

      expect(result.current.events.length).toBe(100);
      expect(result.current.truncatedCount).toBe(0);
    });
  });

  // applyEvent used to have no `circuit_breaker` case — the
  // event fell through `default: return prev`, so the UI had no way to render
  // a "closed → open" transition beyond tailing NDJSON.
  describe("circuit_breaker state tracking", () => {
    it("initializes circuitBreakers to an empty object", () => {
      const { result } = renderHook(() => useWorkflowMonitor(null, null));
      expect(result.current.circuitBreakers).toEqual({});
    });

    it("records the latest transition per adapter", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "open",
          reason: "5 failures in 30s",
          timestamp: "2026-04-20T10:00:00Z",
        })
      );

      expect(result.current.circuitBreakers["claude-sdk"]).toEqual({
        state: "open",
        reason: "5 failures in 30s",
        at: "2026-04-20T10:00:00Z",
      });
      // Event also appears in the events log — this is the rendering path for circuit_breaker events.
      const last = result.current.events[result.current.events.length - 1]!;
      expect(last.type).toBe("circuit_breaker");
    });

    it("overwrites per-adapter state on subsequent transitions", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "open",
        })
      );
      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "half_open",
        })
      );
      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "closed",
        })
      );

      expect(result.current.circuitBreakers["claude-sdk"]?.state).toBe("closed");
    });

    it("tracks multiple adapters independently", () => {
      const { result } = renderHook(() =>
        useWorkflowMonitor("ws://localhost:9000", "wf-1")
      );
      const ws = MockWebSocket.instances[0]!;
      act(() => ws.simulateOpen());

      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "open",
        })
      );
      act(() =>
        ws.simulateMessage({
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "codex",
          state: "half_open",
        })
      );

      expect(result.current.circuitBreakers["claude-sdk"]?.state).toBe("open");
      expect(result.current.circuitBreakers["codex"]?.state).toBe("half_open");
    });
  });
});
