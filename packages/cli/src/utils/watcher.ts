import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 500;

export class WorkflowWatcher extends EventEmitter {
  /** Active FSWatcher instances keyed by the watched path */
  private readonly watchers = new Map<string, fs.FSWatcher>();

  /** Pending debounce timers keyed by the changed path */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * Start watching the workflow file and any additional paths.
   * Emits "change" events with { path: string } after a 500ms debounce.
   * Safe to call multiple times — deduplicates watched paths.
   */
  watch(workflowPath: string, additionalPaths?: string[]): void {
    const resolvedWorkflow = path.resolve(workflowPath);
    this._watchPath(resolvedWorkflow, false);

    if (additionalPaths) {
      for (const p of additionalPaths) {
        const resolved = path.resolve(p);
        this._watchPath(resolved, true);
      }
    }
  }

  /**
   * Stop all watchers and release resources.
   */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore errors during cleanup
      }
    }
    this.watchers.clear();

    this.removeAllListeners();
  }

  // Typed event overloads
  on(event: "change", listener: (info: { path: string }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter base overload requires any[] for catch-all event types
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit(event: "change", info: { path: string }): boolean;
  emit(event: string, ...args: unknown[]): boolean;
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _watchPath(resolved: string, isAdditional: boolean): void {
    // Idempotency — skip if already watching this path
    if (this.watchers.has(resolved)) {
      return;
    }

    // Check existence; skip silently if the path doesn't exist
    if (!fs.existsSync(resolved)) {
      return;
    }

    let isDir: boolean;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch {
      // stat failed — path may have disappeared between existsSync and statSync
      return;
    }

    // Directories are watched recursively; files are watched flat.
    // For the workflow file itself (isAdditional === false) we always treat it
    // as a file even if somehow it is a directory.
    const useRecursive = isAdditional && isDir;

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(resolved, { recursive: useRecursive }, (eventType, filename) => {
        // Determine the actual changed path
        let changedPath: string;
        if (filename !== null && filename !== undefined) {
          changedPath = isDir ? path.join(resolved, filename) : resolved;
        } else {
          changedPath = resolved;
        }

        this._scheduleChange(changedPath);
      });
    } catch (err) {
      console.warn(
        `[WorkflowWatcher] Unable to watch path "${resolved}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }

    watcher.on("error", (err) => {
      console.warn(
        `[WorkflowWatcher] Watch error on "${resolved}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      // Remove the broken watcher so a future watch() call can re-register it
      this.watchers.delete(resolved);
    });

    this.watchers.set(resolved, watcher);
  }

  private _scheduleChange(changedPath: string): void {
    const existing = this.timers.get(changedPath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(changedPath);
      this.emit("change", { path: changedPath });
    }, DEBOUNCE_MS);

    this.timers.set(changedPath, timer);
  }
}
