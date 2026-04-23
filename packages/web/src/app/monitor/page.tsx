"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ExecutionMonitor } from "@/components/monitor/ExecutionMonitor";
import { SigilLogo } from "@/components/ui/SigilLogo";
import { resolveMonitorWsUrl, classifyMonitorWsParam } from "@/lib/monitor-url";
import Link from "next/link";
import { LayoutTemplate, Copy, Check } from "lucide-react";

function MonitorInner() {
  const searchParams = useSearchParams();
  const workflowId = searchParams.get("workflow");
  const token = searchParams.get("token");
  const [copied, setCopied] = useState(false);

  const wsParam = searchParams.get("ws");
  const wsParamClassification = classifyMonitorWsParam(wsParam);
  const wsUrl = resolveMonitorWsUrl({
    wsParam,
    token,
    locationPort: typeof window !== "undefined" ? window.location.port : null,
    locationHostname: typeof window !== "undefined" ? window.location.hostname : "localhost",
  });

  const displayWorkflow = workflowId ?? "tdd-feature";

  async function handleCopyUrl() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="h-screen bg-canvas flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-border bg-canvas shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 group">
            <SigilLogo size={16} color="#71717a" className="group-hover:[&]:opacity-100 transition-opacity duration-200" />
            <span className="font-display font-semibold text-sm text-dim group-hover:text-body transition-colors duration-200">
              sygil
            </span>
          </Link>
          <div className="w-px h-3.5 bg-border" />
          <span className="font-mono text-xs text-dim">{displayWorkflow}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyUrl}
            aria-label={copied ? "URL copied" : "Copy monitor URL to clipboard"}
            className="flex items-center gap-1.5 font-mono text-xs text-dim hover:text-body border border-border hover:border-border-bright px-3 min-h-[44px] rounded-md transition-all duration-200"
          >
            {copied ? <Check size={12} className="text-accent-green" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy URL"}
          </button>
          <Link
            href="/editor"
            aria-label="Open workflow editor"
            className="flex items-center gap-1.5 font-mono text-xs text-dim hover:text-body border border-border hover:border-border-bright px-3 min-h-[44px] rounded-md transition-all duration-200"
          >
            <LayoutTemplate size={12} />
            Editor
          </Link>
        </div>
      </div>

      {wsParamClassification === "invalid_port" && (
        <div
          role="alert"
          className="border-b border-accent-red/30 bg-accent-red/10 text-accent-red px-4 py-2 font-mono text-xs"
        >
          Invalid ?ws= port: expected a number between 1 and 65535.
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <ExecutionMonitor wsUrl={wsUrl} workflowId={workflowId} />
      </div>
    </div>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={<div className="h-screen bg-canvas" />}>
      <MonitorInner />
    </Suspense>
  );
}
