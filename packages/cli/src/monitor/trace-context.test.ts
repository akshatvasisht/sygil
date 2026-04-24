import { describe, it, expect } from "vitest";
import { deriveTraceContext } from "./trace-context.js";

describe("deriveTraceContext", () => {
  it("produces a 32-hex traceId, 16-hex spanId, and the matching traceparent", () => {
    const ctx = deriveTraceContext("run-abc", "node-a");
    expect(ctx.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(ctx.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(ctx.traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("is deterministic — same inputs return the same values", () => {
    const a = deriveTraceContext("run-42", "planner");
    const b = deriveTraceContext("run-42", "planner");
    expect(a).toEqual(b);
  });

  it("every node in a run shares the traceId but gets a unique spanId", () => {
    const planner = deriveTraceContext("run-1", "planner");
    const implementer = deriveTraceContext("run-1", "implementer");
    expect(planner.traceId).toBe(implementer.traceId);
    expect(planner.spanId).not.toBe(implementer.spanId);
  });

  it("different runs produce different traceIds", () => {
    const r1 = deriveTraceContext("run-1", "planner");
    const r2 = deriveTraceContext("run-2", "planner");
    expect(r1.traceId).not.toBe(r2.traceId);
  });
});
