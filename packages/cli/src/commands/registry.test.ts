import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../utils/registry.js", () => ({
  fetchRegistryIndex: vi.fn(),
  searchTemplates: vi.fn(),
  installTemplate: vi.fn(),
  listUserTemplates: vi.fn(),
  USER_TEMPLATES_DIR: vi.fn().mockReturnValue("/home/test/.sigil/templates"),
}));

import {
  fetchRegistryIndex,
  searchTemplates,
  installTemplate,
} from "../utils/registry.js";
import type { RegistryIndex, RegistryEntry } from "../utils/registry.js";

const mockFetchRegistryIndex = fetchRegistryIndex as ReturnType<typeof vi.fn>;
const mockSearchTemplates = searchTemplates as ReturnType<typeof vi.fn>;
const mockInstallTemplate = installTemplate as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "test-template",
    description: "A test template",
    url: "https://example.com/template.json",
    tags: ["test"],
    author: "test-author",
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

// We test the registry subcommands indirectly via Commander's parseAsync.
// Import the registryCommand and invoke its subcommands.
import { registryCommand } from "./registry.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registryCommand", () => {
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
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(_code)})`);
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list subcommand", () => {
    it("displays registry templates", async () => {
      const entry = makeEntry({ name: "my-template", description: "Cool template" });
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([entry]));

      await registryCommand.parseAsync(["list"], { from: "user" });

      const output = consoleLogSpy.mock.calls.flat().join("\n");
      expect(output).toContain("my-template");
    });

    it("shows empty message when no templates exist", async () => {
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([]));

      await registryCommand.parseAsync(["list"], { from: "user" });

      const output = consoleLogSpy.mock.calls.flat().join("\n");
      expect(output).toContain("No templates found");
    });

    it("handles network errors gracefully", async () => {
      mockFetchRegistryIndex.mockRejectedValue(new Error("Registry fetch failed"));

      await expect(
        registryCommand.parseAsync(["list"], { from: "user" })
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not reach template registry")
      );
    });
  });

  describe("search subcommand", () => {
    it("displays matching templates for a query", async () => {
      const entry = makeEntry({ name: "react-app", description: "React app template" });
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([entry]));
      mockSearchTemplates.mockReturnValue([entry]);

      await registryCommand.parseAsync(["search", "react"], { from: "user" });

      const output = consoleLogSpy.mock.calls.flat().join("\n");
      expect(output).toContain("react-app");
    });

    it("shows message when no templates match", async () => {
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([]));
      mockSearchTemplates.mockReturnValue([]);

      await registryCommand.parseAsync(["search", "nonexistent"], { from: "user" });

      const output = consoleLogSpy.mock.calls.flat().join("\n");
      expect(output).toContain("No templates found matching");
    });
  });

  describe("install subcommand", () => {
    it("installs a template from the registry", async () => {
      const entry = makeEntry({ name: "install-me" });
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([entry]));
      mockInstallTemplate.mockResolvedValue("/home/test/.sigil/templates/install-me.json");

      // Mock fetch for the template download
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ name: "install-me", nodes: { a: {} }, edges: [] })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await registryCommand.parseAsync(["install", "install-me"], { from: "user" });

      const output = consoleLogSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Installed template");
      expect(output).toContain("install-me");

      vi.unstubAllGlobals();
    });

    it("exits 1 when template is not found in registry", async () => {
      mockFetchRegistryIndex.mockResolvedValue(makeIndex([]));

      await expect(
        registryCommand.parseAsync(["install", "missing"], { from: "user" })
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("not found in registry")
      );
    });
  });
});
