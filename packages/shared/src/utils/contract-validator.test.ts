import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateStructuredOutput, resolveInputMapping } from "./contract-validator.js";

// ---------------------------------------------------------------------------
// validateStructuredOutput
// ---------------------------------------------------------------------------

describe("validateStructuredOutput", () => {
  const schema = {
    properties: {
      summary: { type: "string" },
      score: { type: "number" },
      tags: { type: "array" },
      metadata: { type: "object" },
      approved: { type: "boolean" },
    },
    required: ["summary", "score"],
  };

  it("validates a correct output with all required fields", () => {
    const output = { summary: "All good", score: 95 };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates output with required and optional fields", () => {
    const output = {
      summary: "All good",
      score: 95,
      tags: ["a", "b"],
      metadata: { source: "test" },
      approved: true,
    };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null output", () => {
    const result = validateStructuredOutput(schema, null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("null or undefined");
  });

  it("rejects undefined output", () => {
    const result = validateStructuredOutput(schema, undefined);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("null or undefined");
  });

  it("rejects non-object output (string)", () => {
    const result = validateStructuredOutput(schema, "just a string");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not an object");
  });

  it("rejects non-object output (number)", () => {
    const result = validateStructuredOutput(schema, 42);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not an object");
  });

  it("rejects array output", () => {
    const result = validateStructuredOutput(schema, [1, 2, 3]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not an object");
  });

  it("reports missing required field", () => {
    const output = { score: 80 }; // missing summary
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"summary"'))).toBe(true);
  });

  it("reports multiple missing required fields", () => {
    const output = { tags: ["a"] }; // missing both summary and score
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("reports wrong type for string field", () => {
    const output = { summary: 123, score: 80 };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"summary"') && e.includes("string"))).toBe(true);
  });

  it("reports wrong type for number field", () => {
    const output = { summary: "ok", score: "not-a-number" };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"score"') && e.includes("number"))).toBe(true);
  });

  it("reports wrong type for array field", () => {
    const output = { summary: "ok", score: 1, tags: "not-an-array" };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"tags"') && e.includes("array"))).toBe(true);
  });

  it("reports wrong type for object field", () => {
    const output = { summary: "ok", score: 1, metadata: "not-an-object" };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"metadata"') && e.includes("object"))).toBe(true);
  });

  it("reports wrong type for boolean field", () => {
    const output = { summary: "ok", score: 1, approved: "yes" };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"approved"') && e.includes("boolean"))).toBe(true);
  });

  it("does not check type for fields not present in output", () => {
    // tags is not present — no type error, only required fields matter
    const output = { summary: "ok", score: 1 };
    const result = validateStructuredOutput(schema, output);
    expect(result.valid).toBe(true);
  });

  it("handles schema without properties", () => {
    const result = validateStructuredOutput({}, { anything: "goes" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("handles schema without required array", () => {
    const schemaNoReq = {
      properties: { name: { type: "string" } },
    };
    const result = validateStructuredOutput(schemaNoReq, { name: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("string"))).toBe(true);
  });

  it("handles schema with properties that have no type constraint", () => {
    const schemaNoType = {
      properties: { flexible: {} },
      required: ["flexible"],
    };
    const result = validateStructuredOutput(schemaNoType, { flexible: "anything" });
    expect(result.valid).toBe(true);
  });

  it("correctly identifies arrays vs objects in type checking", () => {
    const schemaObj = {
      properties: { data: { type: "object" } },
    };
    // Arrays are not objects for this validator
    const result = validateStructuredOutput(schemaObj, { data: [1, 2, 3] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("array"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveInputMapping
// ---------------------------------------------------------------------------

describe("resolveInputMapping", () => {
  // Mock fs module
  vi.mock("node:fs/promises", () => ({
    default: {
      readFile: vi.fn(),
    },
  }));

  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("node:fs/promises");
    mockReadFile = fs.default.readFile as unknown as ReturnType<typeof vi.fn>;
  });

  it("reads a plain file and returns its content", async () => {
    mockReadFile.mockResolvedValue("Hello, world!");

    const result = await resolveInputMapping(
      { greeting: "hello.txt" },
      "/output"
    );

    expect(result.resolved["greeting"]).toBe("Hello, world!");
    expect(result.errors).toHaveLength(0);
    expect(mockReadFile).toHaveBeenCalledWith("/output/hello.txt", "utf-8");
  });

  it("reads a JSON file and extracts a field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ summary: "All tests pass", score: 100 }));

    const result = await resolveInputMapping(
      { summary: "result.json#summary" },
      "/output"
    );

    expect(result.resolved["summary"]).toBe("All tests pass");
    expect(result.errors).toHaveLength(0);
  });

  it("reads a nested JSON field with dot notation", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ meta: { author: { name: "Alice" } } })
    );

    const result = await resolveInputMapping(
      { author: "data.json#meta.author.name" },
      "/output"
    );

    expect(result.resolved["author"]).toBe("Alice");
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty string and error for missing JSON field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ other: "value" }));

    const result = await resolveInputMapping(
      { missing: "data.json#nonexistent" },
      "/output"
    );

    expect(result.resolved["missing"]).toBe("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("field 'nonexistent' not found");
  });

  it("returns empty string and error when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    const result = await resolveInputMapping(
      { data: "missing.txt" },
      "/output"
    );

    expect(result.resolved["data"]).toBe("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("file not found");
  });

  it("returns empty string and error when JSON parse fails", async () => {
    mockReadFile.mockResolvedValue("not valid json");

    const result = await resolveInputMapping(
      { field: "bad.json#someField" },
      "/output"
    );

    expect(result.resolved["field"]).toBe("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("resolves multiple mappings", async () => {
    mockReadFile
      .mockResolvedValueOnce("file content")
      .mockResolvedValueOnce(JSON.stringify({ key: "value" }));

    const result = await resolveInputMapping(
      { plain: "file.txt", extracted: "data.json#key" },
      "/output"
    );

    expect(result.resolved["plain"]).toBe("file content");
    expect(result.resolved["extracted"]).toBe("value");
    expect(result.errors).toHaveLength(0);
  });

  it("skips entries with empty file path from split", async () => {
    // A source string starting with # would produce empty filePath
    const result = await resolveInputMapping(
      { empty: "#field" },
      "/output"
    );

    // Should be skipped entirely — not present in resolved
    expect(result.resolved["empty"]).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it("converts non-string JSON values to string", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ count: 42, active: true }));

    const result = await resolveInputMapping(
      { count: "data.json#count", active: "data.json#active" },
      "/output"
    );

    expect(result.resolved["count"]).toBe("42");
    expect(result.resolved["active"]).toBe("true");
    expect(result.errors).toHaveLength(0);
  });

  it("resolves paths relative to predecessorOutputDir", async () => {
    mockReadFile.mockResolvedValue("content");

    await resolveInputMapping(
      { file: "subdir/output.txt" },
      "/workspace/node-a/output"
    );

    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/node-a/output/subdir/output.txt"),
      "utf-8"
    );
  });

  // -------------------------------------------------------------------------
  // Error reporting — new InputMappingResult shape
  // -------------------------------------------------------------------------

  it("returns errors for missing files alongside empty resolved value", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    const result = await resolveInputMapping(
      { context: "missing.json" },
      "/nonexistent"
    );

    expect(result.resolved["context"]).toBe("");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("context");
  });

  it("returns errors for invalid JSON with field path", async () => {
    mockReadFile.mockResolvedValue("this is not json {{{");

    const result = await resolveInputMapping(
      { config: "broken.json#key" },
      "/output"
    );

    expect(result.resolved["config"]).toBe("");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("returns errors for missing field path in valid JSON", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ present: "yes" }));

    const result = await resolveInputMapping(
      { absent: "data.json#deeply.nested.missing" },
      "/output"
    );

    expect(result.resolved["absent"]).toBe("");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("not found");
  });

  it("returns resolved values alongside errors for partial success", async () => {
    // First mapping succeeds (plain file), second fails (missing file)
    mockReadFile
      .mockResolvedValueOnce("good content")
      .mockRejectedValueOnce(new Error("ENOENT"));

    const result = await resolveInputMapping(
      { good: "exists.txt", bad: "missing.txt" },
      "/output"
    );

    // The successful mapping has its value
    expect(result.resolved["good"]).toBe("good content");
    // The failed mapping has empty string
    expect(result.resolved["bad"]).toBe("");
    // Only one error (for the failed mapping)
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad");
  });

  it("accumulates multiple errors from multiple failed mappings", async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce("not json");

    const result = await resolveInputMapping(
      { first: "missing.txt", second: "bad.json#field" },
      "/output"
    );

    expect(result.errors).toHaveLength(2);
    expect(result.resolved["first"]).toBe("");
    expect(result.resolved["second"]).toBe("");
  });

  it("returns empty errors array when all mappings succeed", async () => {
    mockReadFile
      .mockResolvedValueOnce("content A")
      .mockResolvedValueOnce(JSON.stringify({ val: "B" }));

    const result = await resolveInputMapping(
      { fileA: "a.txt", fieldB: "b.json#val" },
      "/output"
    );

    expect(result.errors).toHaveLength(0);
    expect(result.resolved["fileA"]).toBe("content A");
    expect(result.resolved["fieldB"]).toBe("B");
  });
});
