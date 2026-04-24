"use client";

import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { Wifi, WifiOff, DollarSign, Clock, Layers, Pause, Play, X, Loader2, Download, ChevronDown, Clock3, CheckCircle, XCircle, ChevronUp, Terminal } from "lucide-react";
import { NodeTimeline, type NodeTimelineEntry, type HumanReviewTimelineEntry } from "./NodeTimeline";
import { EventStream } from "./EventStream";
import { MetricsStrip } from "./MetricsStrip";
import { WorkflowEditor } from "@/components/editor/WorkflowEditor";
import { useWorkflowMonitor } from "@/hooks/useWorkflowMonitor";
import type { WsServerEvent, WorkflowRunState, WorkflowGraph, NodeExecutionStatus, MetricsSnapshot } from "@sygil/shared";
import { exportAsJson, exportAsMarkdown, triggerDownload } from "@/utils/exportLog";

// ── NodeExecutionStatus (re-exported for consumers) ───────────────────────────

export type { NodeExecutionStatus };

// ── buildExecutionStateMap ────────────────────────────────────────────────────

export function buildExecutionStateMap(
  events: WsServerEvent[],
  _workflowState: WorkflowRunState | null
): Record<string, NodeExecutionStatus> {
  const map: Record<string, NodeExecutionStatus> = {};
  const attempts: Record<string, number> = {};

  for (const event of events) {
    if (event.type === "node_start") {
      const attempt = event.attempt ?? 1;
      attempts[event.nodeId] = attempt;
      map[event.nodeId] = { status: "running", attempt };
    } else if (event.type === "node_end") {
      map[event.nodeId] = {
        status: "completed",
        attempt: attempts[event.nodeId] ?? 1,
        durationMs: event.result.durationMs,
        costUsd: event.result.costUsd,
      };
    } else if (event.type === "workflow_error" && event.nodeId) {
      map[event.nodeId] = {
        status: "failed",
        attempt: attempts[event.nodeId] ?? 1,
      };
    } else if (event.type === "loop_back") {
      // Mark the currently running node as failed before retry
      for (const [nodeId, status] of Object.entries(map)) {
        if (status.status === "running") {
          map[nodeId] = { ...status, status: "failed" };
        }
      }
    }
  }

  return map;
}


// ── Timeline builder ─────────────────────────────────────────────────────────

