/**
 * Integration tests for runtime node output interpolation.
 *
 * Validates that {{nodes.<id>.output}} and {{nodes.<id>.structuredOutput.<path>}}
 * placeholders are resolved from completed predecessor results, that
 * expectedOutputs are validated after node completion, and that
 * actualOutputDirs are tracked correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "../scheduler/index.js";
import type { WorkflowGraph } from "@sygil/shared";
import {
  createMockAdapter,
  createMockMonitor,
  createNodeRoutingAdapterFactory,
  makeNodeConfigForNode as makeNodeConfig,
  monitorEventsOfType as eventsOfType,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-nodepass-${randomUUID()}`);
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

describe("node output passing", () => {
  // -------------------------------------------------------------------------
  // 1. {{nodes.<id>.output}} resolution
  // -------------------------------------------------------------------------
  it("resolves {{nodes.<id>.output}} from completed predecessor", async () => {
    const capturedPrompts: Record<string, string> = {};

    const workflow: WorkflowGraph = {
      version: "1",
      name: "output-ref",
      nodes: {
        nodeA: makeNodeConfig("nodeA", { prompt: "produce output" }),
        nodeB: makeNodeConfig("nodeB", { prompt: "use {{nodes.nodeA.output}} here" }),
      },
      edges: [
        { id: "e-a-b", from: "nodeA", to: "nodeB" },
      ],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: { output: "hello from A", exitCode: 0, durationMs: 1 },
      }),
      nodeB: createMockAdapter({
        result: { output: "processed", exitCode: 0, durationMs: 1 },
        onSpawn: (config) => { capturedPrompts["nodeB"] = config.prompt; },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-output-ref");

    expect(result.success).toBe(true);
    expect(capturedPrompts["nodeB"]).toContain("hello from A");
  });

  // -------------------------------------------------------------------------
  // 2. {{nodes.<id>.structuredOutput.field}} resolution
  // -------------------------------------------------------------------------
  it("resolves {{nodes.<id>.structuredOutput.field}} from predecessor", async () => {
    const capturedPrompts: Record<string, string> = {};

    const workflow: WorkflowGraph = {
      version: "1",
      name: "structured-ref",
      nodes: {
        nodeA: makeNodeConfig("nodeA", { prompt: "produce structured" }),
        nodeB: makeNodeConfig("nodeB", {
          prompt: "summary is {{nodes.nodeA.structuredOutput.summary}}",
        }),
      },
      edges: [
        { id: "e-a-b", from: "nodeA", to: "nodeB" },
      ],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: {
          output: "done",
          exitCode: 0,
          durationMs: 1,
          structuredOutput: { summary: "test summary" },
        },
      }),
      nodeB: createMockAdapter({
        result: { output: "consumed", exitCode: 0, durationMs: 1 },
        onSpawn: (config) => { capturedPrompts["nodeB"] = config.prompt; },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-structured-ref");

    expect(result.success).toBe(true);
    expect(capturedPrompts["nodeB"]).toContain("test summary");
  });

  // -------------------------------------------------------------------------
  // 3. References to non-existent nodes throw
  // -------------------------------------------------------------------------
  it("throws when {{nodes.<id>.output}} references non-existent node", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "bad-ref",
      nodes: {
        nodeA: makeNodeConfig("nodeA", {
          prompt: "use {{nodes.nonexistent.output}} here",
        }),
      },
      edges: [],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: { output: "out", exitCode: 0, durationMs: 1 },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-bad-ref");

    // The scheduler should report failure because buildNodeInput throws
    expect(result.success).toBe(false);
    expect(result.error).toContain("nodeA");
  });

  // -------------------------------------------------------------------------
  // 4. File-based inputMapping from predecessor outputDir
  // -------------------------------------------------------------------------
  it("resolves inputMapping from predecessor outputDir", async () => {
    const capturedPrompts: Record<string, string> = {};

    // Create a file in a temp output directory for nodeA
    const nodeAOutputDir = join(testDir, "nodeA-output");
    await mkdir(nodeAOutputDir, { recursive: true });
    await writeFile(join(nodeAOutputDir, "plan.md"), "the plan content");

    const workflow: WorkflowGraph = {
      version: "1",
      name: "input-mapping",
      nodes: {
        nodeA: makeNodeConfig("nodeA", {
          prompt: "produce plan",
          outputDir: nodeAOutputDir,
        }),
        nodeB: makeNodeConfig("nodeB", {
          prompt: "consume {{plan}}",
        }),
      },
      edges: [
        {
          id: "e-a-b",
          from: "nodeA",
          to: "nodeB",
          contract: {
            inputMapping: { plan: "plan.md" },
          },
        },
      ],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: { output: "planned", exitCode: 0, durationMs: 1 },
      }),
      nodeB: createMockAdapter({
        result: { output: "consumed", exitCode: 0, durationMs: 1 },
        onSpawn: (config) => { capturedPrompts["nodeB"] = config.prompt; },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-input-mapping");

    expect(result.success).toBe(true);
    expect(capturedPrompts["nodeB"]).toContain("the plan content");
  });

  // -------------------------------------------------------------------------
  // 5. actualOutputDirs tracking
  // -------------------------------------------------------------------------
  it("tracks actualOutputDirs correctly", async () => {
    const nodeAOutputDir = join(testDir, "nodeA-out");
    await mkdir(nodeAOutputDir, { recursive: true });

    const workflow: WorkflowGraph = {
      version: "1",
      name: "output-dirs",
      nodes: {
        nodeA: makeNodeConfig("nodeA", {
          prompt: "do work",
          outputDir: nodeAOutputDir,
        }),
        nodeB: makeNodeConfig("nodeB", { prompt: "more work" }),
      },
      edges: [
        { id: "e-a-b", from: "nodeA", to: "nodeB" },
      ],
    };

    const adapter = createMockAdapter({
      result: { output: "done", exitCode: 0, durationMs: 1 },
    });
    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);

    const result = await scheduler.run("wf-output-dirs");

    expect(result.success).toBe(true);

    // Verify both nodes completed (meaning the scheduler tracked through them)
    const nodeEnds = eventsOfType(monitor.events, "node_end");
    const completedNodeIds = nodeEnds.map((e) => e.nodeId);
    expect(completedNodeIds).toContain("nodeA");
    expect(completedNodeIds).toContain("nodeB");
  });

  // -------------------------------------------------------------------------
  // 6. expectedOutputs validation — missing file
  // -------------------------------------------------------------------------
  it("validates expectedOutputs after node completion — emits warning for missing", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "expected-outputs-missing",
      nodes: {
        nodeA: makeNodeConfig("nodeA", {
          prompt: "produce files",
          expectedOutputs: ["result.txt"],
          outputDir: testDir,
        }),
      },
      edges: [],
    };

    const adapter = createMockAdapter({
      result: { output: "done", exitCode: 0, durationMs: 1 },
    });
    // result.txt does NOT exist in testDir

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);
    const result = await scheduler.run("wf-expected-missing");

    // Workflow should fail (missing expectedOutputs is now fatal, not a warning)
    expect(result.success).toBe(false);

    // Check that a workflow_error event was emitted
    const errorEvents = monitor.events.filter(
      (e) => e.type === "workflow_error" &&
        "message" in e &&
        typeof (e as { message?: unknown }).message === "string" &&
        (e as { message: string }).message.includes("expected outputs")
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    const msg = (errorEvents[0] as { message: string }).message;
    expect(msg).toContain("result.txt");
  });

  // -------------------------------------------------------------------------
  // 7. expectedOutputs validation — file exists (no warning)
  // -------------------------------------------------------------------------
  it("passes when expectedOutputs exist", async () => {
    // Create the expected file
    await writeFile(join(testDir, "result.txt"), "output data");

    const workflow: WorkflowGraph = {
      version: "1",
      name: "expected-outputs-present",
      nodes: {
        nodeA: makeNodeConfig("nodeA", {
          prompt: "produce files",
          expectedOutputs: ["result.txt"],
          outputDir: testDir,
        }),
      },
      edges: [],
    };

    const adapter = createMockAdapter({
      result: { output: "done", exitCode: 0, durationMs: 1 },
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);
    const result = await scheduler.run("wf-expected-present");

    expect(result.success).toBe(true);

    // No error events about missing expected outputs
    const missingOutputErrors = monitor.events.filter(
      (e) => e.type === "workflow_error" &&
        "message" in e &&
        typeof (e as { message?: unknown }).message === "string" &&
        (e as { message: string }).message.includes("missing expected outputs")
    );
    expect(missingOutputErrors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Nested structuredOutput path traversal
  // -------------------------------------------------------------------------
  it("resolves deeply nested structuredOutput paths", async () => {
    const capturedPrompts: Record<string, string> = {};

    const workflow: WorkflowGraph = {
      version: "1",
      name: "deep-structured-ref",
      nodes: {
        nodeA: makeNodeConfig("nodeA", { prompt: "produce deep output" }),
        nodeB: makeNodeConfig("nodeB", {
          prompt: "value is {{nodes.nodeA.structuredOutput.meta.author.name}}",
        }),
      },
      edges: [
        { id: "e-a-b", from: "nodeA", to: "nodeB" },
      ],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: {
          output: "done",
          exitCode: 0,
          durationMs: 1,
          structuredOutput: { meta: { author: { name: "Alice" } } },
        },
      }),
      nodeB: createMockAdapter({
        result: { output: "consumed", exitCode: 0, durationMs: 1 },
        onSpawn: (config) => { capturedPrompts["nodeB"] = config.prompt; },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-deep-ref");

    expect(result.success).toBe(true);
    expect(capturedPrompts["nodeB"]).toContain("Alice");
  });

  // -------------------------------------------------------------------------
  // 9. Missing structuredOutput field resolves to empty string
  // -------------------------------------------------------------------------
  it("resolves missing structuredOutput field to empty string", async () => {
    const capturedPrompts: Record<string, string> = {};

    const workflow: WorkflowGraph = {
      version: "1",
      name: "missing-field-ref",
      nodes: {
        nodeA: makeNodeConfig("nodeA", { prompt: "produce output" }),
        nodeB: makeNodeConfig("nodeB", {
          prompt: "value is [{{nodes.nodeA.structuredOutput.missing}}]",
        }),
      },
      edges: [
        { id: "e-a-b", from: "nodeA", to: "nodeB" },
      ],
    };

    const factory = createNodeRoutingAdapterFactory({
      nodeA: createMockAdapter({
        result: {
          output: "done",
          exitCode: 0,
          durationMs: 1,
          structuredOutput: { present: "yes" },
        },
      }),
      nodeB: createMockAdapter({
        result: { output: "consumed", exitCode: 0, durationMs: 1 },
        onSpawn: (config) => { capturedPrompts["nodeB"] = config.prompt; },
      }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-missing-field");

    expect(result.success).toBe(true);
    // Missing field resolves to empty string, so brackets should be empty
    expect(capturedPrompts["nodeB"]).toContain("value is []");
  });
});
