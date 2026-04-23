import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { NodeConfig } from "@sygil/shared";

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

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const _mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockRm = rm as ReturnType<typeof vi.fn>;

import { LazyWorktreeManager } from "./lazy-worktree-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecFileResolve(stdout: string, stderr = "") {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: null,
      result: { stdout: string; stderr: string }
    ) => void;
    cb(null, { stdout, stderr });
  });
}

const BASE_CONFIG: NodeConfig = {
  adapter: "claude-cli",
  model: "claude-sonnet-4-20250514",
  role: "developer",
  prompt: "implement feature",
  tools: ["Edit", "Read"],
  outputDir: "output",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LazyWorktreeManager", () => {
  const REPO_ROOT = "/fake/repo";
  const RUN_ID = "run-lazy";
  const BASE_DIR = path.join(REPO_ROOT, ".sygil", "worktrees", RUN_ID);

  let manager: LazyWorktreeManager;

  beforeEach(() => {
    manager = new LazyWorktreeManager(RUN_ID, REPO_ROOT);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("sparse checkout", () => {
    it("uses --no-checkout and then sparse-checkout set with needed directories", async () => {
      makeExecFileResolve("main\n");

      const config: NodeConfig = {
        ...BASE_CONFIG,
        outputDir: "results/node-1",
      };
      await manager.getOrCreate("node-1", config);

      const calls = mockExecFile.mock.calls as unknown[][];

      // Find the worktree add call — should have --no-checkout
      const addCall = calls.find(
        (c) => {
          const args = c[1] as string[];
          return args.includes("worktree") && args.includes("add");
        }
      );
      expect(addCall).toBeDefined();
      const addArgs = addCall![1] as string[];
      expect(addArgs).toContain("--no-checkout");

      // Find the sparse-checkout set call
      const sparseCall = calls.find(
        (c) => {
          const args = c[1] as string[];
          return args.includes("sparse-checkout") && args.includes("set");
        }
      );
      expect(sparseCall).toBeDefined();
      const sparseArgs = sparseCall![1] as string[];
      expect(sparseArgs).toContain("results/node-1");
    });
  });

  // -------------------------------------------------------------------------
  describe("lazy creation", () => {
    it("does not create any worktree until getOrCreate is called", async () => {
      // Just constructing the manager should not invoke git
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("returns the same path on repeated getOrCreate calls for the same nodeId", async () => {
      makeExecFileResolve("main\n");

      const path1 = await manager.getOrCreate("node-repeat", BASE_CONFIG);
      const path2 = await manager.getOrCreate("node-repeat", BASE_CONFIG);

      expect(path1).toBe(path2);

      // worktree add should only have been called once
      const calls = mockExecFile.mock.calls as unknown[][];
      const addCalls = calls.filter(
        (c) => {
          const args = c[1] as string[];
          return args.includes("worktree") && args.includes("add");
        }
      );
      expect(addCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("mutex-protected operations", () => {
    it("serializes concurrent getOrCreate calls", async () => {
      const order: string[] = [];

      // Make execFile take a "while" by resolving on next tick
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: null,
          result: { stdout: string; stderr: string }
        ) => void;
        const gitArgs = args[1] as string[];
        // Track when worktree add calls complete
        if (gitArgs.includes("worktree") && gitArgs.includes("add")) {
          const worktreePath = gitArgs.find((a) => a.includes(BASE_DIR));
          if (worktreePath) {
            const nodeId = path.basename(worktreePath);
            order.push(`start-${nodeId}`);
          }
        }
        // Resolve synchronously for test simplicity
        cb(null, { stdout: "main\n", stderr: "" });
      });

      // Fire two concurrent creations
      const configA: NodeConfig = { ...BASE_CONFIG, outputDir: "out-a" };
      const configB: NodeConfig = { ...BASE_CONFIG, outputDir: "out-b" };

      const [pathA, pathB] = await Promise.all([
        manager.getOrCreate("node-a", configA),
        manager.getOrCreate("node-b", configB),
      ]);

      expect(pathA).toBe(path.join(BASE_DIR, "node-a"));
      expect(pathB).toBe(path.join(BASE_DIR, "node-b"));

      // Both should have been created (order may vary but both must exist)
      expect(order).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("cleanup", () => {
    it("handles mix of created and not-created worktrees", async () => {
      makeExecFileResolve("main\n");

      // Create only one worktree
      await manager.getOrCreate("node-created", BASE_CONFIG);

      vi.clearAllMocks();
      makeExecFileResolve("");
      mockRm.mockResolvedValue(undefined);

      // Cleanup should not throw even though some nodes were never created
      await manager.cleanup();

      // Should have called worktree remove for the created one
      const calls = mockExecFile.mock.calls as unknown[][];
      const removeCalls = calls.filter(
        (c) => {
          const args = c[1] as string[];
          return args.includes("worktree") && args.includes("remove");
        }
      );
      expect(removeCalls).toHaveLength(1);

      // Should have cleaned up base directory
      expect(mockRm).toHaveBeenCalledWith(
        BASE_DIR,
        expect.objectContaining({ recursive: true, force: true })
      );
    });

    it("removes all created worktrees in parallel", async () => {
      makeExecFileResolve("main\n");

      await manager.getOrCreate("node-p1", BASE_CONFIG);
      await manager.getOrCreate("node-p2", BASE_CONFIG);

      vi.clearAllMocks();
      makeExecFileResolve("");
      mockRm.mockResolvedValue(undefined);

      await manager.cleanup();

      const calls = mockExecFile.mock.calls as unknown[][];
      const removeCalls = calls.filter(
        (c) => {
          const args = c[1] as string[];
          return args.includes("worktree") && args.includes("remove");
        }
      );
      expect(removeCalls).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("core.compression config", () => {
    it("sets core.compression=0 on the worktree", async () => {
      makeExecFileResolve("main\n");

      await manager.getOrCreate("node-compress", BASE_CONFIG);

      const calls = mockExecFile.mock.calls as unknown[][];
      const configCall = calls.find(
        (c) => {
          const args = c[1] as string[];
          return args.includes("config") && args.includes("core.compression");
        }
      );
      expect(configCall).toBeDefined();
      const configArgs = configCall![1] as string[];
      expect(configArgs).toContain("0");
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
      makeExecFileResolve("main\n");
      await manager.getOrCreate("node-merge-ok", BASE_CONFIG);

      vi.clearAllMocks();
      makeExecFileResolve("");

      const result = await manager.merge("node-merge-ok", "main");
      expect(result).toEqual({ conflicts: [] });

      const calls = mockExecFile.mock.calls as unknown[][];
      const mergeCall = calls.find((c) => {
        const args = c[1] as string[];
        return args.includes("merge") && args.includes("--no-ff");
      });
      expect(mergeCall).toBeDefined();
    });

    it("returns conflict list and aborts when merge fails", async () => {
      makeExecFileResolve("main\n");
      await manager.getOrCreate("node-merge-fail", BASE_CONFIG);

      vi.clearAllMocks();

      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: Error | null,
          result?: { stdout: string; stderr: string }
        ) => void;
        const gitArgs = args[1] as string[];

        if (gitArgs.includes("--no-ff")) {
          cb(new Error("CONFLICT"));
        } else if (gitArgs.includes("--diff-filter=U")) {
          cb(null, { stdout: "file1.ts\nfile2.ts\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      const result = await manager.merge("node-merge-fail", "main");
      expect(result.conflicts).toEqual(["file1.ts", "file2.ts"]);

      const calls = mockExecFile.mock.calls as unknown[][];
      const abortCall = calls.find((c) => {
        const args = c[1] as string[];
        return args.includes("merge") && args.includes("--abort");
      });
      expect(abortCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("remove()", () => {
    it("does nothing when the node is not registered", async () => {
      await expect(manager.remove("non-existent")).resolves.toBeUndefined();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("abort signal propagation", () => {
    it("throws immediately when signal is already aborted before mutex acquire", async () => {
      // First execFile (rev-parse HEAD) resolves; pre-check should catch abort before worktree add.
      makeExecFileResolve("main\n");

      const controller = new AbortController();
      controller.abort();

      await expect(
        manager.getOrCreate("node-aborted", BASE_CONFIG, controller.signal)
      ).rejects.toThrow(/Worktree creation aborted/);
    });

    it("threads the signal to the long-running sparse-checkout set execFile call", async () => {
      const controller = new AbortController();
      makeExecFileResolve("main\n");

      await manager.getOrCreate("node-signal", BASE_CONFIG, controller.signal);

      const calls = mockExecFile.mock.calls as unknown[][];
      const sparseCall = calls.find((c) => {
        const args = c[1] as string[];
        return args.includes("sparse-checkout") && args.includes("set");
      });
      expect(sparseCall).toBeDefined();
      // execFile signature: (file, args, options, callback) — options is index 2.
      const opts = sparseCall![2] as { signal?: AbortSignal };
      expect(opts?.signal).toBe(controller.signal);
    });

    it("threads the signal to the merge --no-ff execFile call", async () => {
      const controller = new AbortController();
      makeExecFileResolve("main\n");
      await manager.getOrCreate("node-merge-signal", BASE_CONFIG);

      vi.clearAllMocks();
      makeExecFileResolve("");

      await manager.merge("node-merge-signal", "main", controller.signal);

      const calls = mockExecFile.mock.calls as unknown[][];
      const mergeCall = calls.find((c) => {
        const args = c[1] as string[];
        return args.includes("merge") && args.includes("--no-ff");
      });
      expect(mergeCall).toBeDefined();
      const opts = mergeCall![2] as { signal?: AbortSignal };
      expect(opts?.signal).toBe(controller.signal);
    });
  });

  // -------------------------------------------------------------------------
  describe("sparse checkout — no outputDir", () => {
    it("defaults to '.' when nodeConfig has no outputDir", async () => {
      makeExecFileResolve("main\n");

      const configNoOutput: NodeConfig = {
        adapter: "claude-cli",
        model: "claude-sonnet-4-20250514",
        role: "developer",
        prompt: "implement feature",
        tools: ["Read"],
      };
      await manager.getOrCreate("node-no-output", configNoOutput);

      const calls = mockExecFile.mock.calls as unknown[][];
      const sparseCall = calls.find((c) => {
        const args = c[1] as string[];
        return args.includes("sparse-checkout") && args.includes("set");
      });
      expect(sparseCall).toBeDefined();
      const sparseArgs = sparseCall![1] as string[];
      expect(sparseArgs).toContain(".");
    });
  });
});
