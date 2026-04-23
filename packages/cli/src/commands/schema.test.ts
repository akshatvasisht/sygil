import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { generateWorkflowJsonSchema, schemaCommand } from "./schema.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, writeFile, mkdir } from "node:fs/promises";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;

describe("generateWorkflowJsonSchema", () => {
  it("produces draft-07 schema with $id and title", () => {
    const schema = generateWorkflowJsonSchema();
    expect(schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema["$id"]).toContain("workflow.schema.json");
    expect(schema["title"]).toBe("Sygil Workflow Graph");
    expect(schema["type"]).toBe("object");
  });

  it("captures required top-level fields", () => {
    const schema = generateWorkflowJsonSchema();
    const required = schema["required"] as string[];
    expect(required).toContain("version");
    expect(required).toContain("name");
    expect(required).toContain("nodes");
    expect(required).toContain("edges");
  });

  it("captures adapter enum in node properties", () => {
    const schema = generateWorkflowJsonSchema();
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    const nodesSchema = properties["nodes"]!;
    const nodeValue = nodesSchema["additionalProperties"] as Record<string, unknown>;
    const nodeProps = nodeValue["properties"] as Record<string, Record<string, unknown>>;
    const adapter = nodeProps["adapter"]!;
    expect(adapter["type"]).toBe("string");
    const adapterEnum = adapter["enum"] as string[];
    expect(adapterEnum).toContain("claude-cli");
    expect(adapterEnum).toContain("gemini-cli");
    expect(adapterEnum).toContain("local-oai");
  });
});

describe("schemaCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let stdoutSpy: MockInstance<any[], any>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("writes schema to --out path", async () => {
    await schemaCommand({ out: "/tmp/workflow.schema.json" });
    expect(mockMkdir).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0]!;
    expect(path).toBe("/tmp/workflow.schema.json");
    expect(String(content)).toContain("\"$schema\"");
    expect(String(content).endsWith("\n")).toBe(true);
  });

  it("writes to stdout when --out omitted", async () => {
    await schemaCommand({});
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = String(stdoutSpy.mock.calls[0]![0]);
    expect(output).toContain("\"$schema\"");
  });

  it("--check succeeds when checked-in file matches", async () => {
    const expected = JSON.stringify(generateWorkflowJsonSchema(), null, 2) + "\n";
    mockReadFile.mockResolvedValueOnce(expected);
    await schemaCommand({ out: "/tmp/workflow.schema.json", check: true });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/up-to-date/));
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("--check fails when checked-in file differs", async () => {
    mockReadFile.mockResolvedValueOnce("{\n  \"$schema\": \"stale\"\n}\n");
    await expect(
      schemaCommand({ out: "/tmp/workflow.schema.json", check: true })
    ).rejects.toThrow("process.exit(1)");
  });

  it("--check without --out fails cleanly", async () => {
    await expect(schemaCommand({ check: true })).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/--check requires --out/));
  });
});
