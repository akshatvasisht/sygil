/**
 * CheckpointManager — debounced, coalesced, background checkpoint writes.
 *
 * Replaces the scheduler's synchronous checkpoint() method with:
 * - Trailing-edge debounce (default 100ms) so rapid markDirty calls coalesce
 * - Background writes that don't block the caller
 * - mkdir called only once (cached flag)
 * - Per-node result files for incremental persistence
 * - Static loadState() to reconstruct state from main + per-node files
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunState, NodeResult } from "@sygil/shared";
import { logger } from "../utils/logger.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

/** Default debounce window in milliseconds. */
export const CHECKPOINT_DEBOUNCE_MS = 100;

interface PendingNodeResult {
  runId: string;
  nodeId: string;
  result: NodeResult;
}

export class CheckpointManager {
  /** Number of times mkdir has been called (exposed for testing). */
  mkdirCallCount = 0;

  /** The last write error, if any. */
  lastError: Error | undefined;

  private readonly baseDir: string;
  private readonly debounceMs: number;
  private onWriteSuccess: (() => void) | null = null;
  private dirCreated = false;
  private dirty = false;
  private pendingState: WorkflowRunState | null = null;
  private pendingNodeResults: PendingNodeResult[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private writeInFlight: Promise<void> = Promise.resolve();

  constructor(baseDir: string, debounceMs = CHECKPOINT_DEBOUNCE_MS) {
    this.baseDir = baseDir;
    this.debounceMs = debounceMs;
  }

  /**
   * Register a callback that fires once per successful background/flush write.
   * Used by the Prometheus exporter to increment a write counter.
   * At most one listener is supported; setting a new one replaces the previous.
   */
  setWriteListener(listener: (() => void) | null): void {
    this.onWriteSuccess = listener;
  }

  /**
   * Mark the run state as dirty — triggers a debounced write.
   * Does NOT return a promise; the write happens in the background.
   */
  markDirty(state: WorkflowRunState): void {
    // Deep-copy to capture the current snapshot
    this.pendingState = JSON.parse(JSON.stringify(state)) as WorkflowRunState;
    this.dirty = true;
    this.scheduleWrite();
  }

  /**
   * Queue a per-node result for writing. Written on next flush or debounce.
   */
  markNodeResult(runId: string, nodeId: string, result: NodeResult): void {
    this.pendingNodeResults.push({
      runId,
      nodeId,
      result: JSON.parse(JSON.stringify(result)) as NodeResult,
    });
    this.dirty = true;
    this.scheduleWrite();
  }

  /**
   * Returns the last write error, if any.
   */
  getLastError(): Error | undefined {
    return this.lastError;
  }

  /**
   * Immediately write all pending state. Cancels any pending debounce timer.
   * Use at workflow end or graceful shutdown.
   */
  async flush(): Promise<void> {
    this.cancelTimer();
    // Wait for any in-flight debounced write to finish first
    await this.writeInFlight;
    await this.writePending();

    if (this.lastError) {
      logger.debug(`[CheckpointManager] flush completed with prior write error: ${this.lastError.message}`);
    }
  }

  /**
   * Wait for any in-flight background write to complete.
   * Useful in tests after advancing fake timers.
   */
  async waitForWrite(): Promise<void> {
    await this.writeInFlight;
  }

  /**
   * Cancel any pending debounce timer and mark as disposed.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /**
   * Reconstruct a full WorkflowRunState from the main state file
   * plus any per-node result files.
   */
  static async loadState(baseDir: string, runId: string): Promise<WorkflowRunState> {
    const runsDir = join(baseDir, ".sygil", "runs");
    const mainFilePath = join(runsDir, `${runId}.json`);
    const raw = await readFile(mainFilePath, "utf8");
    const state = JSON.parse(raw) as WorkflowRunState;

    // Merge per-node result files if they exist
    const nodesDir = join(runsDir, runId, "nodes");
    try {
      const files = await readdir(nodesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const nodeId = file.slice(0, -5); // strip .json
        const nodeRaw = await readFile(join(nodesDir, file), "utf8");
        const nodeResult = JSON.parse(nodeRaw) as NodeResult;
        state.nodeResults[nodeId] = nodeResult;
      }
    } catch {
      // No nodes directory — that's fine, all results are inline
    }

    return state;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleWrite(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.debounceTimer = setTimeout(() => {
      this.writeInFlight = this.writePending();
    }, this.debounceMs);
    // Don't keep the process alive waiting for a debounced checkpoint write —
    // matches the pattern at websocket.ts:297 / metrics-aggregator.ts / event-
    // fanout.ts. The workflow's `flush()` path explicitly awaits the pending
    // write, so callers that care about durability still block correctly.
    this.debounceTimer.unref?.();
  }

  private cancelTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(dir, { recursive: true });
    this.mkdirCallCount++;
    this.dirCreated = true;
  }

  private async writePending(): Promise<void> {
    if (!this.dirty) return;

    const state = this.pendingState;
    const nodeResults = [...this.pendingNodeResults];
    this.pendingNodeResults = [];
    this.dirty = false;

    try {
      const runsDir = join(this.baseDir, ".sygil", "runs");
      await this.ensureDir(runsDir);

      // Write main state file (compact JSON — no pretty-printing). Atomic via
      // write-to-tmp + rename so a crash mid-write leaves the previous
      // checkpoint intact rather than producing a truncated file that
      // `resume` can't parse.
      if (state) {
        const filePath = join(runsDir, `${state.id}.json`);
        await writeFileAtomic(filePath, JSON.stringify(state));
      }

      // Write per-node result files (also atomic).
      for (const { runId, nodeId, result } of nodeResults) {
        const nodesDir = join(runsDir, runId, "nodes");
        await mkdir(nodesDir, { recursive: true });
        const nodeFilePath = join(nodesDir, `${nodeId}.json`);
        await writeFileAtomic(nodeFilePath, JSON.stringify(result));
      }

      this.lastError = undefined;
      this.onWriteSuccess?.();
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      // Re-queue the failed batch so a subsequent flush()/markDirty() retries.
      // Without this, a transient write failure (ENOSPC, EPERM, temporary EBUSY)
      // silently drops in-flight checkpoint data: the sync prologue already
      // cleared `pendingNodeResults` and set `dirty = false`, so flush()'s
      // early-return on `!this.dirty` would bypass the retry path entirely.
      // `pendingState` is intentionally NOT restored: a newer markDirty() that
      // arrived during the await has already overwritten it with a fresher
      // snapshot, which is what we want to write next.
      if (nodeResults.length > 0) {
        this.pendingNodeResults.unshift(...nodeResults);
      }
      this.dirty = true;
    }
  }
}
