import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../src/utils/workflow.js";
import { WorkflowGraphSchema } from "@sygil/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "tdd-feature.json");

describe("tdd-feature.json template", () => {
  it("passes workflow schema validation", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.name).toBe("tdd-feature");
    expect(graph.version).toBe("1");
  });

  it("all edge endpoints reference existing node IDs", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const nodeIds = new Set(Object.keys(graph.nodes));

    for (const edge of graph.edges) {
      expect(
        nodeIds.has(edge.from),
        `Edge "${edge.id}" references unknown source node "${edge.from}"`
      ).toBe(true);
      expect(
        nodeIds.has(edge.to),
        `Edge "${edge.id}" references unknown target node "${edge.to}"`
      ).toBe(true);
    }
  });

  it("loop-back edge has maxRetries defined", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const loopBackEdges = graph.edges.filter((e) => e.isLoopBack === true);

    expect(loopBackEdges.length).toBeGreaterThan(0);

    for (const edge of loopBackEdges) {
      expect(
        edge.maxRetries,
        `Loop-back edge "${edge.id}" is missing maxRetries`
      ).toBeDefined();
      expect(typeof edge.maxRetries).toBe("number");
    }
  });

  it("all nodes have required fields (adapter, model, role, prompt)", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);

    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      expect(node.adapter, `Node "${nodeId}" missing adapter`).toBeTruthy();
      expect(node.model, `Node "${nodeId}" missing model`).toBeTruthy();
      expect(node.role, `Node "${nodeId}" missing role`).toBeTruthy();
      expect(node.prompt, `Node "${nodeId}" missing prompt`).toBeTruthy();
    }
  });

  it("has 3 nodes: planner, implementer, reviewer", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    const nodeIds = Object.keys(graph.nodes);

    expect(nodeIds).toContain("planner");
    expect(nodeIds).toContain("implementer");
    expect(nodeIds).toContain("reviewer");
    expect(nodeIds).toHaveLength(3);
  });

  it("has 3 edges including a loop-back from reviewer to implementer", async () => {
    const graph = await loadWorkflow(TEMPLATE_PATH);
    expect(graph.edges).toHaveLength(3);

    const loopBack = graph.edges.find(
      (e) => e.isLoopBack && e.from === "reviewer" && e.to === "implementer"
    );
    expect(loopBack).toBeDefined();
    expect(loopBack?.maxRetries).toBe(2);
    expect(loopBack?.gate?.conditions[0]?.type).toBe("file_exists");
  });

  it("template validates against the WorkflowGraphSchema directly", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(TEMPLATE_PATH, "utf8");
    const json = JSON.parse(raw) as unknown;

    const result = WorkflowGraphSchema.safeParse(json);
    expect(result.success).toBe(true);
  });
});
