"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { X, Cpu, Trash2, AlertTriangle, ChevronDown, Copy, Clipboard } from "lucide-react";
import type { NodeConfig, AdapterType, SandboxMode, ProviderConfig, RetryPolicy, RetryableErrorClass } from "@sygil/shared";
import { isFieldSupported } from "@sygil/shared";
import type { NodeCardData } from "./NodeCard";
// ── Constants ────────────────────────────────────────────────────────────────

const ADAPTER_OPTIONS: { value: AdapterType; label: string }[] = [
  { value: "claude-sdk", label: "claude-sdk" },
  { value: "claude-cli", label: "claude-cli" },
  { value: "codex", label: "codex" },
  { value: "cursor", label: "cursor" },
  { value: "gemini-cli", label: "gemini-cli" },
  { value: "local-oai", label: "local-oai" },
];

const SANDBOX_OPTIONS: { value: SandboxMode; label: string }[] = [
  { value: "read-only", label: "read-only" },
  { value: "workspace-write", label: "workspace-write" },
  { value: "full-access", label: "full-access" },
];

const MODEL_PRESETS: Record<AdapterType, string[]> = {
  "claude-sdk": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ],
  "claude-cli": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ],
  codex: ["gpt-4o", "gpt-4o-mini", "o3", "o3-mini", "o4-mini"],
  cursor: ["cursor-small", "gpt-4o"],
  echo: ["echo"],
  "gemini-cli": ["gemini-2.5-pro", "gemini-2.5-flash"],
  "local-oai": ["llama3.2", "qwen2.5", "mistral-nemo"],
};

const ADAPTER_ICON_COLOR: Record<string, string> = {
  "claude-sdk": "text-accent-blue",
  "claude-cli": "text-accent-blue",
  codex: "text-accent-green",
  cursor: "text-accent-purple",
  "gemini-cli": "text-accent-cyan",
  "local-oai": "text-accent-amber",
};

const TOOL_PRESETS: Record<AdapterType, string[]> = {
  "claude-sdk": ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS"],
  "claude-cli": ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS"],
  codex: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS"],
  cursor: ["Read", "Write", "Edit"],
  echo: [],
  "gemini-cli": ["shell", "read_file", "write_file", "google_search"],
  "local-oai": [],
};

