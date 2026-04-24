/**
 * Tests for environment snapshot + drift detection.
 *
 * These tests mock process.env and adapter getVersion to avoid real binary
 * calls and network I/O. The pattern mirrors adapter unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildEnvironmentSnapshot, diffEnvironment, hashEnvVar, SYGIL_CLI_VERSION } from "./environment.js";
import type { WorkflowGraph, AgentAdapter, AgentSession, AgentEvent, NodeResult, NodeConfig, SpawnContext } from "@sygil/shared";
import { WorkflowRunStateSchema } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Stub adapter factory
// ---------------------------------------------------------------------------

function makeStubAdapter(name: string, version: string | null): AgentAdapter {
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(true),
    spawn: vi.fn(),
    resume: vi.fn(),
    stream: vi.fn(),
    getResult: vi.fn(),
    kill: vi.fn(),
    getVersion: vi.fn().mockResolvedValue(version),
  };
}

const MINIMAL_WORKFLOW: WorkflowGraph = {
  version: "1",
  name: "test",
  nodes: {
    n1: {
      adapter: "echo",
      model: "test",
      role: "agent",
      prompt: "do something",
    },
  },
  edges: [],
};

// ---------------------------------------------------------------------------
// hashEnvVar
// ---------------------------------------------------------------------------

describe("hashEnvVar", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_KEY", "secretvalue12345");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a 16-char hex string when the var is set", () => {
    const hash = hashEnvVar("TEST_KEY");
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null when the var is not set", () => {
    expect(hashEnvVar("UNSET_VAR_12345")).toBeNull();
  });

  it("produces the same hash for the same value", () => {
    const h1 = hashEnvVar("TEST_KEY");
    const h2 = hashEnvVar("TEST_KEY");
    expect(h1).toBe(h2);
  });

  it("produces different hashes when only the first 10 chars differ", () => {
    vi.unstubAllEnvs();
    vi.stubEnv("TEST_KEY", "aaaaaaaaaa_suffix1");
    const h1 = hashEnvVar("TEST_KEY");
    vi.stubEnv("TEST_KEY", "bbbbbbbbbbb_suffix1");
    const h2 = hashEnvVar("TEST_KEY");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// buildEnvironmentSnapshot
// ---------------------------------------------------------------------------

describe("buildEnvironmentSnapshot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes sygilVersion, nodeVersion, platform", async () => {
    const factory = (_type: unknown) => makeStubAdapter("echo", "test-fixture");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);

    expect(snap.sygilVersion).toBe(SYGIL_CLI_VERSION);
    expect(snap.nodeVersion).toBe(process.versions.node);
    expect(snap.platform).toBe(`${process.platform}-${process.arch}`);
  });

  it("includes adapterVersions for adapters used in the workflow", async () => {
    const factory = (_type: unknown) => makeStubAdapter("echo", "1.2.3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);
    expect(snap.adapterVersions["echo"]).toBe("1.2.3");
  });

  it("omits adapter from adapterVersions when getVersion returns null", async () => {
    const factory = (_type: unknown) => makeStubAdapter("echo", null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);
    expect(snap.adapterVersions["echo"]).toBeUndefined();
  });

  it("omits adapter from adapterVersions when adapter has no getVersion", async () => {
    const noVersionAdapter: AgentAdapter = {
      name: "no-version",
      isAvailable: vi.fn().mockResolvedValue(true),
      spawn: vi.fn() as unknown as (config: NodeConfig, ctx?: SpawnContext) => Promise<AgentSession>,
      resume: vi.fn() as unknown as (config: NodeConfig, session: AgentSession, msg: string, ctx?: SpawnContext) => Promise<AgentSession>,
      stream: vi.fn() as unknown as (session: AgentSession) => AsyncIterable<AgentEvent>,
      getResult: vi.fn() as unknown as (session: AgentSession) => Promise<NodeResult>,
      kill: vi.fn() as unknown as (session: AgentSession) => Promise<void>,
      // No getVersion
    };
    const factory = (_type: unknown) => noVersionAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);
    expect(snap.adapterVersions["echo"]).toBeUndefined();
  });

  it("deduplicates adapter types from multi-node workflow", async () => {
    const workflow: WorkflowGraph = {
      ...MINIMAL_WORKFLOW,
      nodes: {
        n1: { adapter: "echo", model: "m", role: "a", prompt: "p" },
        n2: { adapter: "echo", model: "m", role: "b", prompt: "q" },
      },
    };
    const factory = vi.fn().mockReturnValue(makeStubAdapter("echo", "0.5.0"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(workflow, factory as any);
    // Factory should only be called once per unique adapter type
    expect(factory).toHaveBeenCalledTimes(1);
    expect(snap.adapterVersions["echo"]).toBe("0.5.0");
  });

  it("includes envVarHashes for set relevant env vars", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");
    const factory = (_type: unknown) => makeStubAdapter("echo", null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);
    expect(snap.envVarHashes?.["ANTHROPIC_API_KEY"]).toBeDefined();
    expect(snap.envVarHashes?.["ANTHROPIC_API_KEY"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits envVarHashes when no relevant vars are set", async () => {
    // Ensure none of the relevant vars are set
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("CURSOR_API_KEY", "");
    vi.stubEnv("SYGIL_LOCAL_OAI_URL", "");
    vi.stubEnv("SYGIL_LOCAL_OAI_KEY", "");
    const factory = (_type: unknown) => makeStubAdapter("echo", null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast for factory shape
    const snap = await buildEnvironmentSnapshot(MINIMAL_WORKFLOW, factory as any);
    // Empty string values mean null hash → no envVarHashes entry
    expect(snap.envVarHashes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diffEnvironment
// ---------------------------------------------------------------------------

describe("diffEnvironment", () => {
  it("returns empty array when environments are identical", () => {
    const env = {
      sygilVersion: "0.1.0",
      adapterVersions: { echo: "test-fixture" },
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    expect(diffEnvironment(env, env)).toHaveLength(0);
  });

  it("returns empty array when stored is undefined (old checkpoint, no drift)", () => {
    const current = {
      sygilVersion: "0.1.0",
      adapterVersions: { echo: "test-fixture" },
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    expect(diffEnvironment(undefined, current)).toHaveLength(0);
  });

  it("detects adapter version change", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: { "claude-cli": "2.5.0" },
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      adapterVersions: { "claude-cli": "2.6.0" },
    };
    const diffs = diffEnvironment(stored, current);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("claude-cli");
    expect(diffs[0]).toContain("2.5.0");
    expect(diffs[0]).toContain("2.6.0");
  });

  it("detects when adapter becomes unavailable", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: { "claude-cli": "2.5.0" },
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      adapterVersions: {},
    };
    const diffs = diffEnvironment(stored, current);
    expect(diffs.some((d) => d.includes("claude-cli") && d.includes("not found"))).toBe(true);
  });

  it("detects env var hash change", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: {},
      envVarHashes: { ANTHROPIC_API_KEY: "abcdef0123456789" },
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      envVarHashes: { ANTHROPIC_API_KEY: "9876543210abcdef" },
    };
    const diffs = diffEnvironment(stored, current);
    expect(diffs.some((d) => d.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("detects Node.js version change", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: {},
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      nodeVersion: "22.0.0",
    };
    const diffs = diffEnvironment(stored, current);
    expect(diffs.some((d) => d.includes("Node.js"))).toBe(true);
  });

  it("detects platform change", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: {},
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      platform: "linux-arm64",
    };
    const diffs = diffEnvironment(stored, current);
    expect(diffs.some((d) => d.includes("Platform"))).toBe(true);
  });

  it("does not flag newly-installed adapters as drift", () => {
    const stored = {
      sygilVersion: "0.1.0",
      adapterVersions: {},
      nodeVersion: "20.0.0",
      platform: "linux-x64",
    };
    const current = {
      ...stored,
      adapterVersions: { echo: "test-fixture" },
    };
    // New adapter installed — not a drift concern
    expect(diffEnvironment(stored, current)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backward compat: WorkflowRunStateSchema accepts missing environment
// ---------------------------------------------------------------------------

describe("WorkflowRunStateSchema backward compat", () => {
  it("parses a checkpoint without environment field (old checkpoint format)", () => {
    const oldState = {
      id: "run-old",
      workflowName: "test",
      status: "paused",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
    };
    const result = WorkflowRunStateSchema.safeParse(oldState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.environment).toBeUndefined();
    }
  });

  it("parses a checkpoint with the new environment field", () => {
    const newState = {
      id: "run-new",
      workflowName: "test",
      status: "paused",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
      environment: {
        sygilVersion: "0.1.0",
        adapterVersions: { echo: "test-fixture" },
        nodeVersion: "20.0.0",
        platform: "linux-x64",
      },
    };
    const result = WorkflowRunStateSchema.safeParse(newState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.environment?.sygilVersion).toBe("0.1.0");
    }
  });
});
