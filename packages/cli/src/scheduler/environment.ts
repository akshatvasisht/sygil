/**
 * environment.ts — capture and compare workflow execution environment snapshots.
 *
 * `buildEnvironmentSnapshot` is called at `run()` start and its result is
 * persisted in `WorkflowRunState.environment`. On `sygil resume` and
 * `sygil fork`, `diffEnvironment` compares the stored snapshot against a fresh
 * one; any differences are surfaced as human-readable strings.
 *
 * Design notes:
 * - `getVersion()` is optional on `AgentAdapter` — adapters that don't implement
 *   it are simply omitted from `adapterVersions` rather than erroring out.
 * - Env-var hashing uses `sha256(name + ":" + firstTenChars(value))` truncated
 *   to 16 hex chars — enough entropy for rotation detection without exposing secrets.
 * - All I/O is best-effort: a version probe that times out or throws returns null
 *   and is excluded from the snapshot. This prevents a slow CLI from blocking run start.
 */

import { createHash } from "node:crypto";
import type { AdapterType, WorkflowGraph, AgentAdapter, EnvironmentSnapshot } from "@sygil/shared";

// ---------------------------------------------------------------------------
// Sygil version — sourced from packages/cli/package.json at build time.
// Using a literal here rather than a dynamic import keeps the value constant
// and avoids Node ESM __dirname resolution issues in dist/.
// ---------------------------------------------------------------------------

export const SYGIL_CLI_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Env vars to hash for drift detection
// ---------------------------------------------------------------------------

const RELEVANT_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "CURSOR_API_KEY",
  "SYGIL_LOCAL_OAI_URL",
  "SYGIL_LOCAL_OAI_KEY",
] as const;

/**
 * Hash an env var value for drift detection.
 * Returns null when the variable is not set.
 */
export function hashEnvVar(name: string): string | null {
  const v = process.env[name];
  if (!v) return null;
  return createHash("sha256")
    .update(`${name}:${v.slice(0, 10)}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Version probing
// ---------------------------------------------------------------------------

/**
 * Probe an adapter for its version string. Returns null on any failure (missing
 * binary, timeout, unimplemented `getVersion`). Uses a 1s AbortSignal.timeout
 * so a missing binary doesn't stall run start.
 */
async function probeAdapterVersion(adapter: AgentAdapter): Promise<string | null> {
  if (typeof adapter.getVersion !== "function") return null;
  try {
    // Race against a 1s timeout — don't block run start on a slow version probe.
    const result = await Promise.race<string | null>([
      adapter.getVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export type AdapterFactory = (type: AdapterType) => AgentAdapter;

/**
 * Build an environment snapshot for the given workflow.
 * Only probes adapters actually referenced by workflow nodes.
 */
export async function buildEnvironmentSnapshot(
  workflow: WorkflowGraph,
  adapterFactory: AdapterFactory,
): Promise<EnvironmentSnapshot> {
  // Collect unique adapter types used by this workflow
  const usedAdapterTypes = [
    ...new Set(Object.values(workflow.nodes).map((n) => n.adapter)),
  ];

  // Probe each adapter concurrently — failures return null and are excluded
  const versionEntries = await Promise.all(
    usedAdapterTypes.map(async (adapterType) => {
      try {
        const adapter = adapterFactory(adapterType);
        const version = await probeAdapterVersion(adapter);
        return version !== null ? ([adapterType, version] as const) : null;
      } catch {
        return null;
      }
    }),
  );

  const adapterVersions: Record<string, string> = {};
  for (const entry of versionEntries) {
    if (entry !== null) {
      adapterVersions[entry[0]] = entry[1];
    }
  }

  // Hash relevant env vars (only those actually set)
  const envVarHashes: Record<string, string> = {};
  for (const varName of RELEVANT_ENV_VARS) {
    const hash = hashEnvVar(varName);
    if (hash !== null) {
      envVarHashes[varName] = hash;
    }
  }

  const snapshot: EnvironmentSnapshot = {
    sygilVersion: SYGIL_CLI_VERSION,
    adapterVersions,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    ...(Object.keys(envVarHashes).length > 0 ? { envVarHashes } : {}),
  };

  return snapshot;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Compare a stored environment snapshot against a freshly captured one.
 * Returns an array of human-readable drift descriptions. Empty array = no drift.
 */
export function diffEnvironment(
  stored: EnvironmentSnapshot | undefined,
  current: EnvironmentSnapshot,
): string[] {
  if (!stored) return []; // No stored snapshot — treat as no drift (backward compat)

  const diffs: string[] = [];

  // Adapter version drifts
  const allAdapters = new Set([
    ...Object.keys(stored.adapterVersions),
    ...Object.keys(current.adapterVersions),
  ]);
  for (const adapter of allAdapters) {
    const prev = stored.adapterVersions[adapter];
    const curr = current.adapterVersions[adapter];
    if (prev !== undefined && curr !== undefined && prev !== curr) {
      diffs.push(`${adapter}: ${prev} → ${curr}`);
    } else if (prev !== undefined && curr === undefined) {
      diffs.push(`${adapter}: ${prev} → (not found)`);
    }
    // curr present but prev absent: adapter was newly installed; not a drift concern
  }

  // Env var hash drifts
  const allVars = new Set([
    ...Object.keys(stored.envVarHashes ?? {}),
    ...Object.keys(current.envVarHashes ?? {}),
  ]);
  for (const varName of allVars) {
    const prev = stored.envVarHashes?.[varName];
    const curr = current.envVarHashes?.[varName];
    if (prev !== undefined && curr !== undefined && prev !== curr) {
      diffs.push(`${varName} hash changed (rotation?)`);
    } else if (prev !== undefined && curr === undefined) {
      diffs.push(`${varName} is no longer set`);
    }
  }

  // Node.js version drift
  if (stored.nodeVersion !== current.nodeVersion) {
    diffs.push(`Node.js: ${stored.nodeVersion} → ${current.nodeVersion}`);
  }

  // Platform drift (unusual but guard against)
  if (stored.platform !== current.platform) {
    diffs.push(`Platform: ${stored.platform} → ${current.platform}`);
  }

  return diffs;
}