export function buildTimelineEntries(
  workflowState: WorkflowRunState | null,
  events: WsServerEvent[]
): (NodeTimelineEntry | HumanReviewTimelineEntry)[] {
  // ordered list of (key -> entry) — we need insertion order + ability to update by key
  const orderedKeys: string[] = [];
  const entries = new Map<string, NodeTimelineEntry | HumanReviewTimelineEntry>();

  // Track edgeId -> target nodeId from workflow_start graph
  const edgeTargetMap = new Map<string, string>(); // edgeId -> nodeId (to)

  // Track current attempt per nodeId so we can build the right key
  const currentAttemptKey = new Map<string, string>(); // nodeId -> current entry key

  for (const ev of events) {
    if (ev.type === "workflow_start") {
      for (const edge of ev.graph.edges) {
        edgeTargetMap.set(edge.id, edge.to);
      }
    } else if (ev.type === "node_start") {
      const key = `${ev.nodeId}-${ev.attempt}`;
      currentAttemptKey.set(ev.nodeId, key);
      if (!entries.has(key)) orderedKeys.push(key);
      entries.set(key, {
        nodeId: ev.nodeId,
        adapter: ev.config.adapter,
        status: "running",
        startedAt: ev.timestamp ?? new Date().toISOString(),
        attempt: ev.attempt,
        events: [],
      });
    } else if (ev.type === "node_event") {
      const key = currentAttemptKey.get(ev.nodeId);
      if (key) {
        const entry = entries.get(key) as NodeTimelineEntry | undefined;
        if (entry && entry.adapter !== "human-review") {
          entries.set(key, { ...entry, events: [...entry.events, ev.event] });
        }
      }
    } else if (ev.type === "node_end") {
      const key = currentAttemptKey.get(ev.nodeId);
      if (key) {
        const entry = entries.get(key) as NodeTimelineEntry | undefined;
        if (entry && entry.adapter !== "human-review") {
          entries.set(key, {
            ...entry,
            // distinguish cache hits from fresh completions
            status: ev.result.cacheHit ? "cached" : "completed",
            durationMs: ev.result.durationMs,
            costUsd: ev.result.costUsd,
            tokenUsage: ev.result.tokenUsage,
          });
        }
      }
    } else if (ev.type === "workflow_error") {
      // a "Workflow cancelled" abort leaves in-flight nodes in an
      // ambiguous state — label them cancelled, not failed, so operators can
      // tell user-intent aborts apart from adapter errors.
      const isCancellation = ev.message === "Workflow cancelled";
      if (ev.nodeId) {
        const key = currentAttemptKey.get(ev.nodeId);
        if (key) {
          const entry = entries.get(key);
          if (entry) {
            const status = isCancellation ? "cancelled" : "failed";
            entries.set(key, { ...entry, status } as NodeTimelineEntry);
          }
        }
      }
      if (isCancellation) {
        // Sweep any other in-flight entries — cancellation is workflow-wide.
        for (const [k, entry] of entries) {
          if (entry.adapter !== "human-review" && entry.status === "running") {
            entries.set(k, { ...entry, status: "cancelled" } as NodeTimelineEntry);
          }
        }
      }
    } else if (ev.type === "loop_back") {
      // Mark the current attempt of the target node as failed (gate didn't pass)
      const targetNodeId = edgeTargetMap.get(ev.edgeId);
      if (targetNodeId) {
        const key = currentAttemptKey.get(targetNodeId);
        if (key) {
          const entry = entries.get(key);
          if (entry && entry.adapter !== "human-review" && entry.status === "running") {
            entries.set(key, { ...entry, status: "failed" } as NodeTimelineEntry);
          }
        }
      }
      // The next node_start for that node will create a new entry with attempt+1
    } else if (ev.type === "human_review_request") {
      const reviewKey = `human-review-${ev.edgeId}`;
      if (!entries.has(reviewKey)) orderedKeys.push(reviewKey);
      entries.set(reviewKey, {
        nodeId: reviewKey,
        adapter: "human-review",
        status: "awaiting",
        startedAt: ev.timestamp ?? new Date().toISOString(),
        attempt: 1,
        edgeId: ev.edgeId,
        prompt: ev.prompt,
        events: [],
      } as HumanReviewTimelineEntry);
    }
  }

  // Mark the currently-running node
  if (workflowState?.currentNodeId) {
    const key = currentAttemptKey.get(workflowState.currentNodeId);
    if (key) {
      const entry = entries.get(key);
      if (entry && entry.status !== "completed" && entry.status !== "failed") {
        entries.set(key, { ...entry, status: "running" } as NodeTimelineEntry);
      }
    }
  }

  return orderedKeys.map((k) => entries.get(k)!).filter(Boolean);
}

// ── Elapsed timer (isolated to avoid full-tree re-renders) ──────────────────

function ElapsedTimer({ startedAt, status }: { startedAt: string | null; status: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (status !== "running" || !startedAt) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [status, startedAt]);

  if (!startedAt) return <span className="font-mono text-[11px] text-dim">—</span>;

  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const isRunning = status === "running";
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const display = minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;

  return (
    <span className={`font-mono text-[11px] ${isRunning ? "text-body" : "text-dim"}`}>
      {display}
    </span>
  );
}

// ── Connection banner ────────────────────────────────────────────────────────

type WsStatus = "connecting" | "connected" | "disconnected" | "mock";

interface ConnectionBannerProps {
  status: WsStatus;
  workflowId: string | null;
  reconnectAttempt: number;
  onReconnect?: () => void;
}

