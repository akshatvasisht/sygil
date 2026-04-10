import { describe, it, expect } from "vitest";
import { exportAsJson, exportAsMarkdown } from "./exportLog";
import type { WsServerEvent, WorkflowRunState } from "@sigil/shared";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const MOCK_STATE: WorkflowRunState = {
  id: "r_abc123",
  workflowName: "tdd-feature",
  workflowPath: "sigil.yaml",
  status: "completed",
  startedAt: "2025-01-15T10:42:00Z",
  completedAt: "2025-01-15T10:42:30Z",
  currentNodeId: undefined,
  completedNodes: ["planner", "implementer"],
  nodeResults: {
    planner: {
      output: "Tests written",
      exitCode: 0,
      durationMs: 4200,
      costUsd: 0.014,
      tokenUsage: { input: 2400, output: 880 },
    },
    implementer: {
      output: "Implementation done",
      exitCode: 0,
      durationMs: 18400,
      costUsd: 0.041,
      tokenUsage: { input: 5200, output: 3100 },
    },
  },
  totalCostUsd: 0.055,
  retryCounters: {},
};

const MOCK_EVENTS: WsServerEvent[] = [
  {
    type: "workflow_start",
    workflowId: "r_abc123",
    graph: { version: "1", name: "tdd-feature", nodes: {}, edges: [] },
  },
  {
    type: "node_start",
    workflowId: "r_abc123",
    nodeId: "planner",
    config: { adapter: "claude-sdk", model: "claude-opus-4-5", role: "Planner", prompt: "plan" },
    attempt: 1,
  },
];

// ── exportAsJson ──────────────────────────────────────────────────────────────

describe("exportAsJson", () => {
  it("includes state and events in output", () => {
    const json = exportAsJson(MOCK_STATE, MOCK_EVENTS);
    const parsed = JSON.parse(json);
    expect(parsed.state).toEqual(MOCK_STATE);
    expect(parsed.events).toEqual(MOCK_EVENTS);
  });

  it("output is valid JSON", () => {
    const json = exportAsJson(MOCK_STATE, MOCK_EVENTS);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes exportedAt timestamp", () => {
    const json = exportAsJson(MOCK_STATE, MOCK_EVENTS);
    const parsed = JSON.parse(json);
    expect(parsed.exportedAt).toBeDefined();
    expect(new Date(parsed.exportedAt).getTime()).not.toBeNaN();
  });
});

// ── exportAsMarkdown ──────────────────────────────────────────────────────────

describe("exportAsMarkdown", () => {
  it("includes workflow name in heading", () => {
    const md = exportAsMarkdown(MOCK_STATE, MOCK_EVENTS);
    expect(md).toContain("# Workflow Run: tdd-feature");
  });

  it("includes node results", () => {
    const md = exportAsMarkdown(MOCK_STATE, MOCK_EVENTS);
    expect(md).toContain("### planner");
    expect(md).toContain("### implementer");
    expect(md).toContain("Duration: 4.2s");
    expect(md).toContain("Duration: 18.4s");
  });

  it("handles null state gracefully", () => {
    expect(() => exportAsMarkdown(null, [])).not.toThrow();
    const md = exportAsMarkdown(null, []);
    expect(md).toContain("# Workflow Run: Unknown");
    expect(md).toContain("**Status:** unknown");
  });
});
