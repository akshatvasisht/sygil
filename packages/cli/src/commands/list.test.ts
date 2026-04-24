import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { listCommand } from "./list.js";
import type { WorkflowRunState } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  getAdapter: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(false),
  }),
}));

// Mock fileURLToPath and URL so bundled template dir resolves predictably
vi.mock("node:url", () => ({
  fileURLToPath: vi.fn().mockReturnValue("/mock/templates"),
}));

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getAdapter } from "../adapters/index.js";

const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockGetAdapter = getAdapter as ReturnType<typeof vi.fn>;
const mockFileURLToPath = fileURLToPath as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: "run-abc12345-def",
    workflowName: "my-workflow",
    status: "completed",
    startedAt: new Date("2024-01-15T10:00:00Z").toISOString(),
    completedNodes: [],
    nodeResults: {},
    totalCostUsd: 0.0042,
    retryCounters: {},
    sharedContext: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Restore fileURLToPath mock after vi.clearAllMocks() resets it
    mockFileURLToPath.mockReturnValue("/mock/templates");
    // Default: no templates dirs, no runs
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    // Default adapter: unavailable
    mockGetAdapter.mockReturnValue({ isAvailable: vi.fn().mockResolvedValue(false) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs without error when there are no runs and no templates", async () => {
    await expect(listCommand()).resolves.toBeUndefined();
  });

  it("shows 'No runs found' message when runs directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("No runs found");
  });

  it("shows 'No runs found' when runs dir exists but has no JSON files", async () => {
    // readdir returns no files for templates dirs (throw), then returns empty for runs dir
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) return Promise.resolve([]);
      return Promise.reject(new Error("ENOENT"));
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("No runs found");
  });

  it("displays run entries when run files exist", async () => {
    const state = makeRunState();

    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(["run-abc12345.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes("run-abc12345.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("completed");
    expect(output).toContain("my-workflow");
  });

  it("truncates run ID to 12 characters with ellipsis when ID is longer than 12 chars", async () => {
    // ID longer than 12 chars — should display first 12 + "…"
    const state = makeRunState({ id: "run-abc12345-uniqueid" });

    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(["run-abc12345.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes("run-abc12345.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    // First 12 chars of "run-abc12345-uniqueid" is "run-abc12345"
    expect(output).toContain("run-abc12345…");
    // Footer hint references the full ID storage location
    expect(output).toContain(".sygil/runs");
  });

  it("shows run ID unchanged when it is 12 chars or shorter (no ellipsis)", async () => {
    const state = makeRunState({ id: "short-id" });

    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(["short-id.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes("short-id.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("short-id");
    // No ellipsis when ID fits
    expect(output).not.toMatch(/short-id…/);
  });

  it("skips unparseable run files gracefully", async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(["bad-run.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    // readFile returns invalid JSON
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes("bad-run.json")) {
        return Promise.resolve("not valid json{{");
      }
      return Promise.reject(new Error("not found"));
    });

    // Should not throw
    await expect(listCommand()).resolves.toBeUndefined();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    // Should show the "could not parse" fallback message
    expect(output).toContain("could not parse");
  });

  it("shows adapter availability status", async () => {
    // Make claude-cli available
    mockGetAdapter.mockImplementation((type: string) => {
      if (type === "claude-cli") {
        return { isAvailable: vi.fn().mockResolvedValue(true) };
      }
      return { isAvailable: vi.fn().mockResolvedValue(false) };
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    // Should show both ✓ and ✗ symbols
    expect(output).toContain("✓");
    expect(output).toContain("✗");
  });

  it("shows 'No templates found' when no template directories exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("No templates found");
  });

  it("displays templates when bundled templates dir has JSON files", async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir) === "/mock/templates") {
        return Promise.resolve(["basic.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReadFile.mockImplementation((path: unknown) => {
      if (String(path).endsWith("basic.json")) {
        return Promise.resolve(
          JSON.stringify({ name: "basic-workflow", description: "A basic workflow" })
        );
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("basic-workflow");
    expect(output).toContain("A basic workflow");
  });

  it("limits displayed runs to last 10 entries", async () => {
    // Create 15 run filenames
    const files = Array.from({ length: 15 }, (_, i) =>
      `run-${String(i).padStart(3, "0")}.json`
    );

    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(files);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReadFile.mockImplementation((path: string) => {
      const match = /run-(\d+)\.json/.exec(String(path));
      if (match) {
        return Promise.resolve(
          JSON.stringify(makeRunState({ id: `run-${match[1]!}-id`, workflowName: `wf-${match[1]!}` }))
        );
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    // Count how many "wf-" entries appear in output (each run shows its workflowName)
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    const matches = output.match(/wf-/g);
    expect(matches).not.toBeNull();
    // Should show at most 10 runs (the last 10 after sort().reverse().slice(0, 10))
    expect(matches!.length).toBeLessThanOrEqual(10);
  });

  it("skips .workflow.json files in runs directory", async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes("runs")) {
        return Promise.resolve(["run-abc.json", "run-abc.workflow.json"]);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const state = makeRunState({ id: "run-abc-fullid", workflowName: "only-run" });
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes("run-abc.json") && !String(path).includes("workflow.json")) {
        return Promise.resolve(JSON.stringify(state));
      }
      return Promise.reject(new Error("not found"));
    });

    await listCommand();

    // Should show only the non-workflow run
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("only-run");
  });
});
