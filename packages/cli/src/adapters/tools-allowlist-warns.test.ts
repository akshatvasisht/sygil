import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentAdapter, NodeConfig } from "@sygil/shared";
import { CodexCLIAdapter } from "./codex-cli.js";
import { CursorCLIAdapter } from "./cursor-cli.js";
import { GeminiCLIAdapter } from "./gemini-cli.js";
import { makeFakeProc } from "./__test-helpers__.js";
import { logger } from "../utils/logger.js";

/**
 * Cross-adapter coverage for the `NodeConfig.tools` warn-but-ignore behaviour
 * — consolidated from three identical tests previously duplicated across
 * codex-cli, cursor-cli, and gemini-cli test files (#73 follow-up).
 *
 * Each adapter emits a warn via `logger.warn(...)` when `config.tools` is
 * non-empty, because none of them have an upstream allowlist flag today.
 * The full set of adapter-specific `spawn()` behaviours remains covered in
 * the per-adapter test files; this file owns only the shared warn contract.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
  };
});

import { spawn as mockedSpawn, execSync as mockedExecSync } from "node:child_process";
import { existsSync as mockedExistsSync } from "node:fs";

const mockSpawn = mockedSpawn as unknown as ReturnType<typeof vi.fn>;
const mockExecSync = mockedExecSync as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = mockedExistsSync as unknown as ReturnType<typeof vi.fn>;

type AdapterCase = {
  name: string;
  factory: () => AgentAdapter;
  model: string;
  adapterField: NodeConfig["adapter"];
  warnRegex: RegExp;
  // Cursor and gemini also need existsSync for the credentials/~/.gemini
  // check inside isAvailable. Codex only shells out to `which`.
  needsExistsSync: boolean;
};

const CASES: AdapterCase[] = [
  {
    name: "codex",
    factory: () => new CodexCLIAdapter(),
    model: "o4-mini",
    adapterField: "codex",
    warnRegex: /codex adapter ignores NodeConfig\.tools.*Read.*Write/,
    needsExistsSync: false,
  },
  {
    name: "cursor-cli",
    factory: () => new CursorCLIAdapter(),
    model: "gpt-4o",
    adapterField: "cursor",
    warnRegex: /cursor-cli adapter ignores NodeConfig\.tools.*Read.*Write/,
    needsExistsSync: true,
  },
  {
    name: "gemini-cli",
    factory: () => new GeminiCLIAdapter(),
    model: "gemini-2.5-pro",
    adapterField: "gemini-cli",
    warnRegex: /gemini-cli adapter ignores NodeConfig\.tools.*Read.*Write/,
    needsExistsSync: true,
  },
];

describe.each(CASES)("$name — tools allowlist warn contract", ({ factory, model, adapterField, warnRegex, needsExistsSync }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue("");
    if (needsExistsSync) mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits warn with the offending tool names", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = factory();
    await adapter.spawn({
      adapter: adapterField,
      model,
      role: "agent",
      prompt: "task",
      tools: ["Read", "Write"],
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(warnRegex));
  });
});
