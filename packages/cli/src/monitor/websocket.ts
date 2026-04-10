import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sirv from "sirv";
import type { WsServerEvent, WsClientEvent } from "@sigil/shared";
import { EventFanOut } from "./event-fanout.js";

interface SubscriberInfo {
  ws: WebSocket;
  workflowIds: Set<string>;
  authenticated: boolean;
}

/**
 * WsMonitorServer — WebSocket server for real-time workflow monitoring.
 *
 * Clients connect and send `{ "type": "subscribe", "workflowId": "..." }` to
 * receive events for a specific workflow run. The scheduler calls `emit()` to
 * broadcast events to all subscribed clients.
 */
export class WsMonitorServer {
  private wss: WebSocketServer | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private subscribers = new Map<WebSocket, SubscriberInfo>();
  private port: number | null = null;
  private fanOut = new EventFanOut();
  private clientIdCounter = 0;

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
      // Skipped in dev mode (SIGIL_UI_DEV=1) so the Next.js dev server handles it.
      const distUiPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../dist-ui"
      );
      const serveUi =
        process.env["SIGIL_UI_DEV"] !== "1" && existsSync(distUiPath);

      // Build the static file handler once. dist-ui may not exist when
      // running directly from source without a prior `next build` — guard
      // with existsSync so the CLI degrades gracefully in that case.
      const uiHandler = serveUi ? sirv(distUiPath, { dev: false }) : null;

      const httpServer = createServer((req, res) => {
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
        const authenticated = token === this.authToken;

        const info: SubscriberInfo = { ws, workflowIds: new Set(), authenticated };
        this.subscribers.set(ws, info);

        // Register with fan-out using a filter that checks workflowId subscription
        this.fanOut.addClient(clientId, ws, (event: unknown) => {
          const obj = event as Record<string, unknown>;
          const workflowId = typeof obj.workflowId === "string" ? obj.workflowId : null;
          // If the event has no workflowId, broadcast to all; otherwise check subscription
          return !workflowId || info.workflowIds.has(workflowId);
        });

        ws.on("message", (data) => {
          let event: WsClientEvent;
          try {
            event = JSON.parse(data.toString()) as WsClientEvent;
          } catch {
            return;
          }

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
        resolve(this.port);
      });

      httpServer.on("error", reject);
    });
  }

  /**
   * Emit a WsServerEvent to all clients subscribed to the relevant workflowId.
   *
   * Non-blocking — serializes once and pushes into per-client ring buffers.
   * A periodic flush timer batches and sends events to each WebSocket client.
   */
  emit(event: WsServerEvent): void {
    if (!this.wss) return;
    const eventWithTimestamp = { timestamp: new Date().toISOString(), ...event };
    this.fanOut.emit(eventWithTimestamp);
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

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
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
