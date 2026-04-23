/**
 * NodeCache tests — content-addressable memoization for workflow nodes.
 *
 * Each test is isolated via unique temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { EdgeConfig, NodeResult } from "@sygil/shared";
import {
  computeContentHash,
  areGatesDeterministic,
  NodeCache,
} from "./node-cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCacheDir(): string {
  return join(tmpdir(), `sygil-cache-test-${randomUUID()}`);
}

function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    output: "test output",
    exitCode: 0,
    durationMs: 1234,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------

describe("computeContentHash", () => {
  it("produces consistent hashes for identical inputs", () => {
    const hash1 = computeContentHash(
      { prompt: "do stuff", adapter: "claude-sdk", model: "sonnet", tools: ["bash"] },
      { resolved: "value1" },
      { upstream1: "abc123" }
    );
    const hash2 = computeContentHash(
      { prompt: "do stuff", adapter: "claude-sdk", model: "sonnet", tools: ["bash"] },
      { resolved: "value1" },
      { upstream1: "abc123" }
    );
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hash when prompt changes", () => {
    const base = { prompt: "do stuff", adapter: "claude-sdk" as const, model: "sonnet", tools: ["bash"] };
    const hash1 = computeContentHash(base, {}, {});
    const hash2 = computeContentHash({ ...base, prompt: "do other stuff" }, {}, {});
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when model changes", () => {
    const base = { prompt: "do stuff", adapter: "claude-sdk" as const, model: "sonnet", tools: ["bash"] };
    const hash1 = computeContentHash(base, {}, {});
    const hash2 = computeContentHash({ ...base, model: "opus" }, {}, {});
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when tools change", () => {
    const base = { prompt: "do stuff", adapter: "claude-sdk" as const, model: "sonnet", tools: ["bash"] };
    const hash1 = computeContentHash(base, {}, {});
    const hash2 = computeContentHash({ ...base, tools: ["bash", "read"] }, {}, {});
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when upstream hash changes", () => {
    const base = { prompt: "do stuff", adapter: "claude-sdk" as const, model: "sonnet" };
    const hash1 = computeContentHash(base, {}, { upstream1: "aaa" });
    const hash2 = computeContentHash(base, {}, { upstream1: "bbb" });
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when resolved inputs change", () => {
    const base = { prompt: "do stuff", adapter: "claude-sdk" as const, model: "sonnet" };
    const hash1 = computeContentHash(base, { key: "val1" }, {});
    const hash2 = computeContentHash(base, { key: "val2" }, {});
    expect(hash1).not.toBe(hash2);
  });

  it("includes resolvedInputs in content hash", () => {
    const base = { prompt: "test", adapter: "echo" as const, model: "m" };
    const hash1 = computeContentHash(base, {}, {});
    const hash2 = computeContentHash(base, { plan: "content" }, {});
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when resolvedInputs key differs", () => {
    const base = { prompt: "test", adapter: "echo" as const, model: "m" };
    const hash1 = computeContentHash(base, { plan: "content" }, {});
    const hash2 = computeContentHash(base, { spec: "content" }, {});
    expect(hash1).not.toBe(hash2);
  });

  it("produces same hash with identical resolvedInputs", () => {
    const base = { prompt: "test", adapter: "echo" as const, model: "m" };
    const hash1 = computeContentHash(base, { plan: "content", spec: "data" }, {});
    const hash2 = computeContentHash(base, { plan: "content", spec: "data" }, {});
    expect(hash1).toBe(hash2);
  });

  it("produces different hash when resolvedInputs is empty vs populated", () => {
    const base = { prompt: "test", adapter: "echo" as const, model: "m" };
    const hashEmpty = computeContentHash(base, {}, {});
    const hashPopulated = computeContentHash(base, { key: "" }, {});
    expect(hashEmpty).not.toBe(hashPopulated);
  });
});

// ---------------------------------------------------------------------------
// areGatesDeterministic
// ---------------------------------------------------------------------------

describe("areGatesDeterministic", () => {
  it("returns true for edges with only exit_code, file_exists, and regex conditions", () => {
    const edges: EdgeConfig[] = [
      {
        id: "e1",
        from: "a",
        to: "b",
        gate: {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "file_exists", path: "output.txt" },
            { type: "regex", filePath: "output.txt", pattern: "success" },
          ],
        },
      },
    ];
    expect(areGatesDeterministic(edges)).toBe(true);
  });

  it("returns true for edges with no gate", () => {
    const edges: EdgeConfig[] = [
      { id: "e1", from: "a", to: "b" },
    ];
    expect(areGatesDeterministic(edges)).toBe(true);
  });

  it("returns true for empty edges array", () => {
    expect(areGatesDeterministic([])).toBe(true);
  });

  it("returns false if any condition is human_review", () => {
    const edges: EdgeConfig[] = [
      {
        id: "e1",
        from: "a",
        to: "b",
        gate: {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "human_review" },
          ],
        },
      },
    ];
    expect(areGatesDeterministic(edges)).toBe(false);
  });

  it("returns false if any condition is script", () => {
    const edges: EdgeConfig[] = [
      {
        id: "e1",
        from: "a",
        to: "b",
        gate: {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "script", path: "check.sh" },
          ],
        },
      },
    ];
    expect(areGatesDeterministic(edges)).toBe(false);
  });

  it("returns false when one edge is deterministic but another is not", () => {
    const edges: EdgeConfig[] = [
      {
        id: "e1",
        from: "a",
        to: "b",
        gate: { conditions: [{ type: "exit_code", value: 0 }] },
      },
      {
        id: "e2",
        from: "a",
        to: "c",
        gate: { conditions: [{ type: "human_review" }] },
      },
    ];
    expect(areGatesDeterministic(edges)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NodeCache — storage round-trip
// ---------------------------------------------------------------------------

describe("NodeCache", () => {
  let cacheDir: string;
  let cache: NodeCache;

  beforeEach(async () => {
    cacheDir = makeCacheDir();
    await mkdir(cacheDir, { recursive: true });
    cache = new NodeCache(cacheDir);
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("round-trips: set then get returns the same NodeResult", async () => {
    const result = makeNodeResult({ output: "hello world", exitCode: 0, durationMs: 500 });
    const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";

    await cache.set(hash, result);
    const retrieved = await cache.get(hash);

    expect(retrieved).toEqual(result);
  });

  it("returns null for a cache miss", async () => {
    const retrieved = await cache.get("nonexistent0000000000000000000000000000000000000000000000000000");
    expect(retrieved).toBeNull();
  });

  it("writes cache file to correct path", async () => {
    const hash = "deadbeef".repeat(8);
    const result = makeNodeResult();

    await cache.set(hash, result);

    const filePath = join(cacheDir, `${hash}.json`);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NodeResult;
    expect(parsed.output).toBe(result.output);
    expect(parsed.exitCode).toBe(result.exitCode);
  });

  it("handles special characters in hash (still a valid filename)", async () => {
    // Hashes are hex so no truly special chars, but test with edge-case-looking strings
    const hash = "0".repeat(64); // all-zeros hash
    const result = makeNodeResult({ output: "zero hash" });

    await cache.set(hash, result);
    const retrieved = await cache.get(hash);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.output).toBe("zero hash");
  });

  it("handles concurrent reads and writes without corruption", async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeNodeResult({ output: `output-${i}`, exitCode: 0, durationMs: i * 100 })
    );
    // Each hash must be unique — use hex digit + zero-padding to 64 chars
    const hashes = results.map((_, i) => i.toString(16).padStart(64, "0"));

    // Write all concurrently
    await Promise.all(results.map((r, i) => cache.set(hashes[i]!, r)));

    // Read all concurrently
    const retrieved = await Promise.all(hashes.map((h) => cache.get(h)));

    for (let i = 0; i < results.length; i++) {
      expect(retrieved[i]).toEqual(results[i]);
    }
  });

  it("stores and retrieves large NodeResult objects", async () => {
    const largeOutput = "x".repeat(100_000); // 100KB of output
    const result = makeNodeResult({
      output: largeOutput,
      exitCode: 0,
      durationMs: 99999,
      costUsd: 1.23,
      tokenUsage: { input: 50000, output: 80000 },
    });
    const hash = "f".repeat(64);

    await cache.set(hash, result);
    const retrieved = await cache.get(hash);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.output).toHaveLength(100_000);
    expect(retrieved!.tokenUsage).toEqual({ input: 50000, output: 80000 });
  });

  it("preserves optional fields like costUsd and tokenUsage", async () => {
    const result = makeNodeResult({
      output: "done",
      exitCode: 0,
      durationMs: 2000,
      costUsd: 0.05,
      tokenUsage: { input: 100, output: 200 },
    });
    const hash = "aabbccdd".repeat(8);

    await cache.set(hash, result);
    const retrieved = await cache.get(hash);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.costUsd).toBe(0.05);
    expect(retrieved!.tokenUsage).toEqual({ input: 100, output: 200 });
  });
});
