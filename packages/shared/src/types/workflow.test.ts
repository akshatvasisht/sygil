import { describe, it, expect } from "vitest";
import type {
  WorkflowGraph,
  NodeConfig,
  EdgeConfig,
  GateCondition,
  AdapterType,
  ParameterConfig,
  SandboxMode,
} from "./workflow.js";
import {
  WorkflowGraphSchema,
  NodeConfigSchema,
  EdgeConfigSchema,
  GateConditionSchema,
  ParameterConfigSchema,
  STALL_EXIT_CODE,
} from "./workflow.js";

// ---------------------------------------------------------------------------
// Helper: minimal valid workflow for reuse across tests
// ---------------------------------------------------------------------------

function minimalWorkflow(): Record<string, unknown> {
  return {
    version: "1",
    name: "test-workflow",
    nodes: {
      nodeA: {
        adapter: "claude-sdk",
        model: "claude-opus-4-5",
        role: "planner",
        prompt: "Plan this",
      },
    },
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// Type-level tests — compile-time structural checks
// ---------------------------------------------------------------------------

describe("WorkflowGraph type", () => {
  it("accepts a valid WorkflowGraph with 2 nodes and 1 edge", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "test-workflow",
      nodes: {
        nodeA: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "You are a planner",
          prompt: "Plan this task",
        },
        nodeB: {
          adapter: "codex",
          model: "o4-mini",
          role: "You are an implementer",
          prompt: "Implement this",
        },
      },
      edges: [
        {
          id: "a-to-b",
          from: "nodeA",
          to: "nodeB",
        },
      ],
    };

    expect(graph.nodes["nodeA"]?.adapter).toBe("claude-sdk");
    expect(graph.nodes["nodeB"]?.adapter).toBe("codex");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.id).toBe("a-to-b");
  });

  it("accepts a WorkflowGraph with all optional fields", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "optional-test",
      description: "Tests optional fields",
      nodes: {
        only: {
          adapter: "claude-cli",
          model: "claude-opus-4-5",
          role: "reviewer",
          prompt: "Review this",
          tools: ["Read", "Grep"],
          disallowedTools: ["Bash"],
          maxTurns: 10,
          maxBudgetUsd: 0.5,
          timeoutMs: 60000,
          idleTimeoutMs: 30000,
          sandbox: "read-only",
          outputDir: "./output",
          outputSchema: { type: "object" },
        },
      },
      edges: [],
      parameters: {
        task: {
          type: "string",
          description: "The task to perform",
          required: true,
        },
      },
    };

    expect(graph.description).toBe("Tests optional fields");
    expect(graph.nodes["only"]?.sandbox).toBe("read-only");
    expect(graph.nodes["only"]?.idleTimeoutMs).toBe(30000);
    expect(graph.nodes["only"]?.outputDir).toBe("./output");
    expect(graph.parameters?.["task"]?.required).toBe(true);
  });
});

describe("EdgeConfig type", () => {
  it("accepts a loop-back edge with maxRetries", () => {
    const edge: EdgeConfig = {
      id: "loop-back",
      from: "nodeB",
      to: "nodeA",
      isLoopBack: true,
      maxRetries: 3,
      gate: {
        conditions: [{ type: "exit_code", value: 1 }],
      },
    };

    expect(edge.isLoopBack).toBe(true);
    expect(edge.maxRetries).toBe(3);
  });

  it("accepts a forward edge without isLoopBack", () => {
    const edge: EdgeConfig = {
      id: "forward",
      from: "a",
      to: "b",
    };

    expect(edge.isLoopBack).toBeUndefined();
    expect(edge.maxRetries).toBeUndefined();
  });

  it("accepts an edge with a contract config", () => {
    const edge: EdgeConfig = {
      id: "contracted",
      from: "a",
      to: "b",
      contract: {
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        inputMapping: { summary: "output.json#summary" },
      },
    };

    expect(edge.contract?.outputSchema).toBeDefined();
    expect(edge.contract?.inputMapping?.["summary"]).toBe("output.json#summary");
  });
});

