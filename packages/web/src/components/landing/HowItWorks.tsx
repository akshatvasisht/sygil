"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";

/* ── Error boundary for code blocks ────────── */
class CodeBlockErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-[200px] rounded-xl bg-surface/50 border border-white/[0.08]">
          <span className="font-mono text-xs text-dim">Code preview unavailable</span>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── Minimal syntax highlighter (no deps) ──── */

// Colorize JSON keys, strings, numbers, and booleans inline
function highlightJson(code: string, showLineNumbers = false): React.ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, li) => {
    const parts: React.ReactNode[] = [];
    let rest = line;
    let ki = 0;

    while (rest.length > 0) {
      // JSON key (quoted before colon)
      const keyMatch = rest.match(/^(\s*)"([^"]+)"(\s*:)/);
      if (keyMatch) {
        parts.push(<span key={ki++}>{keyMatch[1]}</span>);
        parts.push(<span key={ki++} className="terminal-key">&quot;{keyMatch[2]}&quot;</span>);
        parts.push(<span key={ki++}>{keyMatch[3]}</span>);
        rest = rest.slice(keyMatch[0].length);
        continue;
      }
      // String value
      const strMatch = rest.match(/^"([^"]*)"/);
      if (strMatch) {
        parts.push(<span key={ki++} className="terminal-string">&quot;{strMatch[1]}&quot;</span>);
        rest = rest.slice(strMatch[0].length);
        continue;
      }
      // Number
      const numMatch = rest.match(/^(\d+)/);
      if (numMatch) {
        parts.push(<span key={ki++} className="terminal-number">{numMatch[1]}</span>);
        rest = rest.slice(numMatch[0].length);
        continue;
      }
      // Boolean
      const boolMatch = rest.match(/^(true|false)/);
      if (boolMatch) {
        parts.push(<span key={ki++} className="terminal-number">{boolMatch[1]}</span>);
        rest = rest.slice(boolMatch[0].length);
        continue;
      }
      // Structural characters and whitespace — consume one char
      parts.push(<span key={ki++} className="terminal-operator">{rest.charAt(0)}</span>);
      rest = rest.slice(1);
    }

    return (
      <div key={li} className="flex code-hover-line">
        {showLineNumbers && (
          <span className="code-line-number inline-block shrink-0 font-mono text-[10px]">
            {li + 1}
          </span>
        )}
        <span>{parts.length > 0 ? parts : "\u00A0"}</span>
      </div>
    );
  });
}

// Colorize terminal output with status indicators and structural highlights
function highlightBash(code: string): React.ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, li) => {
    // Prompt line
    if (line.match(/^\$ /)) {
      return (
        <div key={li}>
          <span className="terminal-prompt">$ </span>
          <span className="text-bright">{line.slice(2)}</span>
        </div>
      );
    }
    // Success check
    if (line.includes("\u2713")) {
      const parts = line.split("\u2713");
      return (
        <div key={li}>
          <span className="terminal-dim">{parts[0]}</span>
          <span className="terminal-success">{"\u2713"}{parts.slice(1).join("\u2713")}</span>
        </div>
      );
    }
    // Error/failure cross
    if (line.includes("\u2717")) {
      const parts = line.split("\u2717");
      return (
        <div key={li}>
          <span className="terminal-dim">{parts[0]}</span>
          <span className="terminal-error">{"\u2717"}{parts.slice(1).join("\u2717")}</span>
        </div>
      );
    }
    // Running arrow
    if (line.includes("\u2192")) {
      const parts = line.split("\u2192");
      return (
        <div key={li}>
          <span className="terminal-dim">{parts[0]}</span>
          <span className="terminal-accent">{"\u2192"}{parts.slice(1).join("\u2192")}</span>
        </div>
      );
    }
    // Timestamp lines [HH:MM:SS]
    const tsMatch = line.match(/^(\s*\[)(\d{2}:\d{2}:\d{2})(\]\s*)(.*)/);
    if (tsMatch) {
      const content = tsMatch[4]!;
      const hasSuccess = content.includes("\u2713");
      const hasArrow = content.includes("\u2192");
      return (
        <div key={li}>
          <span className="terminal-dim">{tsMatch[1]}</span>
          <span className="terminal-number">{tsMatch[2]}</span>
          <span className="terminal-dim">{tsMatch[3]}</span>
          <span className={hasSuccess ? "terminal-success" : hasArrow ? "terminal-accent" : "text-body/70"}>
            {content}
          </span>
        </div>
      );
    }
    // Tree lines (box-drawing characters)
    if (line.match(/^\s*[\u2502\u250C\u251C\u2514\u2500]/)) {
      // Highlight statuses within tree
      if (line.includes("[completed]")) {
        const [before, after] = line.split("[completed]");
        return (
          <div key={li}>
            <span className="terminal-dim">{before}</span>
            <span className="terminal-success">[completed]</span>
            <span className="terminal-dim">{after}</span>
          </div>
        );
      }
      if (line.includes("[running]")) {
        const [before, after] = line.split("[running]");
        return (
          <div key={li}>
            <span className="terminal-dim">{before}</span>
            <span className="terminal-accent">[running]</span>
            <span className="terminal-dim">{after}</span>
          </div>
        );
      }
      if (line.includes("[waiting]")) {
        const [before, after] = line.split("[waiting]");
        return (
          <div key={li}>
            <span className="terminal-dim">{before}</span>
            <span className="text-dim">[waiting]</span>
            <span className="terminal-dim">{after}</span>
          </div>
        );
      }
      return <div key={li} className="terminal-dim">{line}</div>;
    }
    // "Detecting adapters..." and similar info lines
    if (line.match(/^\s+\S/) && !line.match(/^\s*\$/)) {
      return <div key={li} className="text-body/60">{line}</div>;
    }
    // Totals/summary lines with $ cost
    if (line.includes("Total:") || line.includes("$")) {
      return <div key={li} className="text-bright/80">{line}</div>;
    }
    // Empty / default
    return <div key={li} className="text-body/60">{line || "\u00A0"}</div>;
  });
}

