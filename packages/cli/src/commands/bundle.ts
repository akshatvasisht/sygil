/**
 * Bundle helpers: create and extract Sygil workflow bundles.
 *
 * A bundle is a directory (or .tar.gz archive) containing:
 *   sygil-manifest.json      – SygilManifest metadata
 *   workflow.json            – the workflow graph
 *   gates/<script>.sh        – (optional) referenced gate scripts
 *   specs/<file>.md          – (optional) referenced spec_compliance specs
 *
 * These helpers are shared between `export --bundle` and `import-template`.
 */

import { readFile, writeFile, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve as pathResolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { WorkflowGraph } from "@sygil/shared";
import { SygilManifestSchema } from "@sygil/shared";
import type { SygilManifest } from "@sygil/shared";
import { isContainedIn } from "../gates/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { logger } from "../utils/logger.js";

/** Filename used for the manifest inside a bundle directory. */
export const MANIFEST_FILENAME = "sygil-manifest.json";

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

export async function readBundleManifest(bundleDir: string): Promise<SygilManifest> {
  const manifestPath = join(bundleDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`No ${MANIFEST_FILENAME} found in "${bundleDir}" — not a Sygil bundle.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${MANIFEST_FILENAME} in "${bundleDir}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = SygilManifestSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const msg = first ? `${first.path.join(".")}: ${first.message}` : result.error.message;
    throw new Error(`${MANIFEST_FILENAME} failed schema validation: ${msg}`);
  }
  return result.data;
}

export async function writeBundleManifest(bundleDir: string, manifest: SygilManifest): Promise<void> {
  await mkdir(bundleDir, { recursive: true });
  const manifestPath = join(bundleDir, MANIFEST_FILENAME);
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Asset discovery: walk gates/specs from a workflow graph
// ---------------------------------------------------------------------------

export interface BundleAssets {
  /** Resolved absolute paths of gate scripts. */
  gates: Array<{ absPath: string; relName: string }>;
  /** Resolved absolute paths of spec files. */
  specs: Array<{ absPath: string; relName: string }>;
}

/**
 * Walk a workflow graph and collect gate script + spec file references.
 * `workingDir` is used to resolve relative paths; `bundledTemplatesDir` is the
 * fallback (same resolution as `resolveGateScriptPath` in gates/index.ts).
 */
export function discoverAssets(
  workflow: WorkflowGraph,
  workingDir: string,
  bundledTemplatesDir: string,
): BundleAssets {
  const gates: BundleAssets["gates"] = [];
  const specs: BundleAssets["specs"] = [];

  for (const edge of workflow.edges) {
    if (!edge.gate) continue;
    for (const cond of edge.gate.conditions) {
      if (cond.type === "script") {
        const abs = resolveAssetPath(cond.path, workingDir, bundledTemplatesDir);
        if (abs !== null) {
          gates.push({ absPath: abs, relName: `gates/${basename(cond.path)}` });
        } else {
          logger.warn(`bundle: gate script "${cond.path}" could not be resolved — skipping.`);
        }
      } else if (cond.type === "spec_compliance") {
        const abs = resolveAssetPath(cond.specPath, workingDir, join(bundledTemplatesDir, "specs"));
        if (abs !== null) {
          specs.push({ absPath: abs, relName: `specs/${basename(cond.specPath)}` });
        } else {
          logger.warn(`bundle: spec file "${cond.specPath}" could not be resolved — skipping.`);
        }
      }
    }
  }
  return { gates, specs };
}

function resolveAssetPath(
  p: string,
  workingDir: string,
  fallbackDir: string,
): string | null {
  // Try absolute first
  if (existsSync(p)) return p;
  // Try relative to workingDir
  const local = pathResolve(workingDir, p);
  if (existsSync(local)) return local;
  // Try fallback (bundled templates dir)
  const bundled = pathResolve(fallbackDir, basename(p));
  if (existsSync(bundled)) return bundled;
  return null;
}

// ---------------------------------------------------------------------------
// Create bundle (directory)
// ---------------------------------------------------------------------------

export interface CreateBundleOptions {
  /** Absolute path to the directory to create. Will be created if absent. */
  outputDir: string;
  /** The WorkflowGraph object (already loaded + validated). */
  workflow: WorkflowGraph;
  /** Serialized workflow.json content. */
  workflowContent: string;
  /** Working dir used for relative path resolution. */
  workingDir: string;
  /** Absolute path to the bundled templates directory inside the CLI package. */
  bundledTemplatesDir: string;
  /** Sygil CLI version string (from package.json). */
  sygilVersion: string;
  /** Include gate scripts (default true). */
  includeGateScripts?: boolean;
  /** Include spec files (default true). */
  includeSpecs?: boolean;
  /** Optional creator attribution string. */
  createdBy?: string;
}

export async function createBundle(opts: CreateBundleOptions): Promise<SygilManifest> {
  const {
    outputDir,
    workflow,
    workflowContent,
    workingDir,
    bundledTemplatesDir,
    sygilVersion,
    includeGateScripts = true,
    includeSpecs = true,
    createdBy,
  } = opts;

  await mkdir(outputDir, { recursive: true });

  // Write workflow.json
  await writeFileAtomic(join(outputDir, "workflow.json"), workflowContent);

  // Discover assets
  const assets = discoverAssets(workflow, workingDir, bundledTemplatesDir);

  const manifestGates: string[] = [];
  const manifestSpecs: string[] = [];

  if (includeGateScripts && assets.gates.length > 0) {
    const gatesDir = join(outputDir, "gates");
    await mkdir(gatesDir, { recursive: true });
    for (const g of assets.gates) {
      // Path containment check
      if (!isContainedIn(g.absPath, workingDir) && !isContainedIn(g.absPath, bundledTemplatesDir)) {
        logger.warn(`bundle: gate script "${g.absPath}" is outside working dir — skipping.`);
        continue;
      }
      const dest = join(outputDir, g.relName);
      await copyFile(g.absPath, dest);
      manifestGates.push(g.relName);
    }
  }

  if (includeSpecs && assets.specs.length > 0) {
    const specsDir = join(outputDir, "specs");
    await mkdir(specsDir, { recursive: true });
    for (const s of assets.specs) {
      if (!isContainedIn(s.absPath, workingDir) && !isContainedIn(s.absPath, bundledTemplatesDir)) {
        logger.warn(`bundle: spec file "${s.absPath}" is outside working dir — skipping.`);
        continue;
      }
      const dest = join(outputDir, s.relName);
      await copyFile(s.absPath, dest);
      manifestSpecs.push(s.relName);
    }
  }

  // Collect adapter types used by this workflow
  const adapters = [...new Set(Object.values(workflow.nodes).map((n) => n.adapter))];

  const manifest: SygilManifest = {
    sygilVersion,
    workflow: "workflow.json",
    adapters,
    assets: {
      ...(manifestGates.length > 0 ? { gates: manifestGates } : {}),
      ...(manifestSpecs.length > 0 ? { specs: manifestSpecs } : {}),
    },
    createdAt: new Date().toISOString(),
    ...(createdBy !== undefined ? { createdBy } : {}),
  };

  await writeBundleManifest(outputDir, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Create tarball
// ---------------------------------------------------------------------------

export async function createTarball(bundleDir: string, tarballPath: string): Promise<void> {
  // Dynamic import — tar is an approved dep (B.1)
  const tar = await import("tar");
  const tarballDir = dirname(tarballPath);
  await mkdir(tarballDir, { recursive: true });

  // Collect all files in the bundle dir
  const files = await collectRelativeFiles(bundleDir);

  await tar.create(
    {
      gzip: true,
      file: tarballPath,
      cwd: bundleDir,
    },
    files,
  );
}

async function collectRelativeFiles(dir: string, prefix = ""): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = await collectRelativeFiles(join(dir, entry.name), rel);
      results.push(...sub);
    } else {
      results.push(rel);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Extract bundle
// ---------------------------------------------------------------------------

export async function extractBundle(
  source: string,
  destDir: string,
): Promise<void> {
  const tar = await import("tar");
  await mkdir(destDir, { recursive: true });

  await tar.extract({
    file: source,
    cwd: destDir,
    // Built-in path traversal defense in tar@7.x
    strip: 0,
  });

  // Post-extract path containment check
  await verifyExtractedPaths(destDir);
}

async function verifyExtractedPaths(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (!isContainedIn(abs, dir)) {
      throw new Error(
        `Tarball extraction produced a path outside the destination: "${abs}" — aborting.`,
      );
    }
    if (entry.isDirectory()) {
      await verifyExtractedPaths(abs);
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle detection helpers
// ---------------------------------------------------------------------------

/** Returns true if the path points to a tarball (.tar.gz). */
export function isTarball(p: string): boolean {
  return p.endsWith(".tar.gz");
}

/** Returns true if the directory contains a sygil-manifest.json. */
export async function isBundleDir(p: string): Promise<boolean> {
  try {
    await stat(join(p, MANIFEST_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Derive a deterministic short hash for environment snapshot use
// ---------------------------------------------------------------------------
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
