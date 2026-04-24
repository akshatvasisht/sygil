import { randomUUID } from "node:crypto";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;
const WAIT_SAMPLE_CAPACITY = 1000;

/**
 * Circuit breaker defaults. Tuned against the suggested
 * "5 failures in 30s → open for 60s" sizing, which tracks industry practice
 * (Resilience4j / Polly / Hystrix-style breakers typically pair a count-based
 * window with a fixed cooldown).
 */
const DEFAULT_CB_FAILURE_THRESHOLD = 5;
const DEFAULT_CB_WINDOW_MS = 30_000;
const DEFAULT_CB_COOLDOWN_MS = 60_000;

export interface CircuitBreakerConfig {
  /** Failures within `windowMs` required to trip the circuit. Default 5. */
  failureThreshold?: number;
  /** Rolling window (ms) over which failures are counted. Default 30_000. */
  windowMs?: number;
  /** How long (ms) the circuit stays open before transitioning to half-open. Default 60_000. */
  cooldownMs?: number;
}

export interface PoolConfig {
  maxConcurrency: number;
  perAdapterLimit?: number;
  acquireTimeoutMs?: number;
  /**
   * Opt-in per-adapter-type circuit breaker. When absent the pool
   * skips all failure/success bookkeeping and `acquire()` never throws
   * CircuitOpenError. When present, even `{}` is enough to enable defaults.
   */
  circuitBreaker?: CircuitBreakerConfig;
}

export interface WaitStats {
  samples: number[];
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

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitStateSnapshot {
  state: CircuitState;
  openUntil?: number;
  recentFailures: number;
}

export interface CircuitStateChange {
  adapterType: string;
  from: CircuitState;
  to: CircuitState;
  reason?: string;
  openUntil?: number;
}

interface BreakerState {
  /** Epoch-ms timestamps of failures within the rolling window. */
  failures: number[];
  state: CircuitState;
  /** Epoch ms when the circuit will transition to half-open. Only set when state === "open". */
  openUntil?: number;
  /**
   * True once a probe acquire has been granted in the current half_open phase.
   * Only one probe is permitted at a time — subsequent acquires fail-fast
   * until the probe succeeds (→ closed) or fails (→ open).
   */
  halfOpenProbeInFlight: boolean;
}

/**
 * Typed rejection returned by `AdapterPool.acquire` when the circuit for the
 * requested adapter type is open. The scheduler's error classifier recognises
 * this via `instanceof Error && name === "CircuitOpenError"` and marks it
 * retryable so provider failover can pick the next adapter.
 */
export class CircuitOpenError extends Error {
  readonly adapterType: string;
  readonly openUntil: number;

  constructor(adapterType: string, openUntil: number) {
    super(`Circuit open for adapter "${adapterType}" until ${new Date(openUntil).toISOString()}`);
    this.name = "CircuitOpenError";
    this.adapterType = adapterType;
    this.openUntil = openUntil;
  }
}

export class AdapterPool {
  private readonly maxConcurrency: number;
  private readonly perAdapterLimit: number | undefined;
  private readonly acquireTimeoutMs: number;

  private readonly activeSlots = new Map<string, PoolSlot>();
  private readonly waitQueue: Waiter[] = [];
  private draining = false;
  private drainResolve: (() => void) | null = null;

  /** Rolling buffer of recent acquire-wait durations in ms. Bounded; drops oldest. */
  private readonly waitSamples: number[] = [];
  /** Write index for the ring. */
  private waitWriteIdx = 0;
  /** True once the ring has wrapped at least once. */
  private waitWrapped = false;

  /** Per-adapter-type circuit-breaker state. Null when CB is disabled. */
  private readonly breakers: Map<string, BreakerState> | null;
  private readonly cbFailureThreshold: number;
  private readonly cbWindowMs: number;
  private readonly cbCooldownMs: number;
  private onCircuitStateChange: ((change: CircuitStateChange) => void) | null = null;
  private onWaitObserved: ((adapterType: string, waitMs: number) => void) | null = null;