describe("GateCondition discriminated union", () => {
  it("narrows to exit_code condition", () => {
    const cond: GateCondition = { type: "exit_code", value: 0 };
    expect(cond.type).toBe("exit_code");
    if (cond.type === "exit_code") {
      expect(typeof cond.value).toBe("number");
    }
  });

  it("narrows to file_exists condition", () => {
    const cond: GateCondition = { type: "file_exists", path: "/tmp/output.txt" };
    expect(cond.type).toBe("file_exists");
    if (cond.type === "file_exists") {
      expect(typeof cond.path).toBe("string");
    }
  });

  it("narrows to regex condition", () => {
    const cond: GateCondition = {
      type: "regex",
      filePath: "/tmp/output.txt",
      pattern: "LGTM",
    };
    expect(cond.type).toBe("regex");
    if (cond.type === "regex") {
      expect(typeof cond.filePath).toBe("string");
      expect(typeof cond.pattern).toBe("string");
    }
  });

  it("narrows to script condition", () => {
    const cond: GateCondition = { type: "script", path: "/tmp/check.sh" };
    expect(cond.type).toBe("script");
    if (cond.type === "script") {
      expect(typeof cond.path).toBe("string");
    }
  });

  it("narrows to human_review condition without prompt", () => {
    const cond: GateCondition = { type: "human_review" };
    expect(cond.type).toBe("human_review");
    if (cond.type === "human_review") {
      expect(cond.prompt).toBeUndefined();
    }
  });

  it("narrows to human_review condition with prompt", () => {
    const cond: GateCondition = { type: "human_review", prompt: "Approve this?" };
    expect(cond.type).toBe("human_review");
    if (cond.type === "human_review") {
      expect(cond.prompt).toBe("Approve this?");
    }
  });
});

describe("AdapterType union", () => {
  it("accepts all valid adapter type values", () => {
    const adapters: AdapterType[] = ["claude-sdk", "claude-cli", "codex", "cursor", "echo"];
    expect(adapters).toHaveLength(5);
    expect(adapters).toContain("claude-sdk");
    expect(adapters).toContain("claude-cli");
    expect(adapters).toContain("codex");
    expect(adapters).toContain("cursor");
    expect(adapters).toContain("echo");
  });

  it("can be used to type a variable", () => {
    const adapter: AdapterType = "claude-sdk";
    const typed: AdapterType = adapter;
    expect(typed).toBe("claude-sdk");
  });
});

describe("SandboxMode union", () => {
  it("accepts all valid sandbox mode values", () => {
    const modes: SandboxMode[] = ["read-only", "workspace-write", "full-access"];
    expect(modes).toHaveLength(3);
  });
});

describe("Constants", () => {
  it("exports STALL_EXIT_CODE as -2", () => {
    expect(STALL_EXIT_CODE).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// Zod schema runtime validation tests
// ---------------------------------------------------------------------------

describe("WorkflowGraphSchema", () => {
  it("parses a valid minimal workflow", () => {
    const result = WorkflowGraphSchema.safeParse(minimalWorkflow());
    expect(result.success).toBe(true);
  });

  it("parses a workflow with parameters", () => {
    const wf = {
      ...minimalWorkflow(),
      parameters: {
        taskName: { type: "string", description: "Task name", required: true, default: "untitled" },
        retries: { type: "number", required: false },
        verbose: { type: "boolean" },
      },
    };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(true);
  });

  it("rejects workflow with missing name", () => {
    const wf = minimalWorkflow();
    delete wf["name"];
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
  });

  it("rejects workflow with empty name", () => {
    const wf = { ...minimalWorkflow(), name: "" };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
  });

  it("rejects workflow with missing version", () => {
    const wf = minimalWorkflow();
    delete wf["version"];
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
  });

  it("rejects workflow with missing nodes", () => {
    const wf = minimalWorkflow();
    delete wf["nodes"];
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
  });

  it("rejects workflow with empty nodes", () => {
    const wf = { ...minimalWorkflow(), nodes: {} };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("at least one node"))).toBe(true);
    }
  });

  it("rejects workflow with missing edges", () => {
    const wf = minimalWorkflow();
    delete wf["edges"];
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
  });

  it("rejects edge referencing nonexistent 'from' node", () => {
    const wf = {
      ...minimalWorkflow(),
      edges: [{ id: "e1", from: "nonexistent", to: "nodeA" }],
    };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("unknown node"))).toBe(true);
    }
  });

  it("rejects edge referencing nonexistent 'to' node", () => {
    const wf = {
      ...minimalWorkflow(),
      edges: [{ id: "e1", from: "nodeA", to: "nonexistent" }],
    };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("unknown node"))).toBe(true);
    }
  });

  it("rejects duplicate edge IDs", () => {
    const wf = {
      ...minimalWorkflow(),
      nodes: {
        nodeA: { adapter: "claude-sdk", model: "m", role: "r", prompt: "p" },
        nodeB: { adapter: "codex", model: "m", role: "r", prompt: "p" },
      },
      edges: [
        { id: "same-id", from: "nodeA", to: "nodeB" },
        { id: "same-id", from: "nodeB", to: "nodeA" },
      ],
    };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("Duplicate edge ID"))).toBe(true);
    }
  });

  it("accepts a workflow with description", () => {
    const wf = { ...minimalWorkflow(), description: "A test workflow" };
    const result = WorkflowGraphSchema.safeParse(wf);
    expect(result.success).toBe(true);
  });
});

