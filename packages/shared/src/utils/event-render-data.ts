import type { AgentEvent } from "../types/adapter.js";

/**
 * Icon key — a rendering-agnostic string that each consumer maps to its own
 * icon primitive. CLI terminal-renderer maps these to chalk colour + unicode
 * glyph; web `EventStream` / `NodeTimeline` map them to a lucide component.
 * Keeping them as string literals lets the shared package avoid any dependency
 * on chalk or lucide.
 */
export type EventIconKey =
  | "tool"
  | "tool-done"
  | "file"
  | "terminal"
  | "text"
  | "cost"
  | "warning"
  | "error"
  | "failover"
  | "context"
  | "hook"
  | "retry"
  | "sync";

export type EventSeverity = "info" | "warn" | "error" | "neutral";

export interface EventRenderData {
  /** Short primary label (e.g. tool name, "file_write", "hook preNode"). */
  title: string;
  /** Optional secondary detail (input preview, reason, exit/duration). */
  subtitle?: string;
  /** Rendering-agnostic icon key; consumers pick the concrete icon. */
  iconKey: EventIconKey;
  /** Coarse severity driving background/colour choices per consumer. */
  severity: EventSeverity;
}

/** Truncate a string to `max` chars, appending `…` if cut. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Extract the first string value from a tool input record for display. */
function getFirstArgValue(input: Record<string, unknown>): string | null {
  const keys = Object.keys(input);
  const firstKey = keys[0];
  if (firstKey === undefined) return null;
  const val = input[firstKey];
  if (typeof val === "string") return val;
  if (val !== null && val !== undefined) return String(val);
  return null;
}

/**
 * Pure-data projection of an `AgentEvent` into the minimal fields needed for
 * rendering — title, subtitle, icon key, severity. Consumers choose concrete
 * icons and colours from `iconKey` + `severity`.
 *
 * Exhaustive over the `AgentEvent` discriminated union; a new variant will
 * fail tsc here, same as the pre-existing per-consumer switches.
 */
export function eventRenderData(event: AgentEvent): EventRenderData {
  switch (event.type) {
    case "tool_call": {
      const firstArgValue = getFirstArgValue(event.input);
      const subtitle =
        firstArgValue !== null ? `("${truncate(firstArgValue, 40)}")` : undefined;
      return {
        title: event.tool,
        ...(subtitle !== undefined ? { subtitle } : {}),
        iconKey: "tool",
        severity: "info",
      };
    }
    case "tool_result":
      return {
        title: event.tool,
        subtitle: `→ ${event.success ? "✓" : "✗"}`,
        iconKey: "tool-done",
        severity: event.success ? "info" : "error",
      };
    case "file_write":
      return {
        title: "file_write",
        subtitle: event.path,
        iconKey: "file",
        severity: "info",
      };
    case "shell_exec":
      return {
        title: truncate(event.command, 60),
        subtitle: `exit:${event.exitCode}`,
        iconKey: "terminal",
        severity: event.exitCode === 0 ? "info" : "error",
      };
    case "text_delta":
      return {
        title: truncate(event.text, 120),
        iconKey: "text",
        severity: "neutral",
      };
    case "cost_update":
      return {
        title: `cost $${event.totalCostUsd.toFixed(4)}`,
        iconKey: "cost",
        severity: "info",
      };
    case "stall":
      return {
        title: "stall",
        subtitle: event.reason,
        iconKey: "warning",
        severity: "warn",
      };
    case "error":
      return {
        title: "error",
        subtitle: event.message,
        iconKey: "error",
        severity: "error",
      };
    case "adapter_failover":
      return {
        title: "adapter_failover",
        subtitle: `${event.fromAdapter} → ${event.toAdapter} (${event.reason})`,
        iconKey: "failover",
        severity: "warn",
      };
    case "context_set":
      return {
        title: event.key,
        subtitle: `= ${truncate(JSON.stringify(event.value) ?? "undefined", 40)}`,
        iconKey: "context",
        severity: "info",
      };
    case "hook_result":
      return {
        title: `hook ${event.hook}`,
        subtitle: `→ exit=${event.exitCode} (${event.durationMs}ms)`,
        iconKey: "hook",
        severity: event.exitCode === 0 ? "info" : "error",
      };
    case "retry_scheduled":
      return {
        title: "retry_scheduled",
        subtitle: `attempt ${event.attempt}→${event.nextAttempt} in ${event.delayMs}ms (${event.reason})`,
        iconKey: "retry",
        severity: "warn",
      };
    case "sync_acquire":
      return {
        title: "sync_acquire",
        subtitle: `"${event.key}" limit=${event.limit}`,
        iconKey: "sync",
        severity: "info",
      };
    case "sync_release":
      return {
        title: "sync_release",
        subtitle: `"${event.key}"`,
        iconKey: "sync",
        severity: "info",
      };
  }
}
