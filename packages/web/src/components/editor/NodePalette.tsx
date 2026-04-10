"use client";

import { useRef, useState, useEffect } from "react";
import { Upload, GripVertical } from "lucide-react";
import type { NodeArchetype } from "@/hooks/useWorkflowEditor";

// ── Palette entries ──────────────────────────────────────────────────────────

interface PaletteEntry {
  archetype: NodeArchetype;
  label: string;
  description: string;
  badgeLabel: string;
  badgeCls: string;
  dotCls: string;
}

const PALETTE_ENTRIES: PaletteEntry[] = [
  {
    archetype: "planner",
    label: "Planner",
    description: "Plans, researches, writes specs",
    badgeLabel: "claude-sdk",
    badgeCls: "bg-accent-blue/15 text-accent-blue border-accent-blue/30",
    dotCls: "bg-accent-blue",
  },
  {
    archetype: "implementer",
    label: "Implementer",
    description: "Writes and edits code",
    badgeLabel: "codex",
    badgeCls: "bg-accent-green/15 text-accent-green border-accent-green/30",
    dotCls: "bg-accent-green",
  },
  {
    archetype: "reviewer",
    label: "Reviewer",
    description: "Reviews and validates output",
    badgeLabel: "claude-sdk",
    badgeCls: "bg-accent-blue/15 text-accent-blue border-accent-blue/30",
    dotCls: "bg-accent-blue",
  },
  {
    archetype: "custom",
    label: "Custom",
    description: "Configurable agent",
    badgeLabel: "custom",
    badgeCls: "bg-muted/20 text-subtle border-muted/30",
    dotCls: "bg-subtle",
  },
];

// ── Props ────────────────────────────────────────────────────────────────────

interface NodePaletteProps {
  onLoadWorkflow: (json: string) => { success: boolean; error?: string };
  /** Callback to add a node at a default canvas position. Wire from WorkflowEditor. */
  onAddNode?: (archetype: NodeArchetype) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function NodePalette({ onLoadWorkflow, onAddNode }: NodePaletteProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Errors from the workflow loader are transient feedback; dismiss automatically
  // so the UI doesn't stay in an error state after the user corrects the file.
  useEffect(() => {
    if (!loadError) return;
    const timer = setTimeout(() => setLoadError(null), 5000);
    return () => clearTimeout(timer);
  }, [loadError]);

  function handleDragStart(
    event: React.DragEvent<HTMLDivElement>,
    archetype: NodeArchetype
  ) {
    event.dataTransfer.setData("application/sigil-node-type", archetype);
    event.dataTransfer.effectAllowed = "copy";
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text !== "string") return;
      const result = onLoadWorkflow(text);
      if (!result.success) {
        setLoadError(result.error ?? "Unknown error");
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be reloaded
    event.target.value = "";
  }

  return (
    <div className="w-48 shrink-0 bg-panel border-r border-border flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border">
        <div className="font-mono text-[10px] text-dim uppercase tracking-widest">
          Node palette
        </div>
      </div>

      {/* Draggable entries */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5" role="list">
        {PALETTE_ENTRIES.map((entry) => (
          <div
            key={entry.archetype}
            draggable
            role="button"
            tabIndex={0}
            aria-label={`Add ${entry.label} node to canvas`}
            onDragStart={(e) => handleDragStart(e, entry.archetype)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onAddNode?.(entry.archetype);
              }
            }}
            className="relative group cursor-grab active:cursor-grabbing bg-surface border border-border hover:border-border-bright rounded-lg p-2.5 transition-colors duration-200 select-none min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {/* Accent bar */}
            <div
              className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${entry.dotCls} opacity-70`}
            />

            <div className="pl-2">
              {/* Label row */}
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-xs font-semibold text-bright">
                  {entry.label}
                </span>
                <GripVertical
                  size={11}
                  className="text-muted group-hover:text-subtle transition-colors duration-200"
                />
              </div>

              {/* Description */}
              <div className="font-mono text-[10px] text-dim leading-tight mb-2">
                {entry.description}
              </div>

              {/* Adapter badge */}
              <span
                className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${entry.badgeCls}`}
              >
                {entry.badgeLabel}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Load JSON button */}
      <div className="shrink-0 p-2 border-t border-border">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          aria-label="Load workflow JSON file"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Load workflow JSON file"
          className="w-full flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-lg border border-border bg-canvas text-dim font-mono text-xs hover:border-border-bright hover:text-bright transition-colors duration-200"
        >
          <Upload size={11} />
          Load JSON
        </button>
        {loadError && (
          <div className="mt-1.5 px-1 text-accent-red text-[10px] font-mono leading-tight">
            Failed to load: {loadError}
          </div>
        )}
      </div>
    </div>
  );
}
