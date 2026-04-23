import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { importTemplateCommand } from "./import-template.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

// The destination-path write now goes through our `writeFileAtomic` shim
// (backed by the `write-file-atomic` npm library, which uses its own tmp+rename
// scheme bypassing the `node:fs/promises` mocks above). Stub the shim directly
// so tests don't touch the real FS.
vi.mock("../utils/atomic-write.js", () => ({
  writeFileAtomic: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/workflow.js", () => ({
  loadWorkflow: vi.fn(),
}));

vi.mock("../utils/registry.js", () => ({
  listUserTemplates: vi.fn().mockResolvedValue([]),
  USER_TEMPLATES_DIR: vi.fn().mockReturnValue("/home/test/.sygil/templates"),
}));

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { loadWorkflow } from "../utils/workflow.js";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockUnlink = unlink as ReturnType<typeof vi.fn>;
const mockLoadWorkflow = loadWorkflow as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importTemplateCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  const VALID_WORKFLOW = {
    version: "1",
    name: "imported-template",
    nodes: { nodeA: { adapter: "claude-sdk", model: "claude-opus-4-5", role: "agent", prompt: "test" } },
    edges: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(_code)})`);
      }
    );
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports a local file and saves it to user templates directory", async () => {
    const content = JSON.stringify(VALID_WORKFLOW);
    mockReadFile.mockResolvedValue(content);
    mockLoadWorkflow.mockResolvedValue(VALID_WORKFLOW);

    await importTemplateCommand("/path/to/template.json");

    // Should write a temp file then the final destination
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockMkdir).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Imported template")
    );
  });

  it("uses the workflow name from the loaded workflow for the template filename", async () => {
    const content = JSON.stringify(VALID_WORKFLOW);
    mockReadFile.mockResolvedValue(content);
    mockLoadWorkflow.mockResolvedValue(VALID_WORKFLOW);

    await importTemplateCommand("/path/to/template.json");

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("imported-template");
  });

  it("exits 1 when the file cannot be read", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(importTemplateCommand("/nonexistent.json")).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read")
    );
  });

  it("exits 1 when the JSON fails workflow validation", async () => {
    const content = JSON.stringify({ invalid: true });
    mockReadFile.mockResolvedValue(content);
    mockLoadWorkflow.mockRejectedValue(new Error("Workflow validation failed"));

    await expect(importTemplateCommand("/path/to/bad.json")).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Validation failed")
    );
  });

  it("handles URL imports via fetch", async () => {
    const content = JSON.stringify(VALID_WORKFLOW);
    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(content),
    });
    vi.stubGlobal("fetch", mockFetch);
    mockLoadWorkflow.mockResolvedValue(VALID_WORKFLOW);

    await importTemplateCommand("https://example.com/template.json");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/template.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Imported template")
    );

    vi.unstubAllGlobals();
  });

  it("exits 1 when URL fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(importTemplateCommand("https://example.com/missing.json")).rejects.toThrow(
      "process.exit(1)"
    );

    vi.unstubAllGlobals();
  });

  it("derives template name from filename when workflow has no name", async () => {
    const noNameWorkflow = { ...VALID_WORKFLOW, name: undefined };
    const content = JSON.stringify(noNameWorkflow);
    mockReadFile.mockResolvedValue(content);
    mockLoadWorkflow.mockResolvedValue(noNameWorkflow);

    await importTemplateCommand("/path/to/my-cool-template.json");

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    // Should derive name from the file basename
    expect(output).toContain("my-cool-template");
  });
});
