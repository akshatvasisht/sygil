import { describe, it, expect } from "vitest";
// @ts-expect-error — sibling ESM helper with no declaration file
import { dominates, updateFrontier, totalCost } from "./pareto.mjs";

type C = { id: string; gatePassRate: number; costUsd: number };

describe("pareto.dominates", () => {
  it("strictly-better-on-both dominates", () => {
    const a: C = { id: "a", gatePassRate: 0.9, costUsd: 0.1 };
    const b: C = { id: "b", gatePassRate: 0.8, costUsd: 0.2 };
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it("equal on both objectives does not dominate (tie)", () => {
    const a: C = { id: "a", gatePassRate: 0.9, costUsd: 0.1 };
    const b: C = { id: "b", gatePassRate: 0.9, costUsd: 0.1 };
    expect(dominates(a, b)).toBe(false);
    expect(dominates(b, a)).toBe(false);
  });

  it("equal pass-rate but lower cost dominates", () => {
    const cheap: C = { id: "cheap", gatePassRate: 0.8, costUsd: 0.05 };
    const expensive: C = { id: "expensive", gatePassRate: 0.8, costUsd: 0.20 };
    expect(dominates(cheap, expensive)).toBe(true);
  });

  it("higher pass-rate but higher cost does not dominate (trade-off)", () => {
    const accurate: C = { id: "accurate", gatePassRate: 1.0, costUsd: 0.50 };
    const cheap: C = { id: "cheap", gatePassRate: 0.7, costUsd: 0.05 };
    expect(dominates(accurate, cheap)).toBe(false);
    expect(dominates(cheap, accurate)).toBe(false);
  });
});

describe("pareto.updateFrontier", () => {
  it("appends the first entry", () => {
    const archive: C[] = [];
    const next = updateFrontier(archive, { id: "a", gatePassRate: 0.8, costUsd: 0.1 });
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe("a");
  });

  it("keeps non-dominated entries on a trade-off", () => {
    const archive: C[] = [{ id: "accurate", gatePassRate: 1.0, costUsd: 0.50 }];
    const next = updateFrontier(archive, { id: "cheap", gatePassRate: 0.7, costUsd: 0.05 });
    expect(next).toHaveLength(2);
    expect(next.map((c) => c.id).sort()).toEqual(["accurate", "cheap"]);
  });

  it("drops dominated entries when the new one dominates them", () => {
    const archive: C[] = [
      { id: "mid", gatePassRate: 0.8, costUsd: 0.20 },
      { id: "expensive", gatePassRate: 0.8, costUsd: 0.50 },
    ];
    const next = updateFrontier(archive, { id: "cheap", gatePassRate: 0.9, costUsd: 0.10 });
    expect(next.map((c) => c.id)).toEqual(["cheap"]);
  });

  it("rejects a dominated candidate without mutating the archive", () => {
    const archive: C[] = [{ id: "strong", gatePassRate: 1.0, costUsd: 0.05 }];
    const next = updateFrontier(archive, { id: "weak", gatePassRate: 0.7, costUsd: 0.30 });
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe("strong");
  });

  it("does not mutate the input archive", () => {
    const archive: C[] = [{ id: "a", gatePassRate: 0.8, costUsd: 0.1 }];
    const snapshot = JSON.stringify(archive);
    updateFrontier(archive, { id: "b", gatePassRate: 0.9, costUsd: 0.05 });
    expect(JSON.stringify(archive)).toBe(snapshot);
  });

  it("keeps a tied entry (equal on all objectives) — no silent dedup", () => {
    const archive: C[] = [{ id: "a", gatePassRate: 0.9, costUsd: 0.1 }];
    const next = updateFrontier(archive, { id: "b", gatePassRate: 0.9, costUsd: 0.1 });
    expect(next).toHaveLength(2);
  });

  it("numeric noise tolerance — ≈equal entries both retained", () => {
    const archive: C[] = [{ id: "a", gatePassRate: 0.9, costUsd: 0.1 }];
    const next = updateFrontier(archive, { id: "b", gatePassRate: 0.9 + 1e-12, costUsd: 0.1 - 1e-12 });
    // Within epsilon — treated as tie.
    expect(next).toHaveLength(2);
  });
});

describe("pareto.totalCost", () => {
  it("sums costUsd across the archive", () => {
    const archive: C[] = [
      { id: "a", gatePassRate: 0.5, costUsd: 0.1 },
      { id: "b", gatePassRate: 0.7, costUsd: 0.25 },
      { id: "c", gatePassRate: 1.0, costUsd: 0.50 },
    ];
    expect(totalCost(archive)).toBeCloseTo(0.85, 6);
  });

  it("returns 0 for empty archive", () => {
    expect(totalCost([])).toBe(0);
  });

  it("ignores non-finite costs", () => {
    const archive = [{ id: "a", gatePassRate: 0.5, costUsd: NaN }] as C[];
    expect(totalCost(archive)).toBe(0);
  });
});
