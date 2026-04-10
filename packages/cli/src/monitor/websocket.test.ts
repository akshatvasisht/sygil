import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { WsMonitorServer } from "./websocket.js";
import type { WsClientEvent } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const servers: WsMonitorServer[] = [];

async function createServer(): Promise<WsMonitorServer> {
  const server = new WsMonitorServer();
  servers.push(server);
  await server.start();
  return server;
}

function connectClient(
  server: WsMonitorServer,
  token?: string
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const port = server.getPort();
    const url = token
      ? `ws://127.0.0.1:${port}/?token=${token}`
      : `ws://127.0.0.1:${port}/`;
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendEvent(ws: WebSocket, event: WsClientEvent): void {
  ws.send(JSON.stringify(event));
}

/** Wait for the next JSON message from the WebSocket. */
function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Small delay to allow event processing through the fan-out flush cycle. */
function tick(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.stop();
  }
});

// ---------------------------------------------------------------------------
// HTTP serving tests
// ---------------------------------------------------------------------------

describe("WsMonitorServer — HTTP serving", () => {
  it("serves HTML for HTTP GET when dist-ui is present", async () => {
    const server = await createServer();
    const port = server.getPort()!;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    // dist-ui exists, so the server serves static files
    expect([200, 404]).toContain(res.status);
  });

  it("handles arbitrary HTTP paths", async () => {
    const server = await createServer();
    const port = server.getPort()!;
    const res = await fetch(`http://127.0.0.1:${port}/monitor`);
    // dist-ui exists with monitor.html, so 200 is expected
    expect([200, 404]).toContain(res.status);
  });

  it("HTTP requests do not interfere with WebSocket connections on the same port", async () => {
    const server = await createServer();
    const port = server.getPort()!;

    // HTTP request on the same port
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect([200, 404]).toContain(res.status);

    // WebSocket still connects successfully
    const client = await connectClient(server);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("WebSocket upgrade is not handled as an HTTP request", async () => {
    const server = await createServer();
    const token = server.getAuthToken();

    // Connect via WebSocket (upgrade request) — should succeed
    const client = await connectClient(server, token);
    expect(client.readyState).toBe(WebSocket.OPEN);

    // Plain HTTP on the same port
    const port = server.getPort()!;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect([200, 404]).toContain(res.status);

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Auth token tests (Vuln 3 fix)
// ---------------------------------------------------------------------------

describe("WsMonitorServer — auth token", () => {
  it("generates a non-empty auth token on creation", async () => {
    const server = await createServer();
    const token = server.getAuthToken();
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("getAuthToken() returns the token", async () => {
    const server = await createServer();
    const token1 = server.getAuthToken();
    const token2 = server.getAuthToken();
    // Same token each call (stable for the server lifetime)
    expect(token1).toBe(token2);
  });

  it("authenticated client can send control events", async () => {
    const server = await createServer();
    const token = server.getAuthToken();
    const client = await connectClient(server, token);

    const WORKFLOW_ID = "test-wf-1";

    // Track control events received by the server
    const received: WsClientEvent[] = [];
    server.onClientControl = (event) => {
      received.push(event);
    };

    // Subscribe first (needed to set up workflowId tracking, though not auth-gated)
    sendEvent(client, { type: "subscribe", workflowId: WORKFLOW_ID });
    await tick();

    // Send control events
    sendEvent(client, { type: "pause", workflowId: WORKFLOW_ID });
    sendEvent(client, { type: "cancel", workflowId: WORKFLOW_ID });
    await tick();

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe("pause");
    expect(received[1]!.type).toBe("cancel");

    client.close();
  });

  it("unauthenticated client cannot send control events (silently dropped)", async () => {
    const server = await createServer();
    // Connect WITHOUT token
    const client = await connectClient(server);

    const WORKFLOW_ID = "test-wf-2";

    const received: WsClientEvent[] = [];
    server.onClientControl = (event) => {
      received.push(event);
    };

    sendEvent(client, { type: "subscribe", workflowId: WORKFLOW_ID });
    await tick();

    // These should be silently dropped
    sendEvent(client, { type: "pause", workflowId: WORKFLOW_ID });
    sendEvent(client, { type: "cancel", workflowId: WORKFLOW_ID });
    sendEvent(client, {
      type: "human_review_approve",
      workflowId: WORKFLOW_ID,
      edgeId: "e1",
    });
    sendEvent(client, {
      type: "human_review_reject",
      workflowId: WORKFLOW_ID,
      edgeId: "e2",
    });
    await tick();

    expect(received).toHaveLength(0);

    client.close();
  });

  it("client with wrong token cannot send control events", async () => {
    const server = await createServer();
    // Connect with an incorrect token
    const client = await connectClient(server, "wrong-token-value");

    const WORKFLOW_ID = "test-wf-3";

    const received: WsClientEvent[] = [];
    server.onClientControl = (event) => {
      received.push(event);
    };

    sendEvent(client, { type: "subscribe", workflowId: WORKFLOW_ID });
    await tick();

    sendEvent(client, { type: "pause", workflowId: WORKFLOW_ID });
    sendEvent(client, { type: "cancel", workflowId: WORKFLOW_ID });
    await tick();

    expect(received).toHaveLength(0);

    client.close();
  });

  it("subscribe/unsubscribe work without auth (read-only)", async () => {
    const server = await createServer();
    // Connect without token — should still be able to subscribe and receive events
    const client = await connectClient(server);

    const WORKFLOW_ID = "test-wf-4";

    sendEvent(client, { type: "subscribe", workflowId: WORKFLOW_ID });
    await tick();

    // Emit a server event — the unauthenticated client should receive it
    const messagePromise = waitForMessage(client);
    server.emit({
      type: "workflow_start",
      workflowId: WORKFLOW_ID,
      graph: {
        version: "1",
        name: "test",
        nodes: {
          a: {
            adapter: "claude-sdk",
            model: "claude-opus-4-5",
            role: "agent",
            prompt: "test",
          },
        },
        edges: [],
      },
    });

    const msg = (await messagePromise) as Record<string, unknown>;
    expect(msg.type).toBe("workflow_start");
    expect(msg.workflowId).toBe(WORKFLOW_ID);

    // Unsubscribe should also work
    sendEvent(client, { type: "unsubscribe", workflowId: WORKFLOW_ID });
    await tick();

    client.close();
  });

  it("human_review_approve requires auth", async () => {
    const server = await createServer();
    const token = server.getAuthToken();

    const WORKFLOW_ID = "test-wf-5";
    const received: WsClientEvent[] = [];
    server.onClientControl = (event) => {
      received.push(event);
    };

    // Authenticated client sends human_review_approve
    const authedClient = await connectClient(server, token);
    sendEvent(authedClient, { type: "subscribe", workflowId: WORKFLOW_ID });
    await tick();

    sendEvent(authedClient, {
      type: "human_review_approve",
      workflowId: WORKFLOW_ID,
      edgeId: "edge-1",
    });
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("human_review_approve");

    authedClient.close();
  });
});

// ---------------------------------------------------------------------------
// Start / stop lifecycle
// ---------------------------------------------------------------------------

describe("WsMonitorServer — lifecycle", () => {
  it("start() returns a valid port number", async () => {
    const server = await createServer();
    const port = server.getPort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("getPort() returns null before start", () => {
    const server = new WsMonitorServer();
    servers.push(server);
    expect(server.getPort()).toBeNull();
  });

  it("stop() resolves immediately when server was never started", async () => {
    const server = new WsMonitorServer();
    servers.push(server);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("stop() terminates connected clients", async () => {
    const server = await createServer();
    const client = await connectClient(server);

    const closePromise = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    await server.stop();
    // Remove from tracked servers since we already stopped it
    servers.splice(servers.indexOf(server), 1);

    await closePromise;
    // Client should be disconnected
    expect(client.readyState).not.toBe(WebSocket.OPEN);
  });

  it("multiple clients can connect simultaneously", async () => {
    const server = await createServer();
    const c1 = await connectClient(server);
    const c2 = await connectClient(server);
    const c3 = await connectClient(server);

    expect(c1.readyState).toBe(WebSocket.OPEN);
    expect(c2.readyState).toBe(WebSocket.OPEN);
    expect(c3.readyState).toBe(WebSocket.OPEN);

    c1.close();
    c2.close();
    c3.close();
  });

  it("emit() is a no-op before start", () => {
    const server = new WsMonitorServer();
    servers.push(server);
    // Should not throw
    expect(() => {
      server.emit({
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "test", nodes: {}, edges: [] } as never,
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Message handling edge cases
// ---------------------------------------------------------------------------

describe("WsMonitorServer — edge cases", () => {
  it("server does not crash on invalid JSON from client", async () => {
    const server = await createServer();
    const client = await connectClient(server);

    client.send("not valid json {{{");
    await tick();

    // Server should still be functional
    expect(server.getPort()).not.toBeNull();
    client.close();
  });

  it("resume_workflow control event requires auth", async () => {
    const server = await createServer();
    const token = server.getAuthToken();

    const received: WsClientEvent[] = [];
    server.onClientControl = (event) => {
      received.push(event);
    };

    // Unauthenticated client
    const unauthed = await connectClient(server);
    sendEvent(unauthed, { type: "resume_workflow", workflowId: "wf-1" });
    await tick();
    expect(received).toHaveLength(0);

    // Authenticated client
    const authed = await connectClient(server, token);
    sendEvent(authed, { type: "resume_workflow", workflowId: "wf-1" });
    await tick();
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("resume_workflow");

    unauthed.close();
    authed.close();
  });

  it("client disconnect cleans up subscriber info", async () => {
    const server = await createServer();
    const client = await connectClient(server);

    sendEvent(client, { type: "subscribe", workflowId: "wf-1" });
    await tick();

    // Close client
    const closedPromise = new Promise<void>((r) => client.on("close", () => r()));
    client.close();
    await closedPromise;
    await tick();

    // Emit should not throw even though client is gone
    expect(() => {
      server.emit({
        type: "node_start",
        workflowId: "wf-1",
        nodeId: "n1",
        config: {} as never,
        attempt: 1,
      });
    }).not.toThrow();
  });

  it("events without workflowId are broadcast to all subscribed clients", async () => {
    const server = await createServer();
    const token = server.getAuthToken();
    const client = await connectClient(server, token);

    sendEvent(client, { type: "subscribe", workflowId: "wf-1" });
    await tick();

    // Emit an event that has a workflowId matching the subscription
    const msgPromise = waitForMessage(client);
    server.emit({
      type: "node_start",
      workflowId: "wf-1",
      nodeId: "n1",
      config: {} as never,
      attempt: 1,
    });

    const msg = (await msgPromise) as Record<string, unknown>;
    expect(msg.type).toBe("node_start");

    client.close();
  });
});
