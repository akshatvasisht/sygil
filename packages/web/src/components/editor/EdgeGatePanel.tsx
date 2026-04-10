"use client";

import { useState } from "react";
import { X, GitBranch, RefreshCw, CheckSquare, Pencil, Eye, Plus, ChevronDown } from "lucide-react";
import type { EdgeConfig, GateCondition, GateConfig } from "@sigil/shared";

// ── Props ────────────────────────────────────────────────────────────────────

interface EdgeGatePanelProps {
  edge: EdgeConfig | null;
  edgeLabel?: string;
  onUpdate?: (patch: Partial<EdgeConfig>) => void;
  onDelete?: () => void;
  onClose: () => void;
  editMode?: boolean;
  onEditModeChange?: (v: boolean) => void;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const inputCls =
  "w-full bg-canvas border border-border rounded px-2 py-1 font-mono text-xs text-bright placeholder:text-muted focus:outline-none focus:border-accent transition-colors duration-200";

// ── Read-only condition row ──────────────────────────────────────────────────

function ConditionRow({
  condition,
  editMode,
  onDelete,
}: {
  condition: GateCondition;
  editMode: boolean;
  onDelete: () => void;
}) {
  const inner = (() => {
    switch (condition.type) {
      case "exit_code":
        return (
          <div>
            <div className="font-mono text-xs text-accent-green mb-0.5">exit_code</div>
            <div className="font-mono text-[11px] text-dim">
              exit code = <span className="text-bright">{condition.value}</span>
            </div>
          </div>
        );
      case "file_exists":
        return (
          <div>
            <div className="font-mono text-xs text-accent-cyan mb-0.5">file_exists</div>
            <div className="font-mono text-[11px] text-dim">
              path: <span className="text-bright">{condition.path}</span>
            </div>
          </div>
        );
      case "regex":
        return (
          <div>
            <div className="font-mono text-xs text-accent-amber mb-0.5">regex</div>
            <div className="font-mono text-[11px] text-dim">
              file: <span className="text-bright">{condition.filePath}</span>
            </div>
            <div className="font-mono text-[11px] text-dim mt-0.5">
              pattern: <span className="text-bright">&quot;{condition.pattern}&quot;</span>
            </div>
          </div>
        );
      case "script":
        return (
          <div>
            <div className="font-mono text-xs text-accent-purple mb-0.5">script</div>
            <div className="font-mono text-[11px] text-dim">
              path: <span className="text-bright">{condition.path}</span>
            </div>
          </div>
        );
      case "human_review":
        return (
          <div>
            <div className="font-mono text-xs text-dim mb-0.5">human_review</div>
            {condition.prompt && (
              <div className="font-mono text-[11px] text-dim">
                prompt: <span className="text-bright">{condition.prompt}</span>
              </div>
            )}
          </div>
        );
    }
  })();

  const dotColor: Record<string, string> = {
    exit_code: "bg-accent-green",
    file_exists: "bg-accent-cyan",
    regex: "bg-accent-amber",
    script: "bg-accent-purple",
    human_review: "bg-dim",
  };

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-canvas border border-border">
      <div
        className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotColor[condition.type] ?? "bg-muted"}`}
      />
      <div className="flex-1 min-w-0">{inner}</div>
      {editMode && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove condition"
          className="shrink-0 p-2.5 -m-2 rounded text-dim hover:text-accent-red transition-colors duration-200 min-h-[44px] min-w-[44px] flex items-center justify-center"
          title="Remove condition"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ── Add condition form ────────────────────────────────────────────────────────

type ConditionType = GateCondition["type"];

const CONDITION_TYPES: { value: ConditionType; label: string }[] = [
  { value: "exit_code", label: "exit_code" },
  { value: "file_exists", label: "file_exists" },
  { value: "regex", label: "regex" },
  { value: "script", label: "script" },
  { value: "human_review", label: "human_review" },
];

interface AddConditionFormProps {
  onAdd: (cond: GateCondition) => void;
}

function AddConditionForm({ onAdd }: AddConditionFormProps) {
  const [type, setType] = useState<ConditionType>("exit_code");
  const [exitCode, setExitCode] = useState("0");
  const [filePath, setFilePath] = useState("");
  const [regexFile, setRegexFile] = useState("");
  const [regexPattern, setRegexPattern] = useState("");
  const [regexError, setRegexError] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [hrPrompt, setHrPrompt] = useState("");

  function handleAdd() {
    let cond: GateCondition | null = null;
    if (type === "exit_code") {
      cond = { type: "exit_code", value: Number(exitCode) };
    } else if (type === "file_exists" && filePath.trim()) {
      cond = { type: "file_exists", path: filePath.trim() };
    } else if (type === "regex" && regexFile.trim() && regexPattern.trim()) {
      try {
        new RegExp(regexPattern.trim());
      } catch {
        setRegexError("Invalid regular expression");
        return;
      }
      setRegexError("");
      cond = { type: "regex", filePath: regexFile.trim(), pattern: regexPattern.trim() };
    } else if (type === "script" && scriptPath.trim()) {
      cond = { type: "script", path: scriptPath.trim() };
    } else if (type === "human_review") {
      cond = { type: "human_review", prompt: hrPrompt.trim() || undefined };
    }
    if (cond) {
      onAdd(cond);
      // Reset
      setExitCode("0");
      setFilePath("");
      setRegexFile("");
      setRegexPattern("");
      setScriptPath("");
      setHrPrompt("");
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-3 space-y-2">
      <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
        Add condition
      </div>

      {/* Type selector */}
      <div className="relative">
        <select
          className="w-full bg-canvas border border-border rounded px-2 py-1 font-mono text-xs text-bright focus:outline-none focus:border-accent transition-colors duration-200 appearance-none cursor-pointer"
          value={type}
          onChange={(e) => { setType(e.target.value as ConditionType); setRegexError(""); }}
        >
          {CONDITION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
      </div>

      {/* Fields per type */}
      {type === "exit_code" && (
        <input
          className={inputCls}
          type="number"
          value={exitCode}
          aria-label="Exit code value"
          placeholder="Exit code value"
          onChange={(e) => setExitCode(e.target.value)}
        />
      )}
      {type === "file_exists" && (
        <input
          className={inputCls}
          value={filePath}
          aria-label="File path"
          placeholder="File path (e.g. tests/output.py)"
          onChange={(e) => setFilePath(e.target.value)}
        />
      )}
      {type === "regex" && (
        <>
          <input
            className={inputCls}
            value={regexFile}
            aria-label="Regex file path"
            placeholder="File path"
            onChange={(e) => setRegexFile(e.target.value)}
          />
          <input
            className={inputCls}
            value={regexPattern}
            aria-label="Regex pattern"
            placeholder="Regex pattern"
            onChange={(e) => setRegexPattern(e.target.value)}
          />
          {regexError && (
            <p className="font-mono text-[10px] text-accent-red mt-0.5">{regexError}</p>
          )}
        </>
      )}
      {type === "script" && (
        <input
          className={inputCls}
          value={scriptPath}
          aria-label="Script path"
          placeholder="Script path (e.g. ./check.sh)"
          onChange={(e) => setScriptPath(e.target.value)}
        />
      )}
      {type === "human_review" && (
        <input
          className={inputCls}
          value={hrPrompt}
          aria-label="Human review prompt"
          placeholder="Optional review prompt"
          onChange={(e) => setHrPrompt(e.target.value)}
        />
      )}

      <button
        type="button"
        onClick={handleAdd}
        className="w-full flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-lg border border-accent/30 bg-accent/10 text-accent font-mono text-xs hover:bg-accent/20 transition-colors duration-200"
      >
        <Plus size={11} />
        Add
      </button>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function EdgeGatePanel({ edge, edgeLabel, onUpdate, onDelete, onClose, editMode: controlledEditMode, onEditModeChange }: EdgeGatePanelProps) {
  const [internalEditMode, setInternalEditMode] = useState(false);
  const editMode = controlledEditMode ?? internalEditMode;
  const setEditMode = onEditModeChange ?? setInternalEditMode;

  if (!edge) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <GitBranch size={24} className="text-muted" />
        <div className="text-dim text-sm font-mono">
          Select an edge to inspect its gate conditions.
        </div>
      </div>
    );
  }

  const conditions: GateCondition[] = edge.gate?.conditions ?? [];

  function handleDeleteCondition(index: number) {
    if (!onUpdate) return;
    const next = conditions.filter((_, i) => i !== index);
    const gate: GateConfig | undefined =
      next.length > 0 ? { conditions: next } : undefined;
    onUpdate({ gate });
  }

  function handleAddCondition(cond: GateCondition) {
    if (!onUpdate) return;
    const next = [...conditions, cond];
    onUpdate({ gate: { conditions: next } });
  }

  function handleLoopBackToggle(checked: boolean) {
    if (!onUpdate) return;
    if (checked) {
      onUpdate({ isLoopBack: true, maxRetries: edge?.maxRetries ?? 3 });
    } else {
      onUpdate({ isLoopBack: false, maxRetries: undefined });
    }
  }

  function handleMaxRetriesChange(value: string) {
    if (!onUpdate) return;
    onUpdate({ maxRetries: value ? Number(value) : undefined });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={13} className="text-accent-amber shrink-0" />
          <span className="font-mono text-sm text-bright font-medium truncate">
            {edgeLabel ?? edge.id}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {onUpdate && (
            <button
              type="button"
              onClick={() => setEditMode(!editMode)}
              aria-label={editMode ? "Switch to view mode" : "Switch to edit mode"}
              title={editMode ? "View mode" : "Edit mode"}
              className={`p-2.5 -m-1 min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors duration-200 ${
                editMode
                  ? "bg-accent/15 text-accent border border-accent/30"
                  : "text-dim hover:text-bright hover:bg-surface"
              }`}
            >
              {editMode ? <Eye size={12} /> : <Pencil size={12} />}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close edge panel"
            className="p-2.5 -m-1 min-h-[44px] min-w-[44px] flex items-center justify-center rounded hover:bg-surface text-dim hover:text-bright transition-colors duration-200"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Edge metadata */}
        <div className="bg-surface rounded-lg border border-border p-3.5 space-y-2.5 card-glow">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-dim">from</span>
            <span className="font-mono text-[11px] text-bright">{edge.from}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-dim">to</span>
            <span className="font-mono text-[11px] text-bright">{edge.to}</span>
          </div>
          {edge.isLoopBack && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-dim">type</span>
              <div className="flex items-center gap-1.5">
                <RefreshCw size={10} className="text-accent-amber" />
                <span className="font-mono text-[11px] text-accent-amber">loop-back</span>
              </div>
            </div>
          )}
          {edge.maxRetries !== undefined && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-dim">maxRetries</span>
              <span className="font-mono text-[11px] text-bright">{edge.maxRetries}</span>
            </div>
          )}
        </div>

        {/* Loop-back toggle (edit mode) */}
        {onUpdate && editMode && (
          <div className="bg-surface border border-border rounded-lg p-3.5 space-y-3">
            <div className="font-mono text-[10px] text-dim uppercase tracking-widest">
              Loop-back
            </div>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={edge.isLoopBack ?? false}
                onChange={(e) => handleLoopBackToggle(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-accent-amber cursor-pointer"
              />
              <span className="font-mono text-[11px] text-dim">
                Loop-back edge (retry on gate failure)
              </span>
            </label>
            {edge.isLoopBack && (
              <div>
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Max retries
                </label>
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  value={edge.maxRetries ?? ""}
                  placeholder="e.g. 3"
                  onChange={(e) => handleMaxRetriesChange(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {/* Gate conditions */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <CheckSquare size={12} className="text-accent-amber" />
            <span className="font-mono text-[11px] text-dim uppercase tracking-widest">
              Gate conditions
            </span>
            <span className="font-mono text-[10px] text-dim">ALL must pass</span>
          </div>

          {conditions.length > 0 ? (
            <div className="space-y-2">
              {conditions.map((cond, i) => (
                <ConditionRow
                  key={`${cond.type}-${i}`}
                  condition={cond}
                  editMode={editMode}
                  onDelete={() => handleDeleteCondition(i)}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-canvas border border-border">
              <div className="w-1.5 h-1.5 rounded-full bg-muted" />
              <span className="font-mono text-[11px] text-dim">
                No gate — fires unconditionally
              </span>
            </div>
          )}

          {/* Add condition (edit mode) */}
          {onUpdate && editMode && (
            <div className="mt-3">
              <AddConditionForm onAdd={handleAddCondition} />
            </div>
          )}
        </div>

        {/* Contract (if any) */}
        {edge.contract && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="font-mono text-[11px] text-dim uppercase tracking-widest">
                Contract
              </span>
            </div>
            {edge.contract.inputMapping && (
              <div className="bg-canvas border border-border rounded-lg p-3.5">
                <div className="font-mono text-[10px] text-dim mb-2">Input mapping</div>
                {Object.entries(edge.contract.inputMapping).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-accent-cyan truncate">{k}</span>
                    <span className="text-dim shrink-0">→</span>
                    <span className="text-dim truncate">{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete edge */}
      {onDelete && (
        <div className="shrink-0 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete this edge"
            className="w-full flex items-center justify-center gap-2 px-3 min-h-[44px] rounded-lg border border-accent-red/30 bg-accent-red/10 text-accent-red font-mono text-xs hover:bg-accent-red/20 hover:border-accent-red/50 transition-colors duration-200"
          >
            <X size={12} />
            Delete edge
          </button>
        </div>
      )}
    </div>
  );
}
