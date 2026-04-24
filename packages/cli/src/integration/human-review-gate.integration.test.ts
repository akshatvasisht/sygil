/**
 * Integration tests for the human review gate with WebSocket round-trip.
 *
 * These tests verify that GateEvaluator correctly handles human_review conditions
 * when connected to a real WsMonitorServer — exercising the full WebSocket
 * emit → client respond → gate resolve pipeline without mocking I/O.
 *
 * Real timers are required throughout because WebSocket needs real I/O event loop.
 */

import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsMonitorServer } from "../monitor/websocket.js";
import { GateEvaluator } from "../gates/index.js";
import type { GateConfig, NodeResult } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const servers: WsMonitorServer[] = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sygil-hr-gate-"));
  tempDirs.push(dir);
  return dir;
}

async function startServer(): Promise<WsMonitorServer> {
  const server = new WsMonitorServer();
  servers.push(server);
  await server.start();
  return server;
}

function connectClient(server: WsMonitorServer, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const port = server.getPort()!;
    const url = token
      ? `ws://127.0.0.1:${port}/?token=${token}`
      : `ws://127.0.0.1:${port}/`;
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Wait for a specific message type from the WebSocket, with timeout. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for matching message (${timeoutMs}ms)`)),
      timeoutMs
    );

    const handler = (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };

    ws.on("message", handler);
  });
}

/** Small delay to let WebSocket messages propagate through the fan-out flush cycle. */
function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_NODE_RESULT: NodeResult = { output: "test output", exitCode: 0, durationMs: 100 };

const HUMAN_REVIEW_GATE: GateConfig = {
  conditions: [{ type: "human_review", prompt: "Please approve this output" }],
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("human review gate integration", () => {
  it("approve via WebSocket resolves gate as passed", async () => {
    const server = await startServer();
    const token = server.getAuthToken();
    const workflowId = "wf-approve-test";
    const nodeId = "node-1";
    const edgeId = "edge-1";
    const outputDir = await makeTempDir();

    const client = await connectClient(server, token);

    // Subscribe to the workflow so we receive events
    client.send(JSON.stringify({ type: "subscribe", workflowId }));
    await settle();

    // Set up client to respond with approve when it receives human_review_request
    client.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "human_review_request" && msg.edgeId === edgeId) {
        client.send(
          JSON.stringify({ type: "human_review_approve", workflowId, edgeId })
        );
      }
    });

    const evaluator = new GateEvaluator(server, workflowId);
    const result = await evaluator.evaluate(
      HUMAN_REVIEW_GATE,
      BASE_NODE_RESULT,
      outputDir,
      nodeId,
      edgeId
    );

    expect(result.passed).toBe(true);
    expect(result.reason.toLowerCase()).toContain("approved");

    client.close();
  });

  it("reject via WebSocket resolves gate as not passed", async () => {
    const server = await startServer();
    const token = server.getAuthToken();
    const workflowId = "wf-reject-test";
    const nodeId = "node-1";
    const edgeId = "edge-1";
    const outputDir = await makeTempDir();

    const client = await connectClient(server, token);

    client.send(JSON.stringify({ type: "subscribe", workflowId }));
    await settle();

    // Respond with reject when human_review_request arrives
    client.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "human_review_request" && msg.edgeId === edgeId) {
        client.send(
          JSON.stringify({ type: "human_review_reject", workflowId, edgeId })
        );
      }
    });

    const evaluator = new GateEvaluator(server, workflowId);
    const result = await evaluator.evaluate(
      HUMAN_REVIEW_GATE,
      BASE_NODE_RESULT,
      outputDir,
      nodeId,
      edgeId
    );

    expect(result.passed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("rejected");

    client.close();
  });

  it("unauthenticated client cannot approve — gate aborts via signal", async () => {
    const server = await startServer();
    // Deliberately omit the token so the client is unauthenticated
    const workflowId = "wf-unauth-test";
    const nodeId = "node-1";
    const edgeId = "edge-1";
    const outputDir = await makeTempDir();

    const unauthedClient = await connectClient(server); // no token

    unauthedClient.send(JSON.stringify({ type: "subscribe", workflowId }));
    await settle();

    // Unauthenticated client tries to approve — server should silently drop it
    unauthedClient.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "human_review_request" && msg.edgeId === edgeId) {
        unauthedClient.send(
          JSON.stringify({ type: "human_review_approve", workflowId, edgeId })
        );
      }
    });

    // Use a short AbortSignal to avoid waiting 5 minutes for the default timeout
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);

    const evaluator = new GateEvaluator(server, workflowId);
    const result = await evaluator.evaluate(
      HUMAN_REVIEW_GATE,
      BASE_NODE_RESULT,
      outputDir,
      nodeId,
      edgeId,
      controller.signal
    );

    // Gate should not have passed — the approve was dropped by the server
    expect(result.passed).toBe(false);

    unauthedClient.close();
  });

  it("gate emits human_review_response event after approval", async () => {
    const server = await startServer();
    const token = server.getAuthToken();
    const workflowId = "wf-response-event-test";
    const nodeId = "node-1";
    const edgeId = "edge-1";
    const outputDir = await makeTempDir();

    const client = await connectClient(server, token);

    client.send(JSON.stringify({ type: "subscribe", workflowId }));
    await settle();

    // Respond with approve when request arrives
    client.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "human_review_request" && msg.edgeId === edgeId) {
        client.send(
          JSON.stringify({ type: "human_review_approve", workflowId, edgeId })
        );
      }
    });

    // Set up listener for human_review_response BEFORE calling evaluate
    const responsePromise = waitForMessage(
      client,
      (msg) => msg.type === "human_review_response" && msg.edgeId === edgeId
    );

    const evaluator = new GateEvaluator(server, workflowId);
    const result = await evaluator.evaluate(
      HUMAN_REVIEW_GATE,
      BASE_NODE_RESULT,
      outputDir,
      nodeId,
      edgeId
    );

    expect(result.passed).toBe(true);

    // Verify the server emitted human_review_response with approved: true
    const responseMsg = await responsePromise;
    expect(responseMsg.type).toBe("human_review_response");
    expect(responseMsg.workflowId).toBe(workflowId);
    expect(responseMsg.edgeId).toBe(edgeId);
    expect(responseMsg.approved).toBe(true);

    client.close();
  });

  it("AbortSignal cancels pending human review", async () => {
    const server = await startServer();
    const token = server.getAuthToken();
    const workflowId = "wf-abort-test";
    const nodeId = "node-1";
    const edgeId = "edge-1";
    const outputDir = await makeTempDir();

    // Connect a client but intentionally do NOT respond — we want the gate to wait
    const client = await connectClient(server, token);
    client.send(JSON.stringify({ type: "subscribe", workflowId }));
    await settle();

    // Abort after 100ms — the gate should cancel and return passed: false
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const evaluator = new GateEvaluator(server, workflowId);
    const result = await evaluator.evaluate(
      HUMAN_REVIEW_GATE,
      BASE_NODE_RESULT,
      outputDir,
      nodeId,
      edgeId,
      controller.signal
    );

    expect(result.passed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("cancelled");

    client.close();
  });
});
