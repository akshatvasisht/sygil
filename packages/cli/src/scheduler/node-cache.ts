/**
 * Content-addressable node memoization for Sigil workflows.
 *
 * Computes a SHA-256 hash of a node's effective inputs (prompt, adapter, model,
 * tools, resolved input mappings, upstream output hashes). If a cache entry
 * exists for that hash, the scheduler can skip re-execution.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EdgeConfig, NodeResult } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DETERMINISTIC_GATE_TYPES = new Set(["exit_code", "file_exists", "regex"]);

// ---------------------------------------------------------------------------
// Content hash computation
// ---------------------------------------------------------------------------

/** Fields extracted from a NodeConfig that contribute to the content hash. */
export interface HashableNodeInputs {
  prompt: string;
  adapter: string;
  model: string;
  tools?: string[];
  resolvedInputs?: Record<string, string>;
}

/**
 * Compute a deterministic SHA-256 content hash from a node's effective inputs.
 *
 * @param nodeInputs  - Relevant fields from the node config (post variable substitution)
 * @param resolvedInputs - Resolved input mapping key-value pairs
 * @param upstreamHashes - Map of upstream nodeId -> content hash of their result
 * @returns 64-char hex SHA-256 digest
 */
export function computeContentHash(
  nodeInputs: HashableNodeInputs,
  resolvedInputs: Record<string, string>,
  upstreamHashes: Record<string, string>
): string {
  const canonical = {
    prompt: nodeInputs.prompt,
    adapter: nodeInputs.adapter,
    model: nodeInputs.model,
    tools: nodeInputs.tools ?? [],
    resolvedInputs: { ...resolvedInputs, ...(nodeInputs.resolvedInputs ?? {}) },
    upstreamHashes,
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Gate determinism check
// ---------------------------------------------------------------------------

/**
 * Returns true only if every gate condition on the provided edges is
 * deterministic (exit_code, file_exists, regex). Edges without gates are
 * considered deterministic. Non-deterministic types (human_review, script)
 * make the result false — cached results cannot be trusted for those.
 */
export function areGatesDeterministic(edges: EdgeConfig[]): boolean {
  for (const edge of edges) {
    if (!edge.gate) continue;
    for (const condition of edge.gate.conditions) {
      if (!DETERMINISTIC_GATE_TYPES.has(condition.type)) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cache storage
// ---------------------------------------------------------------------------

/**
 * File-backed cache for NodeResult objects, keyed by content hash.
 * Cache files live at `<cacheDir>/<hash>.json`.
 */
export class NodeCache {
  constructor(private readonly cacheDir: string) {}

  /**
   * Retrieve a cached NodeResult by its content hash.
   * Returns null on cache miss or read/parse error.
   */
  async get(hash: string): Promise<NodeResult | null> {
    const filePath = join(this.cacheDir, `${hash}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as NodeResult;
    } catch {
      return null;
    }
  }

  /**
   * Write a NodeResult to the cache under its content hash.
   * Creates the cache directory if it doesn't exist.
   */
  async set(hash: string, result: NodeResult): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const filePath = join(this.cacheDir, `${hash}.json`);
    await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  }
}
