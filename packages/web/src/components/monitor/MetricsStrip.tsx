"use client";

import type { MetricsSnapshot } from "@sygil/shared";
import { Activity, Gauge, CheckCircle, XCircle, Hourglass } from "lucide-react";

interface MetricsStripProps {
  metrics: MetricsSnapshot | null;
}

/**
 * Compact in-run metrics strip, rendered between the sub-toolbar and the
 * split pane of ExecutionMonitor. Shows in-flight nodes, gate pass/fail
 * totals, adapter pool occupancy + acquire-wait percentiles (when pooled),
 * and per-adapter duration percentiles. Hidden when there is no snapshot yet.
 */
export function MetricsStrip({ metrics }: MetricsStripProps) {
  if (!metrics) return null;

  const adapterEntries = Object.entries(metrics.adapters);

  return (
    <div
      role="status"
      aria-label="Live workflow metrics"
      className="flex items-center gap-4 px-4 py-1.5 border-b border-border bg-surface/60 text-[10px] font-mono overflow-x-auto scrollbar-hide"
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <Activity size={10} className="text-accent-blue" />
        <span className="text-dim">in-flight</span>
        <span className="text-bright">{metrics.inFlightNodes}</span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <CheckCircle size={10} className="text-accent-green" />
        <span className="text-dim">gates</span>
        <span className="text-accent-green">{metrics.gates.passed}</span>
        <span className="text-dim">/</span>
        <XCircle size={10} className="text-accent-red" />
        <span className="text-accent-red">{metrics.gates.failed}</span>
      </div>

      {metrics.pool && (
        <div className="flex items-center gap-1.5 shrink-0 border-l border-border pl-4">
          <Gauge size={10} className="text-accent-amber" />
          <span className="text-dim">pool</span>
          <span className="text-bright">
            {metrics.pool.active}/{metrics.pool.maxConcurrency}
          </span>
          {metrics.pool.waiting > 0 && (
            <>
              <Hourglass size={10} className="text-accent-amber" />
              <span className="text-accent-amber">{metrics.pool.waiting}</span>
            </>
          )}
          {metrics.pool.waitCount > 0 && (
            <span className="text-dim">
              wait p50/p95/p99{" "}
              <span className="text-body">{formatMs(metrics.pool.p50WaitMs)}</span>
              <span className="text-dim"> / </span>
              <span className="text-body">{formatMs(metrics.pool.p95WaitMs)}</span>
              <span className="text-dim"> / </span>
              <span className="text-body">{formatMs(metrics.pool.p99WaitMs)}</span>
            </span>
          )}
        </div>
      )}

      {adapterEntries.length > 0 && (
        <div className="flex items-center gap-3 shrink-0 border-l border-border pl-4">
          {adapterEntries.map(([adapter, m]) => (
            <div key={adapter} className="flex items-center gap-1.5">
              <span className="text-accent-purple">{adapter}</span>
              <span className="text-dim">
                p50/p95/p99{" "}
                <span className="text-body">{formatMs(m.p50Ms)}</span>
                <span className="text-dim"> / </span>
                <span className="text-body">{formatMs(m.p95Ms)}</span>
                <span className="text-dim"> / </span>
                <span className="text-body">{formatMs(m.p99Ms)}</span>
              </span>
              <span className="text-dim">×{m.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}
