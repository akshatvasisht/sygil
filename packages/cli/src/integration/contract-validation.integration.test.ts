/**
 * Integration tests for multi-node contract validation (outputSchema + inputMapping)
 * exercised through the full WorkflowScheduler stack.
 *
 * Verifies that validateStructuredOutput() is invoked on edges that carry a
 * contract.outputSchema, that failures surface as a failed RunResult, and that
 * edges without a contract are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "../scheduler/index.js";
import type { WorkflowGraph } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import {
  createMockAdapter,
  createMockMonitor,
  createNodeRoutingAdapterFactory,
  makeNodeConfigForNode as makeNodeConfig,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-contract-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contract validation integration", () => {
  it("valid structured output passes contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-valid",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-produce-consume",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { name: "Alice" } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-contract-valid");

    expect(result.success).toBe(true);
  });

  it("missing required field fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-missing-field",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-missing-field",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns structuredOutput missing the required "name" field
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { age: 30 } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-missing-field");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The top-level error names the failing node; the detailed reason is in monitor events
    expect(result.error).toContain("producer");

    // The detailed contract validation error is emitted as a workflow_error event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("wrong type fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-wrong-type",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-wrong-type",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns name as a number instead of a string
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { name: 42 } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-wrong-type");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("producer");

    // The detailed type-mismatch error is in the workflow_error monitor event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("null structured output fails contract validation", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-null-output",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "e-null-output",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    };

    // Producer returns no structuredOutput — undefined
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { output: "done", exitCode: 0, durationMs: 1 } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-null-output");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("producer");

    // The detailed "null or undefined" error is in the workflow_error monitor event
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorMessage = errorEvents[0]!.message.toLowerCase();
    expect(errorMessage).toContain("validation failed");
  });

  it("multiple nodes — only the edge with a contract is validated", async () => {
    // Three-node chain: A → B (no contract) → C (with contract on B→C).
    // nodeA has no structuredOutput — fine because A→B carries no contract.
    // nodeB returns valid structuredOutput satisfying the B→C contract.
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-selective",
      nodes: {
        nodeA: makeNodeConfig("nodeA"),
        nodeB: makeNodeConfig("nodeB"),
        nodeC: makeNodeConfig("nodeC"),
      },
      edges: [
        {
          id: "e-a-b",
          from: "nodeA",
          to: "nodeB",
          // No contract on this edge — nodeA's structuredOutput is irrelevant
        },
        {
          id: "e-b-c",
          from: "nodeB",
          to: "nodeC",
          contract: {
            outputSchema: {
              properties: { status: { type: "string" } },
              required: ["status"],
            },
          },
        },
      ],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        nodeA: createMockAdapter({ result: { output: "A done", exitCode: 0, durationMs: 1 } }),
        nodeB: createMockAdapter({ result: { structuredOutput: { status: "ready" }, exitCode: 0, durationMs: 1 } }),
        nodeC: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-selective-contract");

    expect(result.success).toBe(true);
  });

  it("contract validation error includes edge and node IDs in message", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "contract-error-ids",
      nodes: {
        producer: makeNodeConfig("producer"),
        consumer: makeNodeConfig("consumer"),
      },
      edges: [
        {
          id: "edge-producer-consumer",
          from: "producer",
          to: "consumer",
          contract: {
            outputSchema: {
              properties: { result: { type: "string" } },
              required: ["result"],
            },
          },
        },
      ],
    };

    // Producer returns structuredOutput missing the required "result" field
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      createNodeRoutingAdapterFactory({
        producer: createMockAdapter({ result: { structuredOutput: { unrelated: true } } }),
        consumer: createMockAdapter(),
      }),
      monitor as WsMonitorServer
    );

    const result = await scheduler.run("run-error-ids");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The top-level result error names the node
    expect(result.error).toContain("producer");

    // The detailed workflow_error monitor event must name both the node and the edge
    const errorEvents = monitor.events.filter((e) => e.type === "workflow_error") as Array<{
      type: string;
      message: string;
    }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    const detailedMessage = errorEvents[0]!.message;
    expect(detailedMessage).toContain("producer");
    expect(detailedMessage).toContain("edge-producer-consumer");
  });
});
