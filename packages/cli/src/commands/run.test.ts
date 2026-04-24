import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { runCommand } from "./run.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
  interpolateWorkflow: vi.fn((wf: unknown) => wf),
}));

vi.mock("../adapters/index.js", () => ({
  getAdapter: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock("../worktree/index.js", () => ({
  pruneWorktrees: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/config.js", () => ({
  readConfig: vi.fn().mockResolvedValue(null),
  readConfigSafe: vi.fn().mockResolvedValue(null),
}));

vi.mock("../utils/tier-resolver.js", () => ({
  resolveModelTiersAndLog: vi.fn((wf: unknown) => wf),
}));

vi.mock("@sygil/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sygil/shared")>();
  return {
    ...actual,
    validateWorkflowTools: vi.fn(() => []),
  };
});

vi.mock("./_scheduler-bootstrap.js", () => ({
  buildSchedulerContext: vi.fn(),
  formatMetricsUrl: vi.fn().mockReturnValue("http://localhost:9090/metrics"),
}));

vi.mock("../utils/watcher.js", () => ({
  WorkflowWatcher: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../utils/telemetry.js", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("../monitor/terminal-renderer.js", () => ({
  createTerminalMonitor: vi.fn().mockReturnValue({ stop: vi.fn(), update: vi.fn() }),
  formatEventSummary: vi.fn().mockReturnValue("event"),
  logEvent: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("open", () => ({ default: vi.fn() }));

import { loadWorkflow, interpolateWorkflow } from "../utils/workflow.js";
import { getAdapter } from "../adapters/index.js";
import { buildSchedulerContext } from "./_scheduler-bootstrap.js";
import { readConfig, readConfigSafe } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { pruneWorktrees } from "../worktree/index.js";

const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;
const mockInterpolateWorkflow = interpolateWorkflow as ReturnType<typeof vi.fn>;
const mockGetAdapter = getAdapter as ReturnType<typeof vi.fn>;
const mockBuildSchedulerContext = buildSchedulerContext as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockReadConfigSafe = readConfigSafe as ReturnType<typeof vi.fn>;
const mockResolveModelTiersAndLog = resolveModelTiersAndLog as ReturnType<typeof vi.fn>;
const mockPruneWorktrees = pruneWorktrees as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helper: minimal valid workflow
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    version: "1",
    name: "test-workflow",
    nodes: {
      nodeA: { adapter: "echo", model: "test", role: "assistant", prompt: "hi" },
    },
    edges: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCommand — A.9 availability pre-flight before interpolation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => undefined as never);

    // Default: workflow loads successfully
    mockLoadWorkflow.mockResolvedValue(makeWorkflow());
    // Default: interpolation tracks calls
    mockInterpolateWorkflow.mockImplementation((wf: unknown) => wf);
    // Default: config mocks (must be re-set after vi.clearAllMocks())
    mockReadConfig.mockResolvedValue(null);
    mockReadConfigSafe.mockResolvedValue(null);
    mockResolveModelTiersAndLog.mockImplementation((wf: unknown) => wf);
    mockPruneWorktrees.mockResolvedValue(undefined);
    // Default: adapter available
    mockGetAdapter.mockReturnValue({ isAvailable: vi.fn().mockResolvedValue(true) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits before interpolateWorkflow when adapter is unavailable", async () => {
    // Adapter unavailable
    mockGetAdapter.mockReturnValue({
      isAvailable: vi.fn().mockResolvedValue(false),
    });

    // Track interpolation calls
    let interpolateCalled = false;
    mockInterpolateWorkflow.mockImplementation((wf: unknown) => {
      interpolateCalled = true;
      return wf;
    });

    await runCommand("workflow.json", undefined, {});

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(interpolateCalled).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not available")
    );
  });

  it("proceeds to interpolation when adapter is available", async () => {
    // Adapter available, but no scheduler context → exits after interpolation
    mockGetAdapter.mockReturnValue({
      isAvailable: vi.fn().mockResolvedValue(true),
    });
    mockBuildSchedulerContext.mockRejectedValue(new Error("no scheduler in test"));

    let interpolateCalled = false;
    mockInterpolateWorkflow.mockImplementation((wf: unknown) => {
      interpolateCalled = true;
      return wf;
    });

    await runCommand("workflow.json", undefined, {});

    // interpolateWorkflow was called because adapter was available
    expect(interpolateCalled).toBe(true);
  });
});
