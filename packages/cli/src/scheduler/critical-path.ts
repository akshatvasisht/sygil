import type { NodeResult } from "@sigil/shared";
import type { GraphIndex } from "./graph-index.js";

/** Default node weight when no historical duration is available. */
const DEFAULT_NODE_WEIGHT = 1;

/**
 * Compute the critical-path weight for every node in the graph.
 *
 * The weight of a node is defined as:
 *   weight(n) = nodeWeight(n) + max(weight(successor) for each forward successor)
 *
 * Terminal nodes (no forward outgoing edges) have weight equal to their own
 * nodeWeight. nodeWeight comes from `historicalResults[nodeId].durationMs` if
 * available, otherwise {@link DEFAULT_NODE_WEIGHT}.
 *
 * Loop-back edges are excluded — only forward edges contribute to the DAG
 * critical path.
 */
export function computeCriticalPathWeights(
  index: GraphIndex,
  historicalResults?: Record<string, NodeResult>
): Map<string, number> {
  const weights = new Map<string, number>();

  function getNodeWeight(nodeId: string): number {
    const result = historicalResults?.[nodeId];
    return result?.durationMs ?? DEFAULT_NODE_WEIGHT;
  }

  function compute(nodeId: string): number {
    const cached = weights.get(nodeId);
    if (cached !== undefined) return cached;

    const outgoing = index.edgesByFrom.get(nodeId) ?? [];
    // Only consider forward edges
    const forwardEdges = outgoing.filter((e) => !e.isLoopBack);

    let maxSuccessorWeight = 0;
    for (const edge of forwardEdges) {
      const successorWeight = compute(edge.to);
      if (successorWeight > maxSuccessorWeight) {
        maxSuccessorWeight = successorWeight;
      }
    }

    const weight = getNodeWeight(nodeId) + maxSuccessorWeight;
    weights.set(nodeId, weight);
    return weight;
  }

  // Compute for all nodes (handles disconnected components)
  for (const nodeId of index.nodeIds) {
    compute(nodeId);
  }

  return weights;
}
