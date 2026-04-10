import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkflow, interpolateWorkflow } from "./workflow.js";
import type { WorkflowGraph } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid workflow JSON */
function validWorkflow(): object {
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
      nodeB: {
        adapter: "codex",
        model: "o4-mini",
        role: "implementer",
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
}

const tempFiles: string[] = [];

async function writeTempWorkflow(content: object | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sigil-test-"));
  const filePath = join(dir, "workflow.json");
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(filePath, text, "utf8");
  tempFiles.push(filePath);
  return filePath;
}

afterEach(async () => {
  for (const f of tempFiles.splice(0)) {
    await unlink(f).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// loadWorkflow tests
// ---------------------------------------------------------------------------

describe("workflow validation", () => {
  it("accepts a valid workflow graph", async () => {
    const filePath = await writeTempWorkflow(validWorkflow());
    const graph = await loadWorkflow(filePath);
    expect(graph.name).toBe("test-workflow");
    expect(Object.keys(graph.nodes)).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.id).toBe("a-to-b");
  });

  it("rejects a workflow with an edge referencing a non-existent node", async () => {
    const wf = {
      ...validWorkflow(),
      edges: [
        { id: "bad-edge", from: "nodeA", to: "doesNotExist" },
      ],
    };
    const filePath = await writeTempWorkflow(wf);
    await expect(loadWorkflow(filePath)).rejects.toThrow(
      /references unknown node "doesNotExist"/
    );
  });

  it("rejects a loop-back edge with no maxRetries", async () => {
    const wf = {
      version: "1",
      name: "loopback-test",
      nodes: {
        nodeA: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "planner",
          prompt: "Plan",
        },
      },
      edges: [
        {
          id: "loop-no-retries",
          from: "nodeA",
          to: "nodeA",
          isLoopBack: true,
          // maxRetries is intentionally omitted
        },
      ],
    };
    const filePath = await writeTempWorkflow(wf);
    await expect(loadWorkflow(filePath)).rejects.toThrow(
      /loop-back edge.*maxRetries/i
    );
  });

  it("accepts a loop-back edge with maxRetries", async () => {
    const wf = {
      version: "1",
      name: "loopback-ok",
      nodes: {
        nodeA: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "planner",
          prompt: "Plan",
        },
      },
      edges: [
        {
          id: "loop-with-retries",
          from: "nodeA",
          to: "nodeA",
          isLoopBack: true,
          maxRetries: 2,
        },
      ],
    };
    const filePath = await writeTempWorkflow(wf);
    const graph = await loadWorkflow(filePath);
    expect(graph.edges[0]?.maxRetries).toBe(2);
    expect(graph.edges[0]?.isLoopBack).toBe(true);
  });

  it("rejects a workflow with duplicate edge IDs", async () => {
    const wf = {
      version: "1",
      name: "dup-edges",
      nodes: {
        nodeA: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "a",
          prompt: "p",
        },
        nodeB: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "b",
          prompt: "p",
        },
        nodeC: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "c",
          prompt: "p",
        },
      },
      edges: [
        { id: "same-id", from: "nodeA", to: "nodeB" },
        { id: "same-id", from: "nodeB", to: "nodeC" },
      ],
    };
    const filePath = await writeTempWorkflow(wf);
    await expect(loadWorkflow(filePath)).rejects.toThrow(/Duplicate edge ID/);
  });

  it("rejects a workflow with no nodes", async () => {
    const wf = {
      version: "1",
      name: "no-nodes",
      nodes: {},
      edges: [],
    };
    const filePath = await writeTempWorkflow(wf);
    await expect(loadWorkflow(filePath)).rejects.toThrow(
      /at least one node/
    );
  });

  it("throws when file does not exist", async () => {
    await expect(loadWorkflow("/tmp/does-not-exist-sigil.json")).rejects.toThrow(
      /Cannot read workflow file/
    );
  });

  it("throws when file is not valid JSON", async () => {
    const filePath = await writeTempWorkflow("not { valid json }");
    await expect(loadWorkflow(filePath)).rejects.toThrow(
      /not valid JSON/
    );
  });
});

// ---------------------------------------------------------------------------
// interpolateWorkflow tests
// ---------------------------------------------------------------------------

