"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Play, X, Terminal, AlertTriangle } from "lucide-react";
import type { WorkflowGraph } from "@sygil/shared";

interface RunModalProps {
  workflow: WorkflowGraph;
  onClose: () => void;
}

export function RunModal({ workflow, onClose }: RunModalProps) {
  const router = useRouter();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [params, setParams] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (workflow.parameters) {
      for (const [key, def] of Object.entries(workflow.parameters)) {
        if (def.default != null) initial[key] = String(def.default);
      }
    }
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paramEntries = workflow.parameters ? Object.entries(workflow.parameters) : [];

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  function handleFocusTrap(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          parameters: params,
        }),
      });
      if (!res.ok) {
        const json = await res.json() as Record<string, unknown>;
        const msg = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      const json = await res.json() as { runId?: string; authToken?: string };
      const runId = json.runId ?? "";
      const token = json.authToken ?? "";
      const url = `/monitor?run=${encodeURIComponent(runId)}&workflow=${encodeURIComponent(workflow.name)}&token=${encodeURIComponent(token)}`;
      router.push(url);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={handleFocusTrap}
    >
      <div
        role="dialog"
        aria-labelledby="run-modal-title"
        aria-describedby="run-modal-desc"
        className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden card-glow"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Terminal size={14} className="text-accent-green" />
            <span id="run-modal-title" className="font-mono text-sm text-bright font-medium">
              Run — {workflow.name}
            </span>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close run modal"
            className="p-2.5 -m-1 rounded hover:bg-surface text-dim hover:text-bright transition-colors duration-200 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <form id="run-modal-desc" className="px-5 py-5 space-y-4" onSubmit={handleSubmit}>
          {paramEntries.length > 0 ? (
            <div className="space-y-3">
              {paramEntries.map(([key, def]) => (
                <div key={key}>
                  <label className="block font-mono text-[11px] text-dim mb-1">
                    {key}
                    {def.required && <span className="text-accent-red ml-1">*</span>}
                  </label>
                  {def.description && (
                    <p className="font-mono text-[10px] text-dim mb-1 opacity-70">{def.description}</p>
                  )}
                  <input
                    type={def.type === "number" ? "number" : "text"}
                    required={def.required ?? false}
                    value={params[key] ?? ""}
                    onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
                    placeholder={def.default != null ? String(def.default) : `Enter ${key}…`}
                    className="w-full bg-canvas border border-border rounded px-2.5 py-1.5 font-mono text-xs text-bright placeholder:text-dim focus:outline-none focus:border-accent transition-colors duration-200"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-dim">
              This workflow has no parameters. Click Run to start.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 bg-accent-red/10 border border-accent-red/30 rounded-lg px-3 py-2">
              <AlertTriangle size={12} className="text-accent-red shrink-0 mt-0.5" />
              <span className="font-mono text-xs text-accent-red">{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono text-xs px-4 min-h-[44px] rounded-lg transition-colors duration-200"
            >
              <Play size={12} fill="currentColor" />
              {submitting ? "Starting…" : "Run workflow"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 min-h-[44px] rounded-lg border border-border bg-canvas text-dim font-mono text-xs hover:border-border-bright transition-colors duration-200"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
