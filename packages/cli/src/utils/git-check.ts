/**
 * Git availability check — provides user-friendly error messages when git is not installed
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let gitAvailableCache: boolean | null = null;

/**
 * Check if git is installed and available in PATH.
 * Caches the result after first check.
 * Throws a user-friendly error if git is not available.
 */
export async function ensureGitAvailable(): Promise<void> {
  // Skip check in test environment
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true") {
    return;
  }

  if (gitAvailableCache !== null) {
    if (!gitAvailableCache) {
      throw new Error(
        "Git is not installed or not available in PATH.\\n" +
        "Git worktree features require git to be installed.\\n" +
        "Install git and try again, or run without --isolate flag."
      );
    }
    return;
  }

  try {
    await execFileAsync("git", ["--version"]);
    gitAvailableCache = true;
  } catch (err) {
    gitAvailableCache = false;
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Git is not installed or not available in PATH.\\n` +
      `Error: ${errMsg}\\n` +
      `Git worktree features require git to be installed.\\n` +
      `Install git and try again, or run without --isolate flag.`
    );
  }
}

/**
 * Check if the current directory is a git repository.
 * Throws a user-friendly error if not in a git repo.
 */
export async function ensureGitRepo(cwd: string = process.cwd()): Promise<void> {
  await ensureGitAvailable();

  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-dir"]);
  } catch {
    throw new Error(
      `Not a git repository: ${cwd}\\n` +
      `Git worktree features require running from within a git repository.\\n` +
      `Initialize a git repo with "git init" or run without --isolate flag.`
    );
  }
}
