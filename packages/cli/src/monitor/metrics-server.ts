import http from "node:http";
import { randomUUID } from "node:crypto";
import type { PrometheusMetrics } from "./prometheus-metrics.js";
import { constantTimeEquals } from "../utils/ct-equals.js";

/**
 * Tiny HTTP server that exposes the Prometheus `/metrics` endpoint.
 *
 * Security: mirrors `WsMonitorServer`'s per-run UUID auth token. Every request
 * except GET `/healthz` requires the token via either the `?token=<uuid>`
 * query parameter or `Authorization: Bearer <uuid>` header. Unauthorized
 * requests get a 401 with no body — not a helpful error to prevent
 * token-probing. `/healthz` is intentionally open so Prometheus service
 * discovery and orchestrators can liveness-probe without auth.
 *
 * This is not a fortress. It sits behind the operator's network boundary;
 * public-internet exposure should be fronted by a reverse proxy that enforces
 * its own auth. The auth token is printed once to stdout alongside the URL.
 */

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// Graceful-shutdown budget: in-flight `/metrics` renders have this long to
// finish before we forcibly terminate keep-alive connections. Small enough
// that a dead scraper can't stall CLI shutdown past a user-noticeable window.
const STOP_GRACE_MS = 500;

export interface MetricsServerOptions {
  port: number;
  metrics: PrometheusMetrics;
  /**
   * Optional pre-generated auth token. If omitted, a fresh UUID is generated.
   * Override primarily exists for tests and for callers that want to share a
   * token with another subsystem.
   */
  authToken?: string;
}

export class MetricsServer {
  private readonly server: http.Server;
  private readonly metrics: PrometheusMetrics;
  private readonly authToken: string;
  private listening = false;
  private actualPort: number | null = null;

  constructor(options: MetricsServerOptions) {
    this.metrics = options.metrics;
    this.authToken = options.authToken ?? randomUUID();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  /**
   * Start listening on the configured port. Resolves with the actual bound
   * port (useful when `port: 0` was passed, which asks the OS for an ephemeral
   * port). Idempotent — calling a second time returns the same port.
   */
  async start(port: number): Promise<number> {
    if (this.listening && this.actualPort !== null) return this.actualPort;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.listening = true;
    const addr = this.server.address();
    if (addr && typeof addr === "object") {
      this.actualPort = addr.port;
    } else {
      this.actualPort = port;
    }
    return this.actualPort;
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    // `http.Server.close()` waits for ALL active connections to finish before
    // resolving. Prometheus scrapers use HTTP/1.1 keep-alive, so a sleeping
    // scraper connection can block shutdown for the duration of its keep-alive
    // timeout (commonly 15–60s). Force-close idle keep-alives immediately and
    // escalate to `closeAllConnections` after a short grace period so an
    // in-flight `/metrics` render can still finish cleanly. Without this,
    // `await metricsServer.stop()` in the run-command finally block would hang
    // the CLI on any active scraper.
    this.server.closeIdleConnections?.();
    const forceClose = setTimeout(() => {
      this.server.closeAllConnections?.();
    }, STOP_GRACE_MS);
    forceClose.unref?.();
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => (err ? reject(err) : resolve()));
      });
    } finally {
      clearTimeout(forceClose);
    }
    this.listening = false;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    // Open liveness endpoint — no auth.
    if (req.method === "GET" && urlPath === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method !== "GET" || urlPath !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401);
      res.end();
      return;
    }

    const body = this.metrics.renderPrometheus();
    res.writeHead(200, { "Content-Type": METRICS_CONTENT_TYPE });
    res.end(body);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    // Query parameter
    const url = new URL(req.url ?? "/", "http://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken && constantTimeEquals(queryToken, this.authToken)) return true;

    // Authorization header (Bearer <token>)
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (m && constantTimeEquals(m[1]!, this.authToken)) return true;
    }

    return false;
  }
}
