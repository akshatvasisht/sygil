"use client";

import { useEffect, useRef, useState } from "react";
import {
  Wrench,
  FileText,
  Terminal,
  Type,
  DollarSign,
  AlertTriangle,
  AlertCircle,
  GitBranch,
  Play,
  CheckCircle2,
  XCircle,
  Eye,
  CheckSquare,
  Zap,
  Database,
  Webhook,
} from "lucide-react";
import type { WsServerEvent } from "@sygil/shared";

interface EventStreamProps {
  events: WsServerEvent[];
  autoScroll?: boolean;
  /**
   * Count of events dropped off the oldest end of the client-side buffer.
   * When > 0, a "N events truncated" banner is rendered at the top of the scrollable
   * list so operators know the view is not complete.
   */
  truncatedCount?: number;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(str: string, n: number): string {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

interface EventRowProps {
  event: WsServerEvent;
  timestamp: string;
  isRecent: boolean;
}

function EventRow({ event, timestamp, isRecent }: EventRowProps) {
  const baseClass = `flex items-start gap-3 px-4 py-2 font-mono text-[12px] border-b border-border/40 last:border-b-0${isRecent ? " animate-stream-in" : ""}`;

  switch (event.type) {
    case "workflow_start":
      return (
        <div className={`${baseClass} bg-accent-blue/5`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <Play size={12} className="text-accent-blue shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-blue">workflow_start</span>
            <span className="text-dim ml-2">{event.workflowId}</span>
          </div>
        </div>
      );

    case "node_start":
      return (
        <div className={`${baseClass} bg-accent-blue/3`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <Play size={12} className="text-accent-blue shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-blue">node_start</span>
            <span className="text-dim ml-2">{event.nodeId}</span>
            {event.attempt > 1 && (
              <span className="ml-2 text-accent-amber">attempt #{event.attempt}</span>
            )}
          </div>
        </div>
      );

    case "node_end":
      return (
        <div className={`${baseClass} bg-accent-green/3`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <CheckCircle2 size={12} className="text-accent-green shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-green">node_end</span>
            <span className="text-dim ml-2">{event.nodeId}</span>
            <span className="text-dim ml-2">
              {(event.result.durationMs / 1000).toFixed(1)}s
            </span>
            {event.result.costUsd !== undefined && (
              <span className="text-dim ml-2">${event.result.costUsd.toFixed(3)}</span>
            )}
          </div>
        </div>
      );

    case "node_event": {
      const inner = event.event;
      switch (inner.type) {
        case "tool_call":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <Wrench size={12} className="text-accent-blue shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-blue">{inner.tool}</span>
                <span className="text-dim ml-2 text-[11px]">
                  {truncate(JSON.stringify(inner.input), 80)}
                </span>
              </div>
            </div>
          );
        case "tool_result":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <div className={`w-3 h-3 rounded-full shrink-0 mt-0.5 ${inner.success ? "bg-accent-green/30" : "bg-accent-red/30"}`} />
              <div className="text-dim text-[11px] truncate max-w-md">
                → {truncate(inner.output, 100)}
              </div>
            </div>
          );
        case "file_write":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <FileText size={12} className="text-accent-cyan shrink-0 mt-0.5" />
              <div>
                <span className="text-dim">file_write</span>
                <span className="text-accent-cyan ml-2">{inner.path}</span>
              </div>
            </div>
          );
        case "shell_exec":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <Terminal size={12} className="text-accent-amber shrink-0 mt-0.5" />
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-accent-amber truncate max-w-[300px]">{inner.command}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] border ${inner.exitCode === 0
                    ? "text-accent-green border-accent-green/20 bg-accent-green/5"
                    : "text-accent-red border-accent-red/20 bg-accent-red/5"
                  }`}>
                  exit:{inner.exitCode}
                </span>
              </div>
            </div>
          );
        case "text_delta":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <Type size={12} className="text-dim shrink-0 mt-0.5" />
              <span className="text-dim text-[11px] leading-relaxed">
                {truncate(inner.text, 120)}
              </span>
            </div>
          );
        case "cost_update":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <DollarSign size={12} className="text-accent-green shrink-0 mt-0.5" />
              <span className="text-dim">cost ${inner.totalCostUsd.toFixed(4)}</span>
            </div>
          );
        case "stall":
          return (
            <div className={`${baseClass} bg-accent-amber/5`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <AlertTriangle size={12} className="text-accent-amber shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-amber">stall</span>
                <span className="text-accent-amber ml-2">{inner.reason}</span>
              </div>
            </div>
          );
        case "error":
          return (
            <div className={`${baseClass} bg-accent-red/5`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <AlertCircle size={12} className="text-accent-red shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-red">error</span>
                <span className="text-accent-red/70 ml-2">{inner.message}</span>
              </div>
            </div>
          );
        case "adapter_failover":
          return (
            <div className={`${baseClass} bg-accent-amber/5`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <AlertTriangle size={12} className="text-accent-amber shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-amber">adapter_failover</span>
                <span className="text-dim ml-2">
                  {inner.fromAdapter} → {inner.toAdapter}
                </span>
                <span className="text-accent-amber/70 ml-2">({inner.reason})</span>
              </div>
            </div>
          );
        case "retry_scheduled":
          return (
            <div className={`${baseClass} bg-accent-amber/5`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <AlertTriangle size={12} className="text-accent-amber shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-amber">retry_scheduled</span>
                <span className="text-dim ml-2">
                  attempt {inner.attempt}→{inner.nextAttempt}
                </span>
                <span className="text-accent-amber/70 ml-2">
                  in {inner.delayMs}ms ({inner.reason})
                </span>
              </div>
            </div>
          );
        case "context_set":
          return (
            <div className={`${baseClass}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <Database size={12} className="text-accent-cyan shrink-0 mt-0.5" />
              <div>
                <span className="text-accent-cyan">context_set</span>
                <kbd className="ml-2 font-mono text-[10px] bg-surface px-1.5 py-0.5 rounded border border-border text-body">
                  {inner.key}
                </kbd>
                <span className="text-dim ml-2 text-[11px]">
                  = {truncate(JSON.stringify(inner.value), 80)}
                </span>
              </div>
            </div>
          );
        case "hook_result":
          return (
            <div className={`${baseClass} ${inner.exitCode !== 0 ? "bg-accent-red/5" : ""}`}>
              <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
              <Webhook size={12} className={inner.exitCode !== 0 ? "text-accent-red shrink-0 mt-0.5" : "text-accent-cyan shrink-0 mt-0.5"} />
              <div>
                <span className={inner.exitCode !== 0 ? "text-accent-red" : "text-accent-cyan"}>
                  hook {inner.hook}
                </span>
                <span className="text-dim ml-2">
                  → exit={inner.exitCode} ({inner.durationMs}ms)
                </span>
              </div>
            </div>
          );
        default:
          return null;
      }
    }

    case "gate_eval":
      return (
        <div className={`${baseClass} ${event.passed ? "bg-accent-green/3" : "bg-accent-red/5"}`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <GitBranch size={12} className={event.passed ? "text-accent-green shrink-0 mt-0.5" : "text-accent-red shrink-0 mt-0.5"} />
          <div>
            <span className={event.passed ? "text-accent-green" : "text-accent-red"}>
              gate_eval
            </span>
            <span className="text-dim ml-2">{event.edgeId}</span>
            <span className={`ml-2 ${event.passed ? "text-accent-green" : "text-accent-red"}`}>
              {event.passed ? "passed" : "failed"}
            </span>
            {event.reason && (
              <span className="text-dim ml-2">({event.reason})</span>
            )}
          </div>
        </div>
      );

    case "loop_back":
      return (
        <div className={`${baseClass} bg-accent-amber/5`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <div className="text-accent-amber shrink-0 mt-0.5 text-[12px]">↺</div>
          <div>
            <span className="text-accent-amber">loop_back</span>
            <span className="text-dim ml-2">{event.edgeId}</span>
            <span className="text-accent-amber ml-2">attempt {event.attempt}/{event.maxRetries}</span>
          </div>
        </div>
      );

    case "rate_limit":
      return (
        <div className={`${baseClass} bg-accent-amber/5`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <AlertTriangle size={12} className="text-accent-amber shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-amber">rate_limit</span>
            <span className="text-dim ml-2">{event.nodeId}</span>
            <span className="text-accent-amber ml-2">
              retrying in {(event.retryAfterMs / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      );

    case "workflow_end":
      return (
        <div className={`${baseClass} ${event.success ? "bg-accent-green/8" : "bg-accent-red/8"}`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <CheckCircle2 size={12} className={event.success ? "text-accent-green shrink-0 mt-0.5" : "text-accent-red shrink-0 mt-0.5"} />
          <div>
            <span className={event.success ? "text-accent-green" : "text-accent-red"}>workflow_end</span>
            <span className="text-dim ml-2">{(event.durationMs / 1000).toFixed(1)}s total</span>
            {event.totalCostUsd !== undefined && (
              <span className="text-dim ml-2">${event.totalCostUsd.toFixed(3)} total</span>
            )}
          </div>
        </div>
      );

    case "workflow_error":
      return (
        <div className={`${baseClass} bg-accent-red/8`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <XCircle size={12} className="text-accent-red shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-red">workflow_error</span>
            {event.nodeId && <span className="text-dim ml-2">{event.nodeId}</span>}
            <span className="text-accent-red/70 ml-2">{event.message}</span>
          </div>
        </div>
      );

    case "human_review_request":
      return (
        <div className={`${baseClass} bg-accent-amber/8 border-l-2 border-accent-amber`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <Eye size={12} className="text-accent-amber shrink-0 mt-0.5" />
          <div>
            <span className="text-accent-amber font-medium">human_review</span>
            <span className="text-dim ml-2">{event.edgeId}</span>
            <span className="text-body ml-2">{event.prompt}</span>
          </div>
        </div>
      );

    case "human_review_response":
      return (
        <div className={`${baseClass} ${event.approved ? "bg-accent-green/5" : "bg-accent-red/5"}`}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <CheckSquare size={12} className={event.approved ? "text-accent-green shrink-0 mt-0.5" : "text-accent-red shrink-0 mt-0.5"} />
          <div>
            <span className={event.approved ? "text-accent-green" : "text-accent-red"}>
              review_{event.approved ? "approved" : "rejected"}
            </span>
            <span className="text-dim ml-2">{event.edgeId}</span>
          </div>
        </div>
      );

    case "circuit_breaker": {
      const bg =
        event.state === "open" ? "bg-accent-red/8" :
        event.state === "half_open" ? "bg-accent-amber/5" :
        "bg-accent-green/5";
      const color =
        event.state === "open" ? "text-accent-red" :
        event.state === "half_open" ? "text-accent-amber" :
        "text-accent-green";
      return (
        <div className={`${baseClass} ${bg}`} role="status" aria-live={event.state === "open" ? "assertive" : "polite"}>
          <span className="text-dim text-[10px] shrink-0 mt-0.5 w-16">{timestamp}</span>
          <Zap size={12} className={`${color} shrink-0 mt-0.5`} />
          <div>
            <span className={color}>circuit_breaker</span>
            <span className="text-dim ml-2">{event.adapterType}</span>
            <span className={`${color} ml-2`}>→ {event.state}</span>
            {event.reason && (
              <span className="text-dim ml-2">({event.reason})</span>
            )}
          </div>
        </div>
      );
    }

    case "metrics_tick":
      // Metrics ticks arrive ~1Hz and drive MetricsStrip directly; surfacing
      // them inline would drown out node events.
      return null;

    default:
      return null;
  }
}

export function EventStream({ events, autoScroll = true, truncatedCount = 0 }: EventStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, autoScroll]);


  const filteredEvents = filter === "all"
    ? events
    : events.filter((e) => {
      if (filter === "tools" && e.type === "node_event") return e.event.type === "tool_call";
      if (filter === "files" && e.type === "node_event") return e.event.type === "file_write";
      if (filter === "shell" && e.type === "node_event") return e.event.type === "shell_exec";
      if (filter === "system") return e.type !== "node_event";
      return false;
    });

  const FILTERS = [
    { id: "all", label: "All" },
    { id: "system", label: "System" },
    { id: "tools", label: "Tools" },
    { id: "files", label: "Files" },
    { id: "shell", label: "Shell" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
        <div className="font-mono text-[11px] text-dim uppercase tracking-widest">
          Event log
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Event filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-label={`Filter events: ${f.label}`}
              aria-pressed={filter === f.id}
              className={`font-mono text-[10px] px-2.5 min-h-[44px] min-w-[44px] rounded transition-colors duration-200 ${filter === f.id
                  ? "bg-surface text-bright border border-border"
                  : "text-dim hover:text-body hover:bg-surface/50"
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable event list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        {truncatedCount > 0 && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 px-4 py-1.5 bg-accent-amber/5 border-b border-accent-amber/20 font-mono text-[10px] text-accent-amber uppercase tracking-widest"
          >
            <AlertTriangle size={10} className="shrink-0" />
            <span>
              {truncatedCount.toLocaleString()} events truncated · oldest dropped
            </span>
          </div>
        )}
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-dim text-xs font-mono">
              {events.length === 0 ? "No events yet" : "No matching events"}
            </span>
          </div>
        ) : (
          filteredEvents.map((event, i) => (
            <EventRow
              key={`${event.type}-${event.timestamp ?? ""}-${i}`}
              event={event}
              timestamp={event.timestamp ? formatTimestamp(event.timestamp) : "--:--:--"}
              isRecent={i >= filteredEvents.length - 10}
            />
          ))
        )}
      </div>
    </div>
  );
}
