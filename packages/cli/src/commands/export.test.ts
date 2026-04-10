import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { exportCommand } from "./export.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exportCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  const TEMPLATE_CONTENT = JSON.stringify({ name: "my-template", nodes: {} }, null, 2);

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${String(_code)})`);
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports a known template to the specified output path", async () => {
    mockReadFile.mockResolvedValue(TEMPLATE_CONTENT);

    await exportCommand("my-template", "output/workflow.json");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "output/workflow.json",
      TEMPLATE_CONTENT,
      "utf8"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Exported my-template")
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("output/workflow.json")
    );
  });

  it("creates the output directory if it does not exist", async () => {
    mockReadFile.mockResolvedValue(TEMPLATE_CONTENT);

    await exportCommand("my-template", "nested/dir/workflow.json");

    expect(mockMkdir).toHaveBeenCalledWith("nested/dir", { recursive: true });
  });

  it("exits 1 and lists available templates when template is not found", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockResolvedValue(["basic.json", "advanced.json"]);

    await expect(exportCommand("nonexistent", "out.json")).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Template "nonexistent" not found')
    );
    // Should list available templates
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("basic")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 and shows 'no templates' message when template not found and templates dir is empty", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // readdir throws too (empty templates dir)
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    await expect(exportCommand("nonexistent", "out.json")).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Template "nonexistent" not found')
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No templates found")
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exports template content verbatim to the output file", async () => {
    const content = '{"version":"1","name":"verbatim"}';
    mockReadFile.mockResolvedValue(content);

    await exportCommand("verbatim-template", "/absolute/output.json");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/absolute/output.json",
      content,
      "utf8"
    );
  });

  it("does not call mkdir when outputPath is at the current directory level", async () => {
    mockReadFile.mockResolvedValue(TEMPLATE_CONTENT);

    // dirname of "output.json" is "." — mkdir should not be called
    await exportCommand("my-template", "output.json");

    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("lists only .json files (strips extension) in available templates message", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockResolvedValue(["basic.json", "review-loop.json", "README.md"]);

    await expect(exportCommand("missing", "out.json")).rejects.toThrow("process.exit(1)");

    // Get the error message that lists templates
    const templateListCall = consoleErrorSpy.mock.calls.find(
      (args) => String(args[0]).includes("Available templates")
    );
    expect(templateListCall).toBeDefined();
    const msg = String(templateListCall![0]);
    expect(msg).toContain("basic");
    expect(msg).toContain("review-loop");
    // Should not include .md files
    expect(msg).not.toContain("README");
  });
});