const STEPS = [
  {
    number: "01",
    title: "Define the graph",
    description:
      "Nodes are agents. Edges are transitions. Gates are pass/fail checks. One JSON file, entire workflow.",
    code: `{
  "version": "1",
  "name": "tdd-feature",
  "nodes": {
    "planner": {
      "adapter": "claude-sdk",
      "model": "claude-opus-4-5",
      "role": "TDD planner",
      "prompt": "Write failing tests for {{goal}}",
      "tools": ["Read", "Grep", "Write"]
    },
    "implementer": {
      "adapter": "codex",
      "model": "o3",
      "role": "Implementation agent",
      "prompt": "Make all tests pass",
      "tools": ["Read", "Write", "Bash"]
    },
    "reviewer": {
      "adapter": "claude-sdk",
      "model": "claude-opus-4-5",
      "role": "Code reviewer",
      "prompt": "Review the implementation"
    }
  },
  "edges": [
    {
      "id": "plan-to-impl",
      "from": "planner", "to": "implementer",
      "gate": { "conditions": [
        { "type": "file_exists", "path": "tests/test_oauth.py" }
      ]}
    },
    {
      "id": "impl-to-review",
      "from": "implementer", "to": "reviewer",
      "gate": { "conditions": [
        { "type": "exit_code", "value": 0 }
      ]}
    },
    {
      "id": "review-loop",
      "from": "reviewer", "to": "implementer",
      "isLoopBack": true, "maxRetries": 2
    }
  ]
}`,
    lang: "json",
  },
  {
    number: "02",
    title: "Preflight check",
    description:
      "Sigil probes installed adapters \u2014 API keys, CLI binaries, model access. Misconfigurations surface before a single token is spent.",
    code: `$ sigil init

  Detecting adapters...

  \u2713  claude-sdk    ANTHROPIC_API_KEY set
                   claude-opus-4-5 available
  \u2713  codex         /usr/local/bin/codex found
                   o3 available
  \u2713  claude-cli    /usr/local/bin/claude found
  \u2717  cursor        not found (Phase 2)

  All required adapters ready.
  Run \`sigil run tdd-feature <goal>\` to start.`,
    lang: "bash",
  },
  {
    number: "03",
    title: "Execute",
    description:
      "Pass a goal. Sigil traverses the graph, evaluating gates after each node \u2014 exit codes, file existence, regex matches. Loop-back edges trigger automatic retries.",
    code: `$ sigil run tdd-feature "add OAuth2 login"

  \u2713 Loaded workflow: tdd-feature
  \u279C  Web monitor available at: http://localhost:4891/...

  \u250C\u2500 planner      \u2713 completed   4.2s   $0.014
  \u2502    Write("tests/test_oauth.py")
  \u2502
  \u251C\u2500 implementer  \u25CF running    12.1s   \u00B7\u00B7\u00B7
  \u2502    Bash("pytest tests/ -x") \u2192 exit:0
  \u2502
  \u2514\u2500 reviewer     \u25CB waiting

  Total: $0.014  12,840 tokens`,
    lang: "bash",
  },
  {
    number: "04",
    title: "Monitor live",
    description:
      "Attach from another terminal or open the web dashboard with --web. Tool calls, file writes, gate evaluations, and cumulative cost stream in real time.",
    code: `$ sigil monitor r_8x92kf

  \u250C\u2500 planner      \u2713 completed   4.2s   $0.014
  \u2502    Write("tests/test_oauth.py")
  \u2502
  \u251C\u2500 implementer  \u25CF running    18.4s   \u00B7\u00B7\u00B7
  \u2502    Bash("pytest tests/ -x") \u2192 exit:0
  \u2502    Write("src/auth/oauth.py")
  \u2502
  \u2514\u2500 reviewer     \u25CB waiting

  Total: $0.055  28,410 tokens`,
    lang: "bash",
  },
];

