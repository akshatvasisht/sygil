import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { validateCommand } from "./validate.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

function validWorkflow(): object {
  return {
    version: "1",
    name: "test-workflow",
    nodes: {
      nodeA: { adapter: "echo", model: "test", role: "assistant", prompt: "hello" },
      nodeB: { adapter: "echo", model: "test", role: "assistant", prompt: "world" },
    },
    edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateCommand", () => {
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
    // Use a no-op mock so process.exit() does NOT throw.
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null | undefined) => undefined as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs success and exits 0 for a valid workflow", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(validWorkflow()));

    await validateCommand("workflow.json");

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Valid"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("2 nodes"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("1 edges"));
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(processExitSpy).not.toHaveBeenCalledWith(1);
  });

  it("logs error and exits 1 when file is not found", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );

    await validateCommand("missing.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot read workflow file"),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(processExitSpy).not.toHaveBeenCalledWith(0);
  });

  it("logs error and exits 1 when JSON is invalid", async () => {
    mockReadFile.mockResolvedValue("not { valid json");

    await validateCommand("bad.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("logs error and exits 1 when schema validation fails (missing required field)", async () => {
    // Missing "nodes" and "edges" fields — schema rejects it.
    mockReadFile.mockResolvedValue(JSON.stringify({ version: "1", name: "bare" }));

    await validateCommand("invalid.json");

    const allErrors = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(allErrors).toContain("Workflow validation failed");
    // Path-prefixed bullet format: "• <path>: <message>"
    expect(allErrors).toMatch(/• (nodes|edges): /);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("prints bad node config issues in '• path: message' format", async () => {
    const bad = {
      version: "1",
      name: "bad-node",
      nodes: {
        nodeA: {
          adapter: "echo",
          model: "", // fails min(1)
          role: "assistant",
          prompt: "hi",
        },
      },
      edges: [],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(bad));

    await validateCommand("workflow.json");

    const allErrors = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(allErrors).toContain("• nodes.nodeA.model:");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("passes the correct file path to readFile", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(validWorkflow()));

    await validateCommand("/absolute/path/workflow.json");

    expect(mockReadFile).toHaveBeenCalledWith("/absolute/path/workflow.json", "utf8");
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects a workflow whose regex gate has a ReDoS pattern (post-schema invariant)", async () => {
    // Cycle 14: validate now runs the same post-schema invariants as
    // loadWorkflow / `sygil run -` stdin. Without this, validate would
    // pass and `sygil run` would later reject with the load-time guard,
    // giving false confidence to users who pre-validated.
    const reDoSWorkflow = {
      version: "1",
      name: "redos",
      nodes: {
        a: { adapter: "echo", model: "echo", role: "r", prompt: "p" },
        b: { adapter: "echo", model: "echo", role: "r", prompt: "p" },
      },
      edges: [
        {
          id: "e",
          from: "a",
          to: "b",
          gate: { conditions: [{ type: "regex", filePath: "out.txt", pattern: "(a+)+" }] },
        },
      ],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(reDoSWorkflow));

    await validateCommand("workflow.json");

    const allErrors = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(allErrors).toMatch(/nested unbounded quantifiers/);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
