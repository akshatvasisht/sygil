import type { EdgeConfig } from "@sygil/shared";

/**
 * Kahn's algorithm topological sort for display ordering.
 *
 * Loop-back edges are excluded so cycle-participating nodes still produce a
 * total order. Falls back to the input `nodeIds` order when the graph has
 * cycles or disconnected components (display path must never throw). O(V+E)
 * via an explicit adjacency map.
 *
 * Not the scheduler's execution order — the scheduler uses a ready-queue keyed
 * on critical-path weight (see `scheduler/critical-path.ts`). This helper is
 * for CLI / monitor display only.
 */
export function topoSort(nodeIds: string[], edges: EdgeConfig[]): string[] {
  const forwardEdges = edges.filter((e) => !e.isLoopBack);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of forwardEdges) {
    const current = inDegree.get(edge.to);
    if (current !== undefined) {
      inDegree.set(edge.to, current + 1);
    }
    adjacency.get(edge.from)?.push(edge.to);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const deg = inDegree.get(neighbor);
      if (deg !== undefined) {
        const next = deg - 1;
        inDegree.set(neighbor, next);
        if (next === 0) queue.push(neighbor);
      }
    }
  }

  if (sorted.length < nodeIds.length) {
    for (const id of nodeIds) {
      if (!sorted.includes(id)) sorted.push(id);
    }
  }

  return sorted;
}
