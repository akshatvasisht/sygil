/**
 * Integration tests for EventRecorder + replayEvents working together.
 *
 * These tests verify that events recorded by EventRecorder can be faithfully
 * read back and replayed via replayEvents — exercising the full NDJSON
 * write → read → replay pipeline without mocking any I/O.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventRecorder } from "../scheduler/event-recorder.js";
import { replayEvents } from "../scheduler/event-replay.js";
import type { AgentEvent, RecordedEvent } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sygil-ndjson-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NDJSON snapshot integration", () => {
  it("records and reads back events for a single node", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    const event1: AgentEvent = { type: "tool_call", tool: "bash", input: { cmd: "ls -la" } };
    const event2: AgentEvent = { type: "file_write", path: "/tmp/output.txt" };
    const event3: AgentEvent = { type: "cost_update", totalCostUsd: 0.0042 };

    recorder.record("nodeA", event1);
    recorder.record("nodeA", event2);
    recorder.record("nodeA", event3);

    await recorder.flushNode("nodeA");

    const events = await EventRecorder.readNodeEvents(runDir, "nodeA");

    expect(events).toHaveLength(3);
    expect(events[0]!.nodeId).toBe("nodeA");
    expect(events[0]!.event.type).toBe("tool_call");
    expect((events[0]!.event as Extract<AgentEvent, { type: "tool_call" }>).tool).toBe("bash");
    expect((events[0]!.event as Extract<AgentEvent, { type: "tool_call" }>).input).toEqual({ cmd: "ls -la" });

    expect(events[1]!.nodeId).toBe("nodeA");
    expect(events[1]!.event.type).toBe("file_write");
    expect((events[1]!.event as Extract<AgentEvent, { type: "file_write" }>).path).toBe("/tmp/output.txt");

    expect(events[2]!.nodeId).toBe("nodeA");
    expect(events[2]!.event.type).toBe("cost_update");
    expect((events[2]!.event as Extract<AgentEvent, { type: "cost_update" }>).totalCostUsd).toBe(0.0042);

    // All events must have numeric timestamps
    for (const e of events) {
      expect(typeof e.timestamp).toBe("number");
    }
  });

  it("records events for multiple nodes and reads all sorted by timestamp", async () => {
    const runDir = await makeTempDir();
    vi.useFakeTimers();

    const base = 1_000_000;

    const recorder = new EventRecorder(runDir);

    // Record nodeA events at t=base+10 and t=base+30
    vi.setSystemTime(base + 10);
    recorder.record("nodeA", { type: "text_delta", text: "nodeA-first" });

    vi.setSystemTime(base + 30);
    recorder.record("nodeA", { type: "text_delta", text: "nodeA-second" });

    // Record nodeB events at t=base+20 and t=base+40 — interleaved with nodeA
    vi.setSystemTime(base + 20);
    recorder.record("nodeB", { type: "shell_exec", command: "echo hi", exitCode: 0 });

    vi.setSystemTime(base + 40);
    recorder.record("nodeB", { type: "error", message: "oops" });

    await recorder.flushAll();

    const all = await EventRecorder.readAllEvents(runDir);

    expect(all).toHaveLength(4);

    // Must be sorted ascending by timestamp
    expect(all[0]!.timestamp).toBe(base + 10);
    expect(all[0]!.nodeId).toBe("nodeA");
    expect((all[0]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("nodeA-first");

    expect(all[1]!.timestamp).toBe(base + 20);
    expect(all[1]!.nodeId).toBe("nodeB");
    expect(all[1]!.event.type).toBe("shell_exec");

    expect(all[2]!.timestamp).toBe(base + 30);
    expect(all[2]!.nodeId).toBe("nodeA");
    expect((all[2]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("nodeA-second");

    expect(all[3]!.timestamp).toBe(base + 40);
    expect(all[3]!.nodeId).toBe("nodeB");
    expect(all[3]!.event.type).toBe("error");
  });

  it("append semantics — flushing twice appends to the same file", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    // First batch
    recorder.record("nodeA", { type: "text_delta", text: "first" });
    recorder.record("nodeA", { type: "text_delta", text: "second" });
    await recorder.flushNode("nodeA");

    // Second batch — same recorder instance, same nodeA, same file
    recorder.record("nodeA", { type: "text_delta", text: "third" });
    recorder.record("nodeA", { type: "text_delta", text: "fourth" });
    await recorder.flushNode("nodeA");

    const events = await EventRecorder.readNodeEvents(runDir, "nodeA");

    expect(events).toHaveLength(4);
    expect((events[0]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("first");
    expect((events[1]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("second");
    expect((events[2]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("third");
    expect((events[3]!.event as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("fourth");
  });

  it("readNodeEvents returns empty array for non-existent node", async () => {
    const runDir = await makeTempDir();

    // No recorder, no flush — nodeId never written
    const events = await EventRecorder.readNodeEvents(runDir, "ghost-node");

    expect(events).toEqual([]);
  });

  it("replayEvents yields all events in order at speed=0 (instant)", async () => {
    const runDir = await makeTempDir();
    vi.useFakeTimers();

    const base = 2_000_000;
    const recorder = new EventRecorder(runDir);

    vi.setSystemTime(base + 5);
    recorder.record("nodeA", { type: "text_delta", text: "a1" });

    vi.setSystemTime(base + 15);
    recorder.record("nodeB", { type: "tool_call", tool: "read_file", input: { path: "foo.ts" } });

    vi.setSystemTime(base + 25);
    recorder.record("nodeA", { type: "stall", reason: "no output" });

    vi.setSystemTime(base + 35);
    recorder.record("nodeB", { type: "cost_update", totalCostUsd: 0.001 });

    await recorder.flushAll();

    // Use real timers for the actual replay so async iteration works correctly
    vi.useRealTimers();

    const reference = await EventRecorder.readAllEvents(runDir);

    const replayed: RecordedEvent[] = [];
    for await (const entry of replayEvents(runDir, { speed: 0 })) {
      replayed.push(entry);
    }

    expect(replayed).toHaveLength(reference.length);
    expect(replayed).toHaveLength(4);

    // Order must match readAllEvents (sorted by timestamp)
    for (let i = 0; i < replayed.length; i++) {
      expect(replayed[i]!.timestamp).toBe(reference[i]!.timestamp);
      expect(replayed[i]!.nodeId).toBe(reference[i]!.nodeId);
      expect(replayed[i]!.event.type).toBe(reference[i]!.event.type);
    }
  });

  it("replayEvents can be aborted mid-stream", async () => {
    const runDir = await makeTempDir();
    vi.useFakeTimers();

    const base = 3_000_000;
    const recorder = new EventRecorder(runDir);

    // Record 10 text_delta events with incrementing timestamps
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(base + i * 10);
      recorder.record("nodeA", { type: "text_delta", text: `chunk-${i}` });
    }

    await recorder.flushNode("nodeA");

    vi.useRealTimers();

    const controller = new AbortController();
    const collected: RecordedEvent[] = [];

    for await (const entry of replayEvents(runDir, { speed: 0, signal: controller.signal })) {
      collected.push(entry);
      if (collected.length === 3) {
        controller.abort();
      }
    }

    // After aborting at 3, some events may slip through before abort is
    // processed, but we should not receive all 10.
    expect(collected.length).toBeGreaterThanOrEqual(3);
    expect(collected.length).toBeLessThanOrEqual(5);
  });
});
