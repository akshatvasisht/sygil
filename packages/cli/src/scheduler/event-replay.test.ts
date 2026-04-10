import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayEvents } from "./event-replay.js";
import { EventRecorder } from "./event-recorder.js";
import type { AgentEvent, RecordedEvent } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sigil-replay-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Write NDJSON events directly to disk (bypasses recorder for isolated tests). */
async function writeEvents(runDir: string, nodeId: string, events: RecordedEvent[]): Promise<void> {
  const eventsDir = join(runDir, "events");
  await mkdir(eventsDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(eventsDir, `${nodeId}.ndjson`), lines, "utf8");
}

function makeRecordedEvent(
  nodeId: string,
  timestamp: number,
  event: AgentEvent
): RecordedEvent {
  return { timestamp, nodeId, event };
}

async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replayEvents", () => {
  it("yields events in timestamp order across multiple nodes", async () => {
    const runDir = await makeTempDir();
    const now = 1000;

    await writeEvents(runDir, "node-a", [
      makeRecordedEvent("node-a", now + 10, { type: "tool_call", tool: "bash", input: {} }),
      makeRecordedEvent("node-a", now + 30, { type: "file_write", path: "/out.txt" }),
    ]);
    await writeEvents(runDir, "node-b", [
      makeRecordedEvent("node-b", now + 20, { type: "text_delta", text: "hi" }),
      makeRecordedEvent("node-b", now + 40, { type: "cost_update", totalCostUsd: 0.01 }),
    ]);

    const events = await collectAll(replayEvents(runDir, { speed: 0 }));
    expect(events).toHaveLength(4);
    expect(events[0]!.timestamp).toBe(now + 10);
    expect(events[1]!.timestamp).toBe(now + 20);
    expect(events[2]!.timestamp).toBe(now + 30);
    expect(events[3]!.timestamp).toBe(now + 40);
  });

  it("yields instantly with speed=0 (no delays)", async () => {
    const runDir = await makeTempDir();
    const now = Date.now();

    // Events spread 5 seconds apart — with speed=0 should be instant
    await writeEvents(runDir, "node-a", [
      makeRecordedEvent("node-a", now, { type: "tool_call", tool: "x", input: {} }),
      makeRecordedEvent("node-a", now + 5000, { type: "tool_result", tool: "x", output: "ok", success: true }),
      makeRecordedEvent("node-a", now + 10000, { type: "file_write", path: "/a.txt" }),
    ]);

    const start = Date.now();
    const events = await collectAll(replayEvents(runDir, { speed: 0 }));
    const elapsed = Date.now() - start;

    expect(events).toHaveLength(3);
    // With speed=0, should complete nearly instantly (well under 1 second)
    expect(elapsed).toBeLessThan(500);
  });

  it("filters to a single node when nodeId is provided", async () => {
    const runDir = await makeTempDir();
    const now = 1000;

    await writeEvents(runDir, "node-a", [
      makeRecordedEvent("node-a", now + 10, { type: "tool_call", tool: "bash", input: {} }),
    ]);
    await writeEvents(runDir, "node-b", [
      makeRecordedEvent("node-b", now + 20, { type: "text_delta", text: "hi" }),
    ]);

    const events = await collectAll(replayEvents(runDir, { nodeId: "node-a", speed: 0 }));
    expect(events).toHaveLength(1);
    expect(events[0]!.nodeId).toBe("node-a");
    expect(events[0]!.event.type).toBe("tool_call");
  });

  it("respects AbortSignal cancellation", async () => {
    const runDir = await makeTempDir();
    const now = 1000;

    // Write many events
    const manyEvents: RecordedEvent[] = [];
    for (let i = 0; i < 100; i++) {
      manyEvents.push(
        makeRecordedEvent("node-a", now + i * 100, { type: "text_delta", text: `line ${i}` })
      );
    }
    await writeEvents(runDir, "node-a", manyEvents);

    // Test 1: pre-aborted signal yields nothing
    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedEvents = await collectAll(replayEvents(runDir, { speed: 0, signal: preAborted.signal }));
    expect(preAbortedEvents).toHaveLength(0);

    // Test 2: abort mid-stream with speed=0 — collect a few then abort
    const controller = new AbortController();
    const collected: RecordedEvent[] = [];

    for await (const event of replayEvents(runDir, { speed: 0, signal: controller.signal })) {
      collected.push(event);
      if (collected.length >= 5) {
        controller.abort();
        // break out of the loop — the generator will check signal on next iteration
        break;
      }
    }

    // Should have stopped at 5 events, not consumed all 100
    expect(collected.length).toBe(5);
  });

  it("applies timing delays with speed > 0", async () => {
    const runDir = await makeTempDir();
    const now = 1000;

    // Events 100ms apart — with speed=100 should be ~1ms each (very fast)
    await writeEvents(runDir, "node-a", [
      makeRecordedEvent("node-a", now, { type: "tool_call", tool: "x", input: {} }),
      makeRecordedEvent("node-a", now + 100, { type: "tool_result", tool: "x", output: "ok", success: true }),
      makeRecordedEvent("node-a", now + 200, { type: "file_write", path: "/a.txt" }),
    ]);

    const start = Date.now();
    const events = await collectAll(replayEvents(runDir, { speed: 100 }));
    const elapsed = Date.now() - start;

    expect(events).toHaveLength(3);
    // With speed=100, total delay should be ~2ms (200ms / 100), well under 500ms
    expect(elapsed).toBeLessThan(500);
  });

  it("replays mixed node events in timestamp order with speed=0", async () => {
    const runDir = await makeTempDir();
    const now = 1000;

    // Three nodes with interleaved timestamps
    await writeEvents(runDir, "node-a", [
      makeRecordedEvent("node-a", now + 10, { type: "tool_call", tool: "bash", input: {} }),
      makeRecordedEvent("node-a", now + 50, { type: "file_write", path: "/a.txt" }),
    ]);
    await writeEvents(runDir, "node-b", [
      makeRecordedEvent("node-b", now + 20, { type: "text_delta", text: "hi" }),
    ]);
    await writeEvents(runDir, "node-c", [
      makeRecordedEvent("node-c", now + 15, { type: "cost_update", totalCostUsd: 0.01 }),
      makeRecordedEvent("node-c", now + 60, { type: "error", message: "oops" }),
    ]);

    const events = await collectAll(replayEvents(runDir, { speed: 0 }));
    expect(events).toHaveLength(5);

    // Verify sorted by timestamp
    expect(events[0]!.timestamp).toBe(now + 10);
    expect(events[0]!.nodeId).toBe("node-a");
    expect(events[1]!.timestamp).toBe(now + 15);
    expect(events[1]!.nodeId).toBe("node-c");
    expect(events[2]!.timestamp).toBe(now + 20);
    expect(events[2]!.nodeId).toBe("node-b");
    expect(events[3]!.timestamp).toBe(now + 50);
    expect(events[3]!.nodeId).toBe("node-a");
    expect(events[4]!.timestamp).toBe(now + 60);
    expect(events[4]!.nodeId).toBe("node-c");
  });

  it("returns empty for a nonexistent run directory", async () => {
    const runDir = join(tmpdir(), "sigil-nonexistent-" + Date.now());
    const events = await collectAll(replayEvents(runDir, { speed: 0 }));
    expect(events).toHaveLength(0);
  });
});
