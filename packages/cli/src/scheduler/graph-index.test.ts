/**
 * GraphIndex tests — O(1) lookup structures for workflow graph topology.
 */
import { describe, it, expect } from "vitest";
import { GraphIndex } from "./graph-index.js";
import type { WorkflowGraph, EdgeConfig, NodeConfig, AdapterType } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk" as AdapterType,
    model: "test-model",
    role: "test role",
    prompt: "test prompt",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphIndex", () => {
  it("builds index from a sample workflow graph", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "sample",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "b-to-c", from: "B", to: "C" },
      ],
    };

    const index = new GraphIndex(graph);

    expect(index.nodeIds).toEqual(expect.arrayContaining(["A", "B", "C"]));
    expect(index.nodeIds).toHaveLength(3);
  });

  it("looks up edges by ID", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "lookup",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
      ],
    };

    const index = new GraphIndex(graph);

    const edge = index.edgeById.get("a-to-b");
    expect(edge).toBeDefined();
    expect(edge!.from).toBe("A");
    expect(edge!.to).toBe("B");

    expect(index.edgeById.get("nonexistent")).toBeUndefined();
  });

  it("looks up edges by 'from' node", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "from-lookup",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "a-to-c", from: "A", to: "C" },
        { id: "b-to-c", from: "B", to: "C" },
      ],
    };

    const index = new GraphIndex(graph);

    const fromA = index.edgesByFrom.get("A") ?? [];
    expect(fromA).toHaveLength(2);
    expect(fromA.map((e) => e.id)).toEqual(expect.arrayContaining(["a-to-b", "a-to-c"]));

    const fromB = index.edgesByFrom.get("B") ?? [];
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.id).toBe("b-to-c");

    // C has no outgoing edges
    const fromC = index.edgesByFrom.get("C") ?? [];
    expect(fromC).toHaveLength(0);
  });

  it("looks up edges by 'to' node", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "to-lookup",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-c", from: "A", to: "C" },
        { id: "b-to-c", from: "B", to: "C" },
      ],
    };

    const index = new GraphIndex(graph);

    const toC = index.edgesByTo.get("C") ?? [];
    expect(toC).toHaveLength(2);
    expect(toC.map((e) => e.id)).toEqual(expect.arrayContaining(["a-to-c", "b-to-c"]));

    // A has no incoming edges
    const toA = index.edgesByTo.get("A") ?? [];
    expect(toA).toHaveLength(0);
  });

  it("handles empty graph (no edges)", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "empty",
      nodes: {
        A: makeNodeConfig(),
      },
      edges: [],
    };

    const index = new GraphIndex(graph);

    expect(index.nodeIds).toEqual(["A"]);
    expect(index.edgeById.size).toBe(0);
    expect(index.edgesByFrom.get("A") ?? []).toHaveLength(0);
    expect(index.edgesByTo.get("A") ?? []).toHaveLength(0);
  });

  it("handles multiple edges between the same pair of nodes", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "multi-edge",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b-forward", from: "A", to: "B" },
        { id: "b-to-a-loopback", from: "B", to: "A", isLoopBack: true, maxRetries: 2 },
      ],
    };

    const index = new GraphIndex(graph);

    const fromA = index.edgesByFrom.get("A") ?? [];
    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.id).toBe("a-to-b-forward");

    const fromB = index.edgesByFrom.get("B") ?? [];
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.id).toBe("b-to-a-loopback");

    const toB = index.edgesByTo.get("B") ?? [];
    expect(toB).toHaveLength(1);
    expect(toB[0]!.id).toBe("a-to-b-forward");

    const toA = index.edgesByTo.get("A") ?? [];
    expect(toA).toHaveLength(1);
    expect(toA[0]!.id).toBe("b-to-a-loopback");

    // Both edges are retrievable by ID
    expect(index.edgeById.get("a-to-b-forward")).toBeDefined();
    expect(index.edgeById.get("b-to-a-loopback")).toBeDefined();
  });

  it("handles multiple forward edges between the same pair of nodes", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "duplicate-forward",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b-1", from: "A", to: "B" },
        { id: "a-to-b-2", from: "A", to: "B" },
      ],
    };

    const index = new GraphIndex(graph);

    const fromA = index.edgesByFrom.get("A") ?? [];
    expect(fromA).toHaveLength(2);

    const toB = index.edgesByTo.get("B") ?? [];
    expect(toB).toHaveLength(2);

    expect(index.edgeById.size).toBe(2);
  });

  it("nodes with no edges have empty edge lists", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "isolated-nodes",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
      },
      edges: [],
    };

    const index = new GraphIndex(graph);

    expect(index.nodeIds).toHaveLength(3);
    for (const nodeId of index.nodeIds) {
      expect(index.edgesByFrom.get(nodeId)).toEqual([]);
      expect(index.edgesByTo.get(nodeId)).toEqual([]);
    }
    expect(index.edgeById.size).toBe(0);
  });

  it("handles self-loop edges", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "self-loop",
      nodes: {
        A: makeNodeConfig(),
      },
      edges: [
        { id: "a-loop", from: "A", to: "A", isLoopBack: true, maxRetries: 3 },
      ],
    };

    const index = new GraphIndex(graph);

    const fromA = index.edgesByFrom.get("A") ?? [];
    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.id).toBe("a-loop");

    const toA = index.edgesByTo.get("A") ?? [];
    expect(toA).toHaveLength(1);
    expect(toA[0]!.id).toBe("a-loop");
  });
});
