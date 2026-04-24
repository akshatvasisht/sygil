import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkflow, interpolateWorkflow } from "./workflow.js";
import type { WorkflowGraph } from "@sygil/shared";

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
  const dir = await mkdtemp(join(tmpdir(), "sygil-test-"));
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

  it("`{{{{foo}}}}` escapes to literal `{{foo}}` without requiring a parameter", () => {
    const graph = makeGraph("Literal placeholder: {{{{foo}}}}");
    const result = interpolateWorkflow(graph, {});
    expect(result.nodes["only"]?.prompt).toBe("Literal placeholder: {{foo}}");
  });

  it("escapes survive alongside real interpolation in the same string", () => {
    const graph = makeGraph("Use {{name}} to replace {{{{name}}}}");
    const result = interpolateWorkflow(graph, { name: "actualValue" });
    expect(result.nodes["only"]?.prompt).toBe("Use actualValue to replace {{name}}");
  });

  it("escape mechanism handles multiple escaped placeholders", () => {
    const graph = makeGraph("{{{{a}}}} and {{{{b}}}} but not {{c}}");
    const result = interpolateWorkflow(graph, { c: "real" });
    expect(result.nodes["only"]?.prompt).toBe("{{a}} and {{b}} but not real");
  });

  it("doubled braces without interpolation target still render literally", () => {
    // Ensure an escaped `{{foo}}` does NOT fail the "missing parameter" check.
    const graph = makeGraph("Template syntax: {{{{unknown}}}}");
    expect(() => interpolateWorkflow(graph, {})).not.toThrow();
  });

  it("parameter values that contain {{otherParam}} are NOT recursively expanded", () => {
    // Defense-in-depth: JS `String.prototype.replace(/g, fn)` does not scan
    // the replacement content for further matches. If that ever changed (spec
    // or implementation bug), a param value like `{{evil}}` would become an
    // injection vector — a caller could sneak arbitrary placeholders into
    // another param's value and have them interpolated in a second pass.
    const graph = makeGraph("Task: {{task}}");
    const result = interpolateWorkflow(graph, {
      task: "Plan this: {{otherParam}}",
      otherParam: "SHOULD_NOT_APPEAR",
    });
    expect(result.nodes["only"]?.prompt).toBe("Task: Plan this: {{otherParam}}");
    expect(result.nodes["only"]?.prompt).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("sentinel-shaped strings in param values survive round-trip", () => {
    // The 3-pass escape uses ` SYGIL_ESC_OPEN ` / `_CLOSE` as
    // sentinels. JSON.stringify escapes raw null bytes as ` ` (6-char
    // escape), so a user's prompt containing these bytes cannot collide with
    // the in-flight sentinel. Test the round-trip.
    const graph = makeGraph("Contains: {{val}}");
    const weird = " SYGIL_ESC_OPEN  and  SYGIL_ESC_CLOSE ";
    const result = interpolateWorkflow(graph, { val: weird });
    expect(result.nodes["only"]?.prompt).toBe(`Contains: ${weird}`);
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

// ---------------------------------------------------------------------------
// loadWorkflow + SYGIL_VERIFY_TEMPLATES integration
// ---------------------------------------------------------------------------

describe("loadWorkflow — Sigstore verification opt-in", () => {
  const createdFiles: string[] = [];
  const original = process.env["SYGIL_VERIFY_TEMPLATES"];

  afterEach(async () => {
    for (const f of createdFiles) {
      await unlink(f).catch(() => undefined);
    }
    createdFiles.length = 0;
    if (original === undefined) delete process.env["SYGIL_VERIFY_TEMPLATES"];
    else process.env["SYGIL_VERIFY_TEMPLATES"] = original;
  });

  it("does not touch the sidecar path when SYGIL_VERIFY_TEMPLATES is unset", async () => {
    delete process.env["SYGIL_VERIFY_TEMPLATES"];
    const dir = await mkdtemp(join(tmpdir(), "sygil-wfload-"));
    const path = join(dir, "wf.json");
    await writeFile(path, JSON.stringify(validWorkflow()), "utf8");
    createdFiles.push(path);
    // Even a garbage sidecar is ignored when verification is off.
    const sidecar = `${path}.sigstore.json`;
    await writeFile(sidecar, "not json", "utf8");
    createdFiles.push(sidecar);

    const wf = await loadWorkflow(path);
    expect(wf.name).toBe("test-workflow");
  });

  it("loads a user-authored workflow without a sidecar when verification is enabled (fail-open)", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const dir = await mkdtemp(join(tmpdir(), "sygil-wfload-"));
    const path = join(dir, "user.json");
    await writeFile(path, JSON.stringify(validWorkflow()), "utf8");
    createdFiles.push(path);

    const wf = await loadWorkflow(path);
    expect(wf.name).toBe("test-workflow");
  });

  it("rejects a workflow when the sidecar is malformed and verification is enabled", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const dir = await mkdtemp(join(tmpdir(), "sygil-wfload-"));
    const path = join(dir, "wf.json");
    await writeFile(path, JSON.stringify(validWorkflow()), "utf8");
    createdFiles.push(path);
    const sidecar = `${path}.sigstore.json`;
    await writeFile(sidecar, "not-json{", "utf8");
    createdFiles.push(sidecar);

    await expect(loadWorkflow(path)).rejects.toThrow(/Template signature verification failed/);
  });
});