function ConnectionBanner({ status, workflowId, reconnectAttempt, onReconnect }: ConnectionBannerProps) {
  if (status === "mock") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-surface border-b border-border shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-subtle shrink-0" />
        <span className="font-mono text-[11px] text-dim">
          No workflow connected — run{" "}
          <code className="font-mono bg-panel border border-border px-1 rounded">
            sygil run workflow.json
          </code>{" "}
          and open the monitor URL it prints
        </span>
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 bg-accent-blue/10 border-b border-accent-blue/20 shrink-0">
        <Loader2 size={12} className="text-accent-blue shrink-0 animate-spin" />
        <span className="font-mono text-[11px] text-accent-blue">
          Connecting to Sygil monitor…
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-8 h-1.5 rounded-full bg-accent-blue/20 animate-pulse" />
          <div className="w-12 h-1.5 rounded-full bg-accent-blue/15 animate-pulse [animation-delay:150ms]" />
          <div className="w-6 h-1.5 rounded-full bg-accent-blue/10 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    );
  }

  if (status === "connected") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-accent-green/8 border-b border-accent-green/20 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0 animate-pulse" />
        <span className="font-mono text-[11px] text-accent-green">
          Live — connected to workflow{" "}
          <span className="text-bright">{workflowId}</span>
        </span>
      </div>
    );
  }

  // disconnected
  const maxed = reconnectAttempt >= 3;
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-accent-red/8 border-b border-accent-red/20 shrink-0">
      <WifiOff size={12} className="text-accent-red shrink-0" />
      <span className="font-mono text-[11px] text-accent-red">
        {maxed
          ? "Could not connect to Sygil monitor server — is `sygil run` still active?"
          : `Disconnected — attempting to reconnect (attempt ${reconnectAttempt}/3)…`}
      </span>
      {maxed && onReconnect && (
        <button
          onClick={onReconnect}
          aria-label="Retry WebSocket connection"
          className="border border-white/[0.08] text-dim hover:text-body px-3 min-h-[44px] rounded-md font-mono text-xs uppercase tracking-wider transition-colors duration-200 ml-auto shrink-0"
        >
          Retry connection
        </button>
      )}
    </div>
  );
}

// ── Component props ──────────────────────────────────────────────────────────

interface ExecutionMonitorProps {
  wsUrl?: string | null;
  workflowId?: string | null;
  /** Auth token — when present, control buttons are enabled. When absent, buttons are read-only. */
  authToken?: string | null;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ExecutionMonitor({ wsUrl = null, workflowId = null, authToken = null }: ExecutionMonitorProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuListRef = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  const { status, workflowState, events, truncatedCount, reconnectAttempt, sendControl, reconnect } =
    useWorkflowMonitor(wsUrl, workflowId);

  useEffect(() => {
    if (!exportMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [exportMenuOpen]);

  // Auto-focus first menu item when export menu opens
  useEffect(() => {
    if (!exportMenuOpen || !exportMenuListRef.current) return;
    const firstItem = exportMenuListRef.current.querySelector('[role="menuitem"]') as HTMLElement | null;
    firstItem?.focus();
  }, [exportMenuOpen]);

  // Auto-dismiss cancel confirmation after 5 seconds
  useEffect(() => {
    if (!confirmingCancel) return;
    const id = setTimeout(() => setConfirmingCancel(false), 5000);
    return () => clearTimeout(id);
  }, [confirmingCancel]);

  const workflowGraph = useMemo((): WorkflowGraph | null => {
    const startEvent = events.find((e) => e.type === "workflow_start");
    return startEvent?.type === "workflow_start" ? startEvent.graph : null;
  }, [events]);

  // Build per-node execution state map for the canvas overlays
  const executionState = useMemo(() => {
    return buildExecutionStateMap(events, workflowState);
  }, [events, workflowState]);

  // Latest metrics snapshot from the most recent metrics_tick event
  const latestMetrics = useMemo((): MetricsSnapshot | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === "metrics_tick") return ev.data;
    }
    return null;
  }, [events]);

  const isRunning = workflowState?.status === "running";
  const isPaused = workflowState?.status === "paused";
  const isControllable = isRunning || isPaused;
  const hasAuth = authToken !== null && authToken !== "";

  // Collect pending human review requests (not yet responded to)
  const pendingReviewRequests = events.filter((ev): ev is Extract<typeof ev, { type: "human_review_request" }> => {
    if (ev.type !== "human_review_request") return false;
    // Check if a response was already sent
    const responded = events.some(
      (e) => e.type === "human_review_response" && e.edgeId === ev.edgeId
    );
    return !responded;
  });

  const activeReview = pendingReviewRequests[0] ?? null;

