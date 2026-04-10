import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { resumeCommand } from "./resume.js";
import type { WorkflowRunState } from "@sigil/shared";

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
  }),
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
  }));
  return { WsMonitorServer };
});

import { readFile } from "node:fs/promises";
import { loadWorkflow } from "../utils/workflow.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import { WsMonitorServer } from "../monitor/websocket.js";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WorkflowScheduler is a mock constructor
const MockScheduler = WorkflowScheduler as unknown as ReturnType<typeof vi.fn>;
const MockMonitor = WsMonitorServer as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: "run-abc12345",
    workflowName: "test-workflow",
    status: "paused",
    startedAt: new Date().toISOString(),
    completedNodes: ["nodeA"],
    nodeResults: {},
    totalCostUsd: 0.01,
    retryCounters: {},
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
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(_code)})`);
      }
    );
    // Re-set constructor mocks after clearAllMocks
    MockMonitor.mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(9876),
      stop: vi.fn().mockResolvedValue(undefined),
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
    delete (state as unknown as Record<string, unknown>)["workflowPath"];
    mockReadFile.mockImplementation((path: string) => {
      // Only the state file should succeed
      if (String(path).includes("run-abc12345.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await expect(resumeCommand("run-abc12345")).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not find the original workflow.json")
    );
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
    const events = mockOn.mock.calls.map((c) => c[0]!);
    expect(events).toContain("node_start");
    expect(events).toContain("node_event");
    expect(events).toContain("node_end");
  });
});
