import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { runCommand } from "./run.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
  interpolateWorkflow: vi.fn((wf: unknown) => wf),
  validateWorkflowInvariants: vi.fn(),
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
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("open", () => ({ default: vi.fn() }));

import { loadWorkflow, interpolateWorkflow } from "../utils/workflow.js";
import { getAdapter } from "../adapters/index.js";
import { buildSchedulerContext } from "./_scheduler-bootstrap.js";
import { readConfig, readConfigSafe } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { pruneWorktrees } from "../worktree/index.js";
import { access } from "node:fs/promises";

const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;
const mockInterpolateWorkflow = interpolateWorkflow as ReturnType<typeof vi.fn>;
const mockGetAdapter = getAdapter as ReturnType<typeof vi.fn>;
const mockBuildSchedulerContext = buildSchedulerContext as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockReadConfigSafe = readConfigSafe as ReturnType<typeof vi.fn>;
const mockResolveModelTiersAndLog = resolveModelTiersAndLog as ReturnType<typeof vi.fn>;
const mockPruneWorktrees = pruneWorktrees as ReturnType<typeof vi.fn>;
const mockAccess = access as ReturnType<typeof vi.fn>;

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

// ---------------------------------------------------------------------------
// stdin mode: workflowPath === "-"
// ---------------------------------------------------------------------------

describe("runCommand — stdin mode (workflowPath = '-')", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy types
  let processExitSpy: MockInstance<any[], never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy types
  let consoleErrorSpy: MockInstance<any[], any>;

  const STDIN_WORKFLOW = JSON.stringify({
    version: "1",
    name: "stdin-workflow",
    nodes: {
      agent: { adapter: "echo", model: "echo", role: "Agent", prompt: "Do stuff" },
    },
    edges: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((_: unknown) => undefined as never);
    // Default mocks
    mockGetAdapter.mockReturnValue({ isAvailable: vi.fn().mockResolvedValue(true) });
    mockInterpolateWorkflow.mockImplementation((wf: unknown) => wf);
    mockReadConfig.mockResolvedValue(null);
    mockReadConfigSafe.mockResolvedValue(null);
    mockResolveModelTiersAndLog.mockImplementation((wf: unknown) => wf);
    mockPruneWorktrees.mockResolvedValue(undefined);
    mockBuildSchedulerContext.mockRejectedValue(new Error("no scheduler in test"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads workflow JSON from stdin when workflowPath is '-'", async () => {
    // Simulate stdin producing the workflow JSON
    const chunks = [Buffer.from(STDIN_WORKFLOW)];
    const fakeStdin = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<{ value: Buffer; done: false } | { value: undefined; done: true }> {
            if (i < chunks.length) {
              return Promise.resolve({ value: chunks[i++]!, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as unknown as typeof process.stdin);

    await runCommand("-", undefined, {});

    // loadWorkflow should NOT have been called for the stdin path
    expect(mockLoadWorkflow).not.toHaveBeenCalled();
    // interpolateWorkflow should have been called with our workflow (adapter available)
    expect(mockInterpolateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stdin-workflow" }),
      expect.anything()
    );
  });

  it("exits with error if stdin contains invalid JSON", async () => {
    const fakeStdin = {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next(): Promise<{ value: Buffer; done: false } | { value: undefined; done: true }> {
            if (!done) {
              done = true;
              return Promise.resolve({ value: Buffer.from("not json {{"), done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as unknown as typeof process.stdin);

    await runCommand("-", undefined, {});

    // process.exit(1) should have been called; the specific error text is in spinner.fail
    // which wraps the "not valid JSON" message internally
    expect(processExitSpy).toHaveBeenCalledWith(1);
    // interpolateWorkflow must not have been called (exited before reaching it)
    expect(mockInterpolateWorkflow).not.toHaveBeenCalled();
  });

  it("still uses loadWorkflow for non-stdin paths", async () => {
    const wf = makeWorkflow();
    mockLoadWorkflow.mockResolvedValue(wf);
    mockBuildSchedulerContext.mockRejectedValue(new Error("no scheduler in test"));

    await runCommand("workflow.json", undefined, {});

    expect(mockLoadWorkflow).toHaveBeenCalledWith("workflow.json");
  });
});

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

// ---------------------------------------------------------------------------
// Template-name resolution
// ---------------------------------------------------------------------------

describe("runCommand — template-name resolution", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy types
  let processExitSpy: MockInstance<any[], never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy types
  let consoleErrorSpy: MockInstance<any[], any>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((_: unknown) => undefined as never);
    mockGetAdapter.mockReturnValue({ isAvailable: vi.fn().mockResolvedValue(true) });
    mockInterpolateWorkflow.mockImplementation((wf: unknown) => wf);
    mockReadConfig.mockResolvedValue(null);
    mockReadConfigSafe.mockResolvedValue(null);
    mockResolveModelTiersAndLog.mockImplementation((wf: unknown) => wf);
    mockPruneWorktrees.mockResolvedValue(undefined);
    mockBuildSchedulerContext.mockRejectedValue(new Error("no scheduler in test"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bare template name resolves to bundled file when access succeeds", async () => {
    // access() succeeds → template exists in the bundled templates dir
    mockAccess.mockResolvedValue(undefined);
    mockLoadWorkflow.mockResolvedValue(makeWorkflow());

    await runCommand("tdd-feature", undefined, {});

    // loadWorkflow should have been called with a path that ends in tdd-feature.json
    expect(mockLoadWorkflow).toHaveBeenCalledWith(
      expect.stringMatching(/tdd-feature\.json$/)
    );
    // The path should contain 'templates' (bundled dir, not a bare name)
    const calledPath = mockLoadWorkflow.mock.calls[0]?.[0] as string;
    expect(calledPath).toMatch(/templates/);
  });

  it("explicit file path still passes through to loadWorkflow unchanged", async () => {
    mockLoadWorkflow.mockResolvedValue(makeWorkflow());

    await runCommand("my-workflow.json", undefined, {});

    expect(mockLoadWorkflow).toHaveBeenCalledWith("my-workflow.json");
  });

  it("unknown bare name falls back to loadWorkflow and exits with error code 1", async () => {
    // access() throws → template not found in bundled dir
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    // loadWorkflow also throws → not found as a file path either (neither template search
    // path nor explicit file path match, so the user gets a clear ENOENT from loadWorkflow)
    mockLoadWorkflow.mockRejectedValue(
      new Error("ENOENT: no such file or directory, open 'nonexistent'")
    );

    await runCommand("nonexistent", undefined, {});

    // process.exit(1) should be called — the spinner.fail message contains
    // "Failed to load workflow: ENOENT: no such file or directory, open 'nonexistent'"
    expect(processExitSpy).toHaveBeenCalledWith(1);
    // loadWorkflow must have been invoked (bare name fell through after access() miss)
    expect(mockLoadWorkflow).toHaveBeenCalledWith("nonexistent");
  });
});
