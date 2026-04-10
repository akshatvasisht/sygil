import { randomUUID } from "node:crypto";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;

export interface PoolConfig {
  maxConcurrency: number;
  perAdapterLimit?: number;
  acquireTimeoutMs?: number;
}

export interface PoolSlot {
  id: string;
  adapterType: string;
  acquiredAt: number;
}

interface Waiter {
  adapterType: string;
  resolve: (slot: PoolSlot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AdapterPool {
  private readonly maxConcurrency: number;
  private readonly perAdapterLimit: number | undefined;
  private readonly acquireTimeoutMs: number;

  private readonly activeSlots = new Map<string, PoolSlot>();
  private readonly waitQueue: Waiter[] = [];
  private draining = false;
  private drainResolve: (() => void) | null = null;

  constructor(config: PoolConfig) {
    this.maxConcurrency = config.maxConcurrency;
    this.perAdapterLimit = config.perAdapterLimit;
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  }

  acquire(adapterType: string): Promise<PoolSlot> {
    if (this.draining) {
      return Promise.reject(new Error("Pool is in drain mode — no new acquires accepted"));
    }

    // Check if we can grant immediately
    if (this.canAcquire(adapterType)) {
      return Promise.resolve(this.createSlot(adapterType));
    }

    // Otherwise, enqueue and wait
    return new Promise<PoolSlot>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new Error(`Acquire timeout after ${this.acquireTimeoutMs}ms for adapter "${adapterType}"`));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ adapterType, resolve, reject, timer });
    });
  }

  release(slot: PoolSlot): void {
    if (!this.activeSlots.has(slot.id)) {
      throw new Error(`Unknown slot "${slot.id}" — cannot release a slot that is not active`);
    }

    this.activeSlots.delete(slot.id);

    // If draining, check if we can resolve the drain promise
    if (this.draining) {
      if (this.activeSlots.size === 0 && this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
      }
      return;
    }

    // Try to fulfill the next waiter in FIFO order
    this.tryFulfillNext();
  }

  stats(): { active: number; waiting: number; maxConcurrency: number } {
    return {
      active: this.activeSlots.size,
      waiting: this.waitQueue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  drain(): Promise<void> {
    this.draining = true;

    // Reject all waiting acquires
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool is in drain mode — no new acquires accepted"));
    }
    this.waitQueue.length = 0;

    if (this.activeSlots.size === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }

  private canAcquire(adapterType: string): boolean {
    // Check global limit
    if (this.activeSlots.size >= this.maxConcurrency) {
      return false;
    }

    // Check per-adapter limit
    if (this.perAdapterLimit !== undefined) {
      let adapterCount = 0;
      for (const slot of this.activeSlots.values()) {
        if (slot.adapterType === adapterType) {
          adapterCount++;
        }
      }
      if (adapterCount >= this.perAdapterLimit) {
        return false;
      }
    }

    return true;
  }

  private createSlot(adapterType: string): PoolSlot {
    const slot: PoolSlot = {
      id: randomUUID(),
      adapterType,
      acquiredAt: Date.now(),
    };
    this.activeSlots.set(slot.id, slot);
    return slot;
  }

  private tryFulfillNext(): void {
    // Walk the queue in FIFO order and fulfill the first waiter whose
    // adapter type can be acquired (respects per-adapter limits)
    for (let i = 0; i < this.waitQueue.length; i++) {
      const waiter = this.waitQueue[i]!;
      if (this.canAcquire(waiter.adapterType)) {
        this.waitQueue.splice(i, 1);
        clearTimeout(waiter.timer);
        const slot = this.createSlot(waiter.adapterType);
        waiter.resolve(slot);
        return;
      }
    }
  }
}
