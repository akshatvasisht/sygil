import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventRecorder } from "./event-recorder.js";
import type { AgentEvent, RecordedEvent } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sigil-recorder-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeEvent(type: AgentEvent["type"], extra?: Record<string, unknown>): AgentEvent {
  switch (type) {
    case "tool_call":
      return { type: "tool_call", tool: "bash", input: { cmd: "ls" }, ...extra };
    case "tool_result":
      return { type: "tool_result", tool: "bash", output: "file.txt", success: true, ...extra };
    case "file_write":
      return { type: "file_write", path: "/tmp/out.txt", ...extra };
    case "text_delta":
      return { type: "text_delta", text: "hello", ...extra };
    case "cost_update":
      return { type: "cost_update", totalCostUsd: 0.05, ...extra };
    case "error":
      return { type: "error", message: "something broke", ...extra };
    case "stall":
      return { type: "stall", reason: "no output for 60s", ...extra };
    default:
      return { type: "shell_exec", command: "ls", exitCode: 0, ...extra };
  }
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

describe("EventRecorder", () => {
  it("recording events buffers them in memory without writing to disk", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    recorder.record("node-a", makeEvent("tool_call"));
    recorder.record("node-a", makeEvent("tool_result"));

    // No events directory should exist yet
    const entries = await readdir(runDir).catch(() => []);
    expect(entries).not.toContain("events");
  });

  it("flushNode writes NDJSON file for that node", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    const event1 = makeEvent("tool_call");
    const event2 = makeEvent("file_write");
    recorder.record("node-a", event1);
    recorder.record("node-a", event2);

    await recorder.flushNode("node-a");

    const filePath = join(runDir, "events", "node-a.ndjson");
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed0 = JSON.parse(lines[0]!) as RecordedEvent;
    expect(parsed0.nodeId).toBe("node-a");
    expect(parsed0.event.type).toBe("tool_call");
    expect(typeof parsed0.timestamp).toBe("number");

    const parsed1 = JSON.parse(lines[1]!) as RecordedEvent;
    expect(parsed1.event.type).toBe("file_write");
  });

  it("flushAll writes files for all nodes with buffered events", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    recorder.record("node-a", makeEvent("tool_call"));
    recorder.record("node-b", makeEvent("text_delta"));
    recorder.record("node-c", makeEvent("cost_update"));

    await recorder.flushAll();

    const eventsDir = join(runDir, "events");
    const files = await readdir(eventsDir);
    expect(files.sort()).toEqual(["node-a.ndjson", "node-b.ndjson", "node-c.ndjson"]);
  });

  it("readNodeEvents reads back recorded events correctly", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    recorder.record("node-x", makeEvent("tool_call"));
    recorder.record("node-x", makeEvent("tool_result"));
    recorder.record("node-x", makeEvent("file_write"));

    await recorder.flushNode("node-x");

    const events = await EventRecorder.readNodeEvents(runDir, "node-x");
    expect(events).toHaveLength(3);
    expect(events[0]!.event.type).toBe("tool_call");
    expect(events[1]!.event.type).toBe("tool_result");
    expect(events[2]!.event.type).toBe("file_write");
    // Timestamps should be monotonically non-decreasing
    expect(events[0]!.timestamp).toBeLessThanOrEqual(events[1]!.timestamp);
    expect(events[1]!.timestamp).toBeLessThanOrEqual(events[2]!.timestamp);
  });

  it("readAllEvents merges all nodes events sorted by timestamp", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    // Record with known timing: node-b event should be interleaved
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now + 10)   // node-a event 1
      .mockReturnValueOnce(now + 30)   // node-a event 2
      .mockReturnValueOnce(now + 20)   // node-b event 1
      .mockReturnValueOnce(now + 40);  // node-b event 2

    recorder.record("node-a", makeEvent("tool_call"));
    recorder.record("node-a", makeEvent("tool_result"));
    recorder.record("node-b", makeEvent("file_write"));
    recorder.record("node-b", makeEvent("text_delta"));

    await recorder.flushAll();

    const all = await EventRecorder.readAllEvents(runDir);
    expect(all).toHaveLength(4);

    // Should be sorted by timestamp
    expect(all[0]!.timestamp).toBe(now + 10);
    expect(all[0]!.nodeId).toBe("node-a");
    expect(all[1]!.timestamp).toBe(now + 20);
    expect(all[1]!.nodeId).toBe("node-b");
    expect(all[2]!.timestamp).toBe(now + 30);
    expect(all[2]!.nodeId).toBe("node-a");
    expect(all[3]!.timestamp).toBe(now + 40);
    expect(all[3]!.nodeId).toBe("node-b");
  });

  it("recording after flush starts a new buffer (no duplication)", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    recorder.record("node-a", makeEvent("tool_call"));
    await recorder.flushNode("node-a");

    // Record more events after flush
    recorder.record("node-a", makeEvent("file_write"));
    await recorder.flushNode("node-a");

    // File should now contain both events (append), not duplicated first event
    const events = await EventRecorder.readNodeEvents(runDir, "node-a");
    expect(events).toHaveLength(2);
    expect(events[0]!.event.type).toBe("tool_call");
    expect(events[1]!.event.type).toBe("file_write");
  });

  it("empty node flush is a no-op (does not create empty files)", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    await recorder.flushNode("nonexistent-node");

    const eventsDir = join(runDir, "events");
    const exists = await readdir(eventsDir).catch(() => null);
    // Either events dir doesn't exist, or it's empty
    if (exists) {
      expect(exists).toHaveLength(0);
    }
  });

  it("handles recording thousands of events", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    const COUNT = 2000;
    for (let i = 0; i < COUNT; i++) {
      recorder.record("node-bulk", makeEvent("text_delta", { text: `line-${i}` }));
    }

    await recorder.flushNode("node-bulk");

    const events = await EventRecorder.readNodeEvents(runDir, "node-bulk");
    expect(events).toHaveLength(COUNT);
    expect(events[0]!.event.type).toBe("text_delta");
    expect(events[COUNT - 1]!.event.type).toBe("text_delta");
  });

  it("handles Unicode content in events", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    recorder.record("node-unicode", makeEvent("text_delta", { text: "日本語テスト 🚀 émojis 中文" }));
    recorder.record("node-unicode", makeEvent("tool_result", {
      tool: "bash",
      output: "Ünïcödé rëspönsë — αβγδ",
      success: true,
    }));

    await recorder.flushNode("node-unicode");

    const events = await EventRecorder.readNodeEvents(runDir, "node-unicode");
    expect(events).toHaveLength(2);
    expect((events[0]!.event as { text: string }).text).toBe("日本語テスト 🚀 émojis 中文");
    expect((events[1]!.event as { output: string }).output).toBe("Ünïcödé rëspönsë — αβγδ");
  });

  it("readNodeEvents returns empty array for node with no recorded events", async () => {
    const runDir = await makeTempDir();
    const events = await EventRecorder.readNodeEvents(runDir, "nonexistent");
    expect(events).toHaveLength(0);
  });

  it("concurrent recording for multiple nodes does not interleave", async () => {
    const runDir = await makeTempDir();
    const recorder = new EventRecorder(runDir);

    // Record many events for two nodes concurrently
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      recorder.record("node-a", makeEvent("text_delta"));
      recorder.record("node-b", makeEvent("tool_call"));
    }

    await recorder.flushAll();

    const eventsA = await EventRecorder.readNodeEvents(runDir, "node-a");
    const eventsB = await EventRecorder.readNodeEvents(runDir, "node-b");

    expect(eventsA).toHaveLength(COUNT);
    expect(eventsB).toHaveLength(COUNT);

    // All events for node-a should have nodeId "node-a"
    for (const e of eventsA) {
      expect(e.nodeId).toBe("node-a");
      expect(e.event.type).toBe("text_delta");
    }
    for (const e of eventsB) {
      expect(e.nodeId).toBe("node-b");
      expect(e.event.type).toBe("tool_call");
    }
  });
});
