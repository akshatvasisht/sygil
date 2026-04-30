import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forkCommand } from "./fork.js";

// ---------------------------------------------------------------------------
// Mocks — stub out the scheduler and bootstrap so the test exercises only the
// fork-specific state construction + event-copy logic. Real filesystem is used
// so we can assert on the child run's on-disk shape.
// ---------------------------------------------------------------------------

vi.mock("./_scheduler-bootstrap.js", () => ({
  buildSchedulerContext: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  getAdapter: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(true),
    spawn: vi.fn(),
    stream: vi.fn(),
    getResult: vi.fn(),
    kill: vi.fn(),
    getVersion: vi.fn().mockResolvedValue("test-fixture"),
  }),
}));

vi.mock("../scheduler/environment.js", () => ({
  buildEnvironmentSnapshot: vi.fn().mockResolvedValue({
    sygilVersion: "0.1.0",
    adapterVersions: { echo: "test-fixture" },
    nodeVersion: "20.0.0",
    platform: "linux-x64",
  }),
  diffEnvironment: vi.fn().mockReturnValue([]),
}));

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
  interpolateWorkflow: vi.fn((wf: unknown) => wf),
}));

vi.mock("../worktree/index.js", () => ({
  pruneWorktrees: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/tier-resolver.js", () => ({
  resolveModelTiersAndLog: vi.fn((wf: unknown) => wf),
}));

vi.mock("../utils/config.js", () => ({
  readConfigSafe: vi.fn().mockResolvedValue({ tiers: {}, hooks: {} }),
}));

import { buildSchedulerContext } from "./_scheduler-bootstrap.js";
import { loadWorkflow } from "../utils/workflow.js";
import { diffEnvironment } from "../scheduler/environment.js";

const mockBuildContext = buildSchedulerContext as ReturnType<typeof vi.fn>;
const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;
const mockDiffEnvironment = diffEnvironment as ReturnType<typeof vi.fn>;