export function HowItWorks() {
  const [activeStep, setActiveStep] = useState(0);
  const [slideDir, setSlideDir] = useState<"right" | "left">("right");
  const prevStepRef = useRef(0);
  const active = STEPS[activeStep] ?? STEPS[0]!;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Track direction of tab change for slide animation
  const changeStep = useCallback((next: number) => {
    setSlideDir(next > prevStepRef.current ? "right" : "left");
    prevStepRef.current = next;
    setActiveStep(next);
  }, []);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      let next = activeStep;
      // ArrowRight / ArrowDown = next tab; ArrowLeft / ArrowUp = prev tab
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        next = (activeStep + 1) % STEPS.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        next = (activeStep - 1 + STEPS.length) % STEPS.length;
      } else if (e.key === "Home") {
        e.preventDefault();
        next = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        next = STEPS.length - 1;
      } else {
        return;
      }
      changeStep(next);
      tabRefs.current[next]?.focus();
    },
    [activeStep, changeStep],
  );

  const highlightedCode = useMemo(
    () =>
      active.lang === "json"
        ? highlightJson(active.code, true)
        : highlightBash(active.code),
    [active.code, active.lang],
  );

  return (
    <section className="below-fold relative py-24 sm:py-32 lg:py-40 border-t border-white/[0.06] section-transition">
      {/* Accent gradient line at top — brighter */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

      {/* Atmospheric background glow */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 70% 40% at 50% 0%, rgba(255,92,0,0.05) 0%, rgba(255,92,0,0.015) 40%, transparent 70%)",
        }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        {/* Section header — scroll-triggered entrance */}
        <ScrollReveal className="mb-16 sm:mb-20 lg:mb-24">
          <div className="font-mono text-xs text-accent mb-5 uppercase tracking-[0.25em] font-medium">
            How it works
          </div>
          <h2 className="font-black text-white leading-[1.04] tracking-[-0.04em]" style={{ fontSize: "clamp(2.25rem, 4.5vw + 0.5rem, 3.5rem)" }}>
            JSON in,
            <br />
            <span className="text-body font-light tracking-[-0.02em]" style={{ fontSize: "0.85em" }}>
              orchestrated agents out.
            </span>
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={150} className="grid lg:grid-cols-[280px_1fr] gap-6 sm:gap-8 lg:gap-12">
          {/* Step selector — horizontal scroll on mobile, vertical sidebar on desktop */}
          <div className="flex flex-col gap-1.5">
          {/* Step progress indicator (desktop only) */}
          <div className="hidden lg:block step-progress-track mb-2">
            <div className="step-progress-fill" style={{ width: `${((activeStep + 1) / STEPS.length) * 100}%` }} />
          </div>
          <div role="tablist" aria-label="How it works steps" className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-x-visible snap-x snap-mandatory pb-2 lg:pb-0 -mx-4 px-4 sm:-mx-0 sm:px-0 scrollbar-hide">
            {STEPS.map((step, i) => (
              <button
                key={i}
                ref={(el) => { tabRefs.current[i] = el; }}
                id={`step-tab-${i}`}
                role="tab"
                aria-selected={activeStep === i}
                aria-controls="step-tabpanel"
                tabIndex={activeStep === i ? 0 : -1}
                onClick={() => changeStep(i)}
                onKeyDown={handleTabKeyDown}
                className={`step-btn text-left px-4 py-3.5 min-h-[44px] min-w-[140px] sm:min-w-[160px] lg:min-w-0 rounded-lg border group shrink-0 lg:shrink snap-start relative ${
                  activeStep === i
                    ? "bg-white/[0.03] border-white/[0.08] card-glow-accent"
                    : "bg-transparent border-transparent hover:bg-white/[0.02] hover:border-white/[0.04]"
                }`}
              >
                {/* Active step left accent bar (desktop only) */}
                {activeStep === i && (
                  <div className="hidden lg:block absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-accent step-accent-bar" />
                )}
                {/* Active step bottom accent bar (mobile only) */}
                {activeStep === i && (
                  <div className="lg:hidden absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-accent step-accent-bar" />
                )}
                <div className="flex items-center justify-between mb-0.5">
                  <span
                    className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      activeStep === i ? "text-accent" : "text-dim"
                    }`}
                  >
                    {step.number}
                  </span>
                  {activeStep === i && (
                    <ChevronRight size={12} className="text-accent hidden lg:block" />
                  )}
                </div>
                <div
                  className={`text-sm font-semibold transition-colors leading-snug whitespace-nowrap lg:whitespace-normal ${
                    activeStep === i
                      ? "text-bright"
                      : "text-dim group-hover:text-body"
                  }`}
                >
                  {step.title}
                </div>
              </button>
            ))}
          </div>
          </div>

          {/* Step content — slides in from the direction of navigation */}
          <div id="step-tabpanel" role="tabpanel" aria-labelledby={`step-tab-${activeStep}`} key={activeStep} className={`flex flex-col gap-6 min-w-0 min-h-0 ${slideDir === "right" ? "animate-slide-in-right" : "animate-slide-in-left"}`}>
            {/* Description card */}
            <div className="bg-panel border border-white/[0.06] rounded-xl px-5 sm:px-8 py-6 card-glow animate-step-pop">
              <h3 className="text-lg font-semibold text-bright mb-2 tracking-tight">
                {active.title}
              </h3>
              <p className="text-body text-sm sm:text-base leading-relaxed max-w-prose">
                {active.description}
              </p>
            </div>

            {/* Code block — premium framing */}
            <CodeBlockErrorBoundary>
              <div className={`rounded-xl border border-white/[0.08] overflow-hidden code-block-premium ${
                active.lang === "json" ? "code-block-json" : "code-block-terminal"
              }`}>
                {/* Chrome bar with dot indicators */}
                <div className="code-chrome flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] bg-panel/80">
                  <div className="flex items-center gap-1.5">
                    <div className="chrome-dot w-2 h-2 rounded-full bg-white/[0.06]" />
                    <div className="chrome-dot w-2 h-2 rounded-full bg-white/[0.06]" />
                    <div className="chrome-dot w-2 h-2 rounded-full bg-white/[0.06]" />
                  </div>
                  <span className="font-mono text-[10px] text-dim uppercase tracking-widest font-medium">
                    {active.lang === "json" ? "workflow.json" : "terminal"}
                  </span>
                  {/* Language indicator dot */}
                  <div className="ml-auto flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      active.lang === "json" ? "bg-accent-blue/60" : "bg-accent/60"
                    }`} />
                    <span className="font-mono text-[9px] text-subtle uppercase tracking-wider">
                      {active.lang}
                    </span>
                  </div>
                </div>
                <div className="relative">
                  {/* Subtle inner glow at top of code area — tinted by language */}
                  <div
                    className="absolute top-0 left-0 right-0 h-12 pointer-events-none z-10"
                    style={{
                      background: active.lang === "json"
                        ? "linear-gradient(to bottom, rgba(59,130,246,0.03) 0%, transparent 100%)"
                        : "linear-gradient(to bottom, rgba(255,92,0,0.02) 0%, transparent 100%)",
                    }}
                  />
                  <pre className="bg-canvas p-3 sm:p-4 md:p-6 font-mono text-[10px] sm:text-xs md:text-sm leading-relaxed overflow-x-auto whitespace-pre">
                    <code>
                      {highlightedCode}
                    </code>
                  </pre>
                </div>
              </div>
            </CodeBlockErrorBoundary>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
