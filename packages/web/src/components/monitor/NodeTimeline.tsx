"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Circle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Wrench,
  AlertTriangle,
  DollarSign,
  Clock3,
  Snowflake,
  Ban,
  Clock,
  ArrowRight,
  Database,
  Webhook,
} from "lucide-react";
import type { AgentEvent } from "@sygil/shared";

export interface HumanReviewTimelineEntry {
  nodeId: string; // synthetic key (e.g. "human-review-<edgeId>")
  adapter: "human-review";
  status: "awaiting";
  startedAt: string;
  attempt: number;
  edgeId: string;
  prompt: string;
  events: never[];
}

/**
 * Visible status for a node in the monitor timeline.
 *
 * - `cached` — `NodeResult.cacheHit === true`; node was served from
 *   `NodeCache` without running the adapter. Distinct from `completed` so
 *   audits can tell real runs from memoized ones.
 * - `cancelled` — observed a `workflow_error` with message "Workflow
 *   cancelled" while this entry was still in-flight (from `AbortTree`).
 */
export type NodeTimelineStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cached"
  | "cancelled";

export interface NodeTimelineEntry {
  nodeId: string;
  adapter: string;
  status: NodeTimelineStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  attempt: number;
  costUsd?: number;
  tokenUsage?: { input: number; output: number; cacheRead?: number };
  events: AgentEvent[];
}

