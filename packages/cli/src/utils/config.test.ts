import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, writeConfig, readConfigSafe } from "./config.js";
import type { SygilConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sygil-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeValidConfig(): SygilConfig {
  return {
    version: "1",
    adapters: {
      "claude-sdk": { available: true },
      "claude-cli": { available: false, note: "claude not in PATH" },
      codex: { available: false, note: "codex not in PATH" },
      cursor: { available: false, note: "agent not in PATH" },
      echo: { available: true },
      "gemini-cli": { available: false, note: "gemini not in PATH" },
      "local-oai": { available: false, note: "no local server" },
    },
    defaultAdapter: "claude-sdk",
    detectedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config utils", () => {
  it("writeConfig + readConfig persists config to disk and reads it back with all fields intact", async () => {
    const dir = await makeTempDir();

    // Point process.cwd() to our temp dir so configPath() returns the temp path
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const config = makeValidConfig();
    await writeConfig(config);
    const loaded = await readConfig();

    expect(loaded.version).toBe(config.version);
    expect(loaded.defaultAdapter).toBe("claude-sdk");
    expect(loaded.adapters["claude-sdk"]?.available).toBe(true);
    expect(loaded.adapters["claude-cli"]?.available).toBe(false);
    expect(loaded.adapters["claude-cli"]?.note).toBe("claude not in PATH");
    expect(loaded.detectedAt).toBe(config.detectedAt);
  });

  it("readConfigSafe returns null when file does not exist", async () => {
    const dir = await makeTempDir();
    // Point to the temp dir — no config file has been written
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const result = await readConfigSafe();
    expect(result).toBeNull();
  });

  it("readConfig throws when file does not exist", async () => {
    const dir = await makeTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    await expect(readConfig()).rejects.toThrow();
  });

  it("writeConfig creates the .sygil directory if missing", async () => {
    const dir = await makeTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const config = makeValidConfig();
    // Should not throw even though .sygil dir doesn't exist yet
    await expect(writeConfig(config)).resolves.toBeUndefined();

    // Verify the file was created
    const loaded = await readConfig();
    expect(loaded.version).toBe("1");
  });

  it("readConfigSafe returns the config when it exists", async () => {
    const dir = await makeTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const config = makeValidConfig();
    await writeConfig(config);

    const result = await readConfigSafe();
    expect(result).not.toBeNull();
    expect(result?.version).toBe("1");
    expect(result?.defaultAdapter).toBe("claude-sdk");
  });
});
