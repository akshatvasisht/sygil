/**
 * Integration tests for workflow-level mutex / semaphore synchronization.
 *
 * Verifies that nodes sharing a `mutex` key execute serially (never
 * concurrently), and that the scheduler emits `sync_acquire` /
 * `sync_release` AgentEvents for every participating node.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "../scheduler/index.js";
import type { WorkflowGraph, AgentEvent, WsServerEvent } from "@sygil/shared";
import {
  createMockAdapter,
  createNodeRoutingAdapterFactory,
  makeNodeConfigForNode as makeNodeConfig,
  createMockMonitor,
} from "./__test-helpers__.js";

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-sync-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: extract AgentEvents of a given type from monitor events
// ---------------------------------------------------------------------------

function nodeAgentEventsOfType<T extends AgentEvent["type"]>(
  events: WsServerEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events
    .filter(
      (e): e is Extract<WsServerEvent, { type: "node_event" }> =>
        e.type === "node_event",
    )
    .map((e) => e.event)
    .filter((ev): ev is Extract<AgentEvent, { type: T }> => ev.type === type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow-level mutex / semaphore", () => {
  // -------------------------------------------------------------------------
  // 1. sync_acquire and sync_release events are emitted for each mutex node
  // -------------------------------------------------------------------------
  it("emits sync_acquire and sync_release AgentEvents for two sequential mutex nodes", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "mutex-events",
      nodes: {
        n1: makeNodeConfig("n1", { synchronization: { mutex: "db" } }),
        n2: makeNodeConfig("n2", { synchronization: { mutex: "db" } }),
      },
      // Linear: n1 → n2 so they run in order
      edges: [{ id: "e-n1-n2", from: "n1", to: "n2" }],
    };

    const adapter = createMockAdapter({
      result: { output: "done", exitCode: 0, durationMs: 1 },
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor);
    const result = await scheduler.run("wf-mutex-events");

    expect(result.success).toBe(true);

    const acquires = nodeAgentEventsOfType(monitor.events, "sync_acquire");
    const releases = nodeAgentEventsOfType(monitor.events, "sync_release");

    // Both nodes must acquire and release
    expect(acquires).toHaveLength(2);
    expect(releases).toHaveLength(2);

    // All events reference the correct key and limit=1 (mutex)
    for (const ev of [...acquires, ...releases]) {
      expect(ev.key).toBe("db");
      expect(ev.limit).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Acquire precedes release in the event log for each node
  // -------------------------------------------------------------------------
  it("acquire event always precedes release event in the monitor event log", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "mutex-ordering",
      nodes: {
        n1: makeNodeConfig("n1", { synchronization: { mutex: "lock" } }),
      },
      edges: [],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      () => createMockAdapter({ result: { output: "ok", exitCode: 0, durationMs: 1 } }),
      monitor,
    );
    await scheduler.run("wf-mutex-ordering");

    const nodeEvents = monitor.events
      .filter((e): e is Extract<WsServerEvent, { type: "node_event" }> => e.type === "node_event")
      .map((e) => e.event.type);

    const acquireIdx = nodeEvents.indexOf("sync_acquire");
    const releaseIdx = nodeEvents.indexOf("sync_release");

    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(acquireIdx);
  });

  // -------------------------------------------------------------------------
  // 3. Semaphore events use correct limit value
  // -------------------------------------------------------------------------
  it("emits sync_acquire with limit=3 for semaphore nodes", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "semaphore-events",
      nodes: {
        n1: makeNodeConfig("n1", { synchronization: { semaphore: { key: "pool", limit: 3 } } }),
        n2: makeNodeConfig("n2", { synchronization: { semaphore: { key: "pool", limit: 3 } } }),
      },
      edges: [{ id: "e-n1-n2", from: "n1", to: "n2" }],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      () => createMockAdapter({ result: { output: "ok", exitCode: 0, durationMs: 1 } }),
      monitor,
    );
    const result = await scheduler.run("wf-semaphore");

    expect(result.success).toBe(true);

    const acquires = nodeAgentEventsOfType(monitor.events, "sync_acquire");
    expect(acquires).toHaveLength(2);
    for (const ev of acquires) {
      expect(ev.limit).toBe(3);
      expect(ev.key).toBe("pool");
    }
  });

  // -------------------------------------------------------------------------
  // 4. Three nodes with mutex run serially — one node at a time
  //    Verified via acquire event nodeIds: each node acquires ONLY after the
  //    previous node's release (inferred from event ordering for linear chain)
  // -------------------------------------------------------------------------
  it("three linear nodes with the same mutex emit non-overlapping acquire/release pairs", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "mutex-serial",
      nodes: {
        n1: makeNodeConfig("n1", { synchronization: { mutex: "x" } }),
        n2: makeNodeConfig("n2", { synchronization: { mutex: "x" } }),
        n3: makeNodeConfig("n3", { synchronization: { mutex: "x" } }),
      },
      edges: [
        { id: "e-n1-n2", from: "n1", to: "n2" },
        { id: "e-n2-n3", from: "n2", to: "n3" },
      ],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      () => createMockAdapter({ result: { output: "ok", exitCode: 0, durationMs: 1 } }),
      monitor,
    );
    const result = await scheduler.run("wf-mutex-serial");

    expect(result.success).toBe(true);

    const acquires = nodeAgentEventsOfType(monitor.events, "sync_acquire");
    const releases = nodeAgentEventsOfType(monitor.events, "sync_release");

    // 3 acquires and 3 releases
    expect(acquires).toHaveLength(3);
    expect(releases).toHaveLength(3);

    // Verify the event sequence in the full event log: each acquire must be
    // preceded by a corresponding release from the prior holder (for n2 and n3).
    const allSyncTypes = monitor.events
      .filter((e): e is Extract<WsServerEvent, { type: "node_event" }> => e.type === "node_event")
      .filter((e) => e.event.type === "sync_acquire" || e.event.type === "sync_release")
      .map((e) => e.event.type);

    // Should alternate: acquire, release, acquire, release, acquire, release
    expect(allSyncTypes).toEqual([
      "sync_acquire",
      "sync_release",
      "sync_acquire",
      "sync_release",
      "sync_acquire",
      "sync_release",
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. Nodes without synchronization still complete successfully
  // -------------------------------------------------------------------------
  it("nodes without synchronization complete successfully with no sync events", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "no-sync",
      nodes: {
        n1: makeNodeConfig("n1"),
        n2: makeNodeConfig("n2"),
      },
      edges: [{ id: "e-n1-n2", from: "n1", to: "n2" }],
    };

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(
      workflow,
      () => createMockAdapter({ result: { output: "done", exitCode: 0, durationMs: 1 } }),
      monitor,
    );
    const result = await scheduler.run("wf-no-sync");

    expect(result.success).toBe(true);

    const acquires = nodeAgentEventsOfType(monitor.events, "sync_acquire");
    const releases = nodeAgentEventsOfType(monitor.events, "sync_release");
    expect(acquires).toHaveLength(0);
    expect(releases).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Mixed: some nodes with mutex, some without — non-mutex nodes are
  //    unaffected, mutex nodes still emit their events
  // -------------------------------------------------------------------------
  it("mixed workflow — only sync nodes emit sync events", async () => {
    const workflow: WorkflowGraph = {
      version: "1",
      name: "mixed-sync",
      nodes: {
        writer: makeNodeConfig("writer", { synchronization: { mutex: "db" } }),
        reader: makeNodeConfig("reader"),
      },
      edges: [{ id: "e-w-r", from: "writer", to: "reader" }],
    };

    const factory = createNodeRoutingAdapterFactory({
      writer: createMockAdapter({ result: { output: "written", exitCode: 0, durationMs: 1 } }),
      reader: createMockAdapter({ result: { output: "read", exitCode: 0, durationMs: 1 } }),
    });

    const monitor = createMockMonitor();
    const scheduler = new WorkflowScheduler(workflow, factory, monitor);
    const result = await scheduler.run("wf-mixed");

    expect(result.success).toBe(true);

    // Only 1 acquire/release pair (writer only)
    const acquires = nodeAgentEventsOfType(monitor.events, "sync_acquire");
    const releases = nodeAgentEventsOfType(monitor.events, "sync_release");
    expect(acquires).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });
});
