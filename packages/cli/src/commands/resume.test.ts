import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { resumeCommand } from "./resume.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
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

vi.mock("../scheduler/index.js", () => ({
  WorkflowScheduler: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    resume: vi.fn().mockResolvedValue({
      success: true,
      durationMs: 1234,
      totalCostUsd: 0.05,
    }),
  })),
}));

vi.mock("../monitor/websocket.js", () => {
  const WsMonitorServer = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(9876),
    stop: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
    getAuthToken: vi.fn().mockReturnValue("test-token"),
    setPrometheusMetrics: vi.fn(),
    setAdapterPool: vi.fn(),
  }));
  return { WsMonitorServer };
});

import { readFile } from "node:fs/promises";
import { loadWorkflow } from "../utils/workflow.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import { WsMonitorServer } from "../monitor/websocket.js";
import { diffEnvironment } from "../scheduler/environment.js";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WorkflowScheduler is a mock constructor
const MockScheduler = WorkflowScheduler as any;
const MockMonitor = WsMonitorServer as ReturnType<typeof vi.fn>;
const mockDiffEnvironment = diffEnvironment as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-abc12345",
    workflowName: "test-workflow",
    status: "paused",
    startedAt: new Date().toISOString(),
    completedNodes: ["nodeA"],
    nodeResults: {},
    totalCostUsd: 0.01,
    retryCounters: {},
    sharedContext: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resumeCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${String(_code)})`);
    });

    // Re-set constructor mocks after clearAllMocks
    MockMonitor.mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(9876),
      stop: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockResolvedValue(undefined),
      getAuthToken: vi.fn().mockReturnValue("test-token"),
      setPrometheusMetrics: vi.fn(),
      setAdapterPool: vi.fn(),
    }));
    MockScheduler.mockImplementation(() => ({
      on: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        success: true,
        durationMs: 1234,
        totalCostUsd: 0.05,
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 when run state file cannot be loaded", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await expect(resumeCommand("nonexistent-run")).rejects.toThrow("process.exit(1)");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("returns early for completed runs with a warning message", async () => {
    const state = makeRunState({ status: "completed" });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    await resumeCommand("run-abc12345");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("already completed");
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("returns early for cancelled runs with a warning message", async () => {
    const state = makeRunState({ status: "cancelled" });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    await resumeCommand("run-abc12345");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("cancelled");
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("shows warning when run status is 'running' (possible crash)", async () => {
    const state = makeRunState({
      status: "running",
      workflowPath: "/fake/workflow.json",
    });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: { nodeA: {} },
      edges: [],
    });
    await resumeCommand("run-abc12345");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("marked as running");
    expect(output).toContain("crashed");
  });

  it("resumes a paused workflow successfully and logs duration", async () => {
    const state = makeRunState({
      status: "paused",
      workflowPath: "/fake/workflow.json",
    });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: { nodeA: {} },
      edges: [],
    });
    await resumeCommand("run-abc12345");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("resumed and completed");
    expect(output).toContain("1.2s");
  });

  it("logs total cost when resume result includes costUsd", async () => {
    const state = makeRunState({
      status: "paused",
      workflowPath: "/fake/workflow.json",
    });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: { nodeA: {} },
      edges: [],
    });
    await resumeCommand("run-abc12345");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("$0.0500");
  });

  it("exits 1 when resume result is not successful", async () => {
    const state = makeRunState({
      status: "paused",
      workflowPath: "/fake/workflow.json",
    });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: { nodeA: {} },
      edges: [],
    });
    // Override the scheduler mock for this test
    MockScheduler.mockImplementation(() => ({
      on: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        success: false,
        durationMs: 500,
        error: "Node nodeB failed",
      }),
    }));
    await expect(resumeCommand("run-abc12345")).rejects.toThrow("process.exit(1)");
  });

  it("exits 1 when workflow file cannot be found during resume", async () => {
    // State has no workflowPath, and all heuristic paths fail
    const state = makeRunState({ status: "paused" });
    // Remove workflowPath if it exists
    delete state["workflowPath"];
    mockReadFile.mockImplementation((path: unknown) => {
      // Only the state file should succeed
      if (String(path).includes("run-abc12345.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("ENOENT"));
    });
    await expect(resumeCommand("run-abc12345")).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not find the original workflow.json"));
  });

  describe("checkpoint schema validation", () => {
    it("exits 1 with 'not valid JSON' when the checkpoint isn't JSON", async () => {
      mockReadFile.mockResolvedValue("{not json");
      await expect(resumeCommand("run-bad")).rejects.toThrow("process.exit(1)");
      // The spinner.fail call doesn't show in console.error, but exit was called.
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("exits 1 when checkpoint is an empty object (fails required fields)", async () => {
      mockReadFile.mockResolvedValue("{}");
      await expect(resumeCommand("run-empty")).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("exits 1 when retryCounters is missing from the checkpoint", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        id: "run-1",
        workflowName: "test",
        status: "failed",
        startedAt: new Date().toISOString(),
        completedNodes: [],
        nodeResults: {},
        totalCostUsd: 0,
        // retryCounters missing
      }));
      await expect(resumeCommand("run-partial")).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("exits 1 when a nodeResults entry is missing required fields", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        id: "run-1",
        workflowName: "test",
        status: "failed",
        startedAt: new Date().toISOString(),
        completedNodes: ["n1"],
        nodeResults: { n1: { output: "x" } }, // missing exitCode + durationMs
        totalCostUsd: 0,
        retryCounters: {},
      }));
      await expect(resumeCommand("run-broken-result")).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts a checkpoint with unknown extra fields (passthrough forward-compat)", async () => {
      const state = makeRunState({
        status: "completed",
      });
      // A status: "completed" run short-circuits before workflow load, so
      // this exercises the schema acceptance path cleanly.
      const withExtras = { ...state, futureField: { newThing: true } };
      mockReadFile.mockResolvedValue(JSON.stringify(withExtras));
      await resumeCommand("run-future");
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  it("registers event listeners on the scheduler", async () => {
    const state = makeRunState({
      status: "paused",
      workflowPath: "/fake/workflow.json",
    });
    mockReadFile.mockResolvedValue(JSON.stringify(state));
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: { nodeA: {} },
      edges: [],
    });
    const mockOn = vi.fn();
    MockScheduler.mockImplementation(() => ({
      on: mockOn,
      resume: vi.fn().mockResolvedValue({ success: true, durationMs: 100 }),
    }));
    await resumeCommand("run-abc12345");
    // Should register node_start, node_event, node_end listeners
    const events = mockOn.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toContain("node_start");
    expect(events).toContain("node_event");
    expect(events).toContain("node_end");
  });

  describe("drift detection", () => {
    it("exits 1 when --check-drift is set and environment drift is detected", async () => {
      const state = makeRunState({
        status: "paused",
        workflowPath: "/fake/workflow.json",
        environment: {
          sygilVersion: "0.1.0",
          adapterVersions: { "claude-cli": "2.5.0" },
          nodeVersion: "20.0.0",
          platform: "linux-x64",
        },
      });
      mockReadFile.mockResolvedValue(JSON.stringify(state));
      mockLoadWorkflow.mockResolvedValue({
        version: "1",
        name: "test-workflow",
        nodes: { nodeA: { adapter: "claude-cli", model: "claude-3", role: "agent", prompt: "p" } },
        edges: [],
      });
      // Simulate drift: adapter version changed
      mockDiffEnvironment.mockReturnValue(["claude-cli: 2.5.0 → 2.6.0"]);

      await expect(resumeCommand("run-abc12345", { checkDrift: true })).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("proceeds silently by default even with drift (drift check is opt-in)", async () => {
      const state = makeRunState({
        status: "paused",
        workflowPath: "/fake/workflow.json",
        environment: {
          sygilVersion: "0.1.0",
          adapterVersions: { "claude-cli": "2.5.0" },
          nodeVersion: "20.0.0",
          platform: "linux-x64",
        },
      });
      mockReadFile.mockResolvedValue(JSON.stringify(state));
      mockLoadWorkflow.mockResolvedValue({
        version: "1",
        name: "test-workflow",
        nodes: { nodeA: { adapter: "claude-cli", model: "claude-3", role: "agent", prompt: "p" } },
        edges: [],
      });
      mockDiffEnvironment.mockReturnValue(["claude-cli: 2.5.0 → 2.6.0"]);

      // No --check-drift flag → drift detection skipped, no exit
      await resumeCommand("run-abc12345", {});
      expect(processExitSpy).not.toHaveBeenCalledWith(1);
    });

    it("proceeds without drift check when state has no environment field", async () => {
      const state = makeRunState({
        status: "paused",
        workflowPath: "/fake/workflow.json",
        // No environment field
      });
      mockReadFile.mockResolvedValue(JSON.stringify(state));
      mockLoadWorkflow.mockResolvedValue({
        version: "1",
        name: "test-workflow",
        nodes: { nodeA: {} },
        edges: [],
      });
      mockDiffEnvironment.mockReturnValue([]);

      await resumeCommand("run-abc12345", {});
      expect(processExitSpy).not.toHaveBeenCalledWith(1);
    });
  });

  describe("runId validation (path traversal guard)", () => {
    it.each([
      "../../etc/passwd",
      "..\\..\\windows\\system32",
      "run/with/slash",
      "run with space",
      "run;rm -rf /",
      "run null",
    ])("exits 1 with invalid runId %s", async (badId) => {
      await expect(resumeCommand(badId)).rejects.toThrow("process.exit(1)");
      expect(processExitSpy).toHaveBeenCalledWith(1);
      // Critical: the path-traversal runId should be rejected BEFORE any readFile attempt
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it.each(["run-abc12345", "RUN_ABC", "abc-DEF_123"])(
      "accepts safe runId %s and proceeds to readFile",
      async (goodId) => {
        mockReadFile.mockRejectedValue(new Error("ENOENT")); // proceed past guard, fail later
        await expect(resumeCommand(goodId)).rejects.toThrow("process.exit(1)");
        expect(mockReadFile).toHaveBeenCalled();
      }
    );
  });
});