  constructor(config: PoolConfig) {
    this.maxConcurrency = config.maxConcurrency;
    this.perAdapterLimit = config.perAdapterLimit;
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

    if (config.circuitBreaker !== undefined) {
      this.breakers = new Map();
      this.cbFailureThreshold = config.circuitBreaker.failureThreshold ?? DEFAULT_CB_FAILURE_THRESHOLD;
      this.cbWindowMs = config.circuitBreaker.windowMs ?? DEFAULT_CB_WINDOW_MS;
      this.cbCooldownMs = config.circuitBreaker.cooldownMs ?? DEFAULT_CB_COOLDOWN_MS;
    } else {
      this.breakers = null;
      this.cbFailureThreshold = DEFAULT_CB_FAILURE_THRESHOLD;
      this.cbWindowMs = DEFAULT_CB_WINDOW_MS;
      this.cbCooldownMs = DEFAULT_CB_COOLDOWN_MS;
    }
  }

  /**
   * Register a listener for circuit-breaker state transitions. At most one
   * listener is supported (setting a new one replaces the previous). The
   * scheduler uses this to emit `circuit_breaker` WsServerEvents.
   */
  setCircuitStateListener(listener: ((change: CircuitStateChange) => void) | null): void {
    this.onCircuitStateChange = listener;
  }

  /**
   * Register a listener that fires for every acquire wait. The
   * callback receives the adapter type and the wait duration in ms (0 for
   * uncontended acquires). Used by the Prometheus exporter to populate
   * `sygil_adapter_acquire_wait_seconds`. At most one listener is supported.
   */
  setWaitObserver(listener: ((adapterType: string, waitMs: number) => void) | null): void {
    this.onWaitObserved = listener;
  }