interface NodeTimelineProps {
  entries: (NodeTimelineEntry | HumanReviewTimelineEntry)[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  /** Highlights the currently-running node when in live mode */
  currentNodeId?: string;
}

function StatusIcon({ status }: { status: NodeTimelineStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={16} className="text-accent-green shrink-0" />;
    case "running":
      return <Loader2 size={16} className="text-accent-blue shrink-0 animate-spin" />;
    case "failed":
      return <XCircle size={16} className="text-accent-red shrink-0" />;
    case "cached":
      return <Snowflake size={16} className="text-accent-cyan shrink-0" />;
    case "cancelled":
      return <Ban size={16} className="text-dim shrink-0" />;
    default:
      return <Circle size={16} className="text-dim shrink-0" />;
  }
}

function EventBadge({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "tool_call":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <Wrench size={9} className="text-accent-blue shrink-0" />
          <span className="text-accent-blue">{event.tool}</span>
          <span className="text-dim truncate max-w-[180px]">
            ({JSON.stringify(event.input).slice(0, 40)})
          </span>
        </div>
      );
    case "file_write":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <FileText size={9} className="text-accent-cyan shrink-0" />
          <span className="text-accent-cyan">{event.path}</span>
        </div>
      );
    case "shell_exec":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <Terminal size={9} className="text-accent-amber shrink-0" />
          <span className="text-dim truncate max-w-[160px]">{event.command}</span>
          <span className={`ml-auto shrink-0 ${event.exitCode === 0 ? "text-accent-green" : "text-accent-red"}`}>
            exit:{event.exitCode}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-accent-red">
          <AlertTriangle size={9} className="shrink-0" />
          <span className="truncate">{event.message}</span>
        </div>
      );
    case "cost_update":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <DollarSign size={9} className="text-accent-green shrink-0" />
          <span>${event.totalCostUsd.toFixed(4)}</span>
        </div>
      );
    case "stall":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-accent-amber">
          <AlertTriangle size={9} className="shrink-0" />
          <span className="truncate">stalled: {event.reason}</span>
        </div>
      );
    case "adapter_failover":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-accent-amber">
          <ArrowRight size={9} className="shrink-0" />
          <span className="truncate">
            adapter {event.fromAdapter} → {event.toAdapter}
          </span>
          <span className="text-dim shrink-0">({event.reason})</span>
        </div>
      );
    case "retry_scheduled":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-accent-amber">
          <Clock size={9} className="shrink-0" />
          <span>
            retry {event.nextAttempt} in {event.delayMs}ms
          </span>
          <span className="text-dim shrink-0">({event.reason})</span>
        </div>
      );
    case "context_set":
      return (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <Database size={9} className="text-accent-cyan shrink-0" />
          <span className="text-accent-cyan">{event.key}</span>
          <span className="truncate max-w-[180px]">
            = {JSON.stringify(event.value).slice(0, 40)}
          </span>
        </div>
      );
    case "hook_result":
      return (
        <div
          className={`flex items-center gap-1.5 font-mono text-[10px] ${
            event.exitCode !== 0 ? "text-accent-red" : "text-dim"
          }`}
        >
          <Webhook
            size={9}
            className={`shrink-0 ${event.exitCode !== 0 ? "text-accent-red" : "text-accent-cyan"}`}
          />
          <span>hook {event.hook}</span>
          <span className="text-dim">
            → exit={event.exitCode} ({event.durationMs}ms)
          </span>
        </div>
      );
    default:
      return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function NodeTimeline({ entries, selectedNodeId, onSelectNode }: NodeTimelineProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const toggleExpanded = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="font-mono text-[11px] text-dim uppercase tracking-widest">
          Node timeline
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Timeline */}
        <div className="relative">
          {/* Vertical spine */}
          <div className="absolute left-[26px] top-0 bottom-0 w-px bg-border" />

          {entries.map((entry, i) => {
            const isLast = i === entries.length - 1;

            // ── Human review sentinel row ──────────────────────────────────
            if (entry.adapter === "human-review") {
              const reviewEntry = entry as HumanReviewTimelineEntry;
              return (
                <div key={reviewEntry.nodeId}>
                  <div className="relative flex items-start gap-3 px-4 py-3 bg-accent-amber/5">
                    <div className="relative z-10 mt-0.5 shrink-0 bg-canvas rounded-full">
                      <Clock3 size={16} className="text-accent-amber shrink-0" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-sm font-medium text-accent-amber">
                        Awaiting human review
                      </span>
                      <div className="font-mono text-[10px] text-dim mt-0.5 truncate">
                        {reviewEntry.prompt}
                      </div>
                    </div>
                  </div>
                  {!isLast && (
                    <div className="ml-[26px] py-1 pl-6 font-mono text-[10px] text-dim" />
                  )}
                </div>
              );
            }

            // ── Regular node row ───────────────────────────────────────────
            const nodeEntry = entry as NodeTimelineEntry;
            const isExpanded = expandedNodes.has(nodeEntry.nodeId);
            const isSelected = selectedNodeId === nodeEntry.nodeId;

            return (
              <div key={`${nodeEntry.nodeId}-${nodeEntry.attempt}`}>
                {/* Node row */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`${nodeEntry.nodeId} node, status: ${nodeEntry.status}${isExpanded ? ", expanded" : ", collapsed"}`}
                  aria-expanded={isExpanded}
                  className={`
                    relative flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors duration-200
                    ${isSelected ? "bg-surface" : "hover:bg-surface/50"}
                  `}
                  onClick={() => {
                    onSelectNode(isSelected ? null : nodeEntry.nodeId);
                    toggleExpanded(nodeEntry.nodeId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNode(isSelected ? null : nodeEntry.nodeId);
                      toggleExpanded(nodeEntry.nodeId);
                    }
                  }}
                >
                  {/* Status icon (sits on spine) */}
                  <div className="relative z-10 mt-0.5 shrink-0 bg-canvas rounded-full">
                    <StatusIcon status={nodeEntry.status} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`font-mono text-sm font-medium truncate ${
                          nodeEntry.status === "completed" ? "text-bright" :
                          nodeEntry.status === "running" ? "text-accent-blue" :
                          nodeEntry.status === "failed" ? "text-accent-red" :
                          nodeEntry.status === "cached" ? "text-accent-cyan" :
                          nodeEntry.status === "cancelled" ? "text-dim line-through" :
                          "text-dim"
                        }`}>
                          {nodeEntry.nodeId}
                        </span>
                        {nodeEntry.attempt > 1 && (
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/10 border border-accent-amber/20 text-accent-amber shrink-0">
                            attempt {nodeEntry.attempt}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {nodeEntry.durationMs !== undefined && (
                          <span className="font-mono text-[10px] text-dim">
                            {formatDuration(nodeEntry.durationMs)}
                          </span>
                        )}
                        {isExpanded ? (
                          <ChevronDown size={12} className="text-dim" />
                        ) : (
                          <ChevronRight size={12} className="text-dim" />
                        )}
                      </div>
                    </div>

                    {/* Metadata row */}
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="font-mono text-[10px] text-dim">{nodeEntry.adapter}</span>
                      <span className="font-mono text-[10px] text-dim">{formatTime(nodeEntry.startedAt)}</span>
                      {nodeEntry.costUsd !== undefined && (
                        <span className="font-mono text-[10px] text-dim">${nodeEntry.costUsd.toFixed(3)}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded events */}
                {isExpanded && nodeEntry.events.length > 0 && (
                  <div className="ml-[52px] mr-4 mb-3 space-y-1 border-l border-border pl-3">
                    {nodeEntry.events
                      .filter((e) => e.type !== "text_delta" && e.type !== "tool_result")
                      .slice(0, 12)
                      .map((event, j) => (
                        <div key={j} className="py-0.5">
                          <EventBadge event={event} />
                        </div>
                      ))}
                    {nodeEntry.events.filter((e) => e.type !== "text_delta" && e.type !== "tool_result").length > 12 && (
                      <div className="font-mono text-[10px] text-dim py-0.5">
                        +{nodeEntry.events.filter((e) => e.type !== "text_delta" && e.type !== "tool_result").length - 12} more events
                      </div>
                    )}
                  </div>
                )}

                {/* Connector to next node */}
                {!isLast && (
                  <div className="ml-[26px] py-1 pl-6 font-mono text-[10px] text-dim flex items-center gap-2">
                    {nodeEntry.status === "completed" && (
                      <span className="text-accent-green/60">gate: passed →</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
