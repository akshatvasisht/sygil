"use client";

import React, { useEffect, useMemo, useRef, useState, memo, lazy, Suspense } from "react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

// Lazy-load the background decoration — purely visual, not needed for LCP or interactivity
const HeroSigil = lazy(() => import("./HeroSigil").then((m) => ({ default: m.HeroSigil })));

/* -- Error boundary for hero visuals --------- */
class HeroErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/* -- Design system adapter colors ------------- */
const COLOR_CLAUDE = "#818cf8";
const COLOR_CODEX = "#34d399";
const COLOR_SUCCESS = "#34d399";
const COLOR_WARNING = "#f5a623";

/* -- DAG node definitions --------------------- */
const NODE_W = 120;
const NODE_H = 64;
const NODES = [
  { id: "planner", x: 10, y: 45, adapter: "claude-sdk", color: COLOR_CLAUDE, model: "claude-opus-4-5", role: "TDD planner", tools: 3 },
  { id: "implementer", x: 195, y: 45, adapter: "codex", color: COLOR_CODEX, model: "o3", role: "Impl agent", tools: 5 },
  { id: "reviewer", x: 380, y: 45, adapter: "claude-sdk", color: COLOR_CLAUDE, model: "claude-opus-4-5", role: "Code reviewer", tools: 2 },
];

const EDGES: readonly { from: number; to: number; label: string | null; isLoop?: boolean }[] = [
  { from: 0, to: 1, label: null },
  { from: 1, to: 2, label: "file_exists" },
  { from: 2, to: 1, label: "exit_code", isLoop: true },
];

type NodeState = "idle" | "running" | "completed";

/* -- Stable style refs (avoid re-creation per render) -- */
const TRANSITION_STROKE = { transition: "stroke 0.3s ease, stroke-width 0.3s ease" } as const;
const TRANSITION_STROKE_FILL = { transition: "stroke 0.3s ease, fill 0.3s ease, stroke-width 0.3s ease" } as const;
const TRANSITION_FILL = { transition: "fill 0.3s ease" } as const;
const TRANSITION_OPACITY = { transition: "opacity 0.3s ease" } as const;

