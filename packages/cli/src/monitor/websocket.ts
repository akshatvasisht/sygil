import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import sirv from "sirv";
import type { WsServerEvent, WsClientEvent } from "@sygil/shared";
import { WsClientEventSchema, RunRequestSchema } from "@sygil/shared";
import { logger } from "../utils/logger.js";
import { EventFanOut } from "./event-fanout.js";
import { MetricsAggregator } from "./metrics-aggregator.js";
import type { PrometheusMetrics } from "./prometheus-metrics.js";
import type { AdapterPool } from "../adapters/adapter-pool.js";
import { constantTimeEquals } from "../utils/ct-equals.js";

interface SubscriberInfo {
  ws: WebSocket;
  workflowIds: Set<string>;
  authenticated: boolean;
  /** Refreshed on every pong; the next heartbeat tick terminates dead clients. */
  isAlive: boolean;
}

/**
 * Heartbeat interval. Every tick, we ping every client and terminate
 * anyone who hasn't ponged since the previous tick. 30s matches the canonical
 * `ws` pattern and is fast enough to reap a suspended laptop within a minute.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Upper bound for `drain()` on graceful shutdown. A client whose
 * `bufferedAmount` hasn't hit zero by this deadline gets `terminate()`-d —
 * we do not block the CLI's exit on an unresponsive TCP peer.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * WsMonitorServer — WebSocket server for real-time workflow monitoring.
 *
 * Clients connect and send `{ "type": "subscribe", "workflowId": "..." }` to
 * receive events for a specific workflow run. The scheduler calls `emit()` to
 * broadcast events to all subscribed clients.
 */
export interface WsMonitorServerConfig {
  /**
   * Override the heartbeat cadence. Defaults to `HEARTBEAT_INTERVAL_MS` (30s).
   * Intended for tests that need sub-second liveness reaping.
   */
  heartbeatIntervalMs?: number;
}

export class WsMonitorServer {
  private wss: WebSocketServer | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private subscribers = new Map<WebSocket, SubscriberInfo>();
  private port: number | null = null;
  private fanOut = new EventFanOut();
  private metrics = new MetricsAggregator();
  private prometheusMetrics: PrometheusMetrics | null = null;
  private clientIdCounter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;

  constructor(config: WsMonitorServerConfig = {}) {
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  /** Per-run auth token required for control events (pause/cancel/human_review). */
  private authToken: string = randomUUID();

  /** Returns the current auth token. Include this in the monitor URL for clients. */
  getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Start the WebSocket server on a random available port.
   * Returns the port number.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Serve the pre-built monitor UI from dist-ui/ when available.
      // Skipped in dev mode (SYGIL_UI_DEV=1) so the Next.js dev server handles it.
      const distUiPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../dist-ui"
      );
      const serveUi =
        process.env["SYGIL_UI_DEV"] !== "1" && existsSync(distUiPath);

      // Build the static file handler once. dist-ui may not exist when
      // running directly from source without a prior `next build` — guard
      // with existsSync so the CLI degrades gracefully in that case.
      const uiHandler = serveUi ? sirv(distUiPath, { dev: false }) : null;