// ── Sub-components ────────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  children: ReactNode;
}
function Section({ title, children }: SectionProps) {
  return (
    <div className="border-b border-border pb-4 mb-4 last:border-0 last:mb-0">
      <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
}
function Field({ label, children }: FieldProps) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="block font-mono text-[11px] text-dim mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full bg-canvas border border-border rounded px-2.5 py-1.5 font-mono text-xs text-bright placeholder:text-muted focus:outline-none focus:border-accent transition-colors duration-200";

const selectCls =
  "w-full bg-canvas border border-border rounded px-2.5 py-1.5 font-mono text-xs text-bright focus:outline-none focus:border-accent transition-colors duration-200 appearance-none cursor-pointer";

// ── Field-support annotation ─────────────────────────────────────────────────

function FieldSupportNote({ adapter, field }: { adapter: AdapterType; field: string }) {
  const support = isFieldSupported(adapter, field);
  if (support !== "ignored" && support !== "na") return null;
  return (
    <span className="ml-1.5 font-mono text-[10px] text-dim opacity-60">
      N/A for this adapter
    </span>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

interface NodePropertyPanelProps {
  nodeId: string;
  config: NodeCardData;
  onUpdate: (patch: Partial<NodeConfig>) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

// Helper: split comma-separated string into trimmed non-empty array
function splitComma(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// Helper: check if any advanced field has a non-default value
function hasAdvancedValue(config: NodeCardData): boolean {
  return (
    (config.providers !== undefined && (config.providers as unknown[]).length > 0) ||
    config.retryPolicy !== undefined ||
    config.modelTier !== undefined ||
    ((config.writesContext as string[] | undefined)?.length ?? 0) > 0 ||
    ((config.readsContext as string[] | undefined)?.length ?? 0) > 0 ||
    ((config.expectedOutputs as string[] | undefined)?.length ?? 0) > 0 ||
    config.outputSchema !== undefined
  );
}

export function NodePropertyPanel({
  nodeId,
  config,
  onUpdate,
  onDelete,
  onDuplicate,
}: NodePropertyPanelProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [newTool, setNewTool] = useState("");
  const [newDisallowedTool, setNewDisallowedTool] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [outputSchemaError, setOutputSchemaError] = useState<string | null>(null);

  // Dismiss the model dropdown when the user clicks anywhere outside it, so it
  // doesn't stay open while the user scrolls the rest of the property panel.
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    if (showModelDropdown) document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showModelDropdown]);

  const adapter = config.adapter;
  const tools: string[] = useMemo(() => config.tools ?? [], [config.tools]);
  const disallowedTools: string[] = useMemo(() => (config.disallowedTools as string[] | undefined) ?? [], [config.disallowedTools]);

  const handleAddTool = useCallback(() => {
    const t = newTool.trim();
    if (!t || tools.includes(t)) return;
    onUpdate({ tools: [...tools, t] });
    setNewTool("");
  }, [newTool, onUpdate, tools]);

  const handleRemoveTool = useCallback(
    (tool: string) => {
      onUpdate({ tools: tools.filter((t) => t !== tool) });
    },
    [onUpdate, tools]
  );

  const handlePresetTool = useCallback(
    (tool: string) => {
      if (tools.includes(tool)) {
        onUpdate({ tools: tools.filter((t) => t !== tool) });
      } else {
        onUpdate({ tools: [...tools, tool] });
      }
    },
    [onUpdate, tools]
  );

  const handleAddDisallowedTool = useCallback(() => {
    const t = newDisallowedTool.trim();
    if (!t || disallowedTools.includes(t)) return;
    onUpdate({ disallowedTools: [...disallowedTools, t] });
    setNewDisallowedTool("");
  }, [newDisallowedTool, onUpdate, disallowedTools]);

  const handleRemoveDisallowedTool = useCallback(
    (tool: string) => {
      onUpdate({ disallowedTools: disallowedTools.filter((t) => t !== tool) });
    },
    [onUpdate, disallowedTools]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu size={13} className={ADAPTER_ICON_COLOR[config.adapter] ?? "text-dim"} />
          <span className="font-mono text-sm text-bright font-medium truncate max-w-[120px]">
            {nodeId}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onDuplicate && (
            <button
              type="button"
              onClick={onDuplicate}
              aria-label="Duplicate node"
              title="Duplicate node"
              className="p-1.5 rounded text-dim hover:text-bright hover:bg-surface transition-colors duration-200"
            >
              <Copy size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => { navigator.clipboard.writeText(nodeId); }}
            aria-label="Copy node ID"
            title="Copy node ID"
            className="p-1.5 rounded text-dim hover:text-bright hover:bg-surface transition-colors duration-200"
          >
            <Clipboard size={12} />
          </button>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border bg-accent-blue/10 border-accent-blue/30 text-accent-blue ml-1">
            node
          </span>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-0">
        {/* Identity */}
        <Section title="Identity">
          <Field label="Role">
            <input
              className={inputCls}
              value={config.role}
              placeholder="e.g. Planner"
              onChange={(e) => onUpdate({ role: e.target.value })}
            />
          </Field>
        </Section>

        {/* Runtime */}
        <Section title="Runtime">
          <Field label="Adapter">
            <div className="relative">
              <select
                className={selectCls}
                value={adapter}
                onChange={(e) => onUpdate({ adapter: e.target.value as AdapterType })}
              >
                {ADAPTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
            </div>
          </Field>
          <Field label="Model">
            <div className="relative" ref={modelDropdownRef}>
              <div className="flex gap-1">
                <input
                  className={inputCls + " flex-1"}
                  value={config.model}
                  placeholder="e.g. claude-sonnet-4-6"
                  onChange={(e) => onUpdate({ model: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setShowModelDropdown((v) => !v)}
                  aria-label="Model presets"
                  aria-expanded={showModelDropdown}
                  aria-haspopup="true"
                  className="bg-canvas border border-border rounded px-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-dim hover:text-body hover:border-border-bright transition-colors duration-200"
                  title="Presets"
                >
                  <ChevronDown size={12} />
                </button>
              </div>
              {showModelDropdown && (
                <div className="absolute top-full mt-1 left-0 right-0 z-50 bg-panel border border-border rounded-lg shadow-xl max-h-48 overflow-y-auto">
                  {MODEL_PRESETS[adapter].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        onUpdate({ model: m });
                        setShowModelDropdown(false);
                      }}
                      className="w-full text-left px-3 py-2 min-h-[44px] font-mono text-xs text-dim hover:bg-surface hover:text-bright transition-colors duration-200"
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {config.model && !MODEL_PRESETS[adapter].includes(config.model) && (
              <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-accent-amber">
                <AlertTriangle size={10} />
                Unknown model — verify this is a valid model ID
              </p>
            )}
          </Field>
        </Section>

        {/* Prompt */}
        <Section title="Prompt">
          <Field label="Task prompt">
            <AutoResizeTextarea
              value={(config.prompt as string | undefined) ?? ""}
              placeholder="Describe what this agent should do…"
              onChange={(v) => onUpdate({ prompt: v })}
            />
          </Field>
        </Section>

        {/* Tools */}
        <Section title="Tools">
          {/* Current tools as chips */}
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {tools.map((tool) => (
                <span
                  key={tool}
                  className="flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 bg-canvas border border-border rounded text-dim hover:border-border-bright group"
                >
                  {tool}
                  <button
                    type="button"
                    onClick={() => handleRemoveTool(tool)}
                    aria-label={`Remove ${tool} tool`}
                    className="text-dim hover:text-accent-red transition-colors duration-200 ml-0.5 min-h-[36px] min-w-[36px] flex items-center justify-center"
                  >
                    <X size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Presets */}
          <div className="flex flex-wrap gap-1 mb-3">
            {TOOL_PRESETS[adapter].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handlePresetTool(t)}
                className={`font-mono text-[10px] px-1.5 py-1 rounded border transition-colors duration-200 min-h-[32px] ${
                  tools.includes(t)
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "bg-canvas border-border text-dim hover:border-border-bright hover:text-body"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Add custom tool */}
          <div className="flex gap-1">
            <input
              className={inputCls + " flex-1"}
              value={newTool}
              placeholder="Add custom tool…"
              onChange={(e) => setNewTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddTool();
                }
              }}
            />
            <button
              type="button"
              onClick={handleAddTool}
              className="px-2.5 py-1.5 min-h-[44px] bg-canvas border border-border rounded font-mono text-xs text-dim hover:border-border-bright hover:text-bright transition-colors duration-200"
            >
              Add
            </button>
          </div>
        </Section>

        {/* Disallowed Tools */}
        <Section title="Disallowed Tools">
          <p className="text-xs text-dim mb-3">
            These tool names are blocked at runtime — the agent cannot invoke them even if they are available.
          </p>
          {/* Current disallowed tools as chips */}
          {disallowedTools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {disallowedTools.map((tool) => (
                <span
                  key={tool}
                  className="flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 bg-canvas border border-border rounded text-dim hover:border-border-bright group"
                >
                  {tool}
                  <button
                    type="button"
                    onClick={() => handleRemoveDisallowedTool(tool)}
                    aria-label={`Remove ${tool} from disallowed tools`}
                    className="text-dim hover:text-accent-red transition-colors duration-200 ml-0.5 min-h-[36px] min-w-[36px] flex items-center justify-center"
                  >
                    <X size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Add disallowed tool */}
          <div className="flex gap-1">
            <input
              className={inputCls + " flex-1"}
              value={newDisallowedTool}
              placeholder="Add disallowed tool…"
              onChange={(e) => setNewDisallowedTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddDisallowedTool();
                }
              }}
            />
            <button
              type="button"
              onClick={handleAddDisallowedTool}
              className="px-2.5 py-1.5 min-h-[44px] bg-canvas border border-border rounded font-mono text-xs text-dim hover:border-border-bright hover:text-bright transition-colors duration-200"
            >
              Add
            </button>
          </div>
        </Section>

        {/* Advanced — core limits + contract fields */}
        <Section title="Advanced">
          <Field label="Output directory">
            <input
              className={inputCls}
              value={(config.outputDir as string | undefined) ?? ""}
              placeholder="e.g. ./output"
              title="Directory where the agent writes its artifacts. Relative paths resolve from the workflow file location."
              onChange={(e) =>
                onUpdate({ outputDir: e.target.value || undefined })
              }
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              className={inputCls}
              type="number"
              min={1}
              aria-label="Timeout in milliseconds"
              title="Wall-clock deadline in milliseconds. Agent is killed if total execution exceeds this."
              value={(config.timeoutMs as number | undefined) ?? ""}
              placeholder="e.g. 300000"
              onChange={(e) =>
                onUpdate({
                  timeoutMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </Field>
          <Field label="Idle Timeout (ms)">
            <input
              className={inputCls}
              type="number"
              min={1}
              aria-label="Idle timeout in milliseconds"
              title="Kills the agent if no output is received for this many milliseconds. Useful for detecting stalls."
              value={(config.idleTimeoutMs as number | undefined) ?? ""}
              placeholder="e.g. 60000"
              onChange={(e) =>
                onUpdate({
                  idleTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </Field>
          <div className="mb-3 last:mb-0">
            <label className="block font-mono text-[11px] text-dim mb-1">
              Max budget (USD)
              <FieldSupportNote adapter={adapter} field="maxBudgetUsd" />
            </label>
            <input
              className={inputCls}
              type="number"
              min={0.01}
              step={0.01}
              aria-label="Maximum budget in USD"
              title="Maximum spend in USD for this node. Agent stops when the budget is reached."
              value={(config.maxBudgetUsd as number | undefined) ?? ""}
              placeholder="e.g. 5.00"
              onChange={(e) =>
                onUpdate({
                  maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
          <div className="mb-3 last:mb-0">
            <label className="block font-mono text-[11px] text-dim mb-1">
              Max turns
              <FieldSupportNote adapter={adapter} field="maxTurns" />
            </label>
            <input
              className={inputCls}
              type="number"
              min={1}
              aria-label="Maximum turns"
              title="Maximum number of agent turns (back-and-forth exchanges). Agent stops after this limit."
              value={(config.maxTurns as number | undefined) ?? ""}
              placeholder="e.g. 20"
              onChange={(e) =>
                onUpdate({
                  maxTurns: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
          {adapter === "codex" && (
            <Field label="Sandbox">
              <div className="relative">
                <select
                  className={selectCls}
                  title="Run the agent in an isolated sandbox environment."
                  value={(config.sandbox as SandboxMode | undefined) ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      sandbox: e.target.value ? (e.target.value as SandboxMode) : undefined,
                    })
                  }
                >
                  <option value="">-- none --</option>
                  {SANDBOX_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
              </div>
            </Field>
          )}

          {/* Advanced <details>: resilience + context fields */}
          <details
            className="mt-3"
            open={hasAdvancedValue(config)}
          >
            <summary className="font-mono text-[10px] text-dim uppercase tracking-widest cursor-pointer list-none flex items-center gap-1.5 py-1">
              <ChevronDown size={10} className="details-marker transition-transform duration-200" />
              More options (resilience + context)
            </summary>
            <div className="mt-3 space-y-3">

              {/* modelTier */}
              <div className="mb-3 last:mb-0">
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Model tier
                  <FieldSupportNote adapter={adapter} field="modelTier" />
                </label>
                <div className="relative">
                  <select
                    className={selectCls}
                    value={(config.modelTier as string | undefined) ?? ""}
                    aria-label="Model tier"
                    onChange={(e) =>
                      onUpdate({ modelTier: (e.target.value as "cheap" | "smart") || undefined })
                    }
                  >
                    <option value="">-- none --</option>
                    <option value="cheap">cheap</option>
                    <option value="smart">smart</option>
                  </select>
                  <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
                </div>
              </div>

              {/* writesContext */}
              <div className="mb-3 last:mb-0">
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Writes context (comma-separated keys)
                </label>
                <input
                  className={inputCls}
                  placeholder="e.g. output, status"
                  aria-label="Context keys this node writes"
                  onBlur={(e) =>
                    onUpdate({ writesContext: splitComma(e.target.value).length > 0 ? splitComma(e.target.value) : undefined })
                  }
                  defaultValue={((config.writesContext as string[] | undefined) ?? []).join(", ")}
                  key={`writes-${JSON.stringify(config.writesContext)}`}
                />
              </div>

              {/* readsContext */}
              <div className="mb-3 last:mb-0">
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Reads context (comma-separated keys)
                </label>
                <input
                  className={inputCls}
                  placeholder="e.g. output"
                  aria-label="Context keys this node reads"
                  onBlur={(e) =>
                    onUpdate({ readsContext: splitComma(e.target.value).length > 0 ? splitComma(e.target.value) : undefined })
                  }
                  onChange={(e) => { void e; }}
                  defaultValue={((config.readsContext as string[] | undefined) ?? []).join(", ")}
                  key={`reads-${JSON.stringify(config.readsContext)}`}
                />
              </div>

              {/* expectedOutputs */}
              <div className="mb-3 last:mb-0">
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Expected outputs (comma-separated)
                </label>
                <input
                  className={inputCls}
                  placeholder="e.g. report.md, summary.json"
                  aria-label="Expected output filenames"
                  onBlur={(e) =>
                    onUpdate({ expectedOutputs: splitComma(e.target.value).length > 0 ? splitComma(e.target.value) : undefined })
                  }
                  onChange={(e) => { void e; }}
                  defaultValue={((config.expectedOutputs as string[] | undefined) ?? []).join(", ")}
                  key={`expected-${JSON.stringify(config.expectedOutputs)}`}
                />
              </div>

              {/* outputSchema */}
              <div className="mb-3 last:mb-0">
                <label className="block font-mono text-[11px] text-dim mb-1">
                  Output schema (JSON)
                  <FieldSupportNote adapter={adapter} field="outputSchema" />
                </label>
                <textarea
                  className={`w-full bg-canvas border ${outputSchemaError ? "border-accent-red" : "border-border"} rounded px-2.5 py-1.5 font-mono text-xs text-bright placeholder:text-muted focus:outline-none focus:border-accent transition-colors duration-200 resize-none min-h-[64px]`}
                  rows={3}
                  placeholder='{"type":"object","properties":{"result":{"type":"string"}}}'
                  aria-label="Output schema JSON"
                  defaultValue={
                    config.outputSchema
                      ? JSON.stringify(config.outputSchema, null, 2)
                      : ""
                  }
                  key={`schema-${JSON.stringify(config.outputSchema)}`}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (!val) {
                      setOutputSchemaError(null);
                      onUpdate({ outputSchema: undefined });
                      return;
                    }
                    try {
                      const parsed = JSON.parse(val) as Record<string, unknown>;
                      setOutputSchemaError(null);
                      onUpdate({ outputSchema: parsed });
                    } catch {
                      setOutputSchemaError("Invalid JSON");
                    }
                  }}
                />
                {outputSchemaError && (
                  <p className="mt-0.5 font-mono text-[10px] text-accent-red flex items-center gap-1">
                    <AlertTriangle size={10} />
                    {outputSchemaError}
                  </p>
                )}
              </div>

              {/* retryPolicy sub-form */}
              <div className="mb-3 last:mb-0">
                <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
                  Retry policy
                  <FieldSupportNote adapter={adapter} field="retryPolicy" />
                </div>
                <div className="space-y-2 pl-2 border-l border-border/40">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block font-mono text-[10px] text-dim mb-0.5">Max attempts</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={1}
                        aria-label="Retry max attempts"
                        value={(config.retryPolicy as RetryPolicy | undefined)?.maxAttempts ?? ""}
                        placeholder="3"
                        onChange={(e) => {
                          const prev = (config.retryPolicy as RetryPolicy | undefined) ?? { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
                          onUpdate({ retryPolicy: e.target.value ? { ...prev, maxAttempts: Number(e.target.value) } : undefined });
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block font-mono text-[10px] text-dim mb-0.5">Initial delay (ms)</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={0}
                        aria-label="Retry initial delay ms"
                        value={(config.retryPolicy as RetryPolicy | undefined)?.initialDelayMs ?? ""}
                        placeholder="1000"
                        onChange={(e) => {
                          const prev = (config.retryPolicy as RetryPolicy | undefined) ?? { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
                          onUpdate({ retryPolicy: e.target.value ? { ...prev, initialDelayMs: Number(e.target.value) } : undefined });
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block font-mono text-[10px] text-dim mb-0.5">Backoff multiplier</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={1}
                        step={0.1}
                        aria-label="Retry backoff multiplier"
                        value={(config.retryPolicy as RetryPolicy | undefined)?.backoffMultiplier ?? ""}
                        placeholder="2"
                        onChange={(e) => {
                          const prev = (config.retryPolicy as RetryPolicy | undefined) ?? { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
                          onUpdate({ retryPolicy: e.target.value ? { ...prev, backoffMultiplier: Number(e.target.value) } : undefined } );
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block font-mono text-[10px] text-dim mb-0.5">Max delay (ms)</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={0}
                        aria-label="Retry max delay ms"
                        value={(config.retryPolicy as RetryPolicy | undefined)?.maxDelayMs ?? ""}
                        placeholder="30000"
                        onChange={(e) => {
                          const prev = (config.retryPolicy as RetryPolicy | undefined) ?? { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
                          onUpdate({ retryPolicy: e.target.value ? { ...prev, maxDelayMs: Number(e.target.value) } : undefined });
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-dim mb-1">Retryable errors</label>
                    <div className="flex gap-2">
                      {(["transport", "rate_limit", "server_5xx"] as RetryableErrorClass[]).map((cls) => {
                        const current = (config.retryPolicy as RetryPolicy | undefined)?.retryableErrors ?? [];
                        const checked = current.includes(cls);
                        return (
                          <label key={cls} className="flex items-center gap-1 font-mono text-[10px] text-dim cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              aria-label={`Retryable: ${cls}`}
                              onChange={() => {
                                const prev = (config.retryPolicy as RetryPolicy | undefined) ?? { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
                                const next = checked
                                  ? current.filter((c) => c !== cls)
                                  : [...current, cls];
                                onUpdate({ retryPolicy: { ...prev, retryableErrors: next.length > 0 ? next : undefined } });
                              }}
                            />
                            {cls}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* providers array editor */}
              <div className="mb-3 last:mb-0">
                <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
                  Providers
                  <FieldSupportNote adapter={adapter} field="providers" />
                </div>
                {((config.providers as ProviderConfig[] | undefined) ?? []).map((p, i) => (
                  <div key={i} className="flex gap-1 items-center mb-1.5">
                    <div className="relative flex-1">
                      <select
                        className={`${selectCls} text-[10px] py-1`}
                        aria-label={`Provider ${i + 1} adapter`}
                        value={p.adapter}
                        onChange={(e) => {
                          const updated = [...(config.providers as ProviderConfig[] ?? [])];
                          updated[i] = { ...p, adapter: e.target.value as AdapterType };
                          onUpdate({ providers: updated });
                        }}
                      >
                        {ADAPTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <input
                      className={`${inputCls} flex-1 py-1 text-[10px]`}
                      value={p.model ?? ""}
                      placeholder="model"
                      aria-label={`Provider ${i + 1} model`}
                      onChange={(e) => {
                        const updated = [...(config.providers as ProviderConfig[] ?? [])];
                        updated[i] = { ...p, model: e.target.value || undefined };
                        onUpdate({ providers: updated });
                      }}
                    />
                    <input
                      className={`${inputCls} w-14 py-1 text-[10px]`}
                      type="number"
                      min={0}
                      value={p.priority}
                      placeholder="prio"
                      aria-label={`Provider ${i + 1} priority`}
                      onChange={(e) => {
                        const updated = [...(config.providers as ProviderConfig[] ?? [])];
                        updated[i] = { ...p, priority: Number(e.target.value) };
                        onUpdate({ providers: updated });
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const updated = (config.providers as ProviderConfig[] ?? []).filter((_, j) => j !== i);
                        onUpdate({ providers: updated.length > 0 ? updated : undefined });
                      }}
                      aria-label={`Remove provider ${i + 1}`}
                      className="p-1 text-dim hover:text-accent-red transition-colors duration-200 min-h-[36px] min-w-[36px] flex items-center justify-center"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const prev = (config.providers as ProviderConfig[] | undefined) ?? [];
                    onUpdate({ providers: [...prev, { adapter: "claude-sdk", priority: prev.length }] });
                  }}
                  className="font-mono text-[10px] text-dim hover:text-body border border-dashed border-border/50 rounded px-2 py-1 transition-colors duration-200"
                >
                  + Add provider
                </button>
              </div>
            </div>
          </details>
        </Section>

        {/* Raw JSON pane — read-only live view */}
        <div className="border-b border-border pb-4 mb-4">
          <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">Raw JSON</div>
          <pre
            className="bg-canvas border border-border rounded px-3 py-2 font-mono text-[10px] text-dim overflow-x-auto whitespace-pre-wrap break-all max-h-48"
            aria-label="Raw node JSON"
          >
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(config).filter(([k]) => !["executionState"].includes(k))
              ),
              null,
              2
            )}
          </pre>
        </div>
      </div>

      {/* Delete node */}
      <div className="shrink-0 px-4 py-3 border-t border-border">
        {!showDeleteConfirm ? (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            aria-label="Delete this node"
            className="w-full flex items-center justify-center gap-2 px-3 min-h-[44px] rounded-lg border border-accent-red/30 bg-accent-red/10 text-accent-red font-mono text-xs hover:bg-accent-red/20 hover:border-accent-red/50 transition-colors duration-200"
          >
            <Trash2 size={12} />
            Delete node
          </button>
        ) : (
          <div className="space-y-2" role="alertdialog" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-desc">
            <div id="delete-confirm-title" className="flex items-center gap-2 text-accent-amber font-mono text-xs">
              <AlertTriangle size={12} />
              <span id="delete-confirm-desc">Delete &quot;{nodeId}&quot;? This also removes its edges.</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDelete();
                }}
                aria-label="Confirm delete node"
                className="flex-1 px-3 min-h-[44px] rounded-lg border border-accent-red/40 bg-accent-red/15 text-accent-red font-mono text-xs hover:bg-accent-red/25 transition-colors duration-200"
              >
                Confirm delete
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                aria-label="Cancel delete"
                className="flex-1 px-3 min-h-[44px] rounded-lg border border-border bg-canvas text-dim font-mono text-xs hover:border-border-bright transition-colors duration-200"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Auto-resize textarea ─────────────────────────────────────────────────────

interface AutoResizeTextareaProps {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}

function AutoResizeTextarea({ value, placeholder, onChange }: AutoResizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="w-full bg-canvas border border-border rounded px-2.5 py-1.5 font-mono text-xs text-bright placeholder:text-muted focus:outline-none focus:border-accent transition-colors duration-200 resize-none overflow-hidden min-h-[64px]"
      value={value}
      placeholder={placeholder}
      rows={3}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