  // Focus trap for human review modal — focus Approve button on open
  useEffect(() => {
    if (activeReview && approveRef.current) {
      approveRef.current.focus();
    }
  }, [activeReview]);

  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault(); // review is mandatory — don't dismiss
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      // Cycle focus between Approve and Reject only
      if (document.activeElement === approveRef.current) {
        rejectRef.current?.focus();
      } else {
        approveRef.current?.focus();
      }
    }
  }, []);

  function handleReviewApprove() {
    if (!activeReview || !workflowId) return;
    sendControl({ type: "human_review_approve", workflowId, edgeId: activeReview.edgeId });
  }

  function handleReviewReject() {
    if (!activeReview || !workflowId) return;
    sendControl({ type: "human_review_reject", workflowId, edgeId: activeReview.edgeId });
  }

  function handleExportJson() {
    const content = exportAsJson(workflowState, events);
    triggerDownload(content, "run-log.json", "application/json");
    setExportMenuOpen(false);
  }

  function handleExportMarkdown() {
    const content = exportAsMarkdown(workflowState, events);
    triggerDownload(content, "run-summary.md", "text/markdown");
    setExportMenuOpen(false);
  }

  const timelineEntries = buildTimelineEntries(workflowState, events);
  const streamEvents = events;
  const displayRunId = workflowState?.id ?? workflowId ?? "—";
  const displayWorkflow = workflowState?.workflowName ?? workflowId ?? "—";
  const completedNodes = workflowState?.completedNodes.length ?? 0;
  const totalCost = workflowState?.totalCostUsd ?? 0;

  return (
    <div className="flex flex-col h-full relative">
      <div aria-hidden={!!activeReview || undefined}>
      {/* Connection banner */}
      <div aria-live="polite" aria-atomic="true">
        <ConnectionBanner
          status={status}
          workflowId={workflowId}
          reconnectAttempt={reconnectAttempt}
          onReconnect={reconnect}
        />
      </div>

      {/* Sub-toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0 bg-surface card-glow">
        <div className="flex items-center gap-4">
          {/* Run info */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-dim">run</span>
            <span className="font-mono text-[11px] text-bright">{displayRunId}</span>
          </div>
          <div className="w-px h-3 bg-border" />
          <div className="font-mono text-[11px] text-dim">
            {displayWorkflow}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Stats */}
          <div role="status" aria-label="Workflow statistics" className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Layers size={11} className="text-dim" />
              <span className="font-mono text-[10px] text-dim">
                {completedNodes}/{timelineEntries.length} nodes
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <DollarSign size={11} className="text-dim" />
              <span className="font-mono text-[10px] text-dim">${totalCost.toFixed(3)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock size={11} className="text-dim" />
              <ElapsedTimer startedAt={workflowState?.startedAt ?? null} status={workflowState?.status ?? "idle"} />
            </div>
          </div>

          {/* Live controls — Pause / Resume / Cancel */}
          {status === "connected" && workflowId && (
            <>
              <div className="w-px h-3 bg-border" />
              <div className="flex items-center gap-1" role="group" aria-label="Workflow controls">
                {/* Pause */}
                <button
                  onClick={() => hasAuth ? sendControl({ type: "pause", workflowId }) : undefined}
                  disabled={!isRunning || !hasAuth}
                  aria-label={hasAuth ? "Pause workflow execution" : "Read-only — open this monitor with ?token=<uuid> to enable controls"}
                  title={!hasAuth ? "Read-only — open this monitor with ?token=<uuid> to enable controls" : undefined}
                  className="flex items-center gap-1 font-mono text-[10px] px-2 min-h-[44px] rounded transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-dim hover:text-accent-amber hover:bg-accent-amber/10 disabled:hover:text-dim disabled:hover:bg-transparent"
                >
                  <Pause size={10} />
                  <span>pause</span>
                </button>
                {/* Resume */}
                <button
                  onClick={() => hasAuth ? sendControl({ type: "resume_workflow", workflowId }) : undefined}
                  disabled={!isPaused || !hasAuth}
                  aria-label={hasAuth ? "Resume paused workflow" : "Read-only — open this monitor with ?token=<uuid> to enable controls"}
                  title={!hasAuth ? "Read-only — open this monitor with ?token=<uuid> to enable controls" : undefined}
                  className="flex items-center gap-1 font-mono text-[10px] px-2 min-h-[44px] rounded transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-dim hover:text-accent-green hover:bg-accent-green/10 disabled:hover:text-dim disabled:hover:bg-transparent"
                >
                  <Play size={10} />
                  <span>resume</span>
                </button>
                {/* Cancel */}
                {confirmingCancel ? (
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px] text-accent-red">Confirm cancel?</span>
                    <button
                      onClick={() => {
                        sendControl({ type: "cancel", workflowId });
                        setConfirmingCancel(false);
                      }}
                      aria-label="Confirm cancel"
                      className="flex items-center gap-1 font-mono text-[10px] text-accent-red hover:text-accent-red px-2 min-h-[44px] rounded hover:bg-accent-red/10 transition-colors duration-200 border border-accent-red/20"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmingCancel(false)}
                      aria-label="Dismiss cancel"
                      className="flex items-center gap-1 font-mono text-[10px] text-dim hover:text-body px-2 min-h-[44px] rounded hover:bg-surface transition-colors duration-200"
                    >
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => hasAuth ? setConfirmingCancel(true) : undefined}
                    disabled={!isControllable || !hasAuth}
                    aria-label={hasAuth ? "Cancel workflow execution" : "Read-only — open this monitor with ?token=<uuid> to enable controls"}
                    title={!hasAuth ? "Read-only — open this monitor with ?token=<uuid> to enable controls" : undefined}
                    className="flex items-center gap-1 font-mono text-[10px] px-2 min-h-[44px] rounded transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-dim hover:text-accent-red hover:bg-accent-red/10 disabled:hover:text-dim disabled:hover:bg-transparent"
                  >
                    <X size={10} />
                    <span>cancel</span>
                  </button>
                )}
              </div>
            </>
          )}

          <div className="w-px h-3 bg-border" />

          {/* Export dropdown */}
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setExportMenuOpen((o) => !o)}
              aria-label="Export run log"
              aria-expanded={exportMenuOpen}
              aria-haspopup="true"
              className="flex items-center gap-1 font-mono text-[10px] text-dim hover:text-body px-2 min-h-[44px] rounded hover:bg-surface transition-colors duration-200 border border-transparent hover:border-border"
            >
              <Download size={10} />
              <span>export</span>
              <ChevronDown size={9} className="ml-0.5" />
            </button>
            {exportMenuOpen && (
              <div
                ref={exportMenuListRef}
                className="absolute right-0 top-full mt-1 z-50 bg-panel border border-border rounded-lg shadow-xl min-w-[160px] overflow-hidden card-glow"
                role="menu"
                onKeyDown={(e) => {
                  const items = e.currentTarget.querySelectorAll('[role="menuitem"]');
                  const current = document.activeElement;
                  const idx = Array.from(items).indexOf(current as Element);

                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const next = idx < items.length - 1 ? idx + 1 : 0;
                    (items[next] as HTMLElement).focus();
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const prev = idx > 0 ? idx - 1 : items.length - 1;
                    (items[prev] as HTMLElement).focus();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setExportMenuOpen(false);
                  }
                }}
              >
                <button
                  onClick={handleExportJson}
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full text-left px-3 py-2 font-mono text-[11px] text-dim hover:text-body hover:bg-surface transition-colors duration-200"
                >
                  Export as JSON
                </button>
                <button
                  onClick={handleExportMarkdown}
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full text-left px-3 py-2 font-mono text-[11px] text-dim hover:text-body hover:bg-surface transition-colors duration-200 border-t border-border/50"
                >
                  Export as Markdown
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-3 bg-border" />

          {/* WS status indicator */}
          <div className="flex items-center gap-1.5">
            {status === "mock" && (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-subtle" />
                <span className="font-mono text-[10px] text-dim">not connected</span>
              </>
            )}
            {status === "connecting" && (
              <>
                <Loader2 size={11} className="text-accent-blue animate-spin" />
                <span className="font-mono text-[10px] text-accent-blue">connecting…</span>
              </>
            )}
            {status === "connected" && (
              <>
                <Wifi size={11} className="text-accent-green" />
                <span className="font-mono text-[10px] text-accent-green">live</span>
              </>
            )}
            {status === "disconnected" && (
              <>
                <WifiOff size={11} className="text-accent-red" />
                <span className="font-mono text-[10px] text-accent-red">
                  {reconnectAttempt < 3 ? `reconnecting…` : "disconnected"}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Metrics strip — hidden until first metrics_tick arrives */}
      <MetricsStrip metrics={latestMetrics} />

      {/* Main split pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Node timeline */}
        <div className="w-72 border-r border-border shrink-0 overflow-hidden flex flex-col bg-surface/30 card-glow">
          <NodeTimeline
            entries={timelineEntries}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            currentNodeId={workflowState?.currentNodeId}
          />
        </div>

        {/* Center/Right: React Flow canvas + collapsible event log drawer */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* React Flow canvas in monitor mode */}
          <div className="flex-1 overflow-hidden">
            {workflowGraph ? (
              <WorkflowEditor
                mode="monitor"
                executionState={executionState}
                initialWorkflow={workflowGraph}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-xl border border-border bg-surface flex items-center justify-center mx-auto">
                    <Terminal size={20} className="text-dim" />
                  </div>
                  <div className="font-mono text-xs text-dim">
                    Workflow graph will appear when execution starts
                  </div>
                  <div className="font-mono text-[11px] text-dim">
                    Waiting for{" "}
                    <code className="bg-surface border border-border rounded px-1">workflow_start</code>{" "}
                    event…
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Collapsible event log drawer */}
          <div
            className={`
              shrink-0 border-t border-border bg-panel flex flex-col transition-all duration-200 code-block-premium
              ${eventLogOpen ? "h-[35%]" : "h-11"}
            `}
          >
            {/* Drawer toggle tab */}
            <button
              type="button"
              onClick={() => setEventLogOpen((o) => !o)}
              aria-label={eventLogOpen ? "Collapse event log" : "Expand event log"}
              className="flex items-center justify-between px-4 min-h-[44px] hover:bg-surface/60 transition-colors duration-200 shrink-0 w-full"
            >
              <div className="flex items-center gap-2">
                <Terminal size={11} className="text-dim" />
                <span className="font-mono text-[11px] text-dim">
                  Event log
                  <span className="ml-1.5 text-dim">({streamEvents.length})</span>
                </span>
              </div>
              {eventLogOpen ? (
                <ChevronDown size={12} className="text-dim" />
              ) : (
                <ChevronUp size={12} className="text-dim" />
              )}
            </button>

            {/* Event stream — visible when open */}
            {eventLogOpen && (
              <div className="flex-1 overflow-hidden">
                <EventStream
                  events={streamEvents}
                  autoScroll={status === "connected"}
                  truncatedCount={truncatedCount}
                  sendControl={hasAuth ? sendControl : undefined}
                  workflowId={workflowId}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      </div>
      {/* Human Review Modal */}
      {activeReview && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" tabIndex={-1} onKeyDown={handleModalKeyDown}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="human-review-title"
            aria-describedby="human-review-description"
            className="bg-panel border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden card-glow"
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-surface/50">
              <div className="w-8 h-8 rounded-full bg-accent-amber/15 border border-accent-amber/30 flex items-center justify-center shrink-0">
                <Clock3 size={16} className="text-accent-amber" />
              </div>
              <div>
                <div id="human-review-title" className="font-display font-semibold text-bright text-sm">Human Review Required</div>
                <div className="font-mono text-[10px] text-dim mt-0.5">edge: {activeReview.edgeId}</div>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5">
              <div className="bg-canvas border border-border rounded-lg px-4 py-3 mb-4">
                <p className="text-body text-sm leading-relaxed whitespace-pre-wrap">{activeReview.prompt}</p>
              </div>
              <p id="human-review-description" className="font-mono text-[11px] text-dim">
                Workflow is paused. Review the output above and approve or reject to continue.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 px-6 py-4 border-t border-border bg-surface/30">
              <button
                ref={approveRef}
                onClick={handleReviewApprove}
                aria-label="Approve human review and continue workflow"
                className="flex items-center gap-2 bg-accent-green/15 hover:bg-accent-green/25 text-accent-green border border-accent-green/30 hover:border-accent-green/50 font-mono text-sm px-4 min-h-[44px] rounded-lg transition-all duration-200"
              >
                <CheckCircle size={14} />
                Approve
              </button>
              <button
                ref={rejectRef}
                onClick={handleReviewReject}
                aria-label="Reject human review and fail the gate"
                className="flex items-center gap-2 bg-accent-red/15 hover:bg-accent-red/25 text-accent-red border border-accent-red/30 hover:border-accent-red/50 font-mono text-sm px-4 min-h-[44px] rounded-lg transition-all duration-200"
              >
                <XCircle size={14} />
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
