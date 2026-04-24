/**
 * Tests for bundle.ts — roundtrip create/extract of Sygil workflow bundles.
 *
 * Uses real filesystem via tmpdir so we exercise the actual tar + path-containment
 * logic, not mocks. This mirrors the integration-test pattern (no mocking FS).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkflowGraph } from "@sygil/shared";
import { SygilManifestSchema } from "@sygil/shared";
import {
  createBundle,
  createTarball,
  extractBundle,
  readBundleManifest,
  writeBundleManifest,
  isTarball,
  isBundleDir,
  MANIFEST_FILENAME,
} from "./bundle.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_WORKFLOW: WorkflowGraph = {
  version: "1",
  name: "test-bundle",
  nodes: {
    nodeA: {
      adapter: "echo",
      model: "test",
      role: "agent",
      prompt: "do the thing",
    },
  },
  edges: [],
};

const FIXTURE_WORKFLOW_WITH_GATE: WorkflowGraph = {
  version: "1",
  name: "test-bundle-with-gate",
  nodes: {
    nodeA: {
      adapter: "echo",
      model: "test",
      role: "agent",
      prompt: "do the thing",
    },
    nodeB: {
      adapter: "echo",
      model: "test",
      role: "reviewer",
      prompt: "review",
    },
  },
  edges: [
    {
      id: "e1",
      from: "nodeA",
      to: "nodeB",
      gate: {
        conditions: [{ type: "script", path: "gates/check-test.sh" }],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sygil-bundle-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

describe("readBundleManifest / writeBundleManifest", () => {
  it("roundtrips a valid manifest", async () => {
    const bundleDir = join(tmpDir, "manifest-test");
    await mkdir(bundleDir, { recursive: true });

    const manifest = {
      sygilVersion: "^0.1",
      workflow: "workflow.json",
      adapters: ["echo"],
      assets: {},
      createdAt: new Date().toISOString(),
    };
    await writeBundleManifest(bundleDir, manifest);
    const read = await readBundleManifest(bundleDir);
    expect(read).toMatchObject(manifest);
  });

  it("throws when no manifest file is present", async () => {
    const bundleDir = join(tmpDir, "no-manifest");
    await mkdir(bundleDir, { recursive: true });

    await expect(readBundleManifest(bundleDir)).rejects.toThrow(
      "not a Sygil bundle",
    );
  });

  it("throws when manifest is invalid JSON", async () => {
    const bundleDir = join(tmpDir, "bad-json");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, MANIFEST_FILENAME), "not-json", "utf8");

    await expect(readBundleManifest(bundleDir)).rejects.toThrow("not valid JSON");
  });

  it("throws when manifest fails schema validation", async () => {
    const bundleDir = join(tmpDir, "bad-schema");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, MANIFEST_FILENAME),
      JSON.stringify({ foo: "bar" }),
      "utf8",
    );

    await expect(readBundleManifest(bundleDir)).rejects.toThrow(
      "schema validation",
    );
  });
});

// ---------------------------------------------------------------------------
// isTarball / isBundleDir
// ---------------------------------------------------------------------------

describe("isTarball", () => {
  it("returns true for .tar.gz paths", () => {
    expect(isTarball("/path/to/bundle.tar.gz")).toBe(true);
    expect(isTarball("bundle.tar.gz")).toBe(true);
  });

  it("returns false for non-tarball paths", () => {
    expect(isTarball("/path/to/bundle")).toBe(false);
    expect(isTarball("workflow.json")).toBe(false);
  });
});

describe("isBundleDir", () => {
  it("returns true when directory contains sygil-manifest.json", async () => {
    const bundleDir = join(tmpDir, "with-manifest");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, MANIFEST_FILENAME),
      JSON.stringify({
        sygilVersion: "^0.1",
        workflow: "workflow.json",
        adapters: [],
        assets: {},
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    expect(await isBundleDir(bundleDir)).toBe(true);
  });

  it("returns false when directory does not contain manifest", async () => {
    const bundleDir = join(tmpDir, "no-manifest-dir");
    await mkdir(bundleDir, { recursive: true });
    expect(await isBundleDir(bundleDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createBundle (directory only)
// ---------------------------------------------------------------------------

describe("createBundle", () => {
  it("creates workflow.json + sygil-manifest.json in outputDir", async () => {
    const outputDir = join(tmpDir, "output-bundle");
    const workflowContent = JSON.stringify(FIXTURE_WORKFLOW, null, 2);

    const manifest = await createBundle({
      outputDir,
      workflow: FIXTURE_WORKFLOW,
      workflowContent,
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
    });

    // Validate manifest structure
    const parsed = SygilManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    expect(manifest.adapters).toContain("echo");
    expect(manifest.workflow).toBe("workflow.json");

    // Files must exist
    await expect(access(join(outputDir, "workflow.json"))).resolves.toBeUndefined();
    await expect(access(join(outputDir, MANIFEST_FILENAME))).resolves.toBeUndefined();

    // Manifest on disk should round-trip
    const onDisk = await readBundleManifest(outputDir);
    expect(onDisk.adapters).toContain("echo");
  });

  it("copies gate scripts into gates/ subdirectory when includeGateScripts is true", async () => {
    // Create a fixture gate script
    const gatesDir = join(tmpDir, "gates");
    await mkdir(gatesDir, { recursive: true });
    const scriptPath = join(gatesDir, "check-test.sh");
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");

    const outputDir = join(tmpDir, "output-with-gate");
    const workflowContent = JSON.stringify(FIXTURE_WORKFLOW_WITH_GATE, null, 2);

    const manifest = await createBundle({
      outputDir,
      workflow: FIXTURE_WORKFLOW_WITH_GATE,
      workflowContent,
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
      includeGateScripts: true,
    });

    expect(manifest.assets.gates).toBeDefined();
    expect(manifest.assets.gates!.length).toBeGreaterThan(0);
    await expect(access(join(outputDir, "gates", "check-test.sh"))).resolves.toBeUndefined();
  });

  it("does not create gates/ dir when includeGateScripts is false", async () => {
    const outputDir = join(tmpDir, "output-no-gates");
    const workflowContent = JSON.stringify(FIXTURE_WORKFLOW_WITH_GATE, null, 2);

    const manifest = await createBundle({
      outputDir,
      workflow: FIXTURE_WORKFLOW_WITH_GATE,
      workflowContent,
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
      includeGateScripts: false,
    });

    // No gates in manifest assets
    expect(manifest.assets.gates).toBeUndefined();
  });

  it("deduplicates adapter types in the manifest", async () => {
    const multiNodeWorkflow: WorkflowGraph = {
      ...FIXTURE_WORKFLOW,
      nodes: {
        n1: { adapter: "echo", model: "m", role: "a", prompt: "p" },
        n2: { adapter: "echo", model: "m", role: "b", prompt: "q" },
      },
    };

    const outputDir = join(tmpDir, "output-dedup");
    const manifest = await createBundle({
      outputDir,
      workflow: multiNodeWorkflow,
      workflowContent: JSON.stringify(multiNodeWorkflow),
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
    });

    // Should deduplicate "echo" → only appears once
    expect(manifest.adapters).toHaveLength(1);
    expect(manifest.adapters[0]).toBe("echo");
  });
});

// ---------------------------------------------------------------------------
// createTarball + extractBundle roundtrip
// ---------------------------------------------------------------------------

describe("createTarball + extractBundle roundtrip", () => {
  it("creates a .tar.gz and extracts it to a destination directory", async () => {
    // First create a bundle dir
    const bundleDir = join(tmpDir, "roundtrip-src");
    const workflowContent = JSON.stringify(FIXTURE_WORKFLOW, null, 2);
    await createBundle({
      outputDir: bundleDir,
      workflow: FIXTURE_WORKFLOW,
      workflowContent,
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
    });

    // Create tarball
    const tarballPath = join(tmpDir, "roundtrip.tar.gz");
    await createTarball(bundleDir, tarballPath);
    await expect(access(tarballPath)).resolves.toBeUndefined();

    // Extract to a new dir
    const extractDir = join(tmpDir, "roundtrip-dest");
    await mkdir(extractDir, { recursive: true });
    await extractBundle(tarballPath, extractDir);

    // Files should be present
    await expect(access(join(extractDir, "workflow.json"))).resolves.toBeUndefined();
    await expect(access(join(extractDir, MANIFEST_FILENAME))).resolves.toBeUndefined();

    // Manifest should be parseable
    const manifest = await readBundleManifest(extractDir);
    expect(manifest.adapters).toContain("echo");
  });

  it("preserves file contents through the tarball roundtrip", async () => {
    const bundleDir = join(tmpDir, "content-roundtrip-src");
    const workflowContent = JSON.stringify(FIXTURE_WORKFLOW, null, 2);
    await createBundle({
      outputDir: bundleDir,
      workflow: FIXTURE_WORKFLOW,
      workflowContent,
      workingDir: tmpDir,
      bundledTemplatesDir: tmpDir,
      sygilVersion: "0.1.0",
    });

    const tarballPath = join(tmpDir, "content-roundtrip.tar.gz");
    await createTarball(bundleDir, tarballPath);

    const extractDir = join(tmpDir, "content-roundtrip-dest");
    await mkdir(extractDir, { recursive: true });
    await extractBundle(tarballPath, extractDir);

    const extracted = await readFile(join(extractDir, "workflow.json"), "utf8");
    const parsed = JSON.parse(extracted) as WorkflowGraph;
    expect(parsed.name).toBe("test-bundle");
    expect(Object.keys(parsed.nodes)).toContain("nodeA");
  });
});
