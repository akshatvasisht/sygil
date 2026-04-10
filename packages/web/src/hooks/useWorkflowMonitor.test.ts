import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkflowMonitor } from "./useWorkflowMonitor";
import type { WsServerEvent } from "@sigil/shared";

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

    const startEvent: WsServerEvent = {
      type: "workflow_start",
      workflowId: "wf-1",
      graph: { version: "1", name: "my-workflow", nodes: {}, edges: [] },
    };

    act(() => ws.simulateMessage(startEvent));

    expect(result.current.workflowState?.workflowName).toBe("my-workflow");
    expect(result.current.workflowState?.status).toBe("running");
  });

  it("updates currentNodeId on node_start event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() =>
      ws.simulateMessage({
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "wf", nodes: {}, edges: [] },
      })
    );

    act(() =>
      ws.simulateMessage({
        type: "node_start",
        workflowId: "wf-1",
        nodeId: "planner",
        config: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "Planner",
          prompt: "plan it",
        },
        attempt: 1,
      })
    );

    expect(result.current.workflowState?.currentNodeId).toBe("planner");
  });

  it("adds to completedNodes on node_end event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() =>
      ws.simulateMessage({
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "wf", nodes: {}, edges: [] },
      })
    );

    act(() =>
      ws.simulateMessage({
        type: "node_end",
        workflowId: "wf-1",
        nodeId: "planner",
        result: {
          output: "done",
          exitCode: 0,
          durationMs: 1000,
          costUsd: 0.01,
          tokenUsage: { input: 100, output: 50 },
        },
      })
    );

    expect(result.current.workflowState?.completedNodes).toContain("planner");
  });

  it("sets status to 'completed' on workflow_end event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() =>
      ws.simulateMessage({
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "wf", nodes: {}, edges: [] },
      })
    );

    act(() =>
      ws.simulateMessage({
        type: "workflow_end",
        workflowId: "wf-1",
        success: true,
        durationMs: 5000,
        totalCostUsd: 0.05,
      })
    );

    expect(result.current.workflowState?.status).toBe("completed");
  });

  it("sets status to 'failed' on workflow_error event", () => {
    const { result } = renderHook(() =>
      useWorkflowMonitor("ws://localhost:9000", "wf-1")
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.simulateOpen());

    act(() =>
      ws.simulateMessage({
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "wf", nodes: {}, edges: [] },
      })
    );

    act(() =>
      ws.simulateMessage({
        type: "workflow_error",
        workflowId: "wf-1",
        message: "something went wrong",
      })
    );

    expect(result.current.workflowState?.status).toBe("failed");
  });
});
