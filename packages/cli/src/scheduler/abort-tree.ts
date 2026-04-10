/**
 * AbortTree — structured concurrency via a tree of AbortControllers.
 *
 * The root controller acts as a "kill switch" for the entire workflow.
 * Each node gets a child signal that aborts when either the root OR the
 * child's own controller aborts, enabling per-node cancellation without
 * affecting siblings.
 */

export class AbortTree {
  private root: AbortController;
  private children = new Map<string, AbortController>();

  constructor() {
    this.root = new AbortController();
  }

  /** The root signal — aborted when the entire workflow is cancelled. */
  get signal(): AbortSignal {
    return this.root.signal;
  }

  /**
   * Create a child signal linked to the root.
   * Aborts when either the root OR the child controller aborts.
   * If a child already exists for `nodeId`, it is replaced.
   */
  createChild(nodeId: string): AbortSignal {
    const child = new AbortController();
    this.children.set(nodeId, child);

    // Combine root + child: abort if either fires
    return AbortSignal.any([this.root.signal, child.signal]);
  }

  /** Abort a single node's signal without affecting siblings or root. */
  abortChild(nodeId: string): void {
    const child = this.children.get(nodeId);
    if (child) {
      child.abort();
      this.children.delete(nodeId);
    }
  }

  /** Abort the root — cascades to all children. */
  abortAll(reason?: string): void {
    this.root.abort(reason);
  }

  /** Clean up all children. */
  dispose(): void {
    this.children.clear();
  }
}