describe("NodeConfigSchema", () => {
  it("parses a minimal node config", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "claude-opus-4-5",
      role: "planner",
      prompt: "Plan this",
    });
    expect(result.success).toBe(true);
  });

  it("parses a node with all optional fields", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "cursor",
      model: "gpt-4",
      role: "implementer",
      prompt: "Implement",
      tools: ["Read", "Write"],
      disallowedTools: ["Bash"],
      outputDir: "./out",
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      maxTurns: 5,
      maxBudgetUsd: 1.5,
      timeoutMs: 120000,
      idleTimeoutMs: 30000,
      sandbox: "workspace-write",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid adapter type", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "invalid-adapter",
      model: "m",
      role: "r",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(NodeConfigSchema.safeParse({ adapter: "claude-sdk" }).success).toBe(false);
    expect(NodeConfigSchema.safeParse({ model: "m" }).success).toBe(false);
    expect(NodeConfigSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty model string", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "",
      role: "r",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty role string", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "m",
      role: "",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty prompt string", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "m",
      role: "r",
      prompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative timeoutMs", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "m",
      role: "r",
      prompt: "p",
      timeoutMs: -1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero maxTurns", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "m",
      role: "r",
      prompt: "p",
      maxTurns: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid sandbox mode", () => {
    const result = NodeConfigSchema.safeParse({
      adapter: "claude-sdk",
      model: "m",
      role: "r",
      prompt: "p",
      sandbox: "invalid-mode",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid adapter types", () => {
    for (const adapter of ["claude-sdk", "claude-cli", "codex", "cursor", "echo"]) {
      const result = NodeConfigSchema.safeParse({
        adapter,
        model: "m",
        role: "r",
        prompt: "p",
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all valid sandbox modes", () => {
    for (const sandbox of ["read-only", "workspace-write", "full-access"]) {
      const result = NodeConfigSchema.safeParse({
        adapter: "claude-sdk",
        model: "m",
        role: "r",
        prompt: "p",
        sandbox,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("EdgeConfigSchema", () => {
  it("parses a minimal edge", () => {
    const result = EdgeConfigSchema.safeParse({ id: "e1", from: "a", to: "b" });
    expect(result.success).toBe(true);
  });

  it("parses a loop-back edge with maxRetries", () => {
    const result = EdgeConfigSchema.safeParse({
      id: "loop",
      from: "b",
      to: "a",
      isLoopBack: true,
      maxRetries: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a loop-back edge without maxRetries", () => {
    const result = EdgeConfigSchema.safeParse({
      id: "loop-no-retries",
      from: "b",
      to: "a",
      isLoopBack: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("must define maxRetries"))).toBe(true);
    }
  });

  it("parses an edge with a gate containing multiple conditions", () => {
    const result = EdgeConfigSchema.safeParse({
      id: "gated",
      from: "a",
      to: "b",
      gate: {
        conditions: [
          { type: "exit_code", value: 0 },
          { type: "file_exists", path: "output.txt" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses an edge with a contract", () => {
    const result = EdgeConfigSchema.safeParse({
      id: "contract-edge",
      from: "a",
      to: "b",
      contract: {
        outputSchema: { type: "object" },
        inputMapping: { summary: "result.json#summary" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty edge id", () => {
    const result = EdgeConfigSchema.safeParse({ id: "", from: "a", to: "b" });
    expect(result.success).toBe(false);
  });

  it("rejects empty from", () => {
    const result = EdgeConfigSchema.safeParse({ id: "e1", from: "", to: "b" });
    expect(result.success).toBe(false);
  });

  it("rejects empty to", () => {
    const result = EdgeConfigSchema.safeParse({ id: "e1", from: "a", to: "" });
    expect(result.success).toBe(false);
  });
});

describe("GateConditionSchema", () => {
  it("parses exit_code condition", () => {
    const result = GateConditionSchema.safeParse({ type: "exit_code", value: 0 });
    expect(result.success).toBe(true);
  });

  it("parses file_exists condition", () => {
    const result = GateConditionSchema.safeParse({ type: "file_exists", path: "output.txt" });
    expect(result.success).toBe(true);
  });

  it("parses regex condition", () => {
    const result = GateConditionSchema.safeParse({
      type: "regex",
      filePath: "output.txt",
      pattern: "PASS",
    });
    expect(result.success).toBe(true);
  });

  it("parses script condition", () => {
    const result = GateConditionSchema.safeParse({ type: "script", path: "check.sh" });
    expect(result.success).toBe(true);
  });

  it("parses human_review condition without prompt", () => {
    const result = GateConditionSchema.safeParse({ type: "human_review" });
    expect(result.success).toBe(true);
  });

  it("parses human_review condition with prompt", () => {
    const result = GateConditionSchema.safeParse({ type: "human_review", prompt: "Approve?" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown condition type", () => {
    const result = GateConditionSchema.safeParse({ type: "unknown_type", value: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects exit_code with non-integer value", () => {
    const result = GateConditionSchema.safeParse({ type: "exit_code", value: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects file_exists with empty path", () => {
    const result = GateConditionSchema.safeParse({ type: "file_exists", path: "" });
    expect(result.success).toBe(false);
  });

  it("rejects regex with empty pattern", () => {
    const result = GateConditionSchema.safeParse({
      type: "regex",
      filePath: "f.txt",
      pattern: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects regex with empty filePath", () => {
    const result = GateConditionSchema.safeParse({
      type: "regex",
      filePath: "",
      pattern: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects script with empty path", () => {
    const result = GateConditionSchema.safeParse({ type: "script", path: "" });
    expect(result.success).toBe(false);
  });

  it("rejects exit_code missing value", () => {
    const result = GateConditionSchema.safeParse({ type: "exit_code" });
    expect(result.success).toBe(false);
  });

  it("rejects file_exists missing path", () => {
    const result = GateConditionSchema.safeParse({ type: "file_exists" });
    expect(result.success).toBe(false);
  });
});

describe("ParameterConfigSchema", () => {
  it("parses string parameter", () => {
    const result = ParameterConfigSchema.safeParse({ type: "string" });
    expect(result.success).toBe(true);
  });

  it("parses number parameter with all optional fields", () => {
    const result = ParameterConfigSchema.safeParse({
      type: "number",
      description: "Max retries",
      required: true,
      default: 3,
    });
    expect(result.success).toBe(true);
  });

  it("parses boolean parameter", () => {
    const result = ParameterConfigSchema.safeParse({ type: "boolean", default: false });
    expect(result.success).toBe(true);
  });

  it("rejects invalid parameter type", () => {
    const result = ParameterConfigSchema.safeParse({ type: "array" });
    expect(result.success).toBe(false);
  });
});
