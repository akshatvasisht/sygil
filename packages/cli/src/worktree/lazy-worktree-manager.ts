import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Mutex } from "async-mutex";
import type { NodeConfig } from "@sygil/shared";
import { logger } from "../utils/logger.js";
import { ensureGitRepo } from "../utils/git-check.js";

const execFileAsync = promisify(execFile);

export interface LazyWorktreeInfo {
  path: string;
  nodeId: string;
  branch: string;
}

/**
 * Enhanced worktree manager with:
 * - Lazy creation via getOrCreate (worktree created on first access)
 * - Sparse checkout (only check out needed directories)
 * - Mutex-protected git worktree add/remove operations
 * - Parallel cleanup
 */
export class LazyWorktreeManager {
  private readonly baseDir: string;
  private readonly repoRoot: string;
  private readonly mutex = new Mutex();
  private readonly worktrees = new Map<string, LazyWorktreeInfo>();

  constructor(runId: string, repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
    this.baseDir = path.join(repoRoot, ".sygil", "worktrees", runId);
  }

  /**
   * Get an existing worktree path or create one lazily.
   * Returns the same path on repeated calls for the same nodeId.
   */
  async getOrCreate(nodeId: string, nodeConfig: NodeConfig, signal?: AbortSignal): Promise<string> {
    const existing = this.worktrees.get(nodeId);
    if (existing) {
      return existing.path;
    }

    return this.createSparse(nodeId, nodeConfig, signal);
  }

  /**
   * Create a sparse-checkout worktree for a node.
   * Uses the mutex to prevent concurrent git worktree add operations.
   */
  private async createSparse(nodeId: string, nodeConfig: NodeConfig, signal?: AbortSignal): Promise<string> {
    // Determine which directories to check out
    const sparseDirs = this.computeSparseDirs(nodeConfig);

    // Get current branch name
    const { stdout: branch } = await execFileAsync("git", [
      "-C", this.repoRoot, "rev-parse", "--abbrev-ref", "HEAD",
    ], { signal }).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        throw new Error(
          "Git is not installed or not available in PATH.\\n" +
          "Git worktree features require git to be installed.\\n" +
          "Install git and try again, or run without --isolate flag."
        );
      }
      throw err;
    });
    const branchName = branch.trim();
    const worktreePath = path.join(this.baseDir, nodeId);
    const wtBranch = `sygil/worktree/${nodeId}-${randomUUID()}`;

    await mkdir(path.dirname(worktreePath), { recursive: true });

    if (signal?.aborted) {
      throw new Error("Worktree creation aborted");
    }

    // Mutex-protect the worktree add operation
    const release = await this.mutex.acquire();
    try {
      await execFileAsync("git", [
        "-C", this.repoRoot,
        "worktree", "add", "--no-checkout",
        "-b", wtBranch,
        worktreePath,
        branchName,
      ], { signal });
    } finally {
      release();
    }

    // Set sparse-checkout (outside mutex — this operates on the new worktree,
    // not .git/index.lock). Sparse-checkout can take tens of seconds on large
    // mono-repos; threading the signal lets Ctrl+C kill it immediately instead
    // of blocking the cancellation path.
    await execFileAsync("git", [
      "-C", worktreePath,
      "sparse-checkout", "set", ...sparseDirs,
    ], { signal });

    // Set core.compression=0 for faster checkout
    await execFileAsync("git", [
      "-C", worktreePath,
      "config", "core.compression", "0",
    ], { signal });

    this.worktrees.set(nodeId, { path: worktreePath, nodeId, branch: wtBranch });
    return worktreePath;
  }

  /**
   * Compute the directories that need to be checked out for sparse checkout.
   * Includes the outputDir and any inputMapping source paths from incoming edges.
   */
  private computeSparseDirs(nodeConfig: NodeConfig): string[] {
    const dirs: string[] = [];

    if (nodeConfig.outputDir) {
      dirs.push(nodeConfig.outputDir);
    }

    // Always include at least the root so the worktree isn't completely empty
    if (dirs.length === 0) {
      dirs.push(".");
    }

    return dirs;
  }

  /**
   * Merge a node's worktree changes into a target branch.
   */
  async merge(nodeId: string, targetBranch: string, signal?: AbortSignal): Promise<{ conflicts: string[] }> {
    const info = this.worktrees.get(nodeId);
    if (!info) throw new Error(`No worktree for node ${nodeId}`);

    if (signal?.aborted) {
      throw new Error("Worktree merge aborted");
    }

    // Commit any changes in the worktree — operates on the node's own worktree
    // path, no `.git/index.lock` involved, so these stay outside the mutex.
    await execFileAsync("git", ["-C", info.path, "add", "-A"]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));
    await execFileAsync("git", ["-C", info.path, "commit", "-m", `sygil: node ${nodeId} output`]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));

    // Serialize main-repo merges against concurrent `worktree add` / `worktree
    // remove` and each other. Two fan-in nodes completing at once would
    // otherwise race on `.git/index.lock`; git exits 128 ("another git
    // process seems to be running"), the catch path runs `diff --diff-filter=U`
    // which returns empty (no actual unmerged files from a lock-contention
    // failure), and the caller would see `{conflicts: []}` — a silent fake
    // success with the merge not actually applied.
    const release = await this.mutex.acquire();
    try {
      try {
        await execFileAsync("git", [
          "-C", this.repoRoot,
          "merge", "--no-ff", info.branch,
          "-m", `Merge node ${nodeId} output`,
        ], { signal });
        return { conflicts: [] };
      } catch {
        const { stdout } = await execFileAsync("git", [
          "-C", this.repoRoot, "diff", "--name-only", "--diff-filter=U",
        ]).catch(() => ({ stdout: "" }));
        const conflicts = stdout.trim().split("\n").filter(Boolean);
        await execFileAsync("git", ["-C", this.repoRoot, "merge", "--abort"]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));
        return { conflicts };
      }
    } finally {
      release();
    }
  }

  /**
   * Remove a single node's worktree. Mutex-protected.
   */
  async remove(nodeId: string): Promise<void> {
    const info = this.worktrees.get(nodeId);
    if (!info) return;

    const release = await this.mutex.acquire();
    try {
      await execFileAsync("git", [
        "-C", this.repoRoot, "worktree", "remove", "--force", info.path,
      ]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));
    } finally {
      release();
    }

    await execFileAsync("git", [
      "-C", this.repoRoot, "branch", "-D", info.branch,
    ]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));

    this.worktrees.delete(nodeId);
  }

  /**
   * Clean up all created worktrees in parallel (each behind the mutex).
   * Then remove the base directory.
   */
  async cleanup(): Promise<void> {
    const nodeIds = [...this.worktrees.keys()];
    await Promise.all(
      nodeIds.map((nodeId) => this.remove(nodeId).catch((e: unknown) => logger.debug(`worktree remove failed for node ${nodeId}: ${e}`)))
    );
    await rm(this.baseDir, { recursive: true, force: true }).catch((e: unknown) => logger.debug(`worktree base directory removal failed: ${e}`));
  }
}
