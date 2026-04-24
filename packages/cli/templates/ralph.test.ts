import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadWorkflow, interpolateWorkflow } from "../src/utils/workflow.js";
import { WorkflowGraphSchema } from "@sygil/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "ralph.json");

describe("ralph.json template", () => {
  it("passes workflow schema validation", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.name).toBe("ralph");
    expect(graph.version).toBe("1");
  });

  it("has exactly one node named 'worker'", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const nodeIds = Object.keys(graph.nodes);
    expect(nodeIds).toEqual(["worker"]);
  });

  it("has a single self-loop edge (worker → worker) with maxRetries >= 50", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0]!;
    expect(edge.from).toBe("worker");
    expect(edge.to).toBe("worker");
    expect(edge.isLoopBack).toBe(true);
    expect(edge.maxRetries).toBeGreaterThanOrEqual(50);
  });

  it("gate is a single script condition pointing at the bundled ralph-done.sh", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const conditions = graph.edges[0]!.gate?.conditions ?? [];
    expect(conditions).toHaveLength(1);
    const [only] = conditions;
    expect(only?.type).toBe("script");
    if (only?.type === "script") {
      expect(only.path).toBe("gates/ralph-done.sh");
    }
  });

  it("worker declares the Ralph-required tools", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const tools = graph.nodes["worker"]!.tools ?? [];
    for (const required of ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]) {
      expect(tools).toContain(required);
    }
  });

  it("worker reads and writes the `currentTask` shared-context key", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const node = graph.nodes["worker"]!;
    expect(node.readsContext).toContain("currentTask");
    expect(node.writesContext).toContain("currentTask");
  });

  it("interpolates user-supplied params and re-validates against the schema", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const interpolated = interpolateWorkflow(graph, {
      model: "opus",
      promptFile: "./MY_PROMPT.md",
      specsDir: "./my-specs",
    });
    expect(interpolated.nodes["worker"]!.model).toBe("opus");
    expect(interpolated.nodes["worker"]!.prompt).toContain("./MY_PROMPT.md");
    expect(interpolated.nodes["worker"]!.prompt).toContain("./my-specs");
    // Gate path is not a user-facing parameter — the plan filename is
    // hardcoded to fix_plan.md inside the gate script.
    const [gate] = interpolated.edges[0]!.gate?.conditions ?? [];
    expect(gate?.type).toBe("script");
    if (gate?.type === "script") {
      expect(gate.path).toBe("gates/ralph-done.sh");
    }
  });

  it("template validates against the WorkflowGraphSchema directly", async () => {
    const raw = await readFile(TEMPLATE_PATH, "utf8");
    const json = JSON.parse(raw) as unknown;
    const result = WorkflowGraphSchema.safeParse(json);
    expect(result.success).toBe(true);
  });
});
