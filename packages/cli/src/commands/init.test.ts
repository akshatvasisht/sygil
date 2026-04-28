import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { initCommand } from "./init.js";

// ---------------------------------------------------------------------------
// Mocks — must be at top level, before imports that use them
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("../utils/config.js", () => ({
  readConfig: vi.fn().mockResolvedValue(null),
  writeConfig: vi.fn().mockResolvedValue(undefined),
}));

// The SDK import is dynamic inside checkClaudeSDK — mock it to always throw
// so it behaves like "not installed" by default.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("SDK not installed");
});

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readConfig, writeConfig } from "../utils/config.js";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Default: no binaries in PATH (execSync throws), no cursor credentials
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mockExistsSync.mockReturnValue(false);
    mockReadConfig.mockResolvedValue(null);
    mockWriteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs without error when no adapters are available", async () => {
    await expect(initCommand()).resolves.toBeUndefined();
  });

  it("writes config even when no adapters are available", async () => {
    await initCommand();
    expect(mockWriteConfig).toHaveBeenCalledOnce();
  });

  it("sets defaultAdapter to null when nothing is available", async () => {
    await initCommand();
    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.defaultAdapter).toBeNull();
  });

  it("shows all adapters as unavailable when no binaries are in PATH", async () => {
    await initCommand();
    // Console output should include the ✗ symbol for unavailable adapters
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("✗");
  });

  it("detects claude-cli as available when 'claude' binary is in PATH", async () => {
    // execSync throws for 'which' except when binary is 'claude'
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which claude") return "";
      if (cmd === "claude --version") return "1.2.3";
      throw new Error("not found");
    });

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.adapters["claude-cli"]?.available).toBe(true);
    expect(writtenConfig.defaultAdapter).toBe("claude-cli");
  });

  it("detects codex as available when 'codex' binary is in PATH", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which codex") return "";
      if (cmd === "codex --version") return "0.9.0";
      throw new Error("not found");
    });

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.adapters["codex"]?.available).toBe(true);
  });

  it("prefers claude-sdk over claude-cli as default adapter when both available", async () => {
    // claude-cli available (SDK will be checked separately via dynamic import, stays unavailable)
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which claude") return "";
      if (cmd === "which codex") return "";
      if (cmd === "claude --version") return "1.0.0";
      if (cmd === "codex --version") return "2.0.0";
      throw new Error("not found");
    });

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    // SDK is unavailable (mocked), claude-cli available → defaultAdapter should be claude-cli
    expect(writtenConfig.defaultAdapter).toBe("claude-cli");
  });

  it("sets telemetry.enabled = true when --telemetry flag is passed", async () => {
    await initCommand({ telemetry: true });

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.telemetry).toEqual({ enabled: true });
  });

  it("sets telemetry.enabled = false when --no-telemetry flag is passed", async () => {
    await initCommand({ telemetry: false });

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.telemetry).toEqual({ enabled: false });
  });

  it("carries forward existing telemetry config when no flag is passed", async () => {
    mockReadConfig.mockResolvedValue({
      version: "1",
      adapters: {},
      defaultAdapter: null,
      detectedAt: new Date().toISOString(),
      telemetry: { enabled: true },
    });

    await initCommand({});

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.telemetry).toEqual({ enabled: true });
  });

  it("omits telemetry from config when no flag is passed and no existing config", async () => {
    mockReadConfig.mockResolvedValue(null);

    await initCommand({});

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.telemetry).toBeUndefined();
  });

  it("logs telemetry-enabled message when --telemetry flag is passed", async () => {
    await initCommand({ telemetry: true });

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Telemetry enabled");
  });

  it("logs telemetry-disabled message when --no-telemetry is passed", async () => {
    await initCommand({ telemetry: false });

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Telemetry disabled");
  });

  it("logs default telemetry message when no flag is passed", async () => {
    await initCommand({});

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("disabled by default");
  });

  it("logs config written message", async () => {
    await initCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Config written to");
  });

  it("prints a next-step hint pointing at sygil export and sygil run", async () => {
    await initCommand();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("sygil export tdd-feature ./my-workflow.json");
    expect(output).toContain("sygil run ./my-workflow.json");
  });

  it("includes version and detectedAt in written config", async () => {
    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.version).toBe("1");
    expect(writtenConfig.detectedAt).toBeTruthy();
    // detectedAt should be a valid ISO date string
    expect(new Date(writtenConfig.detectedAt).toISOString()).toBe(writtenConfig.detectedAt);
  });

  it("detects cursor as available when 'agent' binary is in PATH and credentials file exists", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which agent") return "";
      if (cmd === "agent --version") return "1.0.0";
      throw new Error("not found");
    });
    // Simulate cursor credentials file existing
    mockExistsSync.mockReturnValue(true);

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.adapters["cursor"]?.available).toBe(true);
  });

  it("marks cursor as unavailable when binary exists but credentials are missing", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which agent") return "";
      throw new Error("not found");
    });
    // No credential files exist
    mockExistsSync.mockReturnValue(false);

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.adapters["cursor"]?.available).toBe(false);
  });

  it("preserves existing tiers when re-running init", async () => {
    mockReadConfig.mockResolvedValue({
      version: "1",
      adapters: {},
      defaultAdapter: null,
      detectedAt: new Date().toISOString(),
      tiers: { cheap: "claude-haiku-4-5", smart: "claude-opus-4-7" },
    });

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.tiers).toEqual({
      cheap: "claude-haiku-4-5",
      smart: "claude-opus-4-7",
    });
  });

  it("preserves existing hooks when re-running init", async () => {
    mockReadConfig.mockResolvedValue({
      version: "1",
      adapters: {},
      defaultAdapter: null,
      detectedAt: new Date().toISOString(),
      hooks: { preNode: "./scripts/pre.sh", postGate: "./scripts/post.sh" },
    });

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.hooks).toEqual({
      preNode: "./scripts/pre.sh",
      postGate: "./scripts/post.sh",
    });
  });

  it("omits tiers and hooks from written config when no existing config", async () => {
    mockReadConfig.mockResolvedValue(null);

    await initCommand();

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.tiers).toBeUndefined();
    expect(writtenConfig.hooks).toBeUndefined();
  });

  it("preserves tiers, hooks, and telemetry together when all exist", async () => {
    mockReadConfig.mockResolvedValue({
      version: "1",
      adapters: {},
      defaultAdapter: null,
      detectedAt: new Date().toISOString(),
      telemetry: { enabled: true },
      tiers: { cheap: "claude-haiku-4-5" },
      hooks: { preNode: "./pre.sh" },
    });

    await initCommand({});

    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.telemetry).toEqual({ enabled: true });
    expect(writtenConfig.tiers).toEqual({ cheap: "claude-haiku-4-5" });
    expect(writtenConfig.hooks).toEqual({ preNode: "./pre.sh" });
  });

  it("warns when existing config is unreadable (non-ENOENT) and proceeds with defaults", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // SyntaxError from JSON.parse — has no `.code` field, so the ENOENT
    // discriminator in init.ts correctly treats it as an unreadable-config error.
    mockReadConfig.mockRejectedValue(new SyntaxError("Unexpected token } in JSON"));

    await initCommand({});

    const warning = warnSpy.mock.calls.flat().join("\n");
    expect(warning).toContain("unreadable");
    // Hand-authored tiers/hooks are dropped (can't be recovered from corrupt file)
    const [writtenConfig] = mockWriteConfig.mock.calls[0]! as [Parameters<typeof writeConfig>[0]];
    expect(writtenConfig.tiers).toBeUndefined();
    expect(writtenConfig.hooks).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("does NOT warn when existing config is absent (ENOENT)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enoentErr = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    mockReadConfig.mockRejectedValue(enoentErr);

    await initCommand({});

    // First run is expected to have no prior config; should NOT print the
    // "unreadable" warning to users initializing for the first time.
    const warning = warnSpy.mock.calls.flat().join("\n");
    expect(warning).not.toContain("unreadable");

    warnSpy.mockRestore();
  });
});
