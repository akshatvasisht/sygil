import { describe, it, expect, vi, afterEach } from "vitest";
import type { NodeConfig, NodeResult, WorkflowGraph, WsServerEvent } from "@sygil/shared";
import { MetricsAggregator } from "./metrics-aggregator.js";
import { AdapterPool } from "../adapters/adapter-pool.js";

const graph: WorkflowGraph = {
  version: "1.0",
  name: "test",
  nodes: {},
  edges: [],
};

const baseConfig = (adapter: string): NodeConfig =>
  ({
    adapter,
    model: "m",
    role: "r",
    prompt: "p",
    tools: [],
    outputDir: "out",
  }) as unknown as NodeConfig;

const baseResult = (durationMs: number): NodeResult => ({
  output: "",
  exitCode: 0,
  durationMs,
});

describe("MetricsAggregator", () => {
  let agg: MetricsAggregator;

  afterEach(() => {
    agg?.stop();
  });

  it("returns null for unknown workflow", () => {
    agg = new MetricsAggregator();
    expect(agg.snapshot("nope")).toBeNull();
  });

  it("initializes workflow state on workflow_start", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    const snap = agg.snapshot("w1");
    expect(snap).not.toBeNull();
    expect(snap!.adapters).toEqual({});
    expect(snap!.gates).toEqual({ passed: 0, failed: 0 });
    expect(snap!.inFlightNodes).toBe(0);
    expect(snap!.pool).toBeNull();
  });

  it("tracks in-flight nodes across start/end", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    agg.observe({
      type: "node_start",
      workflowId: "w1",
      nodeId: "a",
      config: baseConfig("claude-cli"),
      attempt: 1,
    });
    agg.observe({
      type: "node_start",
      workflowId: "w1",
      nodeId: "b",
      config: baseConfig("claude-cli"),
      attempt: 1,
    });
    expect(agg.snapshot("w1")!.inFlightNodes).toBe(2);
    agg.observe({ type: "node_end", workflowId: "w1", nodeId: "a", result: baseResult(100) });
    expect(agg.snapshot("w1")!.inFlightNodes).toBe(1);
  });

  it("bins duration samples by the adapter seen at node_start", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    const starts: Array<[string, string]> = [
      ["a", "claude-cli"],
      ["b", "claude-cli"],
      ["c", "codex"],
    ];
    for (const [nodeId, adapter] of starts) {
      agg.observe({
        type: "node_start",
        workflowId: "w1",
        nodeId,
        config: baseConfig(adapter),
        attempt: 1,
      });
    }
    agg.observe({ type: "node_end", workflowId: "w1", nodeId: "a", result: baseResult(100) });
    agg.observe({ type: "node_end", workflowId: "w1", nodeId: "b", result: baseResult(300) });
    agg.observe({ type: "node_end", workflowId: "w1", nodeId: "c", result: baseResult(500) });
    const snap = agg.snapshot("w1")!;
    expect(snap.adapters["claude-cli"]?.count).toBe(2);
    expect(snap.adapters["codex"]?.count).toBe(1);
    expect(snap.adapters["codex"]?.p50Ms).toBe(500);
  });

  it("re-buckets duration under the fallback adapter after adapter_failover", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    agg.observe({
      type: "node_start",
      workflowId: "w1",
      nodeId: "a",
      config: baseConfig("claude-cli"),
      attempt: 1,
    });
    agg.observe({
      type: "node_event",
      workflowId: "w1",
      nodeId: "a",
      event: { type: "adapter_failover", fromAdapter: "claude-cli", toAdapter: "codex", reason: "transport" },
    });
    agg.observe({ type: "node_end", workflowId: "w1", nodeId: "a", result: baseResult(250) });
    const snap = agg.snapshot("w1")!;
    expect(snap.adapters["claude-cli"]).toBeUndefined();
    expect(snap.adapters["codex"]?.count).toBe(1);
    expect(snap.adapters["codex"]?.p50Ms).toBe(250);
  });

  it("computes nearest-rank percentiles correctly on a known sample set", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    // 100 samples 1..100 should give p50=50, p95=95, p99=99
    for (let i = 1; i <= 100; i++) {
      agg.observe({
        type: "node_start",
        workflowId: "w1",
        nodeId: `n${i}`,
        config: baseConfig("claude-cli"),
        attempt: 1,
      });
      agg.observe({ type: "node_end", workflowId: "w1", nodeId: `n${i}`, result: baseResult(i) });
    }
    const snap = agg.snapshot("w1")!;
    expect(snap.adapters["claude-cli"]?.p50Ms).toBe(50);
    expect(snap.adapters["claude-cli"]?.p95Ms).toBe(95);
    expect(snap.adapters["claude-cli"]?.p99Ms).toBe(99);
  });

  it("counts gate passes and failures", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    agg.observe({ type: "gate_eval", workflowId: "w1", edgeId: "e1", passed: true });
    agg.observe({ type: "gate_eval", workflowId: "w1", edgeId: "e2", passed: false });
    agg.observe({ type: "gate_eval", workflowId: "w1", edgeId: "e3", passed: true });
    const snap = agg.snapshot("w1")!;
    expect(snap.gates).toEqual({ passed: 2, failed: 1 });
  });

  it("includes pool metrics when an AdapterPool is attached", async () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    const pool = new AdapterPool({ maxConcurrency: 2 });
    const s1 = await pool.acquire("claude-cli");
    agg.setAdapterPool(pool);
    const snap = agg.snapshot("w1")!;
    expect(snap.pool).not.toBeNull();
    expect(snap.pool!.active).toBe(1);
    expect(snap.pool!.maxConcurrency).toBe(2);
    expect(snap.pool!.waitCount).toBe(1);
    pool.release(s1);
    await pool.drain();
  });

  it("emits metrics_tick events for each active workflow when ticked", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    agg.observe({ type: "workflow_start", workflowId: "w2", graph });
    const emitted: WsServerEvent[] = [];
    agg.start((evt) => emitted.push(evt));
    agg.tick();
    const ticks = emitted.filter((e) => e.type === "metrics_tick");
    expect(ticks.length).toBe(2);
    expect(ticks.map((t) => (t as Extract<WsServerEvent, { type: "metrics_tick" }>).workflowId).sort())
      .toEqual(["w1", "w2"]);
  });

  it("ticks on the configured interval", async () => {
    vi.useFakeTimers();
    try {
      agg = new MetricsAggregator({ tickIntervalMs: 50 });
      agg.observe({ type: "workflow_start", workflowId: "w1", graph });
      const emitted: WsServerEvent[] = [];
      agg.start((evt) => emitted.push(evt));
      await vi.advanceTimersByTimeAsync(125);
      // 125ms elapsed @ 50ms interval → 2 fires
      expect(emitted.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dropWorkflow clears aggregate state", () => {
    agg = new MetricsAggregator();
    agg.observe({ type: "workflow_start", workflowId: "w1", graph });
    agg.observe({ type: "gate_eval", workflowId: "w1", edgeId: "e1", passed: true });
    expect(agg.snapshot("w1")).not.toBeNull();
    agg.dropWorkflow("w1");
    expect(agg.snapshot("w1")).toBeNull();
  });
});