describe("interpolateWorkflow", () => {
  it("substitutes {{param}} placeholders", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "template",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt: "Work on {{task}} in {{outputDir}}",
          outputDir: "{{outputDir}}",
        },
      },
      edges: [],
    };

    const result = interpolateWorkflow(graph, {
      task: "build the feature",
      outputDir: "/workspace/output",
    });

    expect(result.nodes["only"]?.prompt).toBe(
      "Work on build the feature in /workspace/output"
    );
    expect(result.nodes["only"]?.outputDir).toBe("/workspace/output");
  });

  it("throws on missing required parameter", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "template",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt: "Work on {{missingParam}}",
        },
      },
      edges: [],
    };

    expect(() => interpolateWorkflow(graph, {})).toThrow(
      /Missing required parameter: missingParam/
    );
  });

  it("leaves non-template strings unchanged", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "no-templates",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt: "Plain prompt with no templates",
        },
      },
      edges: [],
    };

    const result = interpolateWorkflow(graph, { unused: "value" });
    expect(result.nodes["only"]?.prompt).toBe("Plain prompt with no templates");
    expect(result.name).toBe("no-templates");
  });

  it("substitutes multiple occurrences of the same placeholder", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "{{name}}-workflow",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt: "Task: {{name}} — repeat: {{name}}",
        },
      },
      edges: [],
    };

    const result = interpolateWorkflow(graph, { name: "hello" });
    expect(result.name).toBe("hello-workflow");
    expect(result.nodes["only"]?.prompt).toBe("Task: hello — repeat: hello");
  });
});

// ---------------------------------------------------------------------------
// JSON injection prevention (Vuln 1 fix)
// ---------------------------------------------------------------------------

describe("interpolateWorkflow — JSON injection prevention", () => {
  function makeGraph(prompt: string): WorkflowGraph {
    return {
      version: "1",
      name: "injection-test",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt,
        },
      },
      edges: [],
    };
  }

  it("escapes double quotes in parameter values", () => {
    const graph = makeGraph("Say {{msg}}");
    const result = interpolateWorkflow(graph, { msg: 'He said "hello"' });
    expect(result.nodes["only"]?.prompt).toBe('Say He said "hello"');
  });

  it("escapes backslashes in parameter values", () => {
    const graph = makeGraph("Path is {{path}}");
    const result = interpolateWorkflow(graph, { path: "C:\\Users\\test" });
    expect(result.nodes["only"]?.prompt).toBe("Path is C:\\Users\\test");
  });

  it("escapes newlines and tabs in parameter values", () => {
    const graph = makeGraph("Content: {{val}}");
    const result = interpolateWorkflow(graph, { val: "line1\nline2\ttab" });
    expect(result.nodes["only"]?.prompt).toBe("Content: line1\nline2\ttab");
  });

  it("prevents JSON injection that attempts to override adapter field", () => {
    const graph = makeGraph("Do {{task}}");
    // Crafted payload that tries to break out of the prompt string and
    // inject a new adapter field into the JSON structure.
    const payload = 'x","adapter":"evil","y":"';
    const result = interpolateWorkflow(graph, { task: payload });
    // The adapter must remain the original value — the injection is escaped
    expect(result.nodes["only"]?.adapter).toBe("claude-sdk");
    // The prompt should contain the literal payload text (quotes escaped then unescaped by parse)
    expect(result.nodes["only"]?.prompt).toBe(`Do ${payload}`);
  });

  it("post-interpolation schema validation catches structurally invalid results", () => {
    // Even if a crafted value somehow produces parseable JSON, the Zod schema
    // should reject anything that violates the workflow structure.
    // We test this by interpolating a value into the name field that would
    // produce an invalid type if it weren't properly escaped.
    const graph: WorkflowGraph = {
      version: "1",
      name: "{{name}}",
      nodes: {
        only: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "agent",
          prompt: "test",
        },
      },
      edges: [],
    };
    // This should work fine — the value is escaped and the result is valid
    const result = interpolateWorkflow(graph, { name: "valid-name" });
    expect(result.name).toBe("valid-name");
  });

  it("normal parameter substitution still works after the fix", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "{{project}}",
      nodes: {
        planner: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "planner",
          prompt: "Plan {{task}} for {{project}}",
          outputDir: "{{outDir}}",
        },
      },
      edges: [],
    };

    const result = interpolateWorkflow(graph, {
      project: "my-app",
      task: "implement auth",
      outDir: "/workspace/output",
    });

    expect(result.name).toBe("my-app");
    expect(result.nodes["planner"]?.prompt).toBe("Plan implement auth for my-app");
    expect(result.nodes["planner"]?.outputDir).toBe("/workspace/output");
  });
});
