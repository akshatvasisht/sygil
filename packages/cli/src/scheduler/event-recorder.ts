import { mkdir, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, RecordedEvent } from "@sigil/shared";

const EVENTS_DIR_NAME = "events";

/**
 * EventRecorder — buffers AgentEvents in memory and flushes them as NDJSON files.
 *
 * Storage format: `.sigil/runs/<runId>/events/<nodeId>.ndjson`
 * One JSON line per RecordedEvent, append-friendly.
 */
export class EventRecorder {
  private buffers = new Map<string, RecordedEvent[]>();

  constructor(private readonly runDir: string) {}

  /** Record an event (non-blocking, buffers internally). */
  record(nodeId: string, event: AgentEvent): void {
    const recorded: RecordedEvent = {
      timestamp: Date.now(),
      nodeId,
      event,
    };

    let buffer = this.buffers.get(nodeId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(nodeId, buffer);
    }
    buffer.push(recorded);
  }

  /** Flush buffered events for a single node to disk, then clear its buffer. */
  async flushNode(nodeId: string): Promise<void> {
    const buffer = this.buffers.get(nodeId);
    if (!buffer || buffer.length === 0) {
      // No-op: nothing to flush — don't create empty files
      this.buffers.delete(nodeId);
      return;
    }

    const eventsDir = join(this.runDir, EVENTS_DIR_NAME);
    await mkdir(eventsDir, { recursive: true });

    const lines = buffer.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await appendFile(join(eventsDir, `${nodeId}.ndjson`), lines, "utf8");

    this.buffers.delete(nodeId);
  }

  /** Flush all buffered events for every node. */
  async flushAll(): Promise<void> {
    const nodeIds = [...this.buffers.keys()];
    for (const nodeId of nodeIds) {
      await this.flushNode(nodeId);
    }
  }

  /** Read recorded events for a specific node from disk. */
  static async readNodeEvents(runDir: string, nodeId: string): Promise<RecordedEvent[]> {
    const filePath = join(runDir, EVENTS_DIR_NAME, `${nodeId}.ndjson`);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return [];
    }

    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecordedEvent);
  }

  /** Read all recorded events for a run, merged and sorted by timestamp. */
  static async readAllEvents(runDir: string): Promise<RecordedEvent[]> {
    const eventsDir = join(runDir, EVENTS_DIR_NAME);
    let files: string[];
    try {
      files = await readdir(eventsDir);
    } catch {
      return [];
    }

    const allEvents: RecordedEvent[] = [];

    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const nodeId = file.replace(/\.ndjson$/, "");
      const nodeEvents = await EventRecorder.readNodeEvents(runDir, nodeId);
      allEvents.push(...nodeEvents);
    }

    allEvents.sort((a, b) => a.timestamp - b.timestamp);
    return allEvents;
  }
}
