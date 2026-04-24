import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OtlpPusher } from "./otlp-push.js";
import { PrometheusMetrics } from "./prometheus-metrics.js";

describe("OtlpPusher", () => {
  let metrics: PrometheusMetrics;

  beforeEach(() => {
    metrics = new PrometheusMetrics();
    metrics.recordCheckpointWrite();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushOnce POSTs JSON to {endpoint}/v1/metrics when no suffix given", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.pushOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe("http://collector:4318/v1/metrics");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.resourceMetrics).toBeInstanceOf(Array);
  });

  it("respects a fully-qualified endpoint ending in /v1/metrics", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const p = new OtlpPusher({
      endpoint: "https://otel.example.com/v1/metrics",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.pushOnce();
    const [url] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe("https://otel.example.com/v1/metrics");
  });

  it("strips trailing slashes before appending /v1/metrics", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const p = new OtlpPusher({
      endpoint: "http://collector:4318///",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.pushOnce();
    const [url] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe("http://collector:4318/v1/metrics");
  });

  it("forwards custom headers (bearer auth, etc.)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      headers: { Authorization: "Bearer xyz", "X-Tenant": "acme" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.pushOnce();
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const headers = calls[0]![1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xyz");
    expect(headers["X-Tenant"]).toBe("acme");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("throws from pushOnce when backend responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.pushOnce()).rejects.toThrow(/503/);
  });

  it("start() fires the interval and calls pushOnce at each tick; start() is idempotent", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    let intervalFn: (() => void) | null = null;
    const fakeSet = ((fn: () => void) => {
      intervalFn = fn;
      return { tag: "timer" } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const fakeClear = vi.fn();

    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      exportIntervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear as unknown as typeof clearInterval,
    });
    p.start();
    p.start(); // idempotent
    expect(intervalFn).not.toBeNull();
    intervalFn!();
    // pushOnce runs in a microtask — wait for it
    await new Promise((r) => setImmediate(r));
    expect(fetchImpl).toHaveBeenCalledOnce();

    await p.stop();
    expect(fakeClear).toHaveBeenCalledOnce();
  });

  it("swallows push failures in the interval timer (does not throw)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    let intervalFn: (() => void) | null = null;
    const fakeSet = ((fn: () => void) => {
      intervalFn = fn;
      return { tag: "timer" } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: ((_t: unknown) => {}) as unknown as typeof clearInterval,
    });
    p.start();
    expect(() => intervalFn!()).not.toThrow();
    // Let the rejection settle — stop waits for in-flight push.
    await p.stop();
  });

  it("aborts pushOnce via AbortSignal when collector hangs past exportTimeoutMs", async () => {
    // Observe the AbortSignal threaded to fetch and assert it aborts after the
    // configured timeout. Without this, a dead collector would hang
    // `await otlpPusher.stop()` in the run-command finally block indefinitely.
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      exportTimeoutMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.pushOnce()).rejects.toThrow(/abort/i);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("stop() awaits in-flight push before resolving", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = vi.fn(() =>
      new Promise<Response>((r) => {
        resolveFetch = r;
      }),
    );
    let intervalFn: (() => void) | null = null;
    const fakeSet = ((fn: () => void) => {
      intervalFn = fn;
      return { tag: "timer" } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const p = new OtlpPusher({
      endpoint: "http://collector:4318",
      metrics,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: ((_t: unknown) => {}) as unknown as typeof clearInterval,
    });
    p.start();
    intervalFn!();
    const stopPromise = p.stop();
    // Give the tick's microtask chain a chance to run.
    await new Promise((r) => setImmediate(r));
    resolveFetch(new Response(null, { status: 200 }));
    await stopPromise;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
