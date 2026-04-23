"use client";

import { Puzzle, Shield, Eye } from "lucide-react";

const FEATURES = [
  {
    icon: Puzzle,
    iconColor: "text-accent-blue",
    iconBg: "bg-accent-blue/10 border-accent-blue/20",
    title: "Adapter-agnostic",
    description:
      "Claude SDK, Codex CLI, Claude CLI. Per-node adapter selection — mix runtimes in a single workflow. Add a Cursor node to the same graph as a Codex node without changing anything else.",
    tags: ["claude-sdk", "codex", "claude-cli", "cursor"],
    tagColors: ["text-accent-blue", "text-accent-green", "text-subtle", "text-accent-purple"],
    code: `nodes:\n  planner:\n    adapter: claude-sdk\n    model: claude-opus-4-7\n  implementer:\n    adapter: codex\n    model: o3`,
  },
  {
    icon: Shield,
    iconColor: "text-accent-amber",
    iconBg: "bg-accent-amber/10 border-accent-amber/20",
    title: "Gates, not vibes",
    description:
      "Transitions fire on deterministic conditions: exit codes, file existence checks, regex matches against output, or custom scripts. Never an LLM deciding what happens next.",
    tags: ["exit_code", "file_exists", "regex", "script"],
    tagColors: ["text-accent-green", "text-accent-cyan", "text-accent-amber", "text-dim"],
    code: `gate:\n  conditions:\n    - type: exit_code\n      value: 0\n    - type: regex\n      pattern: "PASSED"`,
  },
  {
    icon: Eye,
    iconColor: "text-accent-cyan",
    iconBg: "bg-accent-cyan/10 border-accent-cyan/20",
    title: "Full observability",
    description:
      "Every tool call, file write, and state transition streams to the monitor in real time over WebSocket. No black boxes. Pause, resume, or cancel mid-run from the monitor.",
    tags: ["tool_call", "file_write", "shell_exec", "text_delta"],
    tagColors: ["text-accent-blue", "text-accent-green", "text-accent-amber", "text-dim"],
    code: `{ type: "tool_call",\n  tool: "Grep",\n  input: { pattern:\n    "def test_" } }`,
  },
];

export function Features() {
  return (
    <section className="relative py-24 border-t border-border">
      <div className="max-w-6xl mx-auto px-6">
        {/* Section header */}
        <div className="mb-16">
          <div className="font-mono text-xs text-accent-blue mb-3 tracking-widest uppercase">
            Core capabilities
          </div>
          <h2 className="font-display text-4xl font-bold text-white leading-tight">
            Built for engineers
            <br />
            <span className="text-dim font-normal">who&apos;ve been burned by black boxes.</span>
          </h2>
        </div>

        {/* Feature cards */}
        <div className="grid lg:grid-cols-3 gap-px bg-border rounded-xl overflow-hidden">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <div
                key={i}
                className="bg-panel hover:bg-surface transition-colors duration-300 p-8 flex flex-col gap-6 group"
              >
                {/* Icon */}
                <div className={`w-10 h-10 rounded-lg border ${feature.iconBg} flex items-center justify-center`}>
                  <Icon size={18} className={feature.iconColor} />
                </div>

                {/* Text */}
                <div>
                  <h3 className="font-display font-semibold text-xl text-bright mb-3 group-hover:text-white transition-colors">
                    {feature.title}
                  </h3>
                  <p className="text-body text-sm leading-relaxed">
                    {feature.description}
                  </p>
                </div>

                {/* Tags */}
                <div className="flex flex-wrap gap-1.5">
                  {feature.tags.map((tag, j) => (
                    <span
                      key={tag}
                      className={`font-mono text-[11px] px-2 py-0.5 bg-canvas border border-border rounded ${feature.tagColors[j] ?? "text-dim"}`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Code snippet */}
                <div className="mt-auto">
                  <div className="rounded-lg bg-canvas border border-border p-4 font-mono text-[11px] leading-relaxed text-dim whitespace-pre">
                    {feature.code}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
