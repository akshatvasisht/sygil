/**
 * Format an ISO timestamp as a zero-padded 24-hour HH:MM:SS string
 * (en-US locale, no AM/PM). Shared by the monitor's EventStream and
 * NodeTimeline so the time format stays identical across both views.
 */
export function formatHHMMSS(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * <1 s  → "Xms"  (rounded to nearest ms)
 * <1 m  → "X.Xs" (one decimal)
 * ≥1 m  → "Xm00s" (zero-padded seconds)
 * Mirrors the formatMs helper in MetricsStrip.tsx so duration rendering
 * stays consistent across the monitor and any other consumer.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}
