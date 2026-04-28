import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../../src/utils/workflow.js";
import { WorkflowGraphSchema } from "@sygil/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "optimize.json");

describe("optimize.json template", () => {
  it("passes workflow schema validation", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.name).toBe("optimize");
    expect(graph.version).toBe("1");
  });

  it("has the three outer-loop nodes (propose, evaluate, score)", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const nodeIds = Object.keys(graph.nodes);
    expect(nodeIds).toContain("propose");
    expect(nodeIds).toContain("evaluate");
    expect(nodeIds).toContain("score");
    expect(nodeIds).toHaveLength(3);
  });

  it("declares workflow / evalTask / budget parameters as required", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.parameters?.["workflow"]?.required).toBe(true);
    expect(graph.parameters?.["evalTask"]?.required).toBe(true);
    expect(graph.parameters?.["budget"]?.required).toBe(true);
  });

  it("score has a loop-back edge back to propose with maxRetries and a budget gate", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const loopBack = graph.edges.find(
      (e) => e.isLoopBack && e.from === "score" && e.to === "propose",
    );
    expect(loopBack).toBeDefined();
    expect(typeof loopBack!.maxRetries).toBe("number");
    expect(loopBack!.maxRetries).toBeGreaterThan(0);

    const conditions = loopBack?.gate?.conditions ?? [];
    const scriptCondition = conditions.find((c) => c.type === "script");
    expect(scriptCondition).toBeDefined();
    expect((scriptCondition as { path: string }).path).toBe("gates/check-budget.sh");
  });

  it("propose is a Read/Grep/Glob-capable proposer node (filesystem-first)", async () => {
    // Meta-Harness Table 3: full-trace access beats summaries by ~15 accuracy pts.
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const propose = graph.nodes["propose"]!;
    expect(propose.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
  });

  it("evaluate has Bash tool (required to run nested sygil invocations)", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const evaluate = graph.nodes["evaluate"]!;
    expect(evaluate.tools).toEqual(expect.arrayContaining(["Bash"]));
  });

  it("template validates against WorkflowGraphSchema directly", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(TEMPLATE_PATH, "utf8");
    const json = JSON.parse(raw) as unknown;
    const result = WorkflowGraphSchema.safeParse(json);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("every edge endpoint references an existing node", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const nodeIds = new Set(Object.keys(graph.nodes));
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from), `edge ${edge.id} from=${edge.from}`).toBe(true);
      expect(nodeIds.has(edge.to), `edge ${edge.id} to=${edge.to}`).toBe(true);
    }
  });
});
