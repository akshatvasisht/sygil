import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Mutex } from "async-mutex";
import type { NodeConfig } from "@sygil/shared";
import { SygilErrorCode } from "@sygil/shared";
import { logger } from "../utils/logger.js";
import { isContainedIn } from "../gates/index.js";

const execFileAsync = promisify(execFile);

/**
 * True when an error came from an aborted operation — either a child-process
 * `AbortError` (raised by execFile when its `signal` fires) or the workflow's
 * signal having flipped to `aborted`. Used to distinguish cancellation (must
 * propagate) from ordinary git failures (lock contention, real conflicts).
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

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
   *
   * `inputSourceDirs` are repo-relative directories holding files this node
   * READS via incoming-edge `inputMapping` contracts. They're added to the
   * sparse-checkout set so the node doesn't hit "file not found" at runtime.
   */
  async getOrCreate(
    nodeId: string,
    nodeConfig: NodeConfig,
    signal?: AbortSignal,
    inputSourceDirs?: string[]
  ): Promise<string> {
    const existing = this.worktrees.get(nodeId);
    if (existing) {
      return existing.path;
    }

    return this.createSparse(nodeId, nodeConfig, signal, inputSourceDirs);
  }

  /**
   * Create a sparse-checkout worktree for a node.
   * Uses the mutex to prevent concurrent git worktree add operations.
   */
  private async createSparse(
    nodeId: string,
    nodeConfig: NodeConfig,
    signal?: AbortSignal,
    inputSourceDirs?: string[]
  ): Promise<string> {
    // Determine which directories to check out
    const sparseDirs = this.computeSparseDirs(nodeConfig, inputSourceDirs);

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
   *
   * `inputSourceDirs` come from the scheduler, which resolves each incoming
   * edge's `inputMapping` source file to the directory containing it. They may
   * be absolute (resolved against a predecessor's outputDir) or repo-relative;
   * either way we normalise to a repo-relative path and drop anything that
   * escapes the repo boundary — sparse-checkout patterns must stay inside the
   * repo, and staging an out-of-tree path is both useless and a containment hole.
   */
  private computeSparseDirs(nodeConfig: NodeConfig, inputSourceDirs?: string[]): string[] {
    const dirs = new Set<string>();

    if (nodeConfig.outputDir) {
      dirs.add(nodeConfig.outputDir);
    }

    for (const src of inputSourceDirs ?? []) {
      const rel = this.toContainedRepoRelative(src);
      if (rel) dirs.add(rel);
    }

    // Always include at least the root so the worktree isn't completely empty
    if (dirs.size === 0) {
      dirs.add(".");
    }

    return [...dirs];
  }

  /**
   * Normalise a path (absolute or repo-relative) to a repo-relative,
   * forward-slash directory inside the repo. Returns undefined when the path
   * escapes the repo boundary — those are dropped from the sparse set rather
   * than checked out, matching the path-containment contract used by gates.
   */
  private toContainedRepoRelative(p: string): string | undefined {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.repoRoot, p);
    if (!isContainedIn(abs, this.repoRoot)) return undefined;
    const rel = path.relative(this.repoRoot, abs);
    // Empty rel means the repo root itself → ".".
    if (rel === "" || rel === ".") return ".";
    // Guard against traversal that survived (defensive — isContainedIn already
    // rejects escapes, but normalise removes any "./" noise).
    if (rel.startsWith("..")) return undefined;
    return rel.split(path.sep).join("/");
  }

  /**
   * Merge a node's worktree changes into a target branch.
   */
  async merge(
    nodeId: string,
    targetBranch: string,
    signal?: AbortSignal
  ): Promise<{ conflicts: string[]; errorCode?: SygilErrorCode }> {
    const info = this.worktrees.get(nodeId);
    if (!info) throw new Error(`No worktree for node ${nodeId}`);

    if (signal?.aborted) {
      throw new Error("Worktree merge aborted");
    }

    // Commit any changes in the worktree — operates on the node's own worktree
    // path, no `.git/index.lock` involved, so these stay outside the mutex.
    // Thread the signal so workflow cancel can interrupt staging/commit too,
    // matching the merge op below.
    await execFileAsync("git", ["-C", info.path, "add", "-A"], { signal }).catch((e: unknown) => {
      if (isAbortError(e, signal)) throw e;
      logger.debug(`worktree git op failed: ${e}`);
    });
    await execFileAsync("git", ["-C", info.path, "commit", "-m", `sygil: node ${nodeId} output`], { signal }).catch((e: unknown) => {
      if (isAbortError(e, signal)) throw e;
      logger.debug(`worktree git op failed: ${e}`);
    });

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
      } catch (mergeErr) {
        // A cancelled merge must not be misreported as a (fake) clean
        // `{conflicts: []}` — propagate the abort instead.
        if (isAbortError(mergeErr, signal)) throw mergeErr;
        const { stdout } = await execFileAsync("git", [
          "-C", this.repoRoot, "diff", "--name-only", "--diff-filter=U",
        ]).catch(() => ({ stdout: "" }));
        const conflicts = stdout.trim().split("\n").filter(Boolean);
        await execFileAsync("git", ["-C", this.repoRoot, "merge", "--abort"], { signal }).catch((e: unknown) => {
          if (isAbortError(e, signal)) throw e;
          logger.debug(`worktree git op failed: ${e}`);
        });
        // Tag genuine conflicts with the structured code so callers can branch
        // on it. Lock-contention failures yield no unmerged files (empty
        // `conflicts`) and are deliberately left uncoded — they're retryable
        // backpressure, not a real merge conflict.
        if (conflicts.length > 0) {
          return { conflicts, errorCode: SygilErrorCode.WORKTREE_MERGE_CONFLICT };
        }
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
