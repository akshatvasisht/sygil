/**
 * Integration tests for WorktreeManager — real git operations in temp repos.
 *
 * No mocks. Each test spins up a fresh git repository in a OS temp directory,
 * exercises WorktreeManager against it, and tears the directory down afterwards.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "../worktree/index.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Initialise a minimal git repository in `dir` with a single commit so that
 * git worktree operations have a valid HEAD to branch from.
 */
async function initRepo(dir: string): Promise<void> {
  const g = (args: string[]) => execFileAsync("git", ["-C", dir, ...args]);

  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@sigil.test"]);
  await g(["config", "user.name", "Sigil Test"]);

  // Create an initial commit so HEAD exists
  await writeFile(join(dir, "README.md"), "# test repo\n", "utf8");
  await g(["add", "README.md"]);
  await g(["commit", "-m", "initial commit"]);
}

/** Returns true when `p` exists on the filesystem. */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let repoDir: string;

beforeEach(async () => {
  repoDir = join(tmpdir(), `sigil-wt-int-${randomUUID()}`);
  await execFileAsync("mkdir", ["-p", repoDir]);
  await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeManager integration", () => {
  it("creates a worktree directory at the expected path", async () => {
    const runId = randomUUID();
    const manager = new WorktreeManager(runId, repoDir);

    const worktreePath = await manager.create("nodeA");

    // Returned path must equal the canonical location
    const expectedPath = join(repoDir, ".sigil", "worktrees", runId, "nodeA");
    expect(worktreePath).toBe(expectedPath);

    // Directory must exist
    expect(await exists(worktreePath)).toBe(true);

    // A git worktree has a `.git` file (not a directory) pointing back to the
    // main repo's worktree metadata
    const gitFile = join(worktreePath, ".git");
    const gitStat = await stat(gitFile);
    // Could be a file (linked worktree) — either way it must exist
    expect(gitStat).toBeTruthy();
  });

  it("worktree branch is based on current HEAD", async () => {
    const manager = new WorktreeManager(randomUUID(), repoDir);
    const worktreePath = await manager.create("nodeA");

    // The worktree should share the initial commit from main
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "log", "--oneline"]);
    expect(stdout.trim()).toContain("initial commit");
  });

  it("worktree allows independent file creation", async () => {
    const manager = new WorktreeManager(randomUUID(), repoDir);
    const worktreePath = await manager.create("nodeA");

    const worktreeFile = join(worktreePath, "worktree-only.txt");
    await writeFile(worktreeFile, "hello from worktree", "utf8");

    // File must exist inside the worktree
    expect(await exists(worktreeFile)).toBe(true);

    // File must NOT exist in the main repo root
    const mainRepoFile = join(repoDir, "worktree-only.txt");
    expect(await exists(mainRepoFile)).toBe(false);
  });

  it("merge brings worktree changes into main branch", async () => {
    const manager = new WorktreeManager(randomUUID(), repoDir);
    const worktreePath = await manager.create("nodeA");

    // Write, stage, and commit a new file inside the worktree
    const newFile = join(worktreePath, "output.txt");
    await writeFile(newFile, "node output", "utf8");
    await execFileAsync("git", ["-C", worktreePath, "add", "output.txt"]);
    await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "add output"]);

    const result = await manager.merge("nodeA", "main");

    // Merge should have succeeded with no conflicts
    expect(result.conflicts).toEqual([]);

    // The committed file must now be present in the main repo working tree
    const mergedFile = join(repoDir, "output.txt");
    expect(await exists(mergedFile)).toBe(true);
    const content = await readFile(mergedFile, "utf8");
    expect(content).toBe("node output");
  });

  it("merge detects conflicts and returns conflict list", async () => {
    const manager = new WorktreeManager(randomUUID(), repoDir);
    const worktreePath = await manager.create("nodeA");

    // Modify README.md in the MAIN repo and commit it
    await writeFile(join(repoDir, "README.md"), "# main branch edit\n", "utf8");
    await execFileAsync("git", ["-C", repoDir, "add", "README.md"]);
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "main: modify README"]);

    // Modify README.md in the WORKTREE differently and commit it
    await writeFile(join(worktreePath, "README.md"), "# worktree branch edit\n", "utf8");
    await execFileAsync("git", ["-C", worktreePath, "add", "README.md"]);
    await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "worktree: modify README"]);

    const result = await manager.merge("nodeA", "main");

    // Conflicts must be reported and include README.md
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts).toContain("README.md");

    // The merge must have been aborted — main repo should be back to a clean state
    const { stdout: statusOut } = await execFileAsync("git", ["-C", repoDir, "status", "--porcelain"]);
    // No "UU" (unmerged) entries should remain
    expect(statusOut).not.toContain("UU");
  });

  it("remove cleans up worktree directory and branch", async () => {
    const runId = randomUUID();
    const manager = new WorktreeManager(runId, repoDir);
    const worktreePath = await manager.create("nodeA");

    // Capture the branch name before removal
    const { stdout: branchOut } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const worktreeBranch = branchOut.trim();

    await manager.remove("nodeA");

    // Worktree directory must be gone
    expect(await exists(worktreePath)).toBe(false);

    // `git worktree list` must no longer mention the worktree path
    const { stdout: listOut } = await execFileAsync("git", ["-C", repoDir, "worktree", "list"]);
    expect(listOut).not.toContain(worktreePath);

    // The sigil branch must have been deleted
    const { stdout: branchListOut } = await execFileAsync("git", ["-C", repoDir, "branch"]);
    expect(branchListOut).not.toContain(worktreeBranch);
  });

  it("cleanup removes all worktrees and the run base directory", async () => {
    const runId = randomUUID();
    const manager = new WorktreeManager(runId, repoDir);

    const pathA = await manager.create("nodeA");
    const pathB = await manager.create("nodeB");

    await manager.cleanup();

    // Both worktree directories must be gone
    expect(await exists(pathA)).toBe(false);
    expect(await exists(pathB)).toBe(false);

    // The entire <runId> base directory must be removed
    const baseDir = join(repoDir, ".sigil", "worktrees", runId);
    expect(await exists(baseDir)).toBe(false);
  });

  it("create respects AbortSignal", async () => {
    const manager = new WorktreeManager(randomUUID(), repoDir);

    const controller = new AbortController();
    // Abort before any async work begins
    controller.abort();

    await expect(manager.create("nodeA", controller.signal)).rejects.toThrow();
  });
});
