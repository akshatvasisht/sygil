/**
 * Unit tests for SyncRegistry — workflow-scoped mutex and semaphore primitives.
 */

import { describe, it, expect } from "vitest";
import { SyncRegistry } from "./sync-registry.js";

// ---------------------------------------------------------------------------
// Helper — build a SyncRegistry with optional weight overrides
// ---------------------------------------------------------------------------

function makeRegistry(weights: Record<string, number> = {}): SyncRegistry {
  return new SyncRegistry(new Map(Object.entries(weights)));
}

// ---------------------------------------------------------------------------
// Mutex (limit=1)
// ---------------------------------------------------------------------------

describe("SyncRegistry — mutex", () => {
  it("allows one concurrent holder", async () => {
    const r = makeRegistry();
    const release = await r.acquire("lock", 1, "nodeA");
    expect(release).toBeDefined();
    // Acquire a second slot — should queue
    let second = false;
    void r.acquire("lock", 1, "nodeB").then(() => {
      second = true;
    });
    // nodeB is still waiting
    await Promise.resolve(); // flush microtasks
    expect(second).toBe(false);
    // Release first slot → nodeB unblocks
    release.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBe(true);
  });

  it("release() is idempotent — calling twice does not double-decrement", async () => {
    const r = makeRegistry();
    const rel = await r.acquire("lock", 1, "nodeA");
    rel.release();
    rel.release(); // should be a no-op
    // Should be able to acquire again immediately
    const rel2 = await r.acquire("lock", 1, "nodeB");
    expect(rel2).toBeDefined();
    rel2.release();
  });
});

// ---------------------------------------------------------------------------
// Semaphore (limit > 1)
// ---------------------------------------------------------------------------

describe("SyncRegistry — semaphore", () => {
  it("allows N concurrent holders", async () => {
    const r = makeRegistry();
    const limit = 3;
    // All three should resolve immediately
    const releases = await Promise.all([
      r.acquire("sem", limit, "n1"),
      r.acquire("sem", limit, "n2"),
      r.acquire("sem", limit, "n3"),
    ]);
    expect(releases).toHaveLength(3);
    for (const rel of releases) rel.release();
  });

  it("queues the (N+1)th waiter", async () => {
    const r = makeRegistry();
    const limit = 2;
    const rel1 = await r.acquire("sem", limit, "n1");
    const rel2 = await r.acquire("sem", limit, "n2");
    // Third should queue
    let third = false;
    const thirdPromise = r.acquire("sem", limit, "n3").then((rel) => {
      third = true;
      return rel;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    rel1.release();
    await thirdPromise;
    expect(third).toBe(true);
    rel2.release();
  });
});

// ---------------------------------------------------------------------------
// Weight-descending dequeue order
// ---------------------------------------------------------------------------

describe("SyncRegistry — waiter ordering", () => {
  it("dequeues higher-weight waiters first", async () => {
    // nodeA holds the mutex; nodeB (weight=1) and nodeC (weight=10) both wait.
    // On release, nodeC (higher weight) should be served first.
    const r = makeRegistry({ nodeB: 1, nodeC: 10 });
    const relA = await r.acquire("lock", 1, "nodeA");

    const order: string[] = [];
    void r.acquire("lock", 1, "nodeB").then(() => { order.push("nodeB"); });
    // Give nodeB a chance to be inserted first (insertion order)
    await Promise.resolve();
    void r.acquire("lock", 1, "nodeC").then((rel) => { order.push("nodeC"); rel.release(); });
    await Promise.resolve();

    relA.release();
    // Allow microtasks to propagate
    await new Promise((r) => setTimeout(r, 0));

    // nodeC has higher weight so it goes first
    expect(order[0]).toBe("nodeC");
  });

  it("equal-weight waiters respect FIFO insertion order", async () => {
    const r = makeRegistry({ n1: 5, n2: 5 });
    const relA = await r.acquire("lock", 1, "nodeA");

    const order: string[] = [];
    const p1 = r.acquire("lock", 1, "n1").then((rel) => { order.push("n1"); rel.release(); });
    await Promise.resolve(); // ensure n1 is inserted before n2
    const p2 = r.acquire("lock", 1, "n2").then((rel) => { order.push("n2"); rel.release(); });
    await Promise.resolve();

    relA.release();
    await Promise.all([p1, p2]);

    expect(order[0]).toBe("n1");
    expect(order[1]).toBe("n2");
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe("SyncRegistry — abort", () => {
  it("cancels a pending waiter cleanly", async () => {
    const r = makeRegistry();
    const rel = await r.acquire("lock", 1, "nodeA");

    const controller = new AbortController();
    const abortedPromise = r.acquire("lock", 1, "nodeB", controller.signal);

    await Promise.resolve();
    controller.abort();

    await expect(abortedPromise).rejects.toThrow("Sync acquisition aborted");
    // Releasing nodeA should not throw even though the queue is empty
    rel.release();
  });

  it("already-acquired slot is not affected by later abort", async () => {
    const r = makeRegistry();
    const controller = new AbortController();
    const rel = await r.acquire("lock", 1, "nodeA", controller.signal);
    // Abort AFTER acquisition — should not interfere
    controller.abort();
    expect(rel).toBeDefined();
    rel.release();
  });
});

// ---------------------------------------------------------------------------
// First-acquire-wins limit enforcement
// ---------------------------------------------------------------------------

describe("SyncRegistry — limit mismatch", () => {
  it("throws when the same key is declared with a different limit", async () => {
    const r = makeRegistry();
    const rel = await r.acquire("key", 2, "nodeA");
    await expect(r.acquire("key", 3, "nodeB")).rejects.toThrow(
      'Sync key "key" was first declared with limit=2; node "nodeB" declares limit=3',
    );
    rel.release();
  });

  it("succeeds when the same key is declared with the same limit", async () => {
    const r = makeRegistry();
    const rel1 = await r.acquire("key", 2, "n1");
    const rel2 = await r.acquire("key", 2, "n2");
    rel1.release();
    rel2.release();
  });
});
