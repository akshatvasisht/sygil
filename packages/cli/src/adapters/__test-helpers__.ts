import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentAdapter, AgentSession } from "@sygil/shared";

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
    // Match Node's real ChildProcess surface so adapters that gate on process
    // liveness (`proc.exitCode === null && !proc.killed`) see the right state.
    // Without these, a fake proc reads `exitCode === undefined` — strict-null
    // checks return "dead", skipping SIGTERM in tests that expected a kill.
    exitCode: number | null;
    killed: boolean;
  };

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.killed = false;
  const killFn = vi.fn();
  killFn.mockImplementation(() => {
    proc.killed = true;
    return true;
  });
  proc.kill = killFn;
  proc.pid = 12345;
  // Bridge the real 'exit' event → exitCode field so test-driven exits
  // match production where Node sets exitCode just before firing 'exit'.
  proc.on("exit", (code: number | null) => {
    if (proc.exitCode === null) proc.exitCode = code ?? 0;
  });

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
 * Build a fake AgentSession with the standard test envelope around an
 * adapter-specific `_internal` shape. Each adapter's `_internal` differs
 * (queues, token counters, stall timers, etc.) — callers pass the full
 * structure; only the outer fields are shared.
 */
export function makeSession<TInternal>(
  adapterName: string,
  internal: TInternal,
  overrides?: { id?: string; nodeId?: string; startedAt?: Date }
): AgentSession {
  return {
    id: overrides?.id ?? "test-session-id",
    nodeId: overrides?.nodeId ?? "test-node",
    adapter: adapterName,
    startedAt: overrides?.startedAt ?? new Date(),
    _internal: internal,
  };
}

/**
 * Drain an adapter's stream() into a plain array. Returns the loose
 * `{ type, ... }` shape adapter tests use for assertions so callers can
 * inspect fields without repeating the discriminated-union narrowing.
 */
export async function collectEvents(
  adapter: AgentAdapter,
  session: AgentSession
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of adapter.stream(session)) {
    events.push(ev as { type: string; [k: string]: unknown });
  }
  return events;
}

