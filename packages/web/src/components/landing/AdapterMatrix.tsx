"use client";

import { Check, Minus, Clock } from "lucide-react";

interface Capability {
  label: string;
  claudeSdk: boolean | "partial";
  codex: boolean | "partial";
  claudeCli: boolean | "partial";
  cursor: boolean | "partial" | "phase2";
}

const CAPABILITIES: Capability[] = [
  {
    label: "Tool calling",
    claudeSdk: true,
    codex: true,
    claudeCli: "partial",
    cursor: "phase2",
  },
  {
    label: "Streaming events",
    claudeSdk: true,
    codex: true,
    claudeCli: "partial",
    cursor: "phase2",
  },
  {
    label: "File write sandbox",
    claudeSdk: true,
    codex: true,
    claudeCli: true,
    cursor: "phase2",
  },
  {
    label: "Cost tracking",
    claudeSdk: true,
    codex: true,
    claudeCli: false,
    cursor: "phase2",
  },
  {
    label: "Token usage",
    claudeSdk: true,
    codex: true,
    claudeCli: false,
    cursor: "phase2",
  },
  {
    label: "Extended thinking",
    claudeSdk: true,
    codex: false,
    claudeCli: false,
    cursor: "phase2",
  },
  {
    label: "Max budget control",
    claudeSdk: true,
    codex: true,
    claudeCli: false,
    cursor: "phase2",
  },
  {
    label: "Parallel tool calls",
    claudeSdk: true,
    codex: true,
    claudeCli: false,
    cursor: "phase2",
  },
  {
    label: "Custom system prompt",
    claudeSdk: true,
    codex: true,
    claudeCli: true,
    cursor: "phase2",
  },
  {
    label: "No API key required",
    claudeSdk: false,
    codex: false,
    claudeCli: true,
    cursor: "phase2",
  },
];

const ADAPTERS = [
  {
    id: "claudeSdk" as const,
    name: "Claude SDK",
    role: "Primary",
    badge: "bg-accent-blue/15 text-accent-blue border-accent-blue/30",
    dot: "bg-accent-blue",
  },
  {
    id: "codex" as const,
    name: "Codex CLI",
    role: "Secondary",
    badge: "bg-accent-green/15 text-accent-green border-accent-green/30",
    dot: "bg-accent-green",
  },
  {
    id: "claudeCli" as const,
    name: "Claude CLI",
    role: "Fallback",
    badge: "bg-subtle/15 text-subtle border-subtle/30",
    dot: "bg-subtle",
  },
  {
    id: "cursor" as const,
    name: "Cursor",
    role: "Phase 2",
    badge: "bg-accent-purple/15 text-accent-purple/70 border-accent-purple/20",
    dot: "bg-accent-purple",
  },
];

function Cell({ value }: { value: boolean | "partial" | "phase2" }) {
  if (value === "phase2") {
    return (
      <div className="flex items-center justify-center">
        <Clock size={13} className="text-accent-purple/40" />
      </div>
    );
  }
  if (value === true) {
    return (
      <div className="flex items-center justify-center">
        <Check size={14} className="text-accent-green" strokeWidth={2.5} />
      </div>
    );
  }
  if (value === "partial") {
    return (
      <div className="flex items-center justify-center">
        <Minus size={14} className="text-accent-amber" strokeWidth={2.5} />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center">
      <div className="w-1 h-1 rounded-full bg-muted" />
    </div>
  );
}

export function AdapterMatrix() {
  return (
    <section className="relative py-24 border-t border-border">
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <div className="mb-12">
          <div className="font-mono text-xs text-accent-cyan mb-3 tracking-widest uppercase">
            Adapter support matrix
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
            <h2 className="font-display text-4xl font-bold text-white leading-tight">
              Pick the right runtime
              <br />
              <span className="text-dim font-normal">for every node.</span>
            </h2>
            <p className="text-body text-sm max-w-xs">
              Each node in your workflow can use a different adapter. Use Claude SDK where you need streaming and cost tracking; fall back to Claude CLI where you can&apos;t manage API keys.
            </p>
          </div>
        </div>

        {/* Adapter legend */}
        <div className="flex flex-wrap gap-3 mb-6">
          {ADAPTERS.map((adapter) => (
            <div
              key={adapter.id}
              className={`inline-flex items-center gap-2 border px-3 py-1.5 rounded-full text-sm ${adapter.badge}`}
            >
              <div className={`w-2 h-2 rounded-full ${adapter.dot} opacity-80`} />
              <span className="font-mono text-xs font-medium">{adapter.name}</span>
              <span className="text-xs opacity-60">{adapter.role}</span>
            </div>
          ))}
        </div>

        {/* Matrix table */}
        <div className="border border-border rounded-xl overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_repeat(4,80px)] bg-surface border-b border-border">
            <div className="px-5 py-3" />
            {ADAPTERS.map((adapter) => (
              <div key={adapter.id} className="py-3 text-center">
                <div className={`font-mono text-[11px] font-medium ${
                  adapter.id === "cursor" ? "text-accent-purple/50" : "text-dim"
                }`}>
                  {adapter.name.split(" ")[0]}
                </div>
              </div>
            ))}
          </div>

          {/* Capability rows */}
          {CAPABILITIES.map((cap, i) => (
            <div
              key={i}
              className={`grid grid-cols-[1fr_repeat(4,80px)] border-b border-border last:border-b-0 transition-colors hover:bg-surface/50`}
            >
              <div className="px-5 py-3.5">
                <span className="font-mono text-xs text-body">{cap.label}</span>
              </div>
              {ADAPTERS.map((adapter) => (
                <div key={adapter.id} className="py-3.5">
                  <Cell value={cap[adapter.id]} />
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-6 mt-5 text-xs text-subtle">
          <div className="flex items-center gap-2">
            <Check size={12} className="text-accent-green" strokeWidth={2.5} />
            <span>Supported</span>
          </div>
          <div className="flex items-center gap-2">
            <Minus size={12} className="text-accent-amber" strokeWidth={2.5} />
            <span>Partial / limited</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-1 h-1 rounded-full bg-muted" />
            <span>Not supported</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={12} className="text-accent-purple/40" />
            <span className="text-accent-purple/40">Phase 2</span>
          </div>
        </div>
      </div>
    </section>
  );
}
