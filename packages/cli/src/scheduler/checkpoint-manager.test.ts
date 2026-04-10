/**
 * CheckpointManager tests
 *
 * Covers: debounced/coalesced writes, background writes, mkdir caching,
 * error tracking, per-node result files, and state reconstruction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WorkflowRunState, NodeResult } from "@sigil/shared";
import { CheckpointManager, CHECKPOINT_DEBOUNCE_MS } from "./checkpoint-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: randomUUID(),
    workflowName: "test-workflow",
    workflowPath: "",
    status: "running",
    startedAt: new Date().toISOString(),
    completedNodes: [],
    nodeResults: {},
    totalCostUsd: 0,
    retryCounters: {},
    ...overrides,
  };
}

function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    output: "test output",
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sigil-ckpt-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CheckpointManager", () => {
  // 1. Single markDirty produces one write after debounce period
  it("writes state once after debounce period on single markDirty", async () => {
    const state = makeRunState();
    const mgr = new CheckpointManager(testDir);

    mgr.markDirty(state);

    // Before debounce fires, file should not exist
    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();

    // Advance past debounce and wait for the background write to complete
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);
    await mgr.waitForWrite();

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(state.id);
    expect(parsed.status).toBe("running");

    mgr.dispose();
  });

  // 2. Multiple rapid markDirty calls coalesce into one write
  it("coalesces multiple rapid markDirty calls into one write", async () => {
    const state = makeRunState();
    const mgr = new CheckpointManager(testDir);

    // Rapid-fire 5 markDirty calls with mutating state
    for (let i = 0; i < 5; i++) {
      state.completedNodes = Array.from({ length: i + 1 }, (_, j) => `node-${j}`);
      mgr.markDirty(state);
    }

    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);
    await mgr.waitForWrite();

    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    // Should have the LAST state (5 completed nodes)
    expect(parsed.completedNodes).toHaveLength(5);

    // Verify only compact JSON (no pretty-printing)
    expect(raw).not.toContain("\n");

    mgr.dispose();
  });

  // 3. flush() writes immediately even if debounce hasn't fired
  it("flush() writes immediately without waiting for debounce", async () => {
    const state = makeRunState({ status: "completed" });
    const mgr = new CheckpointManager(testDir);

    mgr.markDirty(state);

    // flush immediately — don't advance timers
    await mgr.flush();

    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("completed");

    mgr.dispose();
  });

  // 4. mkdir is called only once across multiple writes
  it("calls mkdir only once across multiple writes", async () => {
    const state = makeRunState();
    const mgr = new CheckpointManager(testDir);

    // First write
    mgr.markDirty(state);
    await mgr.flush();

    // Second write
    state.status = "completed";
    mgr.markDirty(state);
    await mgr.flush();

    // Third write
    state.completedNodes = ["nodeA"];
    mgr.markDirty(state);
    await mgr.flush();

    // Verify that the directory exists and all writes succeeded
    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.completedNodes).toContain("nodeA");

    // The mkdir count is internal — we verify indirectly: the manager exposes mkdirCallCount
    expect(mgr.mkdirCallCount).toBe(1);

    mgr.dispose();
  });

  // 5. Write errors are captured and accessible
  it("captures write errors and exposes them", async () => {
    // Use an invalid path to force a write error
    const invalidDir = join(testDir, "\0invalid-path");
    const state = makeRunState();
    const mgr = new CheckpointManager(invalidDir);

    mgr.markDirty(state);

    // Flush triggers the write which will fail
    await mgr.flush();

    expect(mgr.lastError).toBeDefined();
    expect(mgr.lastError).toBeInstanceOf(Error);

    mgr.dispose();
  });

  // 6. Per-node result files are written separately
  it("writes per-node result files to nodes/ subdirectory", async () => {
    const state = makeRunState();
    const nodeResult = makeNodeResult({ output: "node-a output" });
    const mgr = new CheckpointManager(testDir);

    mgr.markNodeResult(state.id, "nodeA", nodeResult);
    await mgr.flush();

    const nodeFilePath = join(
      testDir, ".sigil", "runs", state.id, "nodes", "nodeA.json"
    );
    const raw = await readFile(nodeFilePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.output).toBe("node-a output");
    expect(parsed.exitCode).toBe(0);

    mgr.dispose();
  });

  // 7. State can be reconstructed from main file + per-node files
  it("reconstructs full state from main file + per-node files", async () => {
    const state = makeRunState({ status: "completed" });
    const resultA = makeNodeResult({ output: "output-a" });
    const resultB = makeNodeResult({ output: "output-b", exitCode: 0, durationMs: 200 });

    state.completedNodes = ["nodeA", "nodeB"];
    // Main state stores node results as empty — they live in per-node files
    state.nodeResults = {};

    const mgr = new CheckpointManager(testDir);

    // Write main state
    mgr.markDirty(state);
    await mgr.flush();

    // Write per-node results
    mgr.markNodeResult(state.id, "nodeA", resultA);
    mgr.markNodeResult(state.id, "nodeB", resultB);
    await mgr.flush();

    // Reconstruct
    const reconstructed = await CheckpointManager.loadState(testDir, state.id);

    expect(reconstructed.id).toBe(state.id);
    expect(reconstructed.status).toBe("completed");
    expect(reconstructed.completedNodes).toEqual(["nodeA", "nodeB"]);
    expect(reconstructed.nodeResults["nodeA"]?.output).toBe("output-a");
    expect(reconstructed.nodeResults["nodeB"]?.output).toBe("output-b");
    expect(reconstructed.nodeResults["nodeB"]?.durationMs).toBe(200);

    mgr.dispose();
  });

  // Bonus: flush with no dirty state is a no-op
  it("flush() is a no-op when nothing is dirty", async () => {
    const mgr = new CheckpointManager(testDir);

    // Should not throw
    await mgr.flush();

    expect(mgr.mkdirCallCount).toBe(0);

    mgr.dispose();
  });

  // 8. Concurrent markDirty calls with different states — last one wins
  it("concurrent markDirty calls with different states keeps the last state", async () => {
    const state1 = makeRunState({ status: "running" });
    const state2 = makeRunState({ id: state1.id, status: "completed" });
    const mgr = new CheckpointManager(testDir);

    // Two rapid markDirty with different state objects (same run id)
    mgr.markDirty(state1);
    mgr.markDirty(state2);

    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);
    await mgr.waitForWrite();

    const filePath = join(testDir, ".sigil", "runs", `${state1.id}.json`);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    // The last markDirty should win
    expect(parsed.status).toBe("completed");

    mgr.dispose();
  });

  // 9. Error recovery after write failure — subsequent writes succeed
  it("recovers from write failure on subsequent successful writes", async () => {
    const state = makeRunState();
    // First, use invalid dir to force failure
    const invalidDir = join(testDir, "\0invalid-path");
    const mgrBad = new CheckpointManager(invalidDir);
    mgrBad.markDirty(state);
    await mgrBad.flush();
    expect(mgrBad.lastError).toBeDefined();
    mgrBad.dispose();

    // Now use a valid dir — should succeed
    const mgrGood = new CheckpointManager(testDir);
    mgrGood.markDirty(state);
    await mgrGood.flush();
    expect(mgrGood.lastError).toBeUndefined();

    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(state.id);

    mgrGood.dispose();
  });

  // 10. loadState with missing nodes directory returns state without node results
  it("loadState returns base state when nodes directory does not exist", async () => {
    const state = makeRunState({ status: "completed" });
    state.nodeResults = {};

    const mgr = new CheckpointManager(testDir);
    mgr.markDirty(state);
    await mgr.flush();
    mgr.dispose();

    // No per-node files written — loadState should still work
    const loaded = await CheckpointManager.loadState(testDir, state.id);
    expect(loaded.id).toBe(state.id);
    expect(loaded.status).toBe("completed");
    expect(Object.keys(loaded.nodeResults)).toHaveLength(0);
  });

  // 11. getLastError() returns the last write error
  it("getLastError() returns the error after a failed write", async () => {
    const invalidDir = join(tmpdir(), `sigil-ckpt-test-\0invalid`);
    const state = makeRunState();
    const mgr = new CheckpointManager(invalidDir);

    mgr.markDirty(state);
    await mgr.flush();

    const lastErr = mgr.getLastError();
    expect(lastErr).toBeDefined();
    expect(lastErr).toBeInstanceOf(Error);

    mgr.dispose();
  });

  it("getLastError() returns undefined when no errors occurred", async () => {
    const state = makeRunState();
    const mgr = new CheckpointManager(testDir);

    mgr.markDirty(state);
    await mgr.flush();

    expect(mgr.getLastError()).toBeUndefined();

    mgr.dispose();
  });

  // Bonus: dispose cancels pending debounce
  it("dispose() cancels pending debounce timer", async () => {
    const state = makeRunState();
    const mgr = new CheckpointManager(testDir);

    mgr.markDirty(state);
    mgr.dispose();

    // Advance past debounce — write should NOT happen since we disposed
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);

    const filePath = join(testDir, ".sigil", "runs", `${state.id}.json`);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });
});
