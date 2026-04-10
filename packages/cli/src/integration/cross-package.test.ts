/**
 * Cross-package integration tests — verifies the seams between @sigil/shared and CLI.
 *
 * These tests import from @sigil/shared (not relative paths) to exercise
 * the actual package boundary.
 */

import { describe, it, expect } from "vitest";
import {
  WorkflowGraphSchema,
  GateConditionSchema,
  NodeConfigSchema,
  SigilErrorCode,
} from "@sigil/shared";
import type {
  WorkflowGraph,
  NodeConfig,
  EdgeConfig,
  WsServerEvent,
  WsClientEvent,
  SigilError,
} from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalWorkflow(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    version: "1",
    name: "test-workflow",
    nodes: {
      planner: {
        adapter: "claude-sdk",
        model: "claude-opus-4-5",
        role: "Planner",
        prompt: "Plan the implementation",
        tools: ["Read", "Grep"],
      },
      implementer: {
        adapter: "codex",
        model: "gpt-4o",
        role: "Implementer",
        prompt: "Implement the plan",
        tools: ["Read", "Write", "Bash"],
      },
    },
    edges: [
      {
        id: "plan-to-impl",
        from: "planner",
        to: "implementer",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-package schema round-trip", () => {
  it("valid WorkflowGraph survives JSON round-trip through Zod", () => {
    const workflow = makeMinimalWorkflow();
    const json = JSON.stringify(workflow);
    const parsed = JSON.parse(json);
    const result = WorkflowGraphSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("test-workflow");
      expect(Object.keys(result.data.nodes)).toHaveLength(2);
      expect(result.data.edges).toHaveLength(1);
    }
  });

  it("preserves all node config fields through round-trip", () => {
    const base = makeMinimalWorkflow();
    const workflow = makeMinimalWorkflow({
      nodes: {
        ...base.nodes,
        full: {
          adapter: "claude-sdk",
          model: "claude-sonnet-4-5",
          role: "Full Node",
          prompt: "Test all fields",
          tools: ["Read", "Write"],
          outputDir: "/tmp/test",
          maxTurns: 50,
          maxBudgetUsd: 1.5,
          timeoutMs: 60000,
          idleTimeoutMs: 30000,
          sandbox: "workspace-write",
        },
      },
    });

    const json = JSON.stringify(workflow);
    const result = WorkflowGraphSchema.safeParse(JSON.parse(json));
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data.nodes["full"];
      expect(node).toBeDefined();
      expect(node!.maxTurns).toBe(50);
      expect(node!.maxBudgetUsd).toBe(1.5);
      expect(node!.timeoutMs).toBe(60000);
      expect(node!.idleTimeoutMs).toBe(30000);
      expect(node!.sandbox).toBe("workspace-write");
    }
  });
});

describe("invalid workflow rejection", () => {
  it("rejects edges referencing unknown nodes", () => {
    const workflow = makeMinimalWorkflow({
      edges: [{ id: "bad-edge", from: "planner", to: "nonexistent" }],
    });
    const result = WorkflowGraphSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("unknown node"))).toBe(true);
    }
  });

  it("rejects duplicate edge IDs", () => {
    const workflow = makeMinimalWorkflow({
      edges: [
        { id: "dup", from: "planner", to: "implementer" },
        { id: "dup", from: "implementer", to: "planner", isLoopBack: true, maxRetries: 3 },
      ],
    });
    const result = WorkflowGraphSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("Duplicate edge ID"))).toBe(true);
    }
  });

  it("rejects loop-back without maxRetries", () => {
    const workflow = makeMinimalWorkflow({
      edges: [
        { id: "loop", from: "implementer", to: "planner", isLoopBack: true },
      ],
    });
    const result = WorkflowGraphSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("maxRetries"))).toBe(true);
    }
  });

  it("rejects workflow with zero nodes", () => {
    const workflow = makeMinimalWorkflow({ nodes: {} });
    const result = WorkflowGraphSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });
});

describe("gate condition schema validation", () => {
  it("parses all 5 gate condition types", () => {
    const conditions = [
      { type: "exit_code" as const, value: 0 },
      { type: "file_exists" as const, path: "output.txt" },
      { type: "regex" as const, filePath: "log.txt", pattern: "SUCCESS" },
      { type: "script" as const, path: "./check.sh" },
      { type: "human_review" as const },
    ];

    for (const condition of conditions) {
      const result = GateConditionSchema.safeParse(condition);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid condition type", () => {
    const result = GateConditionSchema.safeParse({ type: "invalid", value: 42 });
    expect(result.success).toBe(false);
  });
});

describe("node config accepts all adapter types", () => {
  const adapters: Array<"claude-sdk" | "claude-cli" | "codex" | "cursor"> = [
    "claude-sdk", "claude-cli", "codex", "cursor",
  ];

  for (const adapter of adapters) {
    it(`accepts adapter type "${adapter}"`, () => {
      const config = {
        adapter,
        model: "test-model",
        role: "Test",
        prompt: "Do something",
      };
      const result = NodeConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  }

  it("rejects unknown adapter type", () => {
    const config = {
      adapter: "unknown-adapter",
      model: "test-model",
      role: "Test",
      prompt: "Do something",
    };
    const result = NodeConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("event type coverage (compile-time verification)", () => {
  it("WsServerEvent union covers key event types", () => {
    // These are type-level tests — if they compile, the types are correct
    const events: WsServerEvent[] = [
      { type: "workflow_start", workflowId: "w1", graph: makeMinimalWorkflow() },
      { type: "node_start", workflowId: "w1", nodeId: "n1", config: makeMinimalWorkflow().nodes["planner"]!, attempt: 1 },
      { type: "node_end", workflowId: "w1", nodeId: "n1", result: { output: "", exitCode: 0, durationMs: 100 } },
      { type: "workflow_end", workflowId: "w1", success: true, durationMs: 1000, totalCostUsd: 0.5 },
    ];
    expect(events).toHaveLength(4);
  });

  it("WsClientEvent union covers control events", () => {
    const events: WsClientEvent[] = [
      { type: "subscribe", workflowId: "w1" },
      { type: "unsubscribe", workflowId: "w1" },
      { type: "pause", workflowId: "w1" },
      { type: "resume_workflow", workflowId: "w1" },
      { type: "cancel", workflowId: "w1" },
    ];
    expect(events).toHaveLength(5);
  });
});

describe("SigilErrorCode integration", () => {
  it("can create SigilError with error codes from shared", () => {
    const err: SigilError = {
      code: SigilErrorCode.NODE_TIMEOUT,
      message: "Node planner exceeded 60s timeout",
      nodeId: "planner",
    };
    expect(err.code).toBe("NODE_TIMEOUT");
  });
});
