"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { WsServerEvent, WsClientEvent, WorkflowRunState } from "@sygil/shared";

/**
 * Last-known state per adapter-type circuit breaker. Driven by the
 * `circuit_breaker` `WsServerEvent` transition stream — not a cumulative view
 * (that lives in `MetricsSnapshot.circuitBreakers` from `metrics_tick`).
 * The UI can render this as a badge + `aria-live` assertive announcement on
 * `state === "open"` without reaching back into the events array.
 */
export interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  reason?: string;
  /** ISO timestamp of the last observed transition. */
  at?: string;
}

export interface MonitorState {
  status: "connecting" | "connected" | "disconnected" | "mock";
  workflowState: WorkflowRunState | null;
  events: WsServerEvent[];
  /** Count of events dropped off the oldest end because the cap was exceeded. */
  truncatedCount: number;
  /** Per-adapter-type circuit breaker transition state. Empty before the first transition. */
  circuitBreakers: Record<string, CircuitBreakerState>;
  error: string | null;
  reconnectAttempt: number;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 3000;

/**
 * Hard cap on the monitor's in-memory event buffer. Long runs that emit
 * `text_delta` / `metrics_tick` at a steady cadence accumulate tens of thousands
 * of entries; each append used to trigger a full re-render over an ever-growing
 * array. We keep the most recent MAX_MONITOR_EVENTS entries and surface the
 * drop count via `truncatedCount` so the UI can render a "N events truncated"
 * banner. The authoritative buffer lives in the CLI's fanout ring (see CLAUDE.md
 * — WebSocket ring buffer 1024 events/client); this cap exists purely to bound
 * client memory and render cost.
 */
const MAX_MONITOR_EVENTS = 2000;

export function useWorkflowMonitor(wsUrl: string | null, workflowId: string | null) {
  const [state, setState] = useState<MonitorState>({
    status: wsUrl === null ? "mock" : "connecting",
    workflowState: null,
    events: [],
    truncatedCount: 0,
    circuitBreakers: {},
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
        // Cap the buffer at MAX_MONITOR_EVENTS. When the cap is reached,
        // drop the oldest entry and bump `truncatedCount` so the UI can render
        // a banner. The array reference changes on every event either way —
        // consumers that care about render cost should memoize over the tail.
        let events: WsServerEvent[];
        let truncatedCount = prev.truncatedCount;
        if (prev.events.length >= MAX_MONITOR_EVENTS) {
          events = [...prev.events.slice(prev.events.length - MAX_MONITOR_EVENTS + 1), event];
          truncatedCount += 1;
        } else {
          events = [...prev.events, event];
        }
        const workflowState = applyEvent(prev.workflowState, event);
        // Track circuit breaker transitions in a separate slice so the UI can
        // render a badge without scanning the events array.
        let circuitBreakers = prev.circuitBreakers;
        if (event.type === "circuit_breaker") {
          circuitBreakers = {
            ...prev.circuitBreakers,
            [event.adapterType]: {
              state: event.state,
              ...(event.reason !== undefined ? { reason: event.reason } : {}),
              ...(event.timestamp !== undefined ? { at: event.timestamp } : {}),
            },
          };
        }
        return { ...prev, events, truncatedCount, workflowState, circuitBreakers };
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
          error: "Could not connect to Sygil monitor server",
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
        truncatedCount: 0,
        circuitBreakers: {},
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
        sharedContext: {},
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

    case "node_event": {
      // Mirror context_set writes into the client's sharedContext view so the
      // monitor UI can render them without re-reading the checkpoint. The
      // server has already enforced the writesContext allowlist; the client
      // trusts the broadcast sequence.
      if (event.event.type === "context_set" && prev) {
        return {
          ...prev,
          sharedContext: { ...prev.sharedContext, [event.event.key]: event.event.value },
        };
      }
      return prev;
    }

    case "human_review_request":
    case "human_review_response":
    case "gate_eval":
    case "rate_limit":
    case "metrics_tick":
      // These events update the timeline / metrics strip but not WorkflowRunState
      return prev;

    default:
      return prev;
  }
}