describe("forkCommand", () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  let originalConfigEnv: string | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  let schedulerResume: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sygil-fork-test-"));
    configDir = join(testDir, ".sygil");
    await mkdir(join(configDir, "runs"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
    originalConfigEnv = process.env["SYGIL_CONFIG_DIR"];
    process.env["SYGIL_CONFIG_DIR"] = configDir;

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });

    schedulerResume = vi.fn().mockResolvedValue({
      success: true,
      durationMs: 1234,
      totalCostUsd: 0,
    });
    mockBuildContext.mockResolvedValue({
      scheduler: { on: vi.fn(), resume: schedulerResume },
      monitor: null,
      monitorPort: null,
      monitorAuthToken: null,
      teardown: vi.fn().mockResolvedValue(undefined),
    });
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: {
        nodeA: { adapter: "echo", model: "m", role: "A", prompt: "a" },
        nodeB: { adapter: "echo", model: "m", role: "B", prompt: "b" },
      },
      edges: [],
      parameters: {},
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalConfigEnv === undefined) delete process.env["SYGIL_CONFIG_DIR"];
    else process.env["SYGIL_CONFIG_DIR"] = originalConfigEnv;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  async function seedParent(overrides: Record<string, unknown> = {}): Promise<string> {
    const parentId = "parent-run-id";
    const parentState = {
      id: parentId,
      workflowName: "test-workflow",
      workflowPath: join(testDir, "workflow.json"),
      status: "completed",
      startedAt: new Date().toISOString(),
      completedNodes: ["nodeA"],
      nodeResults: {
        nodeA: { output: "A done", exitCode: 0, durationMs: 10 },
      },
      totalCostUsd: 0.12,
      retryCounters: {},
      sharedContext: { foo: "bar" },
      ...overrides,
    };
    await writeFile(join(configDir, "runs", `${parentId}.json`), JSON.stringify(parentState));
    await writeFile(parentState.workflowPath as string, JSON.stringify({ version: "1", name: "test-workflow", nodes: {}, edges: [] }));
    // Seed an events dir with a real per-node NDJSON file so fork can copy it.
    const eventsDir = join(configDir, "runs", parentId, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "nodeA.ndjson"), `{"timestamp":1,"nodeId":"nodeA","event":{"type":"text_delta","text":"hi"}}\n`);
    return parentId;
  }

  it("constructs a child state with fresh runId, inherited sharedContext, and forkedFrom pointer", async () => {
    const parentId = await seedParent();
    await forkCommand(parentId, {});

    const runs = await readdir(join(configDir, "runs"));
    const childFile = runs.find((f) => f.endsWith(".json") && !f.includes(parentId));
    expect(childFile).toBeDefined();
    const childState = JSON.parse(await readFile(join(configDir, "runs", childFile!), "utf8")) as Record<string, unknown>;
    expect(childState["id"]).not.toBe(parentId);
    expect(childState["workflowName"]).toBe("test-workflow");
    expect(childState["completedNodes"]).toEqual(["nodeA"]);
    expect(childState["sharedContext"]).toEqual({ foo: "bar" });
    expect(childState["totalCostUsd"]).toBe(0);
    expect(childState["retryCounters"]).toEqual({});
    expect(childState["forkedFrom"]).toEqual({ runId: parentId, checkpointIndex: 1 });
  });

  it("copies per-node NDJSON for retained nodes only", async () => {
    const parentId = await seedParent({
      completedNodes: ["nodeA", "nodeB"],
      nodeResults: {
        nodeA: { output: "a", exitCode: 0, durationMs: 10 },
        nodeB: { output: "b", exitCode: 0, durationMs: 10 },
      },
    });
    // Add a second per-node NDJSON so the copy is selective.
    const parentEvents = join(configDir, "runs", parentId, "events");
    await writeFile(join(parentEvents, "nodeB.ndjson"), `{"timestamp":2,"nodeId":"nodeB","event":{"type":"text_delta","text":"hi2"}}\n`);

    await forkCommand(parentId, { at: "1" });

    const runs = await readdir(join(configDir, "runs"));
    const childId = runs.find((f) => f.endsWith(".json") && !f.includes(parentId))!.replace(".json", "");
    const childEvents = await readdir(join(configDir, "runs", childId, "events"));
    expect(childEvents).toContain("nodeA.ndjson");
    expect(childEvents).not.toContain("nodeB.ndjson");
  });

  it("clamps --at values above the parent's completed count", async () => {
    const parentId = await seedParent();
    await forkCommand(parentId, { at: "99" });

    const runs = await readdir(join(configDir, "runs"));
    const childFile = runs.find((f) => f.endsWith(".json") && !f.includes(parentId))!;
    const childState = JSON.parse(await readFile(join(configDir, "runs", childFile), "utf8")) as Record<string, unknown>;
    // Parent had 1 completed; clamp retains 1.
    expect((childState["completedNodes"] as string[]).length).toBe(1);
    expect((childState["forkedFrom"] as { checkpointIndex: number }).checkpointIndex).toBe(1);
  });

  it("rejects invalid --at values (non-numeric / negative)", async () => {
    const parentId = await seedParent();
    await expect(forkCommand(parentId, { at: "abc" })).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid --at value/),
    );
  });

  it("exits 1 when parent checkpoint is missing", async () => {
    await expect(forkCommand("does-not-exist", {})).rejects.toThrow("process.exit(1)");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when parent has no workflowPath (pre-persisted-path run)", async () => {
    const parentId = "orphan-parent";
    const state = {
      id: parentId,
      workflowName: "test-workflow",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
      sharedContext: {},
    };
    await writeFile(join(configDir, "runs", `${parentId}.json`), JSON.stringify(state));
    await expect(forkCommand(parentId, {})).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no workflowPath|predates the persisted-path feature/),
    );
  });

  it("passes runReason='fork' to scheduler.resume", async () => {
    const parentId = await seedParent();
    await forkCommand(parentId, {});
    expect(schedulerResume).toHaveBeenCalledOnce();
    const resumeOpts = schedulerResume.mock.calls[0]![1] as { runReason: string };
    expect(resumeOpts.runReason).toBe("fork");
  });

  it("parses --param key=value pairs", async () => {
    const parentId = await seedParent();
    mockLoadWorkflow.mockResolvedValueOnce({
      version: "1",
      name: "test-workflow",
      nodes: {},
      edges: [],
      parameters: { task: { required: true } },
    });
    await forkCommand(parentId, { param: ["task=branch-A"] });
    expect(schedulerResume).toHaveBeenCalledOnce();
  });

  it("rejects malformed --param pairs", async () => {
    const parentId = await seedParent();
    await expect(forkCommand(parentId, { param: ["nokey"] })).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid parameter format/));
  });

  describe("drift detection", () => {
    it("exits 1 when --check-drift is set and environment drift is detected", async () => {
      const parentId = await seedParent({
        environment: {
          sygilVersion: "0.1.0",
          adapterVersions: { "claude-cli": "2.5.0" },
          nodeVersion: "20.0.0",
          platform: "linux-x64",
        },
      });
      mockDiffEnvironment.mockReturnValue(["claude-cli: 2.5.0 → 2.6.0"]);

      await expect(forkCommand(parentId, { checkDrift: true })).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("proceeds silently by default even with drift (drift check is opt-in)", async () => {
      const parentId = await seedParent({
        environment: {
          sygilVersion: "0.1.0",
          adapterVersions: { "claude-cli": "2.5.0" },
          nodeVersion: "20.0.0",
          platform: "linux-x64",
        },
      });
      mockDiffEnvironment.mockReturnValue(["claude-cli: 2.5.0 → 2.6.0"]);

      // No --check-drift flag → drift detection skipped, no exit
      await forkCommand(parentId, {});
      expect(processExitSpy).not.toHaveBeenCalledWith(1);
      expect(schedulerResume).toHaveBeenCalledOnce();
    });

    it("proceeds without drift when state has no environment field", async () => {
      const parentId = await seedParent();
      // No environment in parent state — mockDiffEnvironment should not be called
      mockDiffEnvironment.mockReturnValue(["some-drift"]);

      await forkCommand(parentId, {});
      // Should succeed since no environment field to compare against
      expect(schedulerResume).toHaveBeenCalledOnce();
      expect(processExitSpy).not.toHaveBeenCalledWith(1);
    });
  });

  describe("parentRunId validation (path traversal guard)", () => {
    it.each([
      "../../etc/passwd",
      "..\\..\\windows\\system32",
      "run/with/slash",
      "run with space",
      "run;rm -rf /",
    ])("exits 1 with invalid parentRunId %s and never calls scheduler", async (badId) => {
      await expect(forkCommand(badId, {})).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Critical: rejection happens before any state load or scheduler bootstrap
      expect(schedulerResume).not.toHaveBeenCalled();
      expect(mockBuildContext).not.toHaveBeenCalled();
    });
  });

});
