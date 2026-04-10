import { describe, it, expect } from "vitest";
import { WorktreeMutex } from "./worktree-mutex.js";

describe("WorktreeMutex", () => {
  it("allows sequential acquisition and release", async () => {
    const mutex = new WorktreeMutex();
    const release = await mutex.acquire();
    release();
    // Should be able to acquire again after release
    const release2 = await mutex.acquire();
    release2();
  });

  it("second acquire waits until first releases", async () => {
    const mutex = new WorktreeMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire();
    order.push(1);

    // Start second acquire — should not resolve until release1 is called
    const p2 = mutex.acquire().then((release) => {
      order.push(2);
      return release;
    });

    // Yield to the microtask queue — p2 should still be waiting
    await Promise.resolve();
    expect(order).toEqual([1]);

    release1();

    const release2 = await p2;
    expect(order).toEqual([1, 2]);
    release2();
  });

  it("multiple waiters are served in FIFO order", async () => {
    const mutex = new WorktreeMutex();
    const order: string[] = [];

    const release1 = await mutex.acquire();

    const p2 = mutex.acquire().then((r) => {
      order.push("second");
      return r;
    });

    const p3 = mutex.acquire().then((r) => {
      order.push("third");
      return r;
    });

    // Release first — should serve second
    release1();
    const release2 = await p2;

    // Release second — should serve third
    release2();
    const release3 = await p3;

    expect(order).toEqual(["second", "third"]);
    release3();
  });

  it("release is idempotent — calling it twice does not throw or double-release", async () => {
    const mutex = new WorktreeMutex();
    const release = await mutex.acquire();

    // Double release should not throw
    release();
    expect(() => release()).not.toThrow();

    // Mutex should still work normally after double release
    const release2 = await mutex.acquire();
    release2();
  });

  it("handles high contention — 10 concurrent acquires all resolve in FIFO order", async () => {
    const mutex = new WorktreeMutex();
    const order: number[] = [];
    const N = 10;

    // Acquire the lock first
    const firstRelease = await mutex.acquire();

    // Queue up N concurrent acquires
    const promises = Array.from({ length: N }, (_, i) =>
      mutex.acquire().then((release) => {
        order.push(i);
        return release;
      })
    );

    // None should have resolved yet
    await Promise.resolve();
    expect(order).toEqual([]);

    // Release the initial lock — should cascade through all waiters one by one
    firstRelease();

    // Release each in sequence
    for (let i = 0; i < N; i++) {
      const release = await promises[i]!;
      release();
    }

    // All should have resolved in FIFO order (0, 1, 2, ..., 9)
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("acquire resolves immediately when mutex is not held", async () => {
    const mutex = new WorktreeMutex();
    // Should resolve synchronously (within the same microtask)
    const release = await mutex.acquire();
    expect(release).toBeTypeOf("function");
    release();
  });
});