      const httpServer = createServer((req, res) => {
        // POST /run — spawn a sygil run from the web editor
        const reqPath = (req.url ?? "/").split("?")[0];
        if (req.method === "POST" && reqPath === "/run") {
          this.handlePostRun(req, res).catch((err: unknown) => {
            logger.error(`[monitor] POST /run unhandled error: ${err}`);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            }
          });
          return;
        }

        if (uiHandler) {
          uiHandler(req, res, () => {
            res.writeHead(404);
            res.end();
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const wss = new WebSocketServer({ server: httpServer });

      wss.on("connection", (ws, req) => {
        const clientId = `ws-${++this.clientIdCounter}`;

        // Check auth token from query string: ws://host:port/?token=<uuid>
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const token = url.searchParams.get("token");
        const authenticated = token !== null && constantTimeEquals(token, this.authToken);

        const info: SubscriberInfo = { ws, workflowIds: new Set(), authenticated, isAlive: true };
        this.subscribers.set(ws, info);

        // Refresh liveness on every pong — the heartbeat tick reads this flag
        // to reap clients that never responded.
        ws.on("pong", () => { info.isAlive = true; });

        // Register with fan-out using a filter that checks workflowId subscription
        this.fanOut.addClient(clientId, ws, (event: unknown) => {
          const obj = event as Record<string, unknown>;
          const workflowId = typeof obj.workflowId === "string" ? obj.workflowId : null;
          // If the event has no workflowId, broadcast to all; otherwise check subscription
          return !workflowId || info.workflowIds.has(workflowId);
        });

        ws.on("message", (data) => {
          let raw: unknown;
          try {
            raw = JSON.parse(data.toString());
          } catch {
            return;
          }

          const parsed = WsClientEventSchema.safeParse(raw);
          if (!parsed.success) {
            logger.warn(`[monitor] rejected malformed client event: ${parsed.error.message}`);
            return;
          }
          const event: WsClientEvent = parsed.data;

          switch (event.type) {
            case "subscribe":
              info.workflowIds.add(event.workflowId);
              break;
            case "unsubscribe":
              info.workflowIds.delete(event.workflowId);
              break;
            case "pause":
            case "resume_workflow":
            case "cancel":
              // Control events require authentication
              if (!info.authenticated) break;
              this.onClientControl?.(event);
              break;
            case "human_review_approve":
            case "human_review_reject":
              // Human review responses require authentication
              if (!info.authenticated) break;
              this.onClientControl?.(event);
              break;
          }
        });

        ws.on("close", () => {
          this.subscribers.delete(ws);
          this.fanOut.removeClient(clientId);
        });

        ws.on("error", () => {
          this.subscribers.delete(ws);
          this.fanOut.removeClient(clientId);
        });
      });

      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Could not determine server port"));
          return;
        }
        this.port = addr.port;
        this.wss = wss;
        this.server = httpServer;
        this.fanOut.start();
        // Feed aggregator-emitted metrics_tick events back through the
        // server's own emit path so subscribers see them in the same fanout.
        this.metrics.start((evt) => this.emit(evt));
        this.startHeartbeat();
        resolve(this.port);
      });

      httpServer.on("error", reject);
    });
  }

  // ── POST /run helpers ──────────────────────────────────────────────────────

  /**
   * Check if an incoming HTTP request carries a valid auth token.
   * Accepts either:
   *   - `Authorization: Bearer <token>` header
   *   - `?token=<token>` query parameter
   */
  private isHttpAuthorized(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null && constantTimeEquals(queryToken, this.authToken)) return true;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7);
      if (constantTimeEquals(bearerToken, this.authToken)) return true;
    }

    return false;
  }

  /**
   * Read the full JSON body from an incoming HTTP request.
   * Rejects with an error if the body exceeds 4 MB.
   */
  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const MAX_BODY_BYTES = 4 * 1024 * 1024;
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(buf);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * Handle POST /run — spawn a new sygil run and return the runId.
   *
   * Auth: bearer token OR ?token= matching this server's authToken.
   * Body: RunRequestSchema (workflow + optional parameters + flags).
   * Working dir: per-run tmpdir so each run is isolated by default.
   *
   * The handler spawns `sygil run -` with the workflow JSON piped to stdin
   * and extracts the runId from stdout ("Run ID: <id>" line). It returns the
   * runId and this server's auth token so the caller can open the monitor URL.
   *
   * Child process stdio is not awaited — the run executes independently and
   * streams events back to this server via the existing WebSocket channel.
   */
  private async handlePostRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Auth
    if (!this.isHttpAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — provide a valid ?token= or Authorization: Bearer header" }));
      return;
    }

    // 2. Parse + validate body
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid request body: ${err instanceof Error ? err.message : String(err)}` }));
      return;
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Validation failed", issues: parsed.error.issues }));
      return;
    }

    const { workflow, parameters, isolate } = parsed.data;

    // 3. Create a per-run working directory (matches --isolate default)
    const workDir = await mkdtemp(path.join(tmpdir(), "sygil-run-"));

    // 4. Spawn `sygil run -` with workflow JSON piped to stdin
    //    Build extra flags from the request body
    const args: string[] = ["run", "-", "--no-monitor"];
    if (isolate) args.push("--isolate");
    if (parameters) {
      for (const [key, value] of Object.entries(parameters)) {
        args.push("--param", `${key}=${value}`);
      }
    }

    let runId: string | null = null;
    let childError: string | null = null;

    const child = spawn("sygil", args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Write workflow JSON to stdin, then close
    try {
      child.stdin.write(JSON.stringify(workflow));
      child.stdin.end();
    } catch (err) {
      logger.warn(`[monitor] POST /run — stdin write failed: ${err}`);
    }

    // 5. Extract runId from child stdout ("Run ID: <id>" line)
    const RUN_ID_TIMEOUT_MS = 5_000;
    const runIdPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), RUN_ID_TIMEOUT_MS);
      const RUN_ID_RE = /Run ID:\s+([^\s]+)/;
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const match = RUN_ID_RE.exec(buffer);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1] ?? null);
        }
      });
      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        childError = err.message;
        resolve(null);
      });
    });

    runId = await runIdPromise;

    if (childError) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to spawn sygil: ${childError}` }));
      return;
    }

    // 6. Return runId + monitorUrl + authToken
    const port = this.port ?? 0;
    const monitorUrl = `http://localhost:${port}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId, monitorUrl, authToken: this.authToken }));
  }

  /**
   * Emit a WsServerEvent to all clients subscribed to the relevant workflowId.
   *
   * Non-blocking — serializes once and pushes into per-client ring buffers.
   * A periodic flush timer batches and sends events to each WebSocket client.
   */
  emit(event: WsServerEvent): void {
    // Prometheus observation runs even in headless (`--no-monitor`) mode so
    // `--metrics-port` can be combined with a disabled WS monitor.
    this.prometheusMetrics?.observe(event);
    if (!this.wss) return;
    const eventWithTimestamp = { timestamp: new Date().toISOString(), ...event };
    // Observe before fanout so aggregates are consistent with what clients see.
    this.metrics.observe(event);
    this.fanOut.emit(eventWithTimestamp);
  }

  /**
   * Attach the Prometheus exporter so `/metrics` stays in lock-step with the
   * same event stream that the WebSocket fanout sees. Passing
   * `null` detaches — used in tests.
   */
  setPrometheusMetrics(metrics: PrometheusMetrics | null): void {
    this.prometheusMetrics = metrics;
  }

  /**
   * Attach (or detach with `null`) the adapter pool so the aggregator can
   * include pool occupancy + acquire-wait percentiles in each tick.
   * Scheduler calls this once after constructing its pool.
   */
  setAdapterPool(pool: AdapterPool | null): void {
    this.metrics.setAdapterPool(pool);
  }

  /**
   * Optional callback for client-side control events (pause/resume/cancel).
   * Wire this up in the scheduler if you want clients to control workflow execution.
   */
  onClientControl: ((event: WsClientEvent) => void) | undefined;

  /** Returns the port the server is listening on, or null if not started. */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Drain outbound buffers and close connections gracefully. Waits up
   * to `timeoutMs` for every client's `bufferedAmount` to reach zero, then
   * calls `stop()` to hard-close. Designed to be called from a SIGINT/SIGTERM
   * handler BEFORE the scheduler's final `workflow_end` event would otherwise
   * race the process exit.
   */
  async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (!this.wss) return;
    const deadline = Date.now() + timeoutMs;
    // Stop the fanout flush loop AFTER waiting so in-flight events still drain.
    const allFlushed = (): boolean => {
      for (const [ws] of this.subscribers) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 0) return false;
      }
      return true;
    };
    while (!allFlushed() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.stop();
  }

  /**
   * Ping every connected client on a 30s cadence and terminate any that
   * didn't pong between ticks. Without this, a suspended laptop or
   * silently-dropped connection keeps its per-client ring buffer allocated
   * in `EventFanOut` indefinitely.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    const tick = (): void => {
      if (!this.wss) return;
      for (const [ws, info] of this.subscribers) {
        if (info.isAlive === false) {
          // Missed the prior ping — reap. `close`/`error` handlers remove
          // from the subscriber map and fanout.
          ws.terminate();
          continue;
        }
        info.isAlive = false;
        try { ws.ping(); } catch { /* ignore — terminate on next tick */ }
      }
    };
    this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs);
    // Don't keep the process alive just to run heartbeats (matches fanOut).
    this.heartbeatTimer.unref?.();
  }

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.metrics.stop();
    await this.fanOut.stop();
    return new Promise((resolve) => {
      if (!this.wss || !this.server) {
        resolve();
        return;
      }
      for (const [ws] of this.subscribers) {
        ws.terminate();
      }
      this.subscribers.clear();
      this.wss.close(() => {
        this.server?.close(() => resolve());
      });
    });
  }
}
