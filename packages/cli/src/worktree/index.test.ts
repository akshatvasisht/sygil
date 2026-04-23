import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- promisify wraps execFile with a non-generic callback signature that vi.fn can't type precisely
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockRm = rm as ReturnType<typeof vi.fn>;

import { WorktreeManager, pruneWorktrees } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make execFile resolve with the given stdout for all calls.
 * promisify(execFile) calls the underlying execFile with a Node-style callback
 * as the last argument; we need to invoke that callback ourselves.
 */
function makeExecFileResolve(stdout: string, stderr = "") {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: null,
      result: { stdout: string; stderr: string }
    ) => void;
    cb(null, { stdout, stderr });
  });
}

/**
 * Make execFile reject with an error for the NEXT call only, then fall back
 * to resolving with the provided stdout for all subsequent calls.
 */
function makeExecFileRejectOnce(errorMessage: string, thenStdout = "") {
  mockExecFile
    .mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error(errorMessage));
    })
    .mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string }
      ) => void;
      cb(null, { stdout: thenStdout, stderr: "" });
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeManager", () => {
  const REPO_ROOT = "/fake/repo";
  const RUN_ID = "run-abc";
  const BASE_DIR = path.join(REPO_ROOT, ".sygil", "worktrees", RUN_ID);

  let manager: WorktreeManager;

  beforeEach(() => {
    manager = new WorktreeManager(RUN_ID, REPO_ROOT);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("create()", () => {
    it("calls git worktree add with the correct branch name and returns the worktree path", async () => {
      makeExecFileResolve("main\n");

      const nodeId = "node-1";
      const worktreePath = await manager.create(nodeId);

      expect(worktreePath).toBe(path.join(BASE_DIR, nodeId));

      // First call: rev-parse to get current branch
      const firstCall = mockExecFile.mock.calls[0]!;
      expect(firstCall[0]).toBe("git");
      expect(firstCall[1]).toEqual(["-C", REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"]);

      // Second call: worktree add
      const secondCall = mockExecFile.mock.calls[1] as string[][];
      expect(secondCall[0]).toBe("git");
      const args: string[] = secondCall[1] as string[];
      expect(args[0]).toBe("-C");
      expect(args[1]).toBe(REPO_ROOT);
      expect(args[2]).toBe("worktree");
      expect(args[3]).toBe("add");
      expect(args[4]).toBe("-b");
      // Branch name starts with the expected prefix
      expect(args[5]).toMatch(/^sygil\/worktree\/node-1-[0-9a-f-]{36}$/);
      // Worktree path
      expect(args[6]).toBe(path.join(BASE_DIR, nodeId));
      // Source branch
      expect(args[7]).toBe("main");
    });

    it("stores the worktree info so that a subsequent remove() can clean it up", async () => {
      makeExecFileResolve("main\n");

      const nodeId = "node-store";
      await manager.create(nodeId);

      // Reset so remove() calls are tracked cleanly
      vi.clearAllMocks();
      makeExecFileResolve("");

      await manager.remove(nodeId);

      // Should have called worktree remove and branch -D (not skipped)
      const calls = mockExecFile.mock.calls as string[][][];
      const worktreeRemoveCall = calls.find(
        (c) => c[1]?.includes("worktree") && c[1]?.includes("remove")
      );
      const branchDeleteCall = calls.find(
        (c) => c[1]?.includes("branch") && c[1]?.includes("-D")
      );

      expect(worktreeRemoveCall).toBeDefined();
      expect(branchDeleteCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("merge()", () => {
    it("throws when the node has no registered worktree", async () => {
      await expect(manager.merge("non-existent", "main")).rejects.toThrow(
        /No worktree for node non-existent/
      );
    });

    it("returns { conflicts: [] } when the merge succeeds", async () => {
      // Setup: create a worktree first
      makeExecFileResolve("main\n");
      const nodeId = "node-merge-ok";
      await manager.create(nodeId);

      vi.clearAllMocks();
      // All subsequent git calls (add, commit, merge) succeed
      makeExecFileResolve("");

      const result = await manager.merge(nodeId, "main");

      expect(result).toEqual({ conflicts: [] });

      // The merge --no-ff call should have been made
      const calls = mockExecFile.mock.calls as string[][][];
      const mergeCall = calls.find(
        (c) => c[1]?.includes("merge") && c[1]?.includes("--no-ff")
      );
      expect(mergeCall).toBeDefined();
    });

    it("returns the conflict file list and aborts when the merge fails", async () => {
      // Setup: create a worktree first
      makeExecFileResolve("main\n");
      const nodeId = "node-merge-conflict";
      await manager.create(nodeId);

      vi.clearAllMocks();

      // Track call order to simulate: add(ok) → commit(ok) → merge --no-ff (FAIL)
      // → diff --name-only (ok, returns conflict list) → merge --abort (ok)
      let callIndex = 0;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: Error | null,
          result?: { stdout: string; stderr: string }
        ) => void;
        const gitArgs: string[] = args[1] as string[];
        callIndex++;

        if (gitArgs.includes("--no-ff")) {
          // merge fails
          cb(new Error("CONFLICT (content)"));
        } else if (gitArgs.includes("--diff-filter=U")) {
          // diff returns conflicted files
          cb(null, { stdout: "src/foo.ts\nsrc/bar.ts\n", stderr: "" });
        } else {
          // add, commit, merge --abort all succeed
          cb(null, { stdout: "", stderr: "" });
        }
      });

      const result = await manager.merge(nodeId, "main");

      expect(result.conflicts).toEqual(["src/foo.ts", "src/bar.ts"]);

      // merge --abort must have been called
      const calls = mockExecFile.mock.calls as string[][][];
      const abortCall = calls.find(
        (c) => c[1]?.includes("merge") && c[1]?.includes("--abort")
      );
      expect(abortCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("remove()", () => {
    it("does nothing when the node is not registered", async () => {
      // Should not throw and should not call execFile for worktree/branch ops
      await expect(manager.remove("unknown-node")).resolves.toBeUndefined();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("calls git worktree remove and git branch -D for a registered node", async () => {
      // Create a worktree so it is registered
      makeExecFileResolve("main\n");
      const nodeId = "node-remove";
      const worktreePath = await manager.create(nodeId);

      vi.clearAllMocks();
      makeExecFileResolve("");

      await manager.remove(nodeId);

      const calls = mockExecFile.mock.calls as string[][][];

      const worktreeRemoveCall = calls.find(
        (c) =>
          c[1]?.includes("worktree") &&
          c[1]?.includes("remove") &&
          c[1]?.includes("--force") &&
          c[1]?.includes(worktreePath)
      );
      expect(worktreeRemoveCall).toBeDefined();

      const branchDeleteCall = calls.find(
        (c) => c[1]?.includes("branch") && c[1]?.includes("-D")
      );
      expect(branchDeleteCall).toBeDefined();
      // Branch name should start with the expected prefix
      const branchArgs = branchDeleteCall![1] as string[];
      const branchArg = branchArgs[branchArgs.indexOf("-D") + 1];
      expect(branchArg).toMatch(/^sygil\/worktree\/node-remove-[0-9a-f-]{36}$/);
    });
  });

  // -------------------------------------------------------------------------
  describe("abort signal", () => {
    it("create() throws when signal is already aborted", async () => {
      makeExecFileResolve("main\n");
      const controller = new AbortController();
      controller.abort();

      await expect(manager.create("node-abort", controller.signal)).rejects.toThrow();
    });

    it("create() passes signal through to execFileAsync calls", async () => {
      makeExecFileResolve("main\n");
      const controller = new AbortController();

      await manager.create("node-sig", controller.signal);

      // The first call (rev-parse) should have received the signal in its options
      const firstCall = mockExecFile.mock.calls[0]!;
      const opts = firstCall[2] as { signal?: AbortSignal };
      expect(opts.signal).toBe(controller.signal);
    });

    it("merge() throws when signal is already aborted", async () => {
      makeExecFileResolve("main\n");
      await manager.create("node-merge-abort");

      const controller = new AbortController();
      controller.abort();

      await expect(manager.merge("node-merge-abort", "main", controller.signal)).rejects.toThrow(
        /aborted/i
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("pruneWorktrees()", () => {
    it("invokes `git -C <repo> worktree prune` at the given repo root", async () => {
      makeExecFileResolve("");

      await pruneWorktrees(REPO_ROOT);

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const call = mockExecFile.mock.calls[0]!;
      expect(call[0]).toBe("git");
      expect(call[1]).toEqual(["-C", REPO_ROOT, "worktree", "prune"]);
    });

    it("swallows errors (non-git directory, git missing, permission denied)", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error) => void;
        cb(new Error("fatal: not a git repository"));
      });

      await expect(pruneWorktrees(REPO_ROOT)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("cleanup()", () => {
    it("removes all registered worktrees and deletes the base directory", async () => {
      // Register two worktrees
      makeExecFileResolve("main\n");
      await manager.create("node-a");
      await manager.create("node-b");

      vi.clearAllMocks();
      makeExecFileResolve("");
      mockRm.mockResolvedValue(undefined);

      await manager.cleanup();

      // Both worktrees should have been removed (2 × worktree remove + 2 × branch -D)
      const calls = mockExecFile.mock.calls as string[][][];
      const worktreeRemoveCalls = calls.filter(
        (c) => c[1]?.includes("worktree") && c[1]?.includes("remove")
      );
      const branchDeleteCalls = calls.filter(
        (c) => c[1]?.includes("branch") && c[1]?.includes("-D")
      );

      expect(worktreeRemoveCalls).toHaveLength(2);
      expect(branchDeleteCalls).toHaveLength(2);

      // fs.rm should have been called on the base dir
      expect(mockRm).toHaveBeenCalledWith(
        BASE_DIR,
        expect.objectContaining({ recursive: true, force: true })
      );
    });
  });
});
