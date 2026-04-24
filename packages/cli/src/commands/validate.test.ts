import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { validateCommand } from "./validate.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
}));

// Mock WorkflowGraphSchema so we can test the safeParse path directly.
vi.mock("@sygil/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sygil/shared")>();
  return { ...actual };
});

import { loadWorkflow } from "../utils/workflow.js";
import { WorkflowGraphSchema } from "@sygil/shared";

const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;

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
  let safeParseOriginal: typeof WorkflowGraphSchema.safeParse;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Use a no-op mock so process.exit() does NOT throw — validate.ts calls
    // process.exit(0) inside a try block, so any thrown error would be caught
    // and treated as a failure. We just record the call instead.
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null | undefined) => undefined as never
    );
    safeParseOriginal = WorkflowGraphSchema.safeParse.bind(WorkflowGraphSchema);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs success and exits 0 for a valid workflow", async () => {
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test-workflow",
      nodes: {
        nodeA: { adapter: "echo", model: "test", role: "assistant", prompt: "hello" },
        nodeB: { adapter: "echo", model: "test", role: "assistant", prompt: "world" },
      },
      edges: [{ id: "a-to-b", from: "nodeA", to: "nodeB" }],
    });

    await validateCommand("workflow.json");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Valid")
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 nodes")
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 edges")
    );
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(processExitSpy).not.toHaveBeenCalledWith(1);
  });

  it("logs error and exits 1 when loadWorkflow throws (file not found)", async () => {
    mockLoadWorkflow.mockRejectedValue(
      new Error('Cannot read workflow file "missing.json": ENOENT: no such file or directory')
    );

    await validateCommand("missing.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot read workflow file")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(processExitSpy).not.toHaveBeenCalledWith(0);
  });

  it("logs error and exits 1 when JSON is invalid", async () => {
    mockLoadWorkflow.mockRejectedValue(
      new Error('Workflow file "bad.json" is not valid JSON: Unexpected token }')
    );

    await validateCommand("bad.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not valid JSON")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("logs error and exits 1 when schema validation fails (missing required field)", async () => {
    // loadWorkflow itself throws when schema validation fails
    mockLoadWorkflow.mockRejectedValue(
      new Error("Workflow validation failed:\n  - nodes: At least one node is required")
    );

    await validateCommand("invalid.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Workflow validation failed")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("prints issues as '• path: message' format when safeParse fails on loaded data", async () => {
    // Return data that passes loadWorkflow but fails safeParse (we spy on safeParse)
    const validLooking = {
      version: "1",
      name: "test-workflow",
      nodes: {
        nodeA: { adapter: "echo", model: "test", role: "assistant", prompt: "hi" },
      },
      edges: [],
    };
    mockLoadWorkflow.mockResolvedValue(validLooking);

    // Override safeParse to simulate a schema failure on re-validation
    vi.spyOn(WorkflowGraphSchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: {
        issues: [
          { path: ["nodes", "nodeA", "timeoutMs"], message: "Expected positive number" },
        ],
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await validateCommand("workflow.json");

    const allErrors = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(allErrors).toContain("• nodes.nodeA.timeoutMs: Expected positive number");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("handles non-Error thrown values gracefully", async () => {
    mockLoadWorkflow.mockRejectedValue("some string error");

    await validateCommand("workflow.json");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("some string error")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("passes the correct file path to loadWorkflow", async () => {
    mockLoadWorkflow.mockResolvedValue({
      version: "1",
      name: "test",
      nodes: {
        nodeA: { adapter: "echo", model: "test", role: "assistant", prompt: "hi" },
      },
      edges: [],
    });

    await validateCommand("/absolute/path/workflow.json");

    expect(mockLoadWorkflow).toHaveBeenCalledWith("/absolute/path/workflow.json");
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
