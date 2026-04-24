import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../types/adapter.js";
import { eventRenderData, type EventIconKey, type EventSeverity } from "./event-render-data.js";

describe("eventRenderData", () => {
  it("tool_call — emits tool name as title and input preview as subtitle", () => {
    const event: AgentEvent = { type: "tool_call", tool: "Read", input: { path: "/tmp/a.txt" } };
    const data = eventRenderData(event);
    expect(data.title).toBe("Read");
    expect(data.subtitle).toBe('("/tmp/a.txt")');
    expect(data.iconKey).toBe("tool");
    expect(data.severity).toBe("info");
  });

  it("tool_call — omits subtitle when input is empty", () => {
    const event: AgentEvent = { type: "tool_call", tool: "Noop", input: {} };
    const data = eventRenderData(event);
    expect(data.subtitle).toBeUndefined();
  });

  it("tool_result — success drives severity=info with ✓ mark", () => {
    const event: AgentEvent = { type: "tool_result", tool: "Read", output: "ok", success: true };
    const data = eventRenderData(event);
    expect(data.subtitle).toBe("→ ✓");
    expect(data.severity).toBe("info");
  });

  it("tool_result — failure drives severity=error with ✗ mark", () => {
    const event: AgentEvent = { type: "tool_result", tool: "Read", output: "boom", success: false };
    const data = eventRenderData(event);
    expect(data.subtitle).toBe("→ ✗");
    expect(data.severity).toBe("error");
  });

  it("file_write — path as subtitle", () => {
    const event: AgentEvent = { type: "file_write", path: "src/out.ts" };
    expect(eventRenderData(event)).toEqual({
      title: "file_write",
      subtitle: "src/out.ts",
      iconKey: "file",
      severity: "info",
    });
  });

  it("shell_exec — exit 0 is info, non-zero is error", () => {
    const ok = eventRenderData({ type: "shell_exec", command: "ls", exitCode: 0 });
    expect(ok.severity).toBe("info");
    expect(ok.subtitle).toBe("exit:0");
    const bad = eventRenderData({ type: "shell_exec", command: "ls", exitCode: 2 });
    expect(bad.severity).toBe("error");
  });

  it("shell_exec — truncates long commands in title", () => {
    const long = "a".repeat(200);
    const data = eventRenderData({ type: "shell_exec", command: long, exitCode: 0 });
    expect(data.title.length).toBeLessThanOrEqual(60);
    expect(data.title.endsWith("…")).toBe(true);
  });

  it("text_delta — text as title, neutral severity", () => {
    const data = eventRenderData({ type: "text_delta", text: "hello" });
    expect(data.title).toBe("hello");
    expect(data.severity).toBe("neutral");
    expect(data.subtitle).toBeUndefined();
  });

  it("cost_update — formatted dollar amount in title", () => {
    const data = eventRenderData({ type: "cost_update", totalCostUsd: 0.12345 });
    expect(data.title).toBe("cost $0.1235");
    expect(data.iconKey).toBe("cost");
  });

  it("stall — warn severity with reason as subtitle", () => {
    const data = eventRenderData({ type: "stall", reason: "no_output" });
    expect(data.title).toBe("stall");
    expect(data.subtitle).toBe("no_output");
    expect(data.severity).toBe("warn");
  });

  it("error — error severity with message as subtitle", () => {
    const data = eventRenderData({ type: "error", message: "kaboom" });
    expect(data.severity).toBe("error");
    expect(data.subtitle).toBe("kaboom");
  });

  it("adapter_failover — from → to (reason) in subtitle, warn severity", () => {
    const data = eventRenderData({
      type: "adapter_failover",
      fromAdapter: "claude-sdk",
      toAdapter: "claude-cli",
      reason: "transport",
    });
    expect(data.title).toBe("adapter_failover");
    expect(data.subtitle).toBe("claude-sdk → claude-cli (transport)");
    expect(data.severity).toBe("warn");
  });

  it("context_set — key as title, JSON-stringified value as subtitle", () => {
    const data = eventRenderData({ type: "context_set", key: "summary", value: { a: 1 } });
    expect(data.title).toBe("summary");
    expect(data.subtitle).toBe('= {"a":1}');
  });

  it("hook_result — exit 0 is info, non-zero is error", () => {
    const ok = eventRenderData({
      type: "hook_result",
      hook: "preNode",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 12,
    });
    expect(ok.title).toBe("hook preNode");
    expect(ok.subtitle).toBe("→ exit=0 (12ms)");
    expect(ok.severity).toBe("info");

    const bad = eventRenderData({
      type: "hook_result",
      hook: "preNode",
      exitCode: 1,
      stdout: "",
      stderr: "oops",
      durationMs: 5,
    });
    expect(bad.severity).toBe("error");
  });

  it("retry_scheduled — warn severity with attempt transition in subtitle", () => {
    const data = eventRenderData({
      type: "retry_scheduled",
      attempt: 1,
      nextAttempt: 2,
      delayMs: 250,
      reason: "transport",
    });
    expect(data.title).toBe("retry_scheduled");
    expect(data.subtitle).toBe("attempt 1→2 in 250ms (transport)");
    expect(data.severity).toBe("warn");
  });

  it("returns a valid severity for every AgentEvent variant (drift guard)", () => {
    const samples: AgentEvent[] = [
      { type: "tool_call", tool: "T", input: {} },
      { type: "tool_result", tool: "T", output: "", success: true },
      { type: "file_write", path: "a" },
      { type: "shell_exec", command: "c", exitCode: 0 },
      { type: "text_delta", text: "t" },
      { type: "cost_update", totalCostUsd: 0 },
      { type: "stall", reason: "r" },
      { type: "error", message: "m" },
      { type: "adapter_failover", fromAdapter: "a", toAdapter: "b", reason: "r" },
      { type: "context_set", key: "k", value: 1 },
      { type: "hook_result", hook: "preNode", exitCode: 0, stdout: "", stderr: "", durationMs: 1 },
      { type: "retry_scheduled", attempt: 1, nextAttempt: 2, delayMs: 1, reason: "r" },
    ];
    const validSeverities: EventSeverity[] = ["info", "warn", "error", "neutral"];
    const validIcons: EventIconKey[] = [
      "tool", "tool-done", "file", "terminal", "text", "cost",
      "warning", "error", "failover", "context", "hook", "retry",
    ];
    for (const ev of samples) {
      const data = eventRenderData(ev);
      expect(validSeverities).toContain(data.severity);
      expect(validIcons).toContain(data.iconKey);
      expect(typeof data.title).toBe("string");
      expect(data.title.length).toBeGreaterThan(0);
    }
  });
});
