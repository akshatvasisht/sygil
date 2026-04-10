import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentEvent } from "@sigil/shared";

/**
 * Creates a minimal fake ChildProcess with controllable stdout/stderr streams.
 * Use proc.stdout.emit("data", Buffer.from(...)) and proc.emit("exit", code)
 * to drive the stream in tests.
 */
export function makeFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { pipe?: unknown };
  const stderr = new EventEmitter() as EventEmitter & { pipe?: unknown };

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  proc.pid = 12345;

  return proc;
}

/**
 * Pushes NDJSON lines into a fake stdout stream.
 * Each string in `lines` is emitted as a newline-terminated chunk.
 * If `close` is true (default), emits the "end" event after all data.
 */
export function pushLines(stdout: EventEmitter, lines: string[], close = true): void {
  const chunk = Buffer.from(lines.map((l) => l + "\n").join(""));
  stdout.emit("data", chunk);
  if (close) stdout.emit("end");
}

/**
 * Collects all events from an AsyncIterable into an array.
 * Useful for draining an adapter's stream() in tests.
 */
export async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
  }
  return events;
}
