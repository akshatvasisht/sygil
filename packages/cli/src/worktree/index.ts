import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  nodeId: string;
  branch: string;
}

/**
 * Reap orphan entries from `.git/worktrees/<name>`. `git worktree add`
 * creates the registry dir BEFORE `LazyWorktreeManager` records the entry
 * into its in-memory map; SIGINT in that window leaks a directory that
 * `cleanup()` never sees. Prune at the top of every `run`/`resume` so orphans
 * from any cause (prior Sygil crashes, external tooling, manual `rm -rf`)
 * don't pile up.
 *
 * Best-effort — non-git repos and permission errors are swallowed.
 */
export async function pruneWorktrees(repoRoot: string = process.cwd()): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "prune"]);
  } catch (e: unknown) {
    logger.debug(`worktree prune failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}
