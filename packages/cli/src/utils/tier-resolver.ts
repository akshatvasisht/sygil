import type { ModelTier, WorkflowGraph } from "@sygil/shared";
import { logger } from "./logger.js";

export type TierMap = Partial<Record<ModelTier, string>>;

export interface TierResolutionOutcome {
  /** Resolved graph with `model` overridden for every node whose tier mapped. */
  graph: WorkflowGraph;
  /**
   * Node IDs whose `modelTier` had no matching entry in the tier map. Their
   * `model` field is left unchanged; the scheduler will use the author's
   * original value. Caller may choose to warn or fail — this resolver only
   * reports.
   */
  unresolved: string[];
  /**
   * Per-node summary of {from -> to} replacements, for telemetry and the
   * dated build-log. Only populated for nodes that actually had their
   * `model` field rewritten.
   */
  resolved: Array<{ nodeId: string; tier: ModelTier; from: string; to: string }>;
}

/**
 * Apply the project-level tier map to a workflow graph.
 *
 * Runs AFTER `interpolateWorkflow` and BEFORE the scheduler starts so
 * checkpoints observe the concrete model ID, preserving deterministic
 * replay from NDJSON event logs (decisions.md 2026-04-16). Never mutates
 * the input graph — returns a new graph with per-node overrides applied.
 */
export function resolveModelTiers(graph: WorkflowGraph, tiers: TierMap | undefined): TierResolutionOutcome {
  const unresolved: string[] = [];
  const resolved: TierResolutionOutcome["resolved"] = [];

  const newNodes: WorkflowGraph["nodes"] = {};
  for (const [nodeId, nodeConfig] of Object.entries(graph.nodes)) {
    if (!nodeConfig.modelTier) {
      newNodes[nodeId] = nodeConfig;
      continue;
    }
    const tier = nodeConfig.modelTier;
    const mapped = tiers?.[tier];
    if (mapped === undefined || mapped.length === 0) {
      unresolved.push(nodeId);
      newNodes[nodeId] = nodeConfig;
      continue;
    }
    if (mapped === nodeConfig.model) {
      // Tier and node already agree — no rewrite to record.
      newNodes[nodeId] = nodeConfig;
      continue;
    }
    newNodes[nodeId] = { ...nodeConfig, model: mapped };
    resolved.push({ nodeId, tier, from: nodeConfig.model, to: mapped });
  }

  const newGraph: WorkflowGraph = { ...graph, nodes: newNodes };
  return { graph: newGraph, unresolved, resolved };
}

/**
 * Convenience wrapper: apply the tier map, log each rewrite at info level,
 * and warn once per node whose tier was unmapped. Returns the resolved
 * graph so callers can just swap the reference. Use this from command code
 * (`run`, `resume`); use `resolveModelTiers` directly from pure-logic paths
 * that prefer no side effects (tests).
 */
export function resolveModelTiersAndLog(graph: WorkflowGraph, tiers: TierMap | undefined): WorkflowGraph {
  const outcome = resolveModelTiers(graph, tiers);
  for (const entry of outcome.resolved) {
    logger.info(`Tier resolution: node "${entry.nodeId}" (${entry.tier}) ${entry.from} → ${entry.to}`);
  }
  for (const nodeId of outcome.unresolved) {
    logger.warn(`Tier resolution: node "${nodeId}" declares modelTier but no project mapping exists — keeping original model.`);
  }
  return outcome.graph;
}
