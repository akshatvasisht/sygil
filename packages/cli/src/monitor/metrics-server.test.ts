import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetricsServer, METRICS_CONTENT_TYPE } from "./metrics-server.js";
import { PrometheusMetrics } from "./prometheus-metrics.js";

describe("MetricsServer", () => {
  let metrics: PrometheusMetrics;
  let server: MetricsServer;
  let port: number;
  let token: string;

  beforeEach(async () => {
    metrics = new PrometheusMetrics();
    server = new MetricsServer({ port: 0, metrics, authToken: "test-token-1234" });
    port = await server.start(0);
    token = server.getAuthToken();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("uses the provided auth token when passed", () => {
    expect(token).toBe("test-token-1234");
  });

  it("generates a UUID token when none is passed", async () => {
    const other = new MetricsServer({ port: 0, metrics });
    await other.start(0);
    try {
      const t = other.getAuthToken();
      expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      await other.stop();
    }
  });

  it("returns 401 for GET /metrics with no token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for GET /metrics with a wrong token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics?token=not-the-token`);
    expect(res.status).toBe(401);
  });

  it("returns 200 + Prometheus content-type with valid query token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain("# TYPE sygil_node_total counter");
  });

  it("returns 200 with valid Authorization: Bearer header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with an incorrect Bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("exposes GET /healthz without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/foo?token=${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-GET methods on /metrics", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics?token=${token}`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("serves the live registry — updates reflect in subsequent scrapes", async () => {
    metrics.recordCheckpointWrite();
    const r1 = await fetch(`http://127.0.0.1:${port}/metrics?token=${token}`);
    expect(await r1.text()).toMatch(/sygil_checkpoint_write_total 1/);
    metrics.recordCheckpointWrite();
    const r2 = await fetch(`http://127.0.0.1:${port}/metrics?token=${token}`);
    expect(await r2.text()).toMatch(/sygil_checkpoint_write_total 2/);
  });

  it("stop() is idempotent", async () => {
    const s = new MetricsServer({ port: 0, metrics });
    await s.start(0);
    await s.stop();
    await s.stop(); // should not throw
  });
});
