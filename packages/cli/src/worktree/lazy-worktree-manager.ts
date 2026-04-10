import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { NodeConfig } from "@sigil/shared";
import { WorktreeMutex } from "./worktree-mutex.js";
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
  private readonly mutex = new WorktreeMutex();
  private readonly worktrees = new Map<string, LazyWorktreeInfo>();

  constructor(runId: string, repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
    this.baseDir = path.join(repoRoot, ".sigil", "worktrees", runId);
  }

  /**
   * Get an existing worktree path or create one lazily.
   * Returns the same path on repeated calls for the same nodeId.
   */
  async getOrCreate(nodeId: string, nodeConfig: NodeConfig): Promise<string> {
    const existing = this.worktrees.get(nodeId);
    if (existing) {
      return existing.path;
    }

    return this.createSparse(nodeId, nodeConfig);
  }

  /**
   * Create a sparse-checkout worktree for a node.
   * Uses the mutex to prevent concurrent git worktree add operations.
   */
  private async createSparse(nodeId: string, nodeConfig: NodeConfig): Promise<string> {
    // Determine which directories to check out
    const sparseDirs = this.computeSparseDirs(nodeConfig);

    // Get current branch name
    const { stdout: branch } = await execFileAsync("git", [
      "-C", this.repoRoot, "rev-parse", "--abbrev-ref", "HEAD",
    ]).catch((err: unknown) => {
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
    const wtBranch = `sigil/worktree/${nodeId}-${randomUUID()}`;

    await mkdir(path.dirname(worktreePath), { recursive: true });

    // Mutex-protect the worktree add operation
    const release = await this.mutex.acquire();
    try {
      await execFileAsync("git", [
        "-C", this.repoRoot,
        "worktree", "add", "--no-checkout",
        "-b", wtBranch,
        worktreePath,
        branchName,
      ]);
    } finally {
      release();
    }

    // Set sparse-checkout (outside mutex — this operates on the new worktree, not .git/index.lock)
    await execFileAsync("git", [
      "-C", worktreePath,
      "sparse-checkout", "set", ...sparseDirs,
    ]);

    // Set core.compression=0 for faster checkout
    await execFileAsync("git", [
      "-C", worktreePath,
      "config", "core.compression", "0",
    ]);

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
  async merge(nodeId: string, targetBranch: string): Promise<{ conflicts: string[] }> {
    const info = this.worktrees.get(nodeId);
    if (!info) throw new Error(`No worktree for node ${nodeId}`);

    // Commit any changes in the worktree
    await execFileAsync("git", ["-C", info.path, "add", "-A"]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));
    await execFileAsync("git", ["-C", info.path, "commit", "-m", `sigil: node ${nodeId} output`]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));

    // Merge into target branch
    try {
      await execFileAsync("git", [
        "-C", this.repoRoot,
        "merge", "--no-ff", info.branch,
        "-m", `Merge node ${nodeId} output`,
      ]);
      return { conflicts: [] };
    } catch {
      const { stdout } = await execFileAsync("git", [
        "-C", this.repoRoot, "diff", "--name-only", "--diff-filter=U",
      ]).catch(() => ({ stdout: "" }));
      const conflicts = stdout.trim().split("\n").filter(Boolean);
      await execFileAsync("git", ["-C", this.repoRoot, "merge", "--abort"]).catch((e: unknown) => logger.debug(`worktree git op failed: ${e}`));
      return { conflicts };
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
