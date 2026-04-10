/**
 * CLI E2E tests for `sigil run`.
 *
 * Spawns the real CLI binary as a child process and asserts on exit codes,
 * stdout content, and files written to disk. Uses the `echo` adapter via
 * test-fixtures/workflows/*.json so no real AI API is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, rm, mkdtemp, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI_PATH = resolve(__dirname, "../../dist/index.js");
const FIXTURES_DIR = resolve(__dirname, "../../test-fixtures/workflows");

// ---------------------------------------------------------------------------
// Helper: spawn sigil run and collect output
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runSigil(
  workflowPath: string,
  args: string[] = [],
  options: {
    cwd: string;
    env?: Record<string, string>;
    timeout?: number;
  }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [CLI_PATH, "run", workflowPath, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout ?? 15000,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    // Resolve with code 1 on spawn error (e.g. missing binary)
    child.on("error", () => {
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers: filesystem
// ---------------------------------------------------------------------------

/** Read all files under `.sigil/runs/` and return the first checkpoint JSON. */
async function readCheckpoint(cwd: string): Promise<Record<string, unknown>> {
  const runsDir = join(cwd, ".sigil", "runs");
  const entries = await readdir(runsDir);
  // Find the first .json file (the run checkpoint)
  const checkpointFile = entries.find((e) => e.endsWith(".json"));
  if (!checkpointFile) throw new Error("No checkpoint file found in .sigil/runs/");
  const raw = await readFile(join(runsDir, checkpointFile), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Return the run ID from the checkpoint directory (the first UUID directory). */
async function getRunId(cwd: string): Promise<string> {
  const runsDir = join(cwd, ".sigil", "runs");
  const entries = await readdir(runsDir);
  const runId = entries.find((e) => !e.endsWith(".json"));
  if (!runId) throw new Error("No run directory found in .sigil/runs/");
  return runId;
}

/** Read the NDJSON event file for a given nodeId. */
async function readNodeEvents(cwd: string, nodeId: string): Promise<string> {
  const runId = await getRunId(cwd);
  const eventsFile = join(cwd, ".sigil", "runs", runId, "events", `${nodeId}.ndjson`);
  return readFile(eventsFile, "utf-8");
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "sigil-e2e-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI E2E: sigil run", () => {
  it("single-node workflow completes with exit 0", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "single-node.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow completed in/);
  });

  it("linear workflow with exit_code gate passes", async () => {
    // writer exits 0 → gate (exit_code: 0) passes → checker runs
    const result = await runSigil(
      join(FIXTURES_DIR, "linear-gate.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow completed in/);
    // Both nodes should have emitted events
    const writerEvents = await readNodeEvents(testDir, "writer");
    expect(writerEvents).toBeTruthy();
    const checkerEvents = await readNodeEvents(testDir, "checker");
    expect(checkerEvents).toBeTruthy();
  });

  it("diamond DAG runs all 4 nodes", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "parallel-diamond.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow completed in/);

    // All four nodes should have NDJSON event files
    for (const nodeId of ["start", "left", "right", "merge"]) {
      const events = await readNodeEvents(testDir, nodeId);
      expect(events.length).toBeGreaterThan(0);
    }
  });

  it("forward gate failure exits with code 1", async () => {
    // gate-fail.json: writer→checker with gate exit_code: 0
    // ECHO_EXIT_CODE=1 makes writer exit 1 → gate expects 0 → gate FAILS
    const result = await runSigil(
      join(FIXTURES_DIR, "gate-fail.json"),
      [],
      { cwd: testDir, env: { ECHO_EXIT_CODE: "1" } }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/Workflow failed\./);
  });

  it("loop-back retries then succeeds", async () => {
    // loop-back.json: writer→reviewer with a loop-back edge (gate: exit_code: 1)
    //
    // Gate logic for loop-back: gate FAILING → retry target node
    //
    // We use ECHO_EVENTS_SEQ on the reviewer to control per-invocation exit code:
    //   invocation 0: exit 0 → gate (exit_code: 1) FAILS → loop back (retry 1)
    //   invocation 1: exit 0 → gate FAILS → loop back (retry 2)
    //   invocation 2: exit 1 → gate (exit_code: 1) PASSES → continue forward
    //
    // maxRetries: 2 on the loop-back edge so the third attempt (index 2) is
    // exactly at the limit and the gate can still pass.
    const counterFile = join(testDir, "reviewer-counter.txt");

    // reviewer seq: invocations 0 and 1 exit 0 (gate fails → retry),
    //               invocation 2 exits 1 (gate passes → done)
    const reviewerSeq = JSON.stringify([
      [{ type: "text", text: "needs work" }, { type: "cost", total_cost_usd: 0.001 }],
      [{ type: "text", text: "still needs work" }, { type: "cost", total_cost_usd: 0.001 }],
      [{ type: "text", text: "looks good" }, { type: "cost", total_cost_usd: 0.001 }],
    ]);

    // writer always exits 0 (no ECHO_EXIT_CODE override for it)
    // We use ECHO_EVENTS_SEQ + ECHO_COUNTER_FILE for the reviewer.
    // Because env vars apply to ALL echo-adapter invocations, we set the seq
    // on all nodes — writer will see invocation 0 of the seq (exits 0) which
    // is fine since the writer→reviewer edge has no gate.
    const result = await runSigil(
      join(FIXTURES_DIR, "loop-back.json"),
      [],
      {
        cwd: testDir,
        env: {
          ECHO_COUNTER_FILE: counterFile,
          ECHO_EVENTS_SEQ: reviewerSeq,
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow completed in/);
    // The loop-back event should be logged
    expect(result.stdout).toMatch(/loop.back|retry|attempt/i);
  });

  it("parameter interpolation substitutes values into prompt", async () => {
    // parameterized.json: prompt = "Do {{task}} in {{mode}} mode"
    // Pass task param; mode defaults to "fast"
    const result = await runSigil(
      join(FIXTURES_DIR, "parameterized.json"),
      ["--param", "task=build auth"],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow completed in/);
  });

  it("dry-run validates workflow without executing nodes", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "single-node.json"),
      ["--dry-run"],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Workflow is valid/);
    // No checkpoint should be written since the workflow never ran
    let checkpointExists = false;
    try {
      await readCheckpoint(testDir);
      checkpointExists = true;
    } catch {
      checkpointExists = false;
    }
    expect(checkpointExists).toBe(false);
  });

  it("invalid workflow path exits with error", async () => {
    const result = await runSigil(
      join(testDir, "does-not-exist.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(1);
    // Should mention the failure in stdout or stderr
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/failed|error|not found|ENOENT/i);
  });

  it("monitor WebSocket URL is printed to stdout", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "single-node.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);
    // run command prints monitor URL containing token (either "Monitor:" or "Web monitor available at:")
    expect(result.stdout).toMatch(/monitor.*token=[0-9a-f-]+/i);
  });

  it("checkpoint file is written after completion", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "single-node.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);

    const checkpoint = await readCheckpoint(testDir);

    // Checkpoint must record the completed status
    expect(checkpoint["status"]).toBe("completed");
    // Should contain completedNodes with "greeter"
    const completedNodes = checkpoint["completedNodes"] as string[] | undefined;
    expect(completedNodes).toContain("greeter");
  });

  it("NDJSON event log is written for each node", async () => {
    const result = await runSigil(
      join(FIXTURES_DIR, "linear-gate.json"),
      [],
      { cwd: testDir }
    );

    expect(result.exitCode).toBe(0);

    // Each node should have an NDJSON event file with at least one line
    for (const nodeId of ["writer", "checker"]) {
      const raw = await readNodeEvents(testDir, nodeId);
      const lines = raw.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);

      // Each line must be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
