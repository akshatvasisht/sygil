import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdapterPool } from "./adapter-pool.js";

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
});
