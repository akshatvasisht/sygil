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
