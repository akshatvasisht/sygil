/**
 * SyncRegistry — workflow-scoped mutex and semaphore primitives.
 *
 * Nodes declare `synchronization: { mutex: "<key>" }` or
 * `synchronization: { semaphore: { key: "<key>", limit: N } }` in their
 * NodeConfig. The scheduler acquires a slot from the registry BEFORE
 * acquiring the adapter pool slot, and releases it in the finally block
 * symmetric with the adapter pool release.
 *
 * Key invariant: first-acquire-wins on the limit for a given key. If two
 * nodes declare the same key with different limits, acquire() throws at the
 * point the mismatch is detected.
 *
 * Waiters are dequeued in descending critical-path weight order so
 * higher-weight nodes (longer remaining work) proceed first. Ties preserve
 * FIFO insertion order.
 */

interface Waiter {
  nodeId: string;
  /** Critical-path weight — higher weight dequeues first. */
  weight: number;
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
}

interface SyncSlot {
  /** 1 for mutex, N for semaphore. */
  limit: number;
  /** Number of currently acquired slots. */
  acquired: number;
  /** FIFO queue sorted by descending weight. */
  waiters: Waiter[];
}

export interface Release {
  release(): void;
}

export class SyncRegistry {
  private slots = new Map<string, SyncSlot>();
  private weights: Map<string, number>;

  constructor(weights: Map<string, number>) {
    this.weights = weights;
  }

  async acquire(
    key: string,
    limit: number,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<Release> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { limit, acquired: 0, waiters: [] };
      this.slots.set(key, slot);
    } else if (slot.limit !== limit) {
      throw new Error(
        `Sync key "${key}" was first declared with limit=${slot.limit}; node "${nodeId}" declares limit=${limit}. Limits must match across nodes sharing a key.`,
      );
    }

    if (slot.acquired < slot.limit) {
      slot.acquired++;
      return this.makeRelease(key);
    }

    // No slot available — queue a waiter
    return new Promise<Release>((resolve, reject) => {
      // Capture slot reference so the abort listener closure stays valid
      const currentSlot = slot!;

      const waiter: Waiter = {
        nodeId,
        weight: this.weights.get(nodeId) ?? 0,
        resolve: () => {
          currentSlot.acquired++;
          resolve(this.makeRelease(key));
        },
        reject,
        ...(signal !== undefined ? { signal } : {}),
      };

      // Insert in descending weight order; equal-weight waiters preserve FIFO
      const idx = currentSlot.waiters.findIndex(
        (w) => w.weight < waiter.weight,
      );
      if (idx === -1) {
        currentSlot.waiters.push(waiter);
      } else {
        currentSlot.waiters.splice(idx, 0, waiter);
      }

      signal?.addEventListener(
        "abort",
        () => {
          const i = currentSlot.waiters.indexOf(waiter);
          if (i >= 0) currentSlot.waiters.splice(i, 1);
          reject(new Error("Sync acquisition aborted"));
        },
        { once: true },
      );
    });
  }

  private makeRelease(key: string): Release {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const slot = this.slots.get(key);
        if (!slot) return;
        slot.acquired--;
        const next = slot.waiters.shift();
        if (next) next.resolve();
      },
    };
  }
}
