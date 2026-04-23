import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowGraph, NodeConfig } from "@sygil/shared";
import { resolveModelTiers, resolveModelTiersAndLog } from "./tier-resolver.js";
import { logger } from "./logger.js";

function node(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    adapter: "claude-sdk",
    model: "claude-opus-4-7",
    role: "planner",
    prompt: "Plan",
    ...overrides,
  };
}

function graph(nodes: Record<string, NodeConfig>): WorkflowGraph {
  return { version: "1", name: "wf", nodes, edges: [] };
}

describe("resolveModelTiers", () => {
  it("returns the graph unchanged when no node has a modelTier", () => {
    const g = graph({ a: node(), b: node({ model: "claude-sonnet-4-5" }) });
    const out = resolveModelTiers(g, { cheap: "claude-haiku-4-5", smart: "claude-opus-4-7" });
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([]);
    expect(out.graph.nodes["a"]?.model).toBe("claude-opus-4-7");
    expect(out.graph.nodes["b"]?.model).toBe("claude-sonnet-4-5");
  });

  it("overrides model when modelTier has a matching tier map entry", () => {
    const g = graph({ a: node({ modelTier: "cheap" }) });
    const out = resolveModelTiers(g, { cheap: "claude-haiku-4-5" });
    expect(out.graph.nodes["a"]?.model).toBe("claude-haiku-4-5");
    expect(out.resolved).toEqual([
      { nodeId: "a", tier: "cheap", from: "claude-opus-4-7", to: "claude-haiku-4-5" },
    ]);
    expect(out.unresolved).toEqual([]);
  });

  it("records unresolved nodes when the tier has no mapping", () => {
    const g = graph({ a: node({ modelTier: "cheap" }) });
    const out = resolveModelTiers(g, {});
    expect(out.graph.nodes["a"]?.model).toBe("claude-opus-4-7");
    expect(out.unresolved).toEqual(["a"]);
    expect(out.resolved).toEqual([]);
  });

  it("treats an undefined tier map the same as an empty one", () => {
    const g = graph({ a: node({ modelTier: "smart" }) });
    const out = resolveModelTiers(g, undefined);
    expect(out.graph.nodes["a"]?.model).toBe("claude-opus-4-7");
    expect(out.unresolved).toEqual(["a"]);
  });

  it("treats an empty-string tier mapping as unresolved", () => {
    const g = graph({ a: node({ modelTier: "cheap" }) });
    const out = resolveModelTiers(g, { cheap: "" });
    expect(out.graph.nodes["a"]?.model).toBe("claude-opus-4-7");
    expect(out.unresolved).toEqual(["a"]);
  });

  it("does not mutate the input graph or its nodes", () => {
    const original = graph({ a: node({ modelTier: "cheap" }) });
    const snapshot = JSON.stringify(original);
    const out = resolveModelTiers(original, { cheap: "claude-haiku-4-5" });
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(out.graph).not.toBe(original);
    expect(out.graph.nodes["a"]).not.toBe(original.nodes["a"]);
  });

  it("does not record a 'resolved' entry when the mapping equals the author's model", () => {
    const g = graph({ a: node({ modelTier: "smart", model: "claude-opus-4-7" }) });
    const out = resolveModelTiers(g, { smart: "claude-opus-4-7" });
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([]);
    expect(out.graph.nodes["a"]?.model).toBe("claude-opus-4-7");
  });

  it("resolves different tiers across multiple nodes in a single call", () => {
    const g = graph({
      a: node({ modelTier: "cheap" }),
      b: node({ modelTier: "smart" }),
      c: node(),
    });
    const out = resolveModelTiers(g, { cheap: "claude-haiku-4-5", smart: "claude-sonnet-4-5" });
    expect(out.graph.nodes["a"]?.model).toBe("claude-haiku-4-5");
    expect(out.graph.nodes["b"]?.model).toBe("claude-sonnet-4-5");
    expect(out.graph.nodes["c"]?.model).toBe("claude-opus-4-7");
    expect(out.resolved).toHaveLength(2);
  });
});

describe("resolveModelTiersAndLog", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one info line per rewrite and one warn line per unresolved node", () => {
    const g = graph({
      a: node({ modelTier: "cheap" }),
      b: node({ modelTier: "smart" }),
    });
    resolveModelTiersAndLog(g, { cheap: "claude-haiku-4-5" });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('node "a"'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('node "b"'));
  });

  it("returns the resolved graph without the outcome wrapper", () => {
    const g = graph({ a: node({ modelTier: "cheap" }) });
    const resolved = resolveModelTiersAndLog(g, { cheap: "claude-haiku-4-5" });
    expect(resolved.nodes["a"]?.model).toBe("claude-haiku-4-5");
  });
});
