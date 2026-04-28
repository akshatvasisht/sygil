/**
 * WorkflowScheduler — circuit-breaker integration tests.
 *
 * Circuit breaker is opt-in per `PoolConfig.circuitBreaker`. These tests
 * confirm: (a) breaker transitions are broadcast as `circuit_breaker`
 * WsServerEvents, (b) once open, downstream nodes fail fast via
 * `CircuitOpenError` → classified as `retryable:circuit_open` → failover
 * to the next provider, (c) with no `circuitBreaker` config the pool
 * behaves exactly like before.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type { AdapterType, WorkflowGraph } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import {
  createMockAdapter,
  createMockMonitor,
  makeNodeConfig,
} from "./__test-helpers__.js";

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkflowScheduler", () => {
  describe("circuit breaker", () => {
    function cbFailoverWorkflow(): WorkflowGraph {
      return {
        version: "1",
        name: "cb-failover",
        nodes: {
          nodeA: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
        },
        edges: [],
      };
    }

    it("emits circuit_breaker WsServerEvents via the monitor when the breaker trips", async () => {
      const workflow = cbFailoverWorkflow();
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      primary.spawn = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      // Tight breaker: trip on the first failure so a single failing node
      // exercises the full transition.
      const result = await scheduler.run("wf-cb-1", {}, {
        pool: {
          maxConcurrency: 5,
          circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 60_000 },
        },
      });

      expect(result.success).toBe(true);

      // The monitor should have seen a circuit_breaker event with state "open"
      // for the failing adapter.
      const cbEvents = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "circuit_breaker" }> =>
          e.type === "circuit_breaker",
      );
      expect(cbEvents.length).toBeGreaterThanOrEqual(1);
      expect(cbEvents[0]?.adapterType).toBe("claude-sdk");
      expect(cbEvents[0]?.state).toBe("open");
    });

    it("fails a subsequent node fast via CircuitOpenError and fails over to the next provider", async () => {
      // Chain nodeA → nodeB so dispatch is forced sequential — the assertion
      // below ("subsequent acquire fails fast") only makes sense when nodeB
      // actually starts after the breaker has observed nodeA's failure.
      // The earlier fanout shape (no edges, parallel-dispatch) raced because
      // both nodes could call adapter.spawn() on the primary before the
      // breaker registered the first failure.
      const workflow: WorkflowGraph = {
        version: "1",
        name: "cb-chain",
        nodes: {
          nodeA: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
          nodeB: makeNodeConfig({
            adapter: "claude-sdk",
            providers: [
              { adapter: "claude-sdk", priority: 0 },
              { adapter: "claude-cli", priority: 1 },
            ],
          }),
        },
        edges: [{ id: "a_to_b", from: "nodeA", to: "nodeB" }],
      };
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      let primarySpawnCount = 0;
      primary.spawn = async () => {
        primarySpawnCount++;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-cb-2", {}, {
        pool: {
          maxConcurrency: 5,
          circuitBreaker: { failureThreshold: 1, windowMs: 30_000, cooldownMs: 60_000 },
        },
      });

      expect(result.success).toBe(true);
      // Primary attempted on node A (1 call). Once breaker opens, node B's
      // acquire fails fast WITHOUT calling spawn on the primary. So total
      // primary spawns is exactly 1.
      expect(primarySpawnCount).toBe(1);

      // Both nodes completed via the fallback.
      const nodeEnds = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_end" }> => e.type === "node_end",
      );
      expect(nodeEnds).toHaveLength(2);
      expect(nodeEnds.every((e) => e.result.exitCode === 0)).toBe(true);

      // An adapter_failover event was emitted for each node (primary → fallback).
      const failovers = monitor.events.filter(
        (e): e is Extract<typeof e, { type: "node_event" }> =>
          e.type === "node_event" && e.event.type === "adapter_failover",
      );
      expect(failovers).toHaveLength(2);
    });

    it("does not trip the breaker when the pool is created without circuitBreaker config", async () => {
      const workflow = cbFailoverWorkflow();
      const monitor = createMockMonitor();

      const primary = createMockAdapter();
      primary.spawn = async () => {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      };
      const fallback = createMockAdapter({ result: { exitCode: 0, output: "ok" } });

      const factory = (type: AdapterType) =>
        type === "claude-sdk" ? primary : fallback;

      const scheduler = new WorkflowScheduler(workflow, factory, monitor as WsMonitorServer);
      const result = await scheduler.run("wf-cb-3", {}, {
        pool: { maxConcurrency: 5 }, // no circuitBreaker
      });

      expect(result.success).toBe(true);
      const cbEvents = monitor.events.filter((e) => e.type === "circuit_breaker");
      expect(cbEvents).toHaveLength(0);
    });
  });
});
