import { describe, it, expect, afterEach, vi } from "vitest";
import { AdapterPool, CircuitOpenError } from "./adapter-pool.js";
import type { CircuitStateChange } from "./adapter-pool.js";

describe("AdapterPool", () => {
  let pool: AdapterPool;

  afterEach(async () => {
    // Ensure pool is drained after each test to prevent hanging timers
    try {
      await pool?.drain();
    } catch {
      // drain may reject if already drained or if pool was never created
    }
  });

  describe("acquire within limit", () => {
    it("resolves immediately when slots are available", async () => {
      pool = new AdapterPool({ maxConcurrency: 2 });
      const slot = await pool.acquire("claude-cli");
      expect(slot.adapterType).toBe("claude-cli");
      expect(slot.id).toBeTruthy();
      expect(slot.acquiredAt).toBeGreaterThan(0);
      pool.release(slot);
    });

    it("allows acquiring up to maxConcurrency slots", async () => {
      pool = new AdapterPool({ maxConcurrency: 3 });
      const slot1 = await pool.acquire("claude-cli");
      const slot2 = await pool.acquire("codex");
      const slot3 = await pool.acquire("cursor");
      expect(pool.stats().active).toBe(3);
      pool.release(slot1);
      pool.release(slot2);
      pool.release(slot3);
    });
  });

  describe("acquire beyond limit waits until release", () => {
    it("blocks when pool is full and resolves after a release", async () => {
      pool = new AdapterPool({ maxConcurrency: 1 });
      const slot1 = await pool.acquire("claude-cli");

      let resolved = false;
      const pendingPromise = pool.acquire("codex").then((slot) => {
        resolved = true;
        return slot;
      });

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);
      expect(pool.stats().waiting).toBe(1);

      pool.release(slot1);

      const slot2 = await pendingPromise;
      expect(resolved).toBe(true);
      expect(slot2.adapterType).toBe("codex");
      pool.release(slot2);
    });
  });

  describe("acquire timeout", () => {
    it("rejects with descriptive error after acquireTimeoutMs", async () => {
      pool = new AdapterPool({ maxConcurrency: 1, acquireTimeoutMs: 50 });
      const slot1 = await pool.acquire("claude-cli");

      await expect(pool.acquire("codex")).rejects.toThrow(
        /acquire timeout.*50ms/i
      );

      pool.release(slot1);
    });
  });

  describe("FIFO ordering", () => {
    it("first waiter gets the next released slot", async () => {
      pool = new AdapterPool({ maxConcurrency: 1 });
      const slot1 = await pool.acquire("claude-cli");

      const order: number[] = [];
      const p1 = pool.acquire("first").then((s) => {
        order.push(1);
        return s;
      });
      const p2 = pool.acquire("second").then((s) => {
        order.push(2);
        return s;
      });

      // Wait a tick so both are queued
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.stats().waiting).toBe(2);

      // Release first slot — first waiter should get it
      pool.release(slot1);
      const s1 = await p1;
      expect(s1.adapterType).toBe("first");

      // Release again for second waiter
      pool.release(s1);
      const s2 = await p2;
      expect(s2.adapterType).toBe("second");

      expect(order).toEqual([1, 2]);
      pool.release(s2);
    });
  });

  describe("per-adapter limit", () => {
    it("enforces per-adapter limit independently of global limit", async () => {
      pool = new AdapterPool({
        maxConcurrency: 4,
        perAdapterLimit: 2,
      });

      const s1 = await pool.acquire("claude-cli");
      const s2 = await pool.acquire("claude-cli");

      // Third claude-cli should block even though global has capacity
      let thirdResolved = false;
      const p3 = pool.acquire("claude-cli").then((s) => {
        thirdResolved = true;
        return s;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(thirdResolved).toBe(false);
      expect(pool.stats().active).toBe(2);
      expect(pool.stats().waiting).toBe(1);

      // But a different adapter type should succeed immediately
      const s4 = await pool.acquire("codex");
      expect(s4.adapterType).toBe("codex");

      // Release one claude-cli — third should now resolve
      pool.release(s1);
      const s3 = await p3;
      expect(thirdResolved).toBe(true);
      expect(s3.adapterType).toBe("claude-cli");

      pool.release(s2);
      pool.release(s3);
      pool.release(s4);
    });
  });

  describe("release of unknown slot", () => {
    it("throws when releasing a slot not in the active set", () => {
      pool = new AdapterPool({ maxConcurrency: 2 });
      const fakeSlot = {
        id: "fake-id",
        adapterType: "claude-cli",
        acquiredAt: Date.now(),
      };

      expect(() => pool.release(fakeSlot)).toThrow(/unknown slot/i);
    });
  });

  describe("drain mode", () => {
    it("rejects new acquires after drain is called", async () => {
      pool = new AdapterPool({ maxConcurrency: 2 });
      const slot = await pool.acquire("claude-cli");

      const drainPromise = pool.drain();

      await expect(pool.acquire("codex")).rejects.toThrow(/drain/i);

      pool.release(slot);
      await drainPromise;
    });

    it("resolves when all active slots are released", async () => {
      pool = new AdapterPool({ maxConcurrency: 2 });
      const s1 = await pool.acquire("claude-cli");
      const s2 = await pool.acquire("codex");

      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      pool.release(s1);
      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      pool.release(s2);
      await drainPromise;
      expect(drained).toBe(true);
    });

    it("resolves immediately if no active slots", async () => {
      pool = new AdapterPool({ maxConcurrency: 2 });
      await pool.drain();
      // No error means success
    });
  });

  describe("stats", () => {
    it("reflects current state accurately", async () => {
      pool = new AdapterPool({ maxConcurrency: 2 });

      expect(pool.stats()).toEqual({
        active: 0,
        waiting: 0,
        maxConcurrency: 2,
      });

      const s1 = await pool.acquire("claude-cli");
      expect(pool.stats()).toEqual({
        active: 1,
        waiting: 0,
        maxConcurrency: 2,
      });

      const s2 = await pool.acquire("codex");
      expect(pool.stats()).toEqual({
        active: 2,
        waiting: 0,
        maxConcurrency: 2,
      });

      // Queue one more
      const p3 = pool.acquire("cursor");
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.stats()).toEqual({
        active: 2,
        waiting: 1,
        maxConcurrency: 2,
      });

      pool.release(s1);
      const s3 = await p3;
      expect(pool.stats()).toEqual({
        active: 2,
        waiting: 0,
        maxConcurrency: 2,
      });

      pool.release(s2);
      pool.release(s3);
      expect(pool.stats()).toEqual({
        active: 0,
        waiting: 0,
        maxConcurrency: 2,
      });
    });
  });

  describe("rapid acquire/release cycles", () => {
    it("does not leak slots across 100 rapid cycles", async () => {
      pool = new AdapterPool({ maxConcurrency: 3 });

      for (let i = 0; i < 100; i++) {
        const slot = await pool.acquire("claude-cli");
        pool.release(slot);
      }

      expect(pool.stats().active).toBe(0);
      expect(pool.stats().waiting).toBe(0);
    });

    it("handles concurrent acquire/release without leaks", async () => {
      pool = new AdapterPool({ maxConcurrency: 5 });

      const tasks = Array.from({ length: 20 }, async (_, i) => {
        const slot = await pool.acquire(`adapter-${i % 3}`);
        // Simulate brief work
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        pool.release(slot);
      });

      await Promise.all(tasks);
      expect(pool.stats().active).toBe(0);
      expect(pool.stats().waiting).toBe(0);
    });
  });

  describe("slot id uniqueness", () => {
    it("generates unique IDs for each acquired slot", async () => {
      pool = new AdapterPool({ maxConcurrency: 10 });
      const ids = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const slot = await pool.acquire("claude-cli");
        ids.add(slot.id);
        pool.release(slot);
      }

      expect(ids.size).toBe(10);
    });
  });

  describe("waitStats instrumentation", () => {
    it("records a 0ms sample for immediate (uncontended) acquires", async () => {
      pool = new AdapterPool({ maxConcurrency: 4 });
      const slot = await pool.acquire("claude-cli");
      const { samples } = pool.waitStats();
      expect(samples.length).toBe(1);
      expect(samples[0]).toBe(0);
      pool.release(slot);
    });

    it("accumulates samples across multiple acquires and measures contended waits", async () => {
      pool = new AdapterPool({ maxConcurrency: 1 });
      const first = await pool.acquire("claude-cli");
      // First acquire is immediate → 0ms sample
      expect(pool.waitStats().samples).toEqual([0]);

      // Second acquire blocks until release
      const secondP = pool.acquire("claude-cli");
      await new Promise((r) => setTimeout(r, 20));
      pool.release(first);
      const second = await secondP;

      const { samples } = pool.waitStats();
      expect(samples.length).toBe(2);
      expect(samples[0]).toBe(0);
      // Contended wait is >= 20ms (allow jitter tolerance)
      expect(samples[1]!).toBeGreaterThanOrEqual(15);
      pool.release(second);
    });

    it("bounds the sample ring at capacity and drops oldest when full", async () => {
      pool = new AdapterPool({ maxConcurrency: 1 });
      // 1005 rapid uncontended acquires → each records a 0ms sample,
      // capacity is 1000, so the ring should have exactly 1000 entries
      for (let i = 0; i < 1005; i++) {
        const s = await pool.acquire("claude-cli");
        pool.release(s);
      }
      expect(pool.waitStats().samples.length).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  describe("circuit breaker", () => {
    it("defaults to disabled when circuitBreaker option is omitted", async () => {
      pool = new AdapterPool({ maxConcurrency: 5 });
      // Record many failures — with CB disabled, acquires still succeed.
      for (let i = 0; i < 20; i++) {
        pool.recordFailure("claude-cli", "transport");
      }
      const slot = await pool.acquire("claude-cli");
      expect(slot.adapterType).toBe("claude-cli");
      expect(pool.circuitStates()).toEqual({});
      pool.release(slot);
    });

    it("trips from closed to open after threshold failures in window", async () => {
      const changes: CircuitStateChange[] = [];
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 3, windowMs: 30_000, cooldownMs: 60_000 },
      });
      pool.setCircuitStateListener((c) => changes.push(c));

      pool.recordFailure("claude-cli", "transport");
      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      expect(changes).toHaveLength(0);

      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.from).toBe("closed");
      expect(changes[0]?.to).toBe("open");
      expect(changes[0]?.reason).toBe("transport");
      expect(changes[0]?.openUntil).toBeGreaterThan(Date.now());
    });

    it("rejects acquires with CircuitOpenError while circuit is open", async () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 2, windowMs: 30_000, cooldownMs: 60_000 },
      });
      pool.recordFailure("claude-cli", "transport");
      pool.recordFailure("claude-cli", "transport");

      await expect(pool.acquire("claude-cli")).rejects.toBeInstanceOf(CircuitOpenError);
      // Other adapter types are unaffected — isolation by adapter type.
      const slot = await pool.acquire("codex");
      expect(slot.adapterType).toBe("codex");
      pool.release(slot);
    });

    it("isolates breakers per adapter type", () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 2, windowMs: 30_000, cooldownMs: 60_000 },
      });
      pool.recordFailure("claude-cli", "transport");
      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");
      expect(pool.circuitStates()["codex"]).toBeUndefined();
    });

    it("ignores rate_limit as a failure reason (does not trip the breaker)", () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 2, windowMs: 30_000, cooldownMs: 60_000 },
      });
      for (let i = 0; i < 10; i++) {
        pool.recordFailure("claude-cli", "rate_limit");
      }
      // rate_limit failures must not trip the breaker — they indicate server
      // backpressure, not outage.
      expect(pool.circuitStates()["claude-cli"]).toBeUndefined();
    });

    it("prunes failures outside the rolling window", () => {
      vi.useFakeTimers();
      try {
        pool = new AdapterPool({
          maxConcurrency: 5,
          circuitBreaker: { failureThreshold: 3, windowMs: 1_000, cooldownMs: 60_000 },
        });
        pool.recordFailure("claude-cli", "transport");
        pool.recordFailure("claude-cli", "transport");
        // Advance past the window — previous failures should be pruned.
        vi.advanceTimersByTime(2_000);
        pool.recordFailure("claude-cli", "transport");
        // Only the most recent failure remains in the window; circuit stays closed.
        expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("transitions open → half_open after cooldown elapses on next acquire", async () => {
      const changes: CircuitStateChange[] = [];
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 50 },
      });
      pool.setCircuitStateListener((c) => changes.push(c));

      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");

      // While still in cooldown, acquire rejects.
      await expect(pool.acquire("claude-cli")).rejects.toBeInstanceOf(CircuitOpenError);

      // Wait past cooldown, then acquire should succeed as the half_open probe.
      await new Promise((r) => setTimeout(r, 80));
      const probe = await pool.acquire("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");
      expect(changes.map((c) => c.to)).toEqual(["open", "half_open"]);

      pool.release(probe);
    });

    it("half_open → closed on probe success", async () => {
      const changes: CircuitStateChange[] = [];
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.setCircuitStateListener((c) => changes.push(c));

      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));
      const probe = await pool.acquire("claude-cli");
      pool.recordSuccess("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      expect(changes.map((c) => c.to)).toEqual(["open", "half_open", "closed"]);
      pool.release(probe);
    });

    it("half_open → open on probe failure", async () => {
      const changes: CircuitStateChange[] = [];
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.setCircuitStateListener((c) => changes.push(c));

      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));
      const probe = await pool.acquire("claude-cli");
      // Probe attempt fails.
      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");
      expect(changes.map((c) => c.to)).toEqual(["open", "half_open", "open"]);
      pool.release(probe);
    });

    it("half_open rejects concurrent probe attempts", async () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));
      const probe = await pool.acquire("claude-cli"); // becomes the probe
      // A second concurrent acquire during half_open rejects with CircuitOpenError.
      await expect(pool.acquire("claude-cli")).rejects.toBeInstanceOf(CircuitOpenError);
      pool.release(probe);
    });

    // Regression: a concurrent acquire rejected with CircuitOpenError used
    // to race the genuine in-flight probe. The scheduler classifies the
    // rejection as `retryable:circuit_open` and calls `recordFailure(..., "circuit_open")`,
    // which reset `halfOpenProbeInFlight` and re-opened the circuit with a
    // fresh cooldown. The real probe's success then became a no-op (state was
    // `open`, not `half_open`). Now `recordFailure` early-exits on
    // `reason === "circuit_open"` — the breaker's own rejection is not
    // evidence of adapter unhealthiness.
    it("half_open → closed even when concurrent CircuitOpenError is recorded", async () => {
      const changes: CircuitStateChange[] = [];
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.setCircuitStateListener((c) => changes.push(c));

      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));

      // Node A wins the probe slot.
      const probe = await pool.acquire("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");

      // Node B's concurrent acquire rejects with CircuitOpenError; the
      // scheduler reports this as a failure with reason="circuit_open".
      await expect(pool.acquire("claude-cli")).rejects.toBeInstanceOf(CircuitOpenError);
      pool.recordFailure("claude-cli", "circuit_open");

      // The circuit must still be half_open (the phantom failure was ignored).
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");

      // Node A's probe completes successfully.
      pool.recordSuccess("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      expect(changes.map((c) => c.to)).toEqual(["open", "half_open", "closed"]);

      pool.release(probe);
    });

    // Regression where a half-open probe that resolved with a
    // rate_limit error (provider returned 429 and a fallback provider was
    // configured, so the scheduler threw out of the stream loop) used to
    // early-return from recordFailure without clearing halfOpenProbeInFlight.
    // That pinned the circuit at half_open forever — every future acquire saw
    // probe-in-flight=true and returned CircuitOpenError with no way to probe
    // again. Now rate_limit clears the probe flag but leaves state unchanged,
    // so the next acquire can retry the probe.
    it("rate_limit during half-open probe does not pin the circuit", async () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));

      const probe = await pool.acquire("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");

      // Probe ended in rate_limit — not a health signal, but the probe is
      // over and the flag must be cleared.
      pool.recordFailure("claude-cli", "rate_limit");
      pool.release(probe);

      // State unchanged; a follow-up acquire can become the new probe.
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");
      const reprobe = await pool.acquire("claude-cli");
      pool.recordSuccess("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      pool.release(reprobe);
    });

    // Regression where a half-open probe that resolved with a
    // non-retryable / unclassified throw (e.g. adapter config error, invalid
    // API key — anything that classifyError returns retryable=false for) used
    // to pin the circuit at half_open forever. The scheduler only called
    // recordFailure for *retryable* errors, so halfOpenProbeInFlight was
    // never cleared. Fix: scheduler now always calls recordFailure, and the
    // pool treats `reason === undefined` the same way as rate_limit — clears
    // the probe flag, leaves state unchanged, doesn't count toward threshold.
    it("non-retryable error during half-open probe does not pin the circuit", async () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });
      pool.recordFailure("claude-cli", "transport");
      await new Promise((r) => setTimeout(r, 40));

      const probe = await pool.acquire("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");

      // Probe resolved with a non-retryable error (reason omitted — this is
      // how the scheduler passes unclassified failures).
      pool.recordFailure("claude-cli");
      pool.release(probe);

      // State unchanged; a follow-up acquire can become the new probe.
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("half_open");
      const reprobe = await pool.acquire("claude-cli");
      pool.recordSuccess("claude-cli");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("closed");
      pool.release(reprobe);
    });

    // Closed-state recordFailure with undefined reason must NOT count toward
    // the threshold and must NOT create a breaker entry unnecessarily (it
    // matters for `circuitStates()` consumers that rely on empty-object for
    // never-failed adapters). Non-retryable errors in closed state are
    // effectively no-ops.
    it("recordFailure with undefined reason in closed state is a no-op", () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 2, windowMs: 30_000, cooldownMs: 60_000 },
      });
      for (let i = 0; i < 10; i++) pool.recordFailure("claude-cli");
      expect(pool.circuitStates()["claude-cli"]).toBeUndefined();
    });

    it("CircuitOpenError carries the adapterType and openUntil", async () => {
      pool = new AdapterPool({
        maxConcurrency: 5,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 60_000 },
      });
      pool.recordFailure("claude-cli", "transport");
      const err = await pool.acquire("claude-cli").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CircuitOpenError);
      if (err instanceof CircuitOpenError) {
        expect(err.adapterType).toBe("claude-cli");
        expect(err.openUntil).toBeGreaterThan(Date.now());
        expect(err.name).toBe("CircuitOpenError");
      }
    });

    // Regression where a waiter queued BEFORE the circuit tripped
    // used to be fulfilled silently once the cooldown elapsed — bypassing the
    // open→half_open transition and the probe-flag claim. A fresh concurrent
    // acquire would then become a second "probe" running in parallel with
    // the unmarked queue fulfillment, violating the "exactly one probe
    // permitted" invariant. Fix: isBreakerBlockingWaiter blocks queued
    // waiters unconditionally in the "open" state, so they time out and the
    // scheduler's failover path picks the next provider.
    it("queued waiter in open circuit stays blocked past cooldown (no silent probe bypass)", async () => {
      pool = new AdapterPool({
        maxConcurrency: 1,
        acquireTimeoutMs: 80,
        circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 20 },
      });

      const slot = await pool.acquire("claude-cli"); // 1/1
      const queued = pool.acquire("claude-cli").catch((e: unknown) => e);
      pool.recordFailure("claude-cli", "transport");
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");

      // Wait past the cooldown. The release below must NOT silently fulfill
      // the queued waiter — the circuit is still "open" (no fresh acquire
      // has transitioned it to half_open) and queued waiters must wait.
      await new Promise((r) => setTimeout(r, 40));
      pool.release(slot);

      const err = await queued;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/acquire timeout/i);
      // Circuit state has NOT been advanced by the release path; the
      // transition is still reserved for a fresh acquire.
      expect(pool.circuitStates()["claude-cli"]?.state).toBe("open");
    });
  });
});
