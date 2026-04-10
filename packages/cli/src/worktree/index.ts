import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { logger } from "../utils/logger.js";
import { ensureGitRepo } from "../utils/git-check.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  nodeId: string;
  branch: string;
}

export class WorktreeManager {
  private readonly baseDir: string; // .sigil/worktrees/<runId>
  private readonly repoRoot: string;
  private worktrees: Map<string, WorktreeInfo> = new Map();

  constructor(runId: string, repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
    this.baseDir = path.join(repoRoot, ".sigil", "worktrees", runId);
  }

  async create(nodeId: string, signal?: AbortSignal): Promise<string> {
    // Get current branch name
    const { stdout: branch } = await execFileAsync("git", ["-C", this.repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { signal }).catch((err: unknown) => {
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

    await mkdir(path.dirname(worktreePath), { recursive: true });

    if (signal?.aborted) {
      throw new Error("Worktree creation aborted");
    }

    // Create a new branch for this worktree
    const wtBranch = `sigil/worktree/${nodeId}-${randomUUID()}`;
    await execFileAsync("git", ["-C", this.repoRoot, "worktree", "add", "-b", wtBranch, worktreePath, branchName], { signal });

    this.worktrees.set(nodeId, { path: worktreePath, nodeId, branch: wtBranch });
    return worktreePath;
  }

  async merge(nodeId: string, targetBranch: string, signal?: AbortSignal): Promise<{ conflicts: string[] }> {
    const info = this.worktrees.get(nodeId);
    if (!info) throw new Error(`No worktree for node ${nodeId}`);

    if (signal?.aborted) {
      throw new Error("Worktree merge aborted");
    }

    // Commit any changes in the worktree
    await execFileAsync("git", ["-C", info.path, "add", "-A"]).catch((e: unknown) => logger.debug(`worktree git-add failed for node ${nodeId}: ${e}`));
    await execFileAsync("git", ["-C", info.path, "commit", "-m", `sigil: node ${nodeId} output`]).catch((e: unknown) => logger.debug(`worktree git-commit failed for node ${nodeId}: ${e}`));

    // Merge into target branch
    try {
      await execFileAsync("git", ["-C", this.repoRoot, "merge", "--no-ff", info.branch, "-m", `Merge node ${nodeId} output`], { signal });
      return { conflicts: [] };
    } catch {
      // Get conflict list
      const { stdout } = await execFileAsync("git", ["-C", this.repoRoot, "diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" }));
      const conflicts = stdout.trim().split("\n").filter(Boolean);
      // Abort the merge to restore clean state
      await execFileAsync("git", ["-C", this.repoRoot, "merge", "--abort"]).catch((e: unknown) => logger.debug(`worktree merge --abort failed: ${e}`));
      return { conflicts };
    }
  }

  async remove(nodeId: string): Promise<void> {
    const info = this.worktrees.get(nodeId);
    if (!info) return;

    await execFileAsync("git", ["-C", this.repoRoot, "worktree", "remove", "--force", info.path]).catch((e: unknown) => logger.debug(`worktree remove failed for node ${nodeId}: ${e}`));
    await execFileAsync("git", ["-C", this.repoRoot, "branch", "-D", info.branch]).catch((e: unknown) => logger.debug(`worktree branch delete failed for node ${nodeId}: ${e}`));
    this.worktrees.delete(nodeId);
  }

  async cleanup(): Promise<void> {
    for (const nodeId of this.worktrees.keys()) {
      await this.remove(nodeId).catch((e: unknown) => logger.debug(`worktree remove failed for node ${nodeId}: ${e}`));
    }
    await rm(this.baseDir, { recursive: true, force: true }).catch((e: unknown) => logger.debug(`worktree base directory removal failed: ${e}`));
  }
}
