"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { WsServerEvent, WsClientEvent, WorkflowRunState } from "@sigil/shared";

export interface MonitorState {
  status: "connecting" | "connected" | "disconnected" | "mock";
  workflowState: WorkflowRunState | null;
  events: WsServerEvent[];
  error: string | null;
  reconnectAttempt: number;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 3000;

export function useWorkflowMonitor(wsUrl: string | null, workflowId: string | null) {
  const [state, setState] = useState<MonitorState>({
    status: wsUrl === null ? "mock" : "connecting",
    workflowState: null,
    events: [],
    error: null,
    reconnectAttempt: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const isMountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!wsUrl || !isMountedRef.current) return;

    // Tear down a stale socket before opening a new one so event handlers from
    // the previous connection can't fire into the new state.
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    setState((prev) => ({ ...prev, status: "connecting" }));

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          status: "disconnected",
          error: "Invalid WebSocket URL",
        }));
      }
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setState((prev) => ({
        ...prev,
        status: "connected",
        error: null,
        reconnectAttempt: 0,
      }));
      // Tell the server which workflow to stream — without this, the server
      // won't know which event log to replay to this client.
      if (workflowId) {
        ws.send(JSON.stringify({ type: "subscribe", workflowId } satisfies WsClientEvent));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (!isMountedRef.current) return;
      let event: WsServerEvent;
      try {
        event = JSON.parse(ev.data as string) as WsServerEvent;
      } catch {
        return;
      }

      setState((prev) => {
        const events = [...prev.events, event];
        const workflowState = applyEvent(prev.workflowState, event);
        return { ...prev, events, workflowState };
      });
    };

    ws.onclose = () => {
      if (!isMountedRef.current) return;
      wsRef.current = null;

      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;

      if (attempt <= MAX_RECONNECT_ATTEMPTS) {
        setState((prev) => ({
          ...prev,
          status: "disconnected",
          reconnectAttempt: attempt,
        }));
        reconnectTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) connectRef.current();
        }, RECONNECT_DELAY_MS);
      } else {
        setState((prev) => ({
          ...prev,
          status: "disconnected",
          reconnectAttempt: attempt,
          error: "Could not connect to Sigil monitor server",
        }));
      }
    };

    ws.onerror = () => {
      if (!isMountedRef.current) return;
      // onclose will fire after onerror — let it handle reconnect
      setState((prev) => ({
        ...prev,
        status: "disconnected",
      }));
    };
  }, [wsUrl, workflowId]);

  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    isMountedRef.current = true;

    if (wsUrl === null) {
      setState({
        status: "mock",
        workflowState: null,
        events: [],
        error: null,
        reconnectAttempt: 0,
      });
      return;
    }

    connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [wsUrl, workflowId, connect]);

  const sendControl = useCallback((event: WsClientEvent) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    setState((prev) => ({ ...prev, reconnectAttempt: 0 }));
    connectRef.current();
  }, []);

  return { ...state, sendControl, reconnect };
}

// ── State builder ────────────────────────────────────────────────────────────

function applyEvent(
  prev: WorkflowRunState | null,
  event: WsServerEvent
): WorkflowRunState | null {
  switch (event.type) {
    case "workflow_start":
      return {
        id: event.workflowId,
        workflowName: event.graph.name,
        status: "running",
        startedAt: new Date().toISOString(),
        currentNodeId: undefined,
        completedNodes: [],
        nodeResults: {},
        totalCostUsd: 0,
        retryCounters: {},
      };

    case "node_start": {
      if (!prev) return prev;
      return {
        ...prev,
        currentNodeId: event.nodeId,
      };
    }

    case "node_end": {
      if (!prev) return prev;
      const completedNodes = prev.completedNodes.includes(event.nodeId)
        ? prev.completedNodes
        : [...prev.completedNodes, event.nodeId];
      const nodeResults = { ...prev.nodeResults, [event.nodeId]: event.result };
      const totalCostUsd = prev.totalCostUsd + (event.result.costUsd ?? 0);
      return {
        ...prev,
        completedNodes,
        nodeResults,
        totalCostUsd,
        currentNodeId:
          prev.currentNodeId === event.nodeId ? undefined : prev.currentNodeId,
      };
    }

    case "workflow_end":
      if (!prev) return prev;
      return {
        ...prev,
        status: event.success ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        totalCostUsd: event.totalCostUsd ?? prev.totalCostUsd,
      };

    case "workflow_error":
      if (!prev) return prev;
      return {
        ...prev,
        status: "failed",
        completedAt: new Date().toISOString(),
      };

    case "loop_back": {
      if (!prev) return prev;
      return {
        ...prev,
        retryCounters: {
          ...prev.retryCounters,
          [event.edgeId]: event.attempt,
        },
      };
    }

    case "human_review_request":
    case "human_review_response":
    case "gate_eval":
    case "rate_limit":
    case "node_event":
      // These events update the timeline but not WorkflowRunState
      return prev;

    default:
      return prev;
  }
}
