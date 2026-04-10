"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  code: string;
  id: string;
}

function CodeBlock({ code, id }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative group bg-canvas border border-border rounded-lg overflow-hidden">
      <pre className="font-mono text-sm text-body px-4 py-3 overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        aria-label={`Copy code for step ${id}`}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-surface border border-border text-muted hover:text-subtle transition-all opacity-0 group-hover:opacity-100"
      >
        {copied ? <Check size={12} className="text-accent-green" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

const STEPS = [
  {
    number: "01",
    title: "Install",
    description: "Install sigil globally with npm.",
    code: "npm install -g sigil",
    output: null,
  },
  {
    number: "02",
    title: "Initialize",
    description: "Run sigil init inside your project to scaffold a workflow file and detect installed adapters.",
    code: "cd my-project && sigil init",
    output: `Detected adapters:
  ✓ claude-sdk  (ANTHROPIC_API_KEY set)
  ✓ codex       (codex CLI found at /usr/local/bin/codex)
  ✗ cursor      (not installed)

Created sigil.yaml — edit it to define your workflow.`,
  },
  {
    number: "03",
    title: "Run",
    description: "Execute a workflow with a goal. Sigil prints a live monitor URL you can open in the browser.",
    code: 'sigil run tdd-feature "add OAuth2 login"',
    output: `Starting workflow: tdd-feature
Goal: "add OAuth2 login"

  ➜ Monitor: http://localhost:3001/monitor?workflow=r_8x92kf

  [planner]     ✓  4.2s   $0.014
  [implementer] ↺  running...`,
  },
];

export function GetStarted() {
  return (
    <section className="border-t border-border py-24">
      <div className="max-w-6xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="font-mono text-xs text-accent-blue mb-4 tracking-widest uppercase">
            Quickstart
          </div>
          <h2 className="font-display text-4xl font-bold text-white mb-4">
            Get started in 3 steps
          </h2>
          <p className="text-body max-w-lg mx-auto">
            From zero to a running multi-agent workflow in under two minutes.
          </p>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {STEPS.map((step) => (
            <div
              key={step.number}
              className="bg-panel border border-border rounded-xl p-6 flex flex-col gap-4 hover:border-border-bright transition-colors"
            >
              {/* Step number + title */}
              <div className="flex items-center gap-3">
                <span className="font-mono text-2xl font-bold text-accent-blue/40 leading-none">
                  {step.number}
                </span>
                <h3 className="font-display font-semibold text-bright text-lg">{step.title}</h3>
              </div>

              {/* Description */}
              <p className="text-body text-sm leading-relaxed">{step.description}</p>

              {/* Primary code block */}
              <CodeBlock code={step.code} id={step.number} />

              {/* Optional output preview */}
              {step.output && (
                <div className="bg-canvas border border-border rounded-lg px-4 py-3 overflow-x-auto">
                  <pre className="font-mono text-[11px] text-muted leading-relaxed whitespace-pre-wrap">
                    {step.output}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
