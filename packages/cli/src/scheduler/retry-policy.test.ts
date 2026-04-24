import { describe, it, expect } from "vitest";
import type { RetryPolicy } from "@sygil/shared";
import {
  computeRetryDelay,
  deterministicJitter,
  isRetryableReason,
  sleepWithAbort,
  RETRY_JITTER_CAP_MS,
} from "./retry-policy.js";

// ---------------------------------------------------------------------------
// computeRetryDelay — exponential backoff + deterministic jitter
// ---------------------------------------------------------------------------

const BASIC_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 100,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
};

describe("computeRetryDelay", () => {
  it("attempt 1 returns initialDelayMs plus deterministic jitter", () => {
    const d = computeRetryDelay(BASIC_POLICY, 1, "run-x", "node-a");
    expect(d).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThan(100 + RETRY_JITTER_CAP_MS);
  });

  it("scales exponentially with backoffMultiplier", () => {
    // Use a policy whose base delays (5000, 10000, 20000) are comfortably
    // larger than RETRY_JITTER_CAP_MS so jitter can't invert ordering.
    const policy: RetryPolicy = {
      maxAttempts: 5,
      initialDelayMs: 5_000,
      backoffMultiplier: 2,
      maxDelayMs: 1_000_000,
    };
    const a1 = computeRetryDelay(policy, 1, "r", "n");
    const a2 = computeRetryDelay(policy, 2, "r", "n");
    const a3 = computeRetryDelay(policy, 3, "r", "n");
    // bases: 5000, 10000, 20000 — jitter up to 500 preserves ordering.
    expect(a1).toBeGreaterThanOrEqual(5_000);
    expect(a1).toBeLessThan(5_000 + RETRY_JITTER_CAP_MS);
    expect(a2).toBeGreaterThanOrEqual(10_000);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThanOrEqual(20_000);
    expect(a3).toBeGreaterThan(a2);
  });

  it("is capped at maxDelayMs even with large exponents", () => {
    const policy: RetryPolicy = {
      maxAttempts: 20,
      initialDelayMs: 100,
      backoffMultiplier: 10,
      maxDelayMs: 5_000,
    };
    const big = computeRetryDelay(policy, 15, "r", "n");
    expect(big).toBeLessThanOrEqual(5_000);
  });

  it("is deterministic across repeated calls", () => {
    const a = computeRetryDelay(BASIC_POLICY, 3, "run-42", "node-xyz");
    const b = computeRetryDelay(BASIC_POLICY, 3, "run-42", "node-xyz");
    expect(a).toBe(b);
  });

  it("varies by runId (same node, same attempt, different run)", () => {
    const a = computeRetryDelay(BASIC_POLICY, 2, "run-a", "node-1");
    const b = computeRetryDelay(BASIC_POLICY, 2, "run-b", "node-1");
    // They might collide (500-bucket jitter) but across many runs the distribution differs
    // Here we just verify at least one differs for the picked seeds
    const c = computeRetryDelay(BASIC_POLICY, 2, "run-c", "node-1");
    const d = computeRetryDelay(BASIC_POLICY, 2, "run-d", "node-1");
    const values = new Set([a, b, c, d]);
    expect(values.size).toBeGreaterThan(1);
  });

  it("returns 0 when initialDelayMs is 0 and backoffMultiplier > 1", () => {
    const policy: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 0,
      backoffMultiplier: 2,
      maxDelayMs: 0,
    };
    // maxDelayMs: 0 clamps everything to 0 regardless of jitter
    const d = computeRetryDelay(policy, 2, "r", "n");
    expect(d).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deterministicJitter — hash-derived, always in range
// ---------------------------------------------------------------------------

describe("deterministicJitter", () => {
  it("always returns an integer in [0, RETRY_JITTER_CAP_MS)", () => {
    for (let i = 1; i <= 20; i++) {
      const j = deterministicJitter("run-id", `node-${i}`, i);
      expect(Number.isInteger(j)).toBe(true);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(RETRY_JITTER_CAP_MS);
    }
  });

  it("distributes roughly uniformly across the 500-ms range", () => {
    const values: number[] = [];
    for (let i = 0; i < 500; i++) {
      values.push(deterministicJitter("run", "node", i));
    }
    // Sanity checks only — not a statistical test.
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(min).toBeLessThan(50);
    expect(max).toBeGreaterThan(450);
  });

  it("changes with attempt number", () => {
    const a = deterministicJitter("r", "n", 1);
    const b = deterministicJitter("r", "n", 2);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// isRetryableReason
// ---------------------------------------------------------------------------

describe("isRetryableReason", () => {
  it("defaults to all three classes when retryableErrors is omitted", () => {
    const p: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      maxDelayMs: 1000,
    };
    expect(isRetryableReason(p, "transport")).toBe(true);
    expect(isRetryableReason(p, "rate_limit")).toBe(true);
    expect(isRetryableReason(p, "server_5xx")).toBe(true);
  });

  it("opts in to only the listed classes when retryableErrors is set", () => {
    const p: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      maxDelayMs: 1000,
      retryableErrors: ["transport"],
    };
    expect(isRetryableReason(p, "transport")).toBe(true);
    expect(isRetryableReason(p, "rate_limit")).toBe(false);
    expect(isRetryableReason(p, "server_5xx")).toBe(false);
  });

  it("returns false for undefined reason (non-classified error)", () => {
    const p: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      maxDelayMs: 1000,
    };
    expect(isRetryableReason(p, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sleepWithAbort
// ---------------------------------------------------------------------------

describe("sleepWithAbort", () => {
  it("resolves after ms elapses (no signal)", async () => {
    const start = Date.now();
    await sleepWithAbort(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // timer jitter tolerance
  });

  it("resolves immediately when ms <= 0", async () => {
    const start = Date.now();
    await sleepWithAbort(0);
    expect(Date.now() - start).toBeLessThan(5);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await sleepWithAbort(1000, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(10);
  });

  it("resolves when signal is aborted mid-sleep", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const start = Date.now();
    await sleepWithAbort(1000, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
