import type { NodeResult } from "@sygil/shared";
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

  const visiting = new Set<string>();

  function compute(nodeId: string): number {
    const cached = weights.get(nodeId);
    if (cached !== undefined) return cached;
    // Cycle guard: a forward-edge cycle (A→B→A with neither marked
    // `isLoopBack`) would cause unbounded recursion, crashing with
    // "Maximum call stack size exceeded" before the scheduler ever gets
    // to surface the malformed graph. The schema doesn't reject such
    // cycles today — only the semantic BFS for `{{nodes.<id>}}` refs is
    // cycle-safe. Treat re-entry as weight 0 so recursion terminates
    // with a finite (if approximate) priority ordering; the scheduler's
    // start-node detection then surfaces the empty ready-set as a stall.
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);

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
    visiting.delete(nodeId);
    return weight;
  }

  // Compute for all nodes (handles disconnected components)
  for (const nodeId of index.nodeIds) {
    compute(nodeId);
  }

  return weights;
}
