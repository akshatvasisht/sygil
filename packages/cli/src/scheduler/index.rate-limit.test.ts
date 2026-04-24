/**
 * WorkflowScheduler — rate-limit/backoff tests.
 *
 * Covers the `rate_limit:<ms>` sentinel pathway: the scheduler detects a
 * rate-limited error, emits a monitor event, waits, and calls `resume()`
 * (falling back to `spawn()` if the adapter has no resume support). Retry
 * counters must NOT advance during a rate-limit pause.
 *
 * The documented flaky test `"emits rate_limit monitor event"` lives here
 * (Rounds 92/99/borrow-vs-build/Phase 1 iter 2) — isolating it to its own
 * file makes CI retries cheaper and keeps the monolith from re-forming.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkflowScheduler } from "./index.js";
import type { AgentAdapter, AgentEvent } from "@sygil/shared";
import type { WsMonitorServer } from "../monitor/websocket.js";
import { createMockMonitor, makeSession, singleNodeWorkflow } from "./__test-helpers__.js";

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
  describe("rate limit handling", () => {
    // Helper to robustly advance time, interleaving macro/microtasks with fake timer advancement
    const advanceThroughRateLimit = async () => {
      // Advance in 100ms increments for a total of 6 seconds (to cover 5000ms delay)
      for (let i = 0; i < 60; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
    };

    it("pauses execution when rate_limit error event is received and resumes after delay", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      // After a rate limit, the scheduler now calls adapter.resume() first (to preserve
      // conversation history), falling back to spawn() only if resume throws.
      // Track calls via a shared counter on the session state.
      let resumeCount = 0;
      let spawnCount = 0;
      const rateLimitMs = 5000;

      // Use a flag on the session to let stream() know it's past the rate limit
      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          spawnCount++;
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          resumeCount++;
          rateLimitHandled = true;
          return s;
        },
        async *stream(_s): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: `rate_limit:${rateLimitMs}` };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();

      const result = await runPromise;

      expect(result.success).toBe(true);
      // Scheduler should have called resume() to continue the conversation
      expect(resumeCount).toBe(1);
      // spawn() called only once (initial session)
      expect(spawnCount).toBe(1);
    });

    it("falls back to spawn when resume throws during rate limit recovery", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let spawnCount = 0;
      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          spawnCount++;
          return makeSession(_c.role);
        },
        async resume(_c, _s) {
          // Simulate adapters (e.g. claude-cli) that don't support resume
          throw new Error("resume not supported");
        },
        async *stream(_s): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            rateLimitHandled = true;
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      const result = await runPromise;

      expect(result.success).toBe(true);
      // spawn() should be called twice: initial + fallback after failed resume
      expect(spawnCount).toBe(2);
    });

    it("emits rate_limit monitor event", async () => {
      vi.useFakeTimers();

      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          rateLimitHandled = true;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      await runPromise;

      const rateLimitEvents = monitor.events.filter((e) => e.type === "rate_limit");
      expect(rateLimitEvents.length).toBeGreaterThan(0);
    });

    it("does not count rate limit pauses as retries", async () => {
      vi.useFakeTimers();

      // Loop-back workflow but the rate limit happens during nodeA (no loop-back on nodeA)
      const workflow = singleNodeWorkflow();
      const monitor = createMockMonitor();

      let rateLimitHandled = false;

      const adapter: AgentAdapter = {
        name: "mock",
        async isAvailable() { return true; },
        async spawn(_c) {
          return makeSession(_c.role);
        },
        async resume(_c, s) {
          rateLimitHandled = true;
          return s;
        },
        async *stream(): AsyncIterable<AgentEvent> {
          if (!rateLimitHandled) {
            yield { type: "error", message: "rate_limit:1000" };
          }
        },
        async getResult() {
          return { output: "", exitCode: 0, durationMs: 1 };
        },
        async kill() { /* no-op */ },
      };

      const scheduler = new WorkflowScheduler(workflow, () => adapter, monitor as WsMonitorServer);
      const runPromise = scheduler.run("wf-1");

      // Let the workflow start and reach the rate limit error
      await vi.runOnlyPendingTimersAsync();
      await advanceThroughRateLimit();
      const result = await runPromise;

      expect(result.success).toBe(true);

      // retryCounters should be empty — rate limits don't count as retries
      const stateFile = join(testDir, ".sygil", "runs", `${result.runId}.json`);
      const raw = await readFile(stateFile, "utf8");
      const state = JSON.parse(raw);
      expect(Object.keys(state.retryCounters)).toHaveLength(0);
    });
  });
});
