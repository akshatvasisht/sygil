import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchTemplates,
  listUserTemplates,
  REGISTRY_INDEX_URL,
} from "./registry.js";
import type { RegistryIndex, RegistryEntry } from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "basic",
    description: "A basic template",
    url: "https://example.com/basic.json",
    tags: ["starter"],
    author: "test",
    adapterRequirements: ["claude-sdk"],
    ...overrides,
  };
}

function makeIndex(templates: RegistryEntry[] = []): RegistryIndex {
  return {
    version: "1",
    updatedAt: new Date().toISOString(),
    templates,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REGISTRY_INDEX_URL", () => {
  it("points to the expected GitHub URL", () => {
    expect(REGISTRY_INDEX_URL).toContain("github");
    expect(REGISTRY_INDEX_URL).toContain("index.json");
  });
});

describe("searchTemplates", () => {
  it("returns empty array when no templates match", () => {
    const index = makeIndex([makeEntry()]);
    const results = searchTemplates(index, "nonexistent");
    expect(results).toEqual([]);
  });

  it("matches by name (case insensitive)", () => {
    const index = makeIndex([
      makeEntry({ name: "React-App" }),
      makeEntry({ name: "vue-starter" }),
    ]);
    const results = searchTemplates(index, "react");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("React-App");
  });

  it("matches by description", () => {
    const index = makeIndex([
      makeEntry({ name: "template-a", description: "Uses GraphQL for queries" }),
      makeEntry({ name: "template-b", description: "REST API starter" }),
    ]);
    const results = searchTemplates(index, "graphql");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("template-a");
  });

  it("matches by tags", () => {
    const index = makeIndex([
      makeEntry({ name: "tagged", tags: ["frontend", "react"] }),
      makeEntry({ name: "untagged", tags: ["backend"] }),
    ]);
    const results = searchTemplates(index, "frontend");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("tagged");
  });

  it("returns multiple matches", () => {
    const index = makeIndex([
      makeEntry({ name: "auth-basic" }),
      makeEntry({ name: "auth-advanced" }),
      makeEntry({ name: "database" }),
    ]);
    const results = searchTemplates(index, "auth");
    expect(results).toHaveLength(2);
  });

  it("returns all templates when query matches everything", () => {
    const index = makeIndex([
      makeEntry({ name: "a", description: "test" }),
      makeEntry({ name: "b", description: "test" }),
    ]);
    const results = searchTemplates(index, "test");
    expect(results).toHaveLength(2);
  });
});

describe("listUserTemplates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await listUserTemplates("/nonexistent/dir");
    expect(result).toEqual([]);
  });

  it("returns only .json files from the directory", async () => {
    // Use a real temp dir for this test
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "sygil-registry-test-"));
    try {
      await writeFile(join(dir, "template-a.json"), "{}", "utf8");
      await writeFile(join(dir, "template-b.json"), "{}", "utf8");
      await writeFile(join(dir, "readme.md"), "# readme", "utf8");

      const result = await listUserTemplates(dir);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toContain("template-a");
      expect(result.map((r) => r.name)).toContain("template-b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns name without .json extension", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "sygil-registry-test-"));
    try {
      await writeFile(join(dir, "my-template.json"), "{}", "utf8");

      const result = await listUserTemplates(dir);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("my-template");
      expect(result[0]!.path).toContain("my-template.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
