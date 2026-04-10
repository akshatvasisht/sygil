import type { WorkflowGraph, EdgeConfig } from "@sigil/shared";

/**
 * Pre-indexed graph topology for O(1) edge lookups.
 *
 * Replaces linear scans like `edges.find(e => e.id === id)` with map lookups.
 */
export class GraphIndex {
  readonly edgeById: Map<string, EdgeConfig>;
  readonly edgesByFrom: Map<string, EdgeConfig[]>;
  readonly edgesByTo: Map<string, EdgeConfig[]>;
  readonly nodeIds: string[];

  constructor(graph: WorkflowGraph) {
    this.nodeIds = Object.keys(graph.nodes);
    this.edgeById = new Map<string, EdgeConfig>();
    this.edgesByFrom = new Map<string, EdgeConfig[]>();
    this.edgesByTo = new Map<string, EdgeConfig[]>();

    // Initialize empty arrays for every node
    for (const nodeId of this.nodeIds) {
      this.edgesByFrom.set(nodeId, []);
      this.edgesByTo.set(nodeId, []);
    }

    // Index all edges
    for (const edge of graph.edges) {
      this.edgeById.set(edge.id, edge);

      const fromList = this.edgesByFrom.get(edge.from);
      if (fromList) {
        fromList.push(edge);
      }

      const toList = this.edgesByTo.get(edge.to);
      if (toList) {
        toList.push(edge);
      }
    }
  }
}
