import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForDoneOrTimeout, type AwaitDoneTarget } from "./await-done.js";
import { makeFakeProc } from "./__test-helpers__.js";

// Dedicated tests for the #49 force-kill helper shared by the codex, cursor,
// and gemini adapters. Without these, cursor-cli.test.ts and gemini-cli.test.ts
// would silently lose the force-kill regression when the helper was extracted.

type FakeProc = ReturnType<typeof makeFakeProc>;

function makeTarget(): { proc: FakeProc; done: boolean; exitCode: number | null } {
  const proc = makeFakeProc();
  return { proc, done: false, exitCode: null };
}

// Cast a fake-target to the AwaitDoneTarget shape the helper expects.
// The helper only touches `proc.kill`, `proc.once("exit")`, `done`, `exitCode` —
// all of which makeFakeProc() satisfies.
const asTarget = (t: { proc: FakeProc; done: boolean; exitCode: number | null }): AwaitDoneTarget =>
  t as unknown as AwaitDoneTarget;

describe("waitForDoneOrTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves promptly when target.done flips before the timeout", async () => {
    const target = makeTarget();
    const p = waitForDoneOrTimeout(asTarget(target), {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      killGraceMs: 2_000,
    });

    target.done = true;
    target.exitCode = 0;
    await vi.advanceTimersByTimeAsync(50);

    await expect(p).resolves.toBeUndefined();
    // Never force-terminated because the child reported done cleanly.
    expect(target.proc.kill).not.toHaveBeenCalled();
    expect(target.exitCode).toBe(0);
  });

  it("sends SIGTERM after timeoutMs and SIGKILL after killGraceMs when target.done never flips", async () => {
    const target = makeTarget();
    const p = waitForDoneOrTimeout(asTarget(target), {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      killGraceMs: 2_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(target.proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(target.done).toBe(false); // still waiting on grace

    await vi.advanceTimersByTimeAsync(2_000);
    expect(target.proc.kill).toHaveBeenCalledWith("SIGKILL");

    await expect(p).resolves.toBeUndefined();
    // Synthesized exit code when the child never reported one.
    expect(target.exitCode).toBe(1);
    expect(target.done).toBe(true);
  });

  it("does not SIGKILL if the child exits during the grace window", async () => {
    const target = makeTarget();
    const p = waitForDoneOrTimeout(asTarget(target), {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      killGraceMs: 2_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(target.proc.kill).toHaveBeenCalledWith("SIGTERM");

    // Child obeys SIGTERM inside the grace window → the helper sees "exit"
    // and resolves without escalating to SIGKILL.
    target.proc.emit("exit", 0);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBeUndefined();

    expect(target.proc.kill).toHaveBeenCalledTimes(1);
    expect(target.proc.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(target.done).toBe(true);
  });

  it("swallows kill() throws when the child is already dead", async () => {
    const target = makeTarget();
    target.proc.kill.mockImplementation(() => {
      throw new Error("ESRCH: no such process");
    });

    const p = waitForDoneOrTimeout(asTarget(target), {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      killGraceMs: 2_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(2_000);

    // Should not reject despite both kill() calls throwing.
    await expect(p).resolves.toBeUndefined();
    expect(target.done).toBe(true);
  });

  it("clears the poll timer after resolution (no setTimeout leak)", async () => {
    const target = makeTarget();
    const p = waitForDoneOrTimeout(asTarget(target), {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      killGraceMs: 2_000,
    });

    target.done = true;
    await vi.advanceTimersByTimeAsync(50);
    await p;

    // After resolution, no pending timers should keep the event loop alive.
    // (fake timers report 0 pending — lock in the invariant).
    expect(vi.getTimerCount()).toBe(0);
  });
});
