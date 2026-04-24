/**
 * Critical-path weight computation tests.
 *
 * The critical-path weight of a node is the longest path (by weight) from that
 * node to any terminal node. Terminal nodes have weight 1 (or their historical
 * duration). Nodes with no forward successors are terminals.
 */
import { describe, it, expect } from "vitest";
import { computeCriticalPathWeights } from "./critical-path.js";
import { GraphIndex } from "./graph-index.js";
import type { WorkflowGraph, NodeConfig, NodeResult } from "@sygil/shared";
import { makeNodeConfig } from "./__test-helpers__.js";

const DEFAULT_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCriticalPathWeights", () => {
  it("linear chain A->B->C: A=3, B=2, C=1", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "linear",
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
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("A")).toBe(3);
    expect(weights.get("B")).toBe(2);
    expect(weights.get("C")).toBe(1);
  });

  it("diamond graph: longer path gets higher weight", () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    // A->B->D and A->C->D
    // All default weight 1.
    // D=1, B=2, C=2, A=3
    const graph: WorkflowGraph = {
      version: "1",
      name: "diamond",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
        D: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "a-to-c", from: "A", to: "C" },
        { id: "b-to-d", from: "B", to: "D" },
        { id: "c-to-d", from: "C", to: "D" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("D")).toBe(1);
    expect(weights.get("B")).toBe(2);
    expect(weights.get("C")).toBe(2);
    expect(weights.get("A")).toBe(3);
  });

  it("asymmetric diamond: longer path dominates", () => {
    //   A
    //  / \
    // B   C
    // |   |
    // D   |
    //  \ /
    //   E
    // A->B->D->E (length 4) and A->C->E (length 3)
    // E=1, D=2, C=2, B=3, A=4
    const graph: WorkflowGraph = {
      version: "1",
      name: "asymmetric-diamond",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
        D: makeNodeConfig(),
        E: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "a-to-c", from: "A", to: "C" },
        { id: "b-to-d", from: "B", to: "D" },
        { id: "d-to-e", from: "D", to: "E" },
        { id: "c-to-e", from: "C", to: "E" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("E")).toBe(1);
    expect(weights.get("D")).toBe(2);
    expect(weights.get("C")).toBe(2);
    expect(weights.get("B")).toBe(3);
    expect(weights.get("A")).toBe(4);
  });

  it("with historical durations: weights reflect actual times", () => {
    // A->B->C, historical durations: A=10ms, B=50ms, C=5ms
    // C weight = 5, B weight = 5+50 = 55, A weight = 55+10 = 65
    const graph: WorkflowGraph = {
      version: "1",
      name: "historical",
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

    const historicalResults: Record<string, NodeResult> = {
      A: { output: "", exitCode: 0, durationMs: 10 },
      B: { output: "", exitCode: 0, durationMs: 50 },
      C: { output: "", exitCode: 0, durationMs: 5 },
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index, historicalResults);

    expect(weights.get("C")).toBe(5);
    expect(weights.get("B")).toBe(55);
    expect(weights.get("A")).toBe(65);
  });

  it("mixed historical and default weights", () => {
    // A->B->C, only B has historical duration of 100ms
    // C=1 (default), B=1+100=101, A=101+1=102
    const graph: WorkflowGraph = {
      version: "1",
      name: "mixed",
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

    const historicalResults: Record<string, NodeResult> = {
      B: { output: "", exitCode: 0, durationMs: 100 },
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index, historicalResults);

    expect(weights.get("C")).toBe(1);
    expect(weights.get("B")).toBe(101);
    expect(weights.get("A")).toBe(102);
  });

  it("single node: weight is 1", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "single",
      nodes: {
        A: makeNodeConfig(),
      },
      edges: [],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("A")).toBe(1);
  });

  it("ignores loop-back edges when computing weights", () => {
    // A->B with a loop-back B->B. Only forward edges count.
    // B=1, A=2
    const graph: WorkflowGraph = {
      version: "1",
      name: "loopback",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "b-loop", from: "B", to: "B", isLoopBack: true, maxRetries: 3 },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("A")).toBe(2);
    expect(weights.get("B")).toBe(1);
  });

  it("all equal weights: linear chain of 5 nodes", () => {
    // A->B->C->D->E, all default weight 1
    // E=1, D=2, C=3, B=4, A=5
    const graph: WorkflowGraph = {
      version: "1",
      name: "equal-weights",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
        D: makeNodeConfig(),
        E: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "b-to-c", from: "B", to: "C" },
        { id: "c-to-d", from: "C", to: "D" },
        { id: "d-to-e", from: "D", to: "E" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("E")).toBe(1);
    expect(weights.get("D")).toBe(2);
    expect(weights.get("C")).toBe(3);
    expect(weights.get("B")).toBe(4);
    expect(weights.get("A")).toBe(5);
  });

  it("very deep chain (12 nodes)", () => {
    const nodeNames = Array.from({ length: 12 }, (_, i) => `N${i}`);
    const nodes: Record<string, NodeConfig> = {};
    for (const name of nodeNames) {
      nodes[name] = makeNodeConfig();
    }

    const edges = [];
    for (let i = 0; i < nodeNames.length - 1; i++) {
      edges.push({ id: `e${i}`, from: nodeNames[i]!, to: nodeNames[i + 1]! });
    }

    const graph: WorkflowGraph = {
      version: "1",
      name: "deep-chain",
      nodes,
      edges,
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    // N11 (terminal) = 1, N10 = 2, ..., N0 = 12
    for (let i = 0; i < 12; i++) {
      expect(weights.get(nodeNames[i]!)).toBe(12 - i);
    }
  });

  it("disconnected components: each component computed independently", () => {
    // A->B (component 1), C (standalone, component 2)
    const graph: WorkflowGraph = {
      version: "1",
      name: "disconnected",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
        C: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
      ],
    };

    const index = new GraphIndex(graph);
    const weights = computeCriticalPathWeights(index);

    expect(weights.get("A")).toBe(2);
    expect(weights.get("B")).toBe(1);
    expect(weights.get("C")).toBe(1);
  });

  // Regression where a forward-edge cycle (unmarked isLoopBack)
  // would recurse unboundedly and crash with "Maximum call stack size
  // exceeded" before the scheduler could start. The schema doesn't reject
  // such cycles explicitly, so the priority-weight routine must terminate
  // on any input and let the scheduler's start-node detection surface the
  // malformed graph.
  it("terminates on a forward-edge cycle without stack overflow", () => {
    const graph: WorkflowGraph = {
      version: "1",
      name: "cycle",
      nodes: {
        A: makeNodeConfig(),
        B: makeNodeConfig(),
      },
      edges: [
        { id: "a-to-b", from: "A", to: "B" },
        { id: "b-to-a", from: "B", to: "A" }, // unmarked forward back-edge
      ],
    };

    const index = new GraphIndex(graph);
    // Should not throw. Weights are finite (approximate, but terminating).
    const weights = computeCriticalPathWeights(index);
    expect(weights.get("A")).toBe(DEFAULT_WEIGHT + DEFAULT_WEIGHT); // A + max(B=1)
    expect(weights.get("B")).toBeGreaterThanOrEqual(1);
    expect(weights.size).toBe(2);
  });
});