  acquire(adapterType: string): Promise<PoolSlot> {
    if (this.draining) {
      return Promise.reject(new Error("Pool is in drain mode — no new acquires accepted"));
    }

    // Circuit breaker check. If the circuit is open and the
    // cooldown hasn't elapsed, fail fast so the scheduler can failover to the
    // next provider without holding a pool slot or spawning an adapter.
    const breakerRejection = this.checkBreakerOnAcquire(adapterType);
    if (breakerRejection) {
      return Promise.reject(breakerRejection);
    }

    // Check if we can grant immediately (wait time ~0, still sampled so
    // aggregate reflects uncontended hits alongside contended waits)
    if (this.canAcquire(adapterType)) {
      this.recordWait(0);
      this.onWaitObserved?.(adapterType, 0);
      return Promise.resolve(this.createSlot(adapterType));
    }

    // Otherwise, enqueue and wait
    const startedAt = Date.now();
    return new Promise<PoolSlot>((resolve, reject) => {
      const wrappedResolve = (slot: PoolSlot): void => {
        const waitMs = Date.now() - startedAt;
        this.recordWait(waitMs);
        this.onWaitObserved?.(adapterType, waitMs);
        resolve(slot);
      };

      const timer = setTimeout(() => {
        // Remove from queue on timeout — match by wrappedResolve identity, which
        // is what the queue actually stores
        const idx = this.waitQueue.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new Error(`Acquire timeout after ${this.acquireTimeoutMs}ms for adapter "${adapterType}"`));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ adapterType, resolve: wrappedResolve, reject, timer });
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

  /**
   * Returns a snapshot of recent acquire-wait samples (ms), bounded at
   * WAIT_SAMPLE_CAPACITY. Callers compute percentiles; the pool does not cache
   * them because the ring is mutated after each acquire and re-sorting on every
   * mutation would be wasteful for a metric only read at ~1Hz.
   */
  waitStats(): WaitStats {
    if (!this.waitWrapped) {
      return { samples: this.waitSamples.slice(0, this.waitWriteIdx) };
    }
    // Ring has wrapped — return logically ordered samples (oldest→newest).
    // Order doesn't actually matter for percentile math but we keep it stable
    // in case callers want time-ordered sampling later.
    return {
      samples: [
        ...this.waitSamples.slice(this.waitWriteIdx),
        ...this.waitSamples.slice(0, this.waitWriteIdx),
      ],
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

  private recordWait(durationMs: number): void {
    if (this.waitSamples.length < WAIT_SAMPLE_CAPACITY) {
      this.waitSamples.push(durationMs);
      this.waitWriteIdx = this.waitSamples.length % WAIT_SAMPLE_CAPACITY;
      if (this.waitWriteIdx === 0) this.waitWrapped = true;
      return;
    }
    this.waitSamples[this.waitWriteIdx] = durationMs;
    this.waitWriteIdx = (this.waitWriteIdx + 1) % WAIT_SAMPLE_CAPACITY;
    this.waitWrapped = true;
  }

  private tryFulfillNext(): void {
    // Walk the queue in FIFO order and fulfill the first waiter whose
    // adapter type can be acquired (respects per-adapter limits)
    for (let i = 0; i < this.waitQueue.length; i++) {
      const waiter = this.waitQueue[i]!;
      // Skip waiters whose circuit is open — they'll keep waiting until the
      // timeout fires (the scheduler's failover path ordinarily rejects these
      // via acquire's pre-check, but queued waiters didn't get that check).
      if (this.isBreakerBlockingWaiter(waiter.adapterType)) continue;
      if (this.canAcquire(waiter.adapterType)) {
        this.waitQueue.splice(i, 1);
        clearTimeout(waiter.timer);
        const slot = this.createSlot(waiter.adapterType);
        waiter.resolve(slot);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker
  // ---------------------------------------------------------------------------

  /**
   * Record a failure for the given adapter type. Called by the scheduler when
   * a retryable (transport / 5xx / circuit_open cascading) error bubbles out of
   * adapter.spawn / stream / getResult. No-op when the circuit breaker is
   * disabled.
   *
   * A rate-limit error is NOT recorded here — rate limits are expected,
   * provider-directed pauses; counting them toward the circuit trip would
   * cause a single noisy-tenant rate-limit burst to pull down the circuit for
   * all nodes.
   */
  recordFailure(adapterType: string, reason?: string): void {
    if (!this.breakers) return;
    // A `CircuitOpenError` is the breaker signalling itself — not evidence the
    // adapter is unhealthy. Counting it toward failures races with the genuine
    // in-flight half-open probe: a concurrent acquire rejection re-opens the
    // circuit and the real probe's success becomes a no-op.
    if (reason === "circuit_open") return;

    // rate_limit is provider-directed backpressure, not a health signal, so it
    // does NOT count toward the sliding-window failure threshold. But if a
    // probe is in flight for this adapter we must still clear the flag —
    // otherwise the circuit is pinned at half_open forever because no future
    // acquire can become the probe. No breaker = no probe;
    // do not create one just to observe the flag.
    //
    // Same treatment for `reason === undefined`: the scheduler calls
    // recordFailure unconditionally on every adapter failure so probe
    // resolution is always signalled, but passes `undefined` when
    // classifyError didn't recognise the failure (a non-retryable /
    // deterministic bug — e.g. adapter config error, invalid API key). We
    // must not count these toward the threshold (that would trip the
    // breaker on application bugs), but we MUST clear the probe flag for
    // the same reason as rate_limit: an unclassified throw during a
    // half_open probe used to pin the circuit indefinitely.
    // Staying in half_open lets the next acquire retry the probe.
    if (reason === "rate_limit" || reason === undefined) {
      const existing = this.breakers.get(adapterType);
      if (existing && existing.state === "half_open") {
        existing.halfOpenProbeInFlight = false;
      }
      return;
    }

    const now = Date.now();
    const breaker = this.ensureBreaker(adapterType);

    // If the failure arrived during a half-open probe, re-open the circuit.
    if (breaker.state === "half_open") {
      breaker.halfOpenProbeInFlight = false;
      this.transitionTo(adapterType, breaker, "open", reason, now + this.cbCooldownMs);
      return;
    }

    // Append failure and prune samples outside the window.
    breaker.failures.push(now);
    const cutoff = now - this.cbWindowMs;
    while (breaker.failures.length > 0 && breaker.failures[0]! < cutoff) {
      breaker.failures.shift();
    }

    // Trip the breaker if threshold crossed. Closed → open.
    if (
      breaker.state === "closed" &&
      breaker.failures.length >= this.cbFailureThreshold
    ) {
      this.transitionTo(adapterType, breaker, "open", reason, now + this.cbCooldownMs);
    }
  }

  /**
   * Record a success for the given adapter type. A success during half-open
   * closes the circuit; a success during closed is a no-op (the rolling
   * window simply doesn't accumulate). No-op when the circuit breaker is
   * disabled.
   */
  recordSuccess(adapterType: string): void {
    if (!this.breakers) return;
    const breaker = this.breakers.get(adapterType);
    if (!breaker) return;

    if (breaker.state === "half_open") {
      breaker.halfOpenProbeInFlight = false;
      breaker.failures.length = 0;
      this.transitionTo(adapterType, breaker, "closed", "probe_success");
    }
  }

  /**
   * Current snapshot of all tracked adapter breakers. Used by the monitor
   * metrics tick to publish state alongside percentiles. Returns an empty
   * object when the circuit breaker is disabled.
   */
  circuitStates(): Record<string, CircuitStateSnapshot> {
    if (!this.breakers) return {};
    const now = Date.now();
    const out: Record<string, CircuitStateSnapshot> = {};
    for (const [adapterType, breaker] of this.breakers) {
      const cutoff = now - this.cbWindowMs;
      const recentFailures = breaker.failures.filter((t) => t >= cutoff).length;
      out[adapterType] = {
        state: breaker.state,
        recentFailures,
        ...(breaker.openUntil !== undefined ? { openUntil: breaker.openUntil } : {}),
      };
    }
    return out;
  }

  private ensureBreaker(adapterType: string): BreakerState {
    const existing = this.breakers!.get(adapterType);
    if (existing) return existing;
    const fresh: BreakerState = {
      failures: [],
      state: "closed",
      halfOpenProbeInFlight: false,
    };
    this.breakers!.set(adapterType, fresh);
    return fresh;
  }

  private transitionTo(
    adapterType: string,
    breaker: BreakerState,
    to: CircuitState,
    reason?: string,
    openUntil?: number,
  ): void {
    const from = breaker.state;
    breaker.state = to;
    if (to === "open" && openUntil !== undefined) {
      breaker.openUntil = openUntil;
    } else {
      delete breaker.openUntil;
    }

    if (from === to) return;

    const change: CircuitStateChange = {
      adapterType,
      from,
      to,
      ...(reason !== undefined ? { reason } : {}),
      ...(openUntil !== undefined ? { openUntil } : {}),
    };
    this.onCircuitStateChange?.(change);
  }

  /**
   * Pre-acquire check. Returns a CircuitOpenError if the circuit is open and
   * the cooldown hasn't elapsed, or if a half-open probe is already in flight.
   * Returns null when the acquire should proceed (closed, or half-open and
   * this caller becomes the probe).
   */
  private checkBreakerOnAcquire(adapterType: string): CircuitOpenError | null {
    if (!this.breakers) return null;
    const breaker = this.breakers.get(adapterType);
    if (!breaker) return null;

    const now = Date.now();

    if (breaker.state === "open") {
      if (breaker.openUntil !== undefined && now >= breaker.openUntil) {
        // Cooldown elapsed → transition to half-open and allow this probe.
        this.transitionTo(adapterType, breaker, "half_open", "cooldown_elapsed");
        breaker.halfOpenProbeInFlight = true;
        return null;
      }
      return new CircuitOpenError(adapterType, breaker.openUntil ?? now + this.cbCooldownMs);
    }

    if (breaker.state === "half_open") {
      if (breaker.halfOpenProbeInFlight) {
        // Another probe is in flight; keep failing fast until it resolves.
        return new CircuitOpenError(adapterType, now + this.cbCooldownMs);
      }
      breaker.halfOpenProbeInFlight = true;
      return null;
    }

    return null;
  }

  /**
   * Queue fulfillment check — same logic as checkBreakerOnAcquire but pure:
   * does not mutate the breaker. Used when tryFulfillNext walks queued waiters
   * (the acquire-time check already tripped; this prevents fulfilling a
   * waiter that has since become blocked by a state change).
   */
  private isBreakerBlockingWaiter(adapterType: string): boolean {
    if (!this.breakers) return false;
    const breaker = this.breakers.get(adapterType);
    if (!breaker) return false;
    // State=="open": block queued waiters unconditionally, even after the
    // cooldown has elapsed. The open→half_open transition + probe-flag claim
    // lives in `checkBreakerOnAcquire` (driven by *fresh* acquires). Letting
    // a queued waiter through on "cooldown-elapsed" silently bypasses that
    // transition — the fulfillment runs with state still "open", and a
    // concurrent fresh acquire then claims the probe slot for itself, so
    // two adapter invocations end up racing as implicit probes. That
    // violates the "exactly one probe permitted" invariant documented in
    // CLAUDE.md (AdapterPool circuit breaker section). Queued waiters will
    // time out via `acquireTimeoutMs` if the circuit stays open; the
    // scheduler's failover path then picks the next provider — which is
    // exactly the documented behaviour.
    if (breaker.state === "open") return true;
    if (breaker.state === "half_open" && breaker.halfOpenProbeInFlight) return true;
    return false;
  }
}