/* -- Animated DAG component ------------------- */
const AnimatedDAG = memo(function AnimatedDAG() {
  const [nodeStates, setNodeStates] = useState<NodeState[]>(["idle", "idle", "idle"]);
  const [activeEdge, setActiveEdge] = useState(-1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const cycleRef = useRef(0);
  const isPausedRef = useRef(false);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReducedMotion(prefersReduced);
    if (prefersReduced) {
      setNodeStates(["completed", "completed", "running"]);
      setActiveEdge(1);
      return;
    }

    const sequence = [
      () => { setNodeStates(["running", "idle", "idle"]); setActiveEdge(-1); },
      () => { setNodeStates(["completed", "idle", "idle"]); setActiveEdge(0); },
      () => { setNodeStates(["completed", "running", "idle"]); setActiveEdge(-1); },
      () => { setNodeStates(["completed", "completed", "idle"]); setActiveEdge(1); },
      () => { setNodeStates(["completed", "completed", "running"]); setActiveEdge(-1); },
      // Loop-back: reviewer triggers retry on implementer
      () => { setNodeStates(["completed", "idle", "completed"]); setActiveEdge(2); },
      () => { setNodeStates(["completed", "running", "idle"]); setActiveEdge(-1); },
      () => { setNodeStates(["completed", "completed", "idle"]); setActiveEdge(1); },
      () => { setNodeStates(["completed", "completed", "running"]); setActiveEdge(-1); },
      () => { setNodeStates(["completed", "completed", "completed"]); setActiveEdge(-1); },
      () => { setNodeStates(["idle", "idle", "idle"]); setActiveEdge(-1); },
    ];

    let step = 0;
    const tick = () => {
      if (isPausedRef.current) {
        cycleRef.current = window.setTimeout(tick, 200);
        return;
      }
      sequence[step % sequence.length]!();
      step++;
      cycleRef.current = window.setTimeout(tick, step % sequence.length === 0 ? 1200 : 800);
    };
    cycleRef.current = window.setTimeout(tick, 600);

    return () => clearTimeout(cycleRef.current);
  }, []);

  const svgW = 520;
  const svgH = 200;
  const halfH = NODE_H / 2;

  const getEdgePath = (fromIdx: number, toIdx: number) => {
    const f = NODES[fromIdx]!;
    const t = NODES[toIdx]!;
    return `M ${f.x + NODE_W} ${f.y + halfH} L ${t.x} ${t.y + halfH}`;
  };

  const getLoopPath = (fromIdx: number, toIdx: number) => {
    const f = NODES[fromIdx]!;
    const t = NODES[toIdx]!;
    const fx = f.x + NODE_W / 2;
    const tx = t.x + NODE_W / 2;
    const by = Math.max(f.y, t.y) + NODE_H + 55;
    return `M ${fx} ${f.y + NODE_H} C ${fx} ${by}, ${tx} ${by}, ${tx} ${t.y + NODE_H}`;
  };

  return (
    <div className="relative">
      {/* Glow backdrop behind DAG */}
      <div
        className="absolute inset-0 -m-8 rounded-3xl"
        style={{
          background: "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(255,92,0,0.06) 0%, transparent 70%)",
        }}
      />
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="w-full h-auto relative"
        role="img"
        aria-labelledby="dag-title"
        onMouseEnter={() => { isPausedRef.current = true; }}
        onMouseLeave={() => { isPausedRef.current = false; }}
      >
        <title id="dag-title">Animated workflow DAG showing planner, implementer, and reviewer nodes with loop-back retry</title>
        <defs>
          <filter id="edge-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="node-glow-running" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="node-glow-completed" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="edge-active-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FF5C00" stopOpacity="0" />
            <stop offset="50%" stopColor="#FF5C00" stopOpacity="1" />
            <stop offset="100%" stopColor="#FF5C00" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="loop-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={COLOR_WARNING} stopOpacity="0" />
            <stop offset="50%" stopColor={COLOR_WARNING} stopOpacity="1" />
            <stop offset="100%" stopColor={COLOR_WARNING} stopOpacity="0" />
          </linearGradient>
          <pattern id="dot-grid" x="8" y="8" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="0" cy="0" r="0.5" fill="rgba(255,255,255,0.04)" />
          </pattern>
        </defs>
        <rect width={svgW} height={svgH} fill="url(#dot-grid)" />

        {/* Edges */}
        {EDGES.map((edge, i) => {
          const isActive = activeEdge === i;
          const path = edge.isLoop
            ? getLoopPath(edge.from, edge.to)
            : getEdgePath(edge.from, edge.to);
          const color = edge.isLoop ? COLOR_WARNING : "#3f3f46";
          const activeColor = edge.isLoop ? COLOR_WARNING : "#FF5C00";

          return (
            <g key={`edge-${i}`}>
              <path
                d={path}
                fill="none"
                stroke={isActive ? activeColor : color}
                strokeWidth={isActive ? 2 : 1}
                strokeDasharray={edge.isLoop ? "6 4" : "none"}
                style={TRANSITION_STROKE}
                filter={isActive ? "url(#edge-glow)" : undefined}
              />
              {isActive && (
                <path
                  d={path}
                  fill="none"
                  stroke={edge.isLoop ? "url(#loop-grad)" : "url(#edge-active-grad)"}
                  strokeWidth={3}
                  strokeDasharray="20 200"
                  className="dag-edge-pulse"
                />
              )}
              {edge.label && (
                <g>
                  {(() => {
                    const f = NODES[edge.from]!;
                    const t = NODES[edge.to]!;
                    const bw = edge.label.length * 4.5 + 12;
                    const mx = edge.isLoop
                      ? (f.x + t.x + NODE_W) / 2
                      : (f.x + NODE_W + t.x) / 2;
                    const my = edge.isLoop
                      ? Math.max(f.y, t.y) + NODE_H + 40
                      : f.y + halfH;
                    return (
                      <>
                        <rect
                          x={mx - bw / 2}
                          y={my - 8}
                          width={bw}
                          height={16}
                          rx={4}
                          fill={isActive ? (edge.isLoop ? "rgba(245,158,11,0.15)" : "rgba(255,92,0,0.15)") : "rgba(255,255,255,0.03)"}
                          stroke={isActive ? (edge.isLoop ? COLOR_WARNING : "#FF5C00") : "rgba(255,255,255,0.08)"}
                          strokeWidth={0.5}
                          style={TRANSITION_FILL}
                        />
                        <text
                          x={mx}
                          y={my + 3.5}
                          textAnchor="middle"
                          fontSize={8}
                          fontFamily="var(--font-mono)"
                          fill={isActive ? (edge.isLoop ? COLOR_WARNING : "#FF5C00") : "#71717a"}
                          style={TRANSITION_FILL}
                        >
                          {edge.label}
                        </text>
                      </>
                    );
                  })()}
                </g>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {NODES.map((node, i) => {
          const state = nodeStates[i];
          const isRunning = state === "running";
          const isCompleted = state === "completed";

          return (
            <g key={node.id} style={TRANSITION_OPACITY}>
              {isRunning && (
                <rect
                  x={node.x - 4}
                  y={node.y - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={12}
                  fill="none"
                  stroke={node.color}
                  strokeWidth={1}
                  opacity={0.3}
                  filter="url(#node-glow-running)"
                  className="dag-node-pulse"
                />
              )}
              {isCompleted && (
                <rect
                  x={node.x - 2}
                  y={node.y - 2}
                  width={NODE_W + 4}
                  height={NODE_H + 4}
                  rx={10}
                  fill="none"
                  stroke={COLOR_SUCCESS}
                  strokeWidth={0.5}
                  opacity={0.2}
                  filter="url(#node-glow-completed)"
                />
              )}
              <rect
                x={node.x}
                y={node.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={
                  isRunning ? `${node.color}08`
                    : isCompleted ? `${COLOR_SUCCESS}0A`
                      : "rgba(255,255,255,0.02)"
                }
                stroke={
                  isRunning ? node.color
                    : isCompleted ? COLOR_SUCCESS
                      : "rgba(255,255,255,0.08)"
                }
                strokeWidth={isRunning ? 1.5 : 1}
                style={TRANSITION_STROKE_FILL}
              />

              <circle
                cx={node.x + 12}
                cy={node.y + 14}
                r={4}
                fill={node.color}
                opacity={isRunning ? 1 : isCompleted ? 0.7 : 0.4}
                style={TRANSITION_OPACITY}
              />
              <text
                x={node.x + 20}
                y={node.y + 17}
                fontSize={10}
                fontFamily="var(--font-mono)"
                fontWeight={500}
                fill={isRunning || isCompleted ? "#e4e4e7" : "#a1a1aa"}
                style={TRANSITION_FILL}
              >
                {node.id}
              </text>
              <circle
                cx={node.x + NODE_W - 10}
                cy={node.y + 14}
                r={3}
                fill={
                  isRunning ? node.color
                    : isCompleted ? COLOR_SUCCESS
                      : "rgba(255,255,255,0.06)"
                }
                style={TRANSITION_FILL}
              >
                {isRunning && !reducedMotion && (
                  <animate
                    attributeName="opacity"
                    values="1;0.3;1"
                    dur="1.5s"
                    repeatCount="indefinite"
                  />
                )}
              </circle>

              <text
                x={node.x + 12}
                y={node.y + 35}
                fontSize={7}
                fontFamily="var(--font-mono)"
                fill="#71717a"
              >
                {node.role}
              </text>

              <text
                x={node.x + 12}
                y={node.y + 52}
                fontSize={7}
                fontFamily="var(--font-mono)"
                fill="#71717a"
              >
                {node.model}
              </text>
              <rect
                x={node.x + 12 + node.model.length * 4.2 + 4}
                y={node.y + 44}
                width={node.tools >= 10 ? 32 : 28}
                height={12}
                rx={3}
                fill="rgba(255,255,255,0.03)"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={0.5}
              />
              <text
                x={node.x + 12 + node.model.length * 4.2 + 4 + (node.tools >= 10 ? 16 : 14)}
                y={node.y + 53}
                textAnchor="middle"
                fontSize={6.5}
                fontFamily="var(--font-mono)"
                fill="#52525b"
              >
                {node.tools} tools
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
});

/* -- Terminal line data (stable reference) ---- */
const TERMINAL_LINES: { type: string; text: string }[] = [
  { type: "prompt", text: "sigil run tdd-feature \"add OAuth2 login\"" },
  { type: "blank", text: "" },
  { type: "info", text: "Workflow: tdd-feature  run-id: r_8x92kf" },
  { type: "blank", text: "" },
  { type: "running", text: "[10:42:01] planner      \u2192 running   (claude-sdk)" },
  { type: "success", text: "[10:42:08] planner      \u2713 done      4.2s  $0.014" },
  { type: "gate", text: "[10:42:08] plan-to-impl   gate      file_exists: \u2713" },
  { type: "blank", text: "" },
  { type: "running", text: "[10:42:08] implementer  \u2192 running   (codex)" },
  { type: "success", text: "[10:42:38] implementer  \u2713 done     18.4s  $0.041" },
];
const TERMINAL_LINE_COUNT = TERMINAL_LINES.length;

/* -- Terminal preview component --------------- */
const TerminalPreview = memo(function TerminalPreview() {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setVisibleLines(TERMINAL_LINE_COUNT);
      return;
    }

    const START_DELAY_MS = 2000;
    let count = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const delayTimer = setTimeout(() => {
      interval = setInterval(() => {
        count++;
        setVisibleLines(count);
        if (count >= TERMINAL_LINE_COUNT) clearInterval(interval);
      }, 400);
    }, START_DELAY_MS);

    return () => {
      clearTimeout(delayTimer);
      if (interval) clearInterval(interval);
    };
  }, []);

  const renderedLines = useMemo(() =>
    TERMINAL_LINES.map((line, i) => {
      const visible = i < visibleLines;
      const hidden = visible ? "" : " invisible";
      if (line.type === "blank") return <div key={i} className={hidden || undefined}>{"\u00A0"}</div>;
      if (line.type === "prompt") {
        return (
          <div key={i} className={visible ? "animate-fade-switch terminal-line-hover" : "invisible"}>
            <span className="text-dim">$ </span>
            <span className="text-bright">{line.text}</span>
          </div>
        );
      }
      if (line.type === "info") {
        return (
          <div key={i} className={visible ? "animate-fade-switch terminal-line-hover" : "invisible"}>
            <span className="text-body/70">{line.text}</span>
          </div>
        );
      }
      if (line.type === "running") {
        return (
          <div key={i} className={visible ? "animate-fade-switch terminal-line-hover" : "invisible"}>
            <span className="terminal-accent">{line.text}</span>
          </div>
        );
      }
      if (line.type === "success") {
        return (
          <div key={i} className={visible ? "animate-fade-switch terminal-line-hover" : "invisible"}>
            <span className="terminal-success">{line.text}</span>
          </div>
        );
      }
      if (line.type === "gate") {
        return (
          <div key={i} className={visible ? "animate-fade-switch terminal-line-hover" : "invisible"}>
            <span className="text-accent-amber">{line.text}</span>
          </div>
        );
      }
      return <div key={i} className={visible ? "text-body/60 animate-fade-switch terminal-line-hover" : "invisible"}>{line.text}</div>;
    }), [visibleLines]);

  return (
    <div className="rounded-xl border border-white/[0.08] overflow-hidden code-block-premium relative">
      <div className="absolute inset-0 pointer-events-none terminal-scanlines z-10" />
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] bg-panel/80 relative z-20">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-accent-red/40" />
          <div className="w-2 h-2 rounded-full bg-accent-amber/40" />
          <div className="w-2 h-2 rounded-full bg-accent-green/40" />
        </div>
        <span className="font-mono text-[10px] text-dim uppercase tracking-widest font-medium">
          terminal
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-1 h-1 rounded-full bg-accent-green animate-pulse" />
          <span className="font-mono text-[9px] text-dim">live</span>
        </div>
      </div>
      <pre className="bg-canvas p-3 sm:p-4 md:p-5 font-mono text-[10px] sm:text-xs leading-[1.8] overflow-x-auto whitespace-pre relative z-20">
        <code>
          {renderedLines}
          {visibleLines >= TERMINAL_LINE_COUNT && (
            <div className="animate-fade-switch">
              <span className="text-dim">$ </span>
              <span className="terminal-cursor" />
            </div>
          )}
        </code>
      </pre>
    </div>
  );
});

/* -- Hero section ----------------------------- */
export function Hero() {
  return (
    <section className="relative min-h-0 lg:min-h-[calc(100vh-48px)] flex items-center overflow-hidden noise-overlay">
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[400px] sm:h-[600px] pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(255,92,0,0.10) 0%, rgba(255,92,0,0.03) 40%, transparent 70%)",
        }}
      />
      <div
        className="absolute top-[20%] right-[10%] w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at center, rgba(255,92,0,0.05) 0%, transparent 60%)",
        }}
      />

      <div className="absolute inset-0 z-[2] pointer-events-none flex items-center justify-center lg:justify-start">
        <div className="w-[400px] h-[400px] sm:w-[600px] sm:h-[600px] lg:w-[750px] lg:h-[750px] lg:ml-[2%] -mt-[8%]">
          <HeroErrorBoundary fallback={null}>
            <Suspense fallback={null}>
              <HeroSigil />
            </Suspense>
          </HeroErrorBoundary>
        </div>
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-48 pointer-events-none z-[3]"
        style={{
          background: "linear-gradient(to bottom, transparent 0%, var(--canvas) 100%)",
        }}
      />

      <div className="relative z-[4] max-w-6xl mx-auto px-4 sm:px-6 w-full py-20 sm:py-28 lg:py-32">
        <div className="grid lg:grid-cols-[1fr_minmax(320px,420px)] gap-10 sm:gap-14 lg:gap-20 items-center">
          <div className="max-w-xl min-w-0">
            <h1
              className="font-black leading-[0.98] tracking-[-0.04em] text-bright mb-10 animate-slide-up"
              style={{ animationDelay: "0.2s", fontSize: "clamp(2.75rem, 6vw + 1rem, 4.5rem)" }}
            >
              Orchestrate{" "}
              <span className="hero-accent-text hero-headline-accent hero-accent-text-shimmer relative">
                AI agents
              </span>
              <br />
              <span className="text-body font-light tracking-[-0.02em]" style={{ fontSize: "0.82em" }}>
                as deterministic DAGs.
              </span>
            </h1>

            <p
              className="text-base sm:text-lg text-body/90 leading-relaxed mb-12 max-w-md animate-slide-up"
              style={{ animationDelay: "0.3s" }}
            >
              Define workflows as JSON. Sigil executes every node, evaluates gates, retries on failure, and streams results to your terminal.
            </p>

            <div
              className="flex flex-wrap items-center gap-3 animate-slide-up"
              style={{ animationDelay: "0.4s" }}
            >
              <Link
                href="/editor"
                className="inline-flex items-center gap-2.5 font-mono text-sm uppercase tracking-wider font-semibold bg-accent hover:bg-accent-hover text-white px-7 py-3.5 min-h-[48px] rounded-lg transition-all duration-200 cta-glow hover:scale-[1.02] active:scale-[0.98]"
              >
                Build a Workflow
                <ArrowRight size={14} strokeWidth={2.5} />
              </Link>
              <Link
                href="https://github.com/akshatvasisht/sigil"
                target="_blank"
                rel="noopener noreferrer"
                className="view-source-btn inline-flex items-center gap-2 font-mono text-sm uppercase tracking-wider text-dim hover:text-body border border-white/[0.1] hover:border-white/[0.18] px-7 py-3.5 min-h-[48px] rounded-lg transition-all duration-200 hover:bg-white/[0.03]"
              >
                View Source
              </Link>
            </div>

            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-10 animate-slide-up"
              style={{ animationDelay: "0.5s" }}
            >
              <div className="adapter-dot flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-accent-blue shadow-[0_0_6px_rgba(129,140,248,0.4)]" />
                <span className="font-mono text-[10px] text-dim uppercase tracking-wider">Claude</span>
              </div>
              <div className="adapter-dot flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.4)]" />
                <span className="font-mono text-[10px] text-dim uppercase tracking-wider">Codex</span>
              </div>
              <div className="adapter-dot flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-accent-purple shadow-[0_0_6px_rgba(192,132,252,0.4)]" />
                <span className="font-mono text-[10px] text-dim uppercase tracking-wider">Cursor</span>
              </div>
              <span className="font-mono text-[10px] text-subtle">+ more</span>
            </div>
          </div>

          <div
            className="flex flex-col gap-6 min-w-0 animate-slide-up"
            style={{ animationDelay: "0.35s" }}
          >
            <div className="relative rounded-xl border border-white/[0.08] bg-surface/50 p-5 overflow-hidden card-glow-dag dag-card-tilt">
              <HeroErrorBoundary
                fallback={
                  <div className="flex items-center justify-center h-[200px] rounded-lg bg-surface/50 border border-white/[0.06]">
                    <span className="font-mono text-xs text-dim">Workflow visualization</span>
                  </div>
                }
              >
                <AnimatedDAG />
              </HeroErrorBoundary>
            </div>

            <HeroErrorBoundary
              fallback={
                <div className="flex items-center justify-center h-[200px] rounded-xl bg-surface/50 border border-white/[0.08]">
                  <span className="font-mono text-xs text-dim">Terminal preview</span>
                </div>
              }
            >
              <TerminalPreview />
            </HeroErrorBoundary>
          </div>
        </div>
      </div>
    </section>
  );
}
