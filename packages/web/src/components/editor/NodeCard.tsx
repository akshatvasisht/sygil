"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Code, Terminal, MousePointer, Radio } from "lucide-react";
import type { AdapterType, NodeExecutionStatus } from "@sigil/shared";

export type NodeStatus = "idle" | "running" | "completed" | "failed" | "gate";

export type { NodeExecutionStatus };

export interface NodeCardData {
  nodeId: string;
  adapter: AdapterType;
  model: string;
  role: string;
  tools: string[];
  status: NodeStatus;
  durationMs?: number;
  costUsd?: number;
  attempt?: number;
  executionState?: NodeExecutionStatus;
  [key: string]: unknown;
}

const ADAPTER_ICON: Record<AdapterType, { icon: typeof Bot; color: string }> = {
  "claude-sdk": { icon: Bot, color: "text-accent-blue" },
  codex: { icon: Code, color: "text-accent-green" },
  "claude-cli": { icon: Terminal, color: "text-subtle" },
  cursor: { icon: MousePointer, color: "text-accent-purple" },
  echo: { icon: Radio, color: "text-dim" },
};

function execBorder(execState: NodeExecutionStatus | undefined, status: NodeStatus): string {
  const src = execState ?? { status };
  switch (src.status) {
    case "running": return "border-accent-blue/70 node-running";
    case "completed": return "border-accent-green/60 node-completed";
    case "failed": return "border-accent-red/60 node-failed";
    default: return "border-border";
  }
}

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps) {
  const d = data as NodeCardData;
  const adapterInfo = ADAPTER_ICON[d.adapter] ?? ADAPTER_ICON["claude-cli"];
  const AdapterIcon = adapterInfo.icon;
  const borderClass = execBorder(d.executionState, d.status);
  const exec = d.executionState;
  const selectedClass = selected ? "ring-2 ring-accent/50 border-accent" : "";
  const prompt = d.prompt as string | undefined;
  const promptPreview = prompt && prompt.length > 0
    ? (prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt)
    : null;

  return (
    <div
      className={`
        relative w-52 rounded-lg border bg-panel transition-all duration-200
        ${selectedClass || borderClass}
        ${!selected ? "hover:border-border-bright" : ""}
      `}
    >
      <Handle type="target" position={Position.Left} className="!left-[-5px] handle-target" />
      <Handle type="source" position={Position.Right} className="!right-[-5px] handle-source" />

      <div className="px-3 py-2.5">
        {/* Node ID + adapter icon + status */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <AdapterIcon size={14} className={`${adapterInfo.color} shrink-0`} />
            <span className="font-mono text-xs font-medium text-bright truncate">
              {d.nodeId}
            </span>
          </div>
          <StatusBadge exec={exec} status={d.status} />
        </div>

        {/* Role — single line, muted */}
        <div className="font-mono text-[10px] text-dim mt-1 truncate">{d.role}</div>

        {/* Model + tool count */}
        <div className="flex items-center gap-1.5 mt-1">
          <span className="font-mono text-[10px] text-dim truncate">{d.model}</span>
          {d.tools.length > 0 && (
            <span className="bg-surface border border-border text-dim text-[10px] px-1.5 rounded whitespace-nowrap shrink-0">
              {d.tools.length} tool{d.tools.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Execution metrics when available */}
        {exec && exec.status === "completed" && (exec.durationMs !== undefined || exec.costUsd !== undefined) && (
          <div className="flex items-center gap-2 mt-1.5">
            {exec.durationMs !== undefined && (
              <span className="font-mono text-[10px] text-dim">
                {exec.durationMs < 1000 ? `${exec.durationMs}ms` : `${(exec.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
            {exec.costUsd !== undefined && (
              <span className="font-mono text-[10px] text-dim">${exec.costUsd.toFixed(4)}</span>
            )}
          </div>
        )}

        {/* Retry badge */}
        {exec && exec.attempt > 1 && (
          <div className="mt-1">
            <span className="font-mono text-[10px] text-accent-amber/80">↺ attempt {exec.attempt}</span>
          </div>
        )}

        {/* Prompt preview */}
        {promptPreview && (
          <div className="border-t border-border/50 mt-2 pt-1.5">
            <div className="font-mono text-[10px] text-dim italic truncate">{promptPreview}</div>
          </div>
        )}
      </div>
    </div>
  );
});

function StatusBadge({
  exec,
  status,
}: {
  exec: NodeExecutionStatus | undefined;
  status: NodeStatus;
}) {
  const s = exec?.status ?? status;
  switch (s) {
    case "running":
      return <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse shrink-0" />;
    case "completed":
      return <div className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0" />;
    case "failed":
      return <div className="w-1.5 h-1.5 rounded-full bg-accent-red shrink-0" />;
    case "gate":
      return <div className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse shrink-0" />;
    default:
      return <div className="w-1.5 h-1.5 rounded-full bg-muted shrink-0" />;
  }
}
