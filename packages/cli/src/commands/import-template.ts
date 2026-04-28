import chalk from "chalk";
import { readFile, writeFile, mkdir, access, unlink, rm, copyFile, readdir } from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { loadWorkflow } from "../utils/workflow.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { listUserTemplates, USER_TEMPLATES_DIR, validateTemplateUrl } from "../utils/registry.js";
import {
  readBundleManifest,
  extractBundle,
  isTarball,
  isBundleDir,
  MANIFEST_FILENAME,
} from "./bundle.js";

/**
 * Determines how the argument should be resolved:
 *  1. URL (starts with http:// or https://)
 *  2. File path (contains path separators or ends in .json)
 *  3. Template name (bare name, check ~/.sygil/templates/<name>.json)
 */
function classifyArg(arg: string): "url" | "file" | "name" {
  if (arg.startsWith("http://") || arg.startsWith("https://")) return "url";
  if (arg.includes("/") || arg.includes("\\") || arg.endsWith(".json")) return "file";
  return "name";
}

async function fetchOrRead(urlOrPath: string): Promise<string> {
  // Check if it's a URL
  if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
    // Scheme allowlist parity with utils/registry.ts. Without this, exotic
    // schemes (file://, gopher://, ftp://) embedded after a startsWith match
    // would surface as opaque fetch errors. The startsWith check above already
    // gates the obvious cases; this defends against URLs whose tail re-parses
    // to a different scheme via `new URL()`.
    validateTemplateUrl(urlOrPath);
    // 10s timeout — without an AbortSignal, a hung remote would block the
    // import-template command indefinitely with no user feedback. Matches the
    // `installTemplate` helper in utils/registry.ts.
    const res = await fetch(urlOrPath, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch "${urlOrPath}": HTTP ${res.status}`);
    }
    return res.text();
  }
  // Local file
  return readFile(urlOrPath, "utf8");
}

async function resolveArg(arg: string): Promise<{ content: string; resolvedPath: string }> {
  const kind = classifyArg(arg);

  if (kind === "url") {
    const content = await fetchOrRead(arg);
    return { content, resolvedPath: arg };
  }

  if (kind === "file") {
    const content = await fetchOrRead(arg);
    return { content, resolvedPath: arg };
  }

  // kind === "name" — check ~/.sygil/templates/<name>.json
  const userTemplatesDir = USER_TEMPLATES_DIR();
  const candidatePath = join(userTemplatesDir, `${arg}.json`);
  try {
    await access(candidatePath);
    const content = await readFile(candidatePath, "utf8");
    return { content, resolvedPath: candidatePath };
  } catch {
    // Not found — list available templates for a helpful error
    const available = await listUserTemplates(userTemplatesDir);
    const names = available.map(t => t.name);
    const hint =
      names.length > 0
        ? `\nAvailable user templates: ${names.join(", ")}`
        : "\nNo user templates installed. Run 'sygil registry install <name>' to install one.";
    throw new Error(
      `Template '${arg}' not found as a URL, file path, or installed template.${hint}`
    );
  }
}

function deriveTemplateName(urlOrPath: string): string {
  const base = basename(urlOrPath);
  // Strip .tar.gz or .json extension for the name
  if (base.endsWith(".tar.gz")) return base.slice(0, -".tar.gz".length);
  if (base.endsWith(".json")) return base.slice(0, -5);
  return base;
}

// ---------------------------------------------------------------------------
// Bundle import path
// ---------------------------------------------------------------------------

async function importBundle(sourcePath: string): Promise<void> {
  const userTemplatesDir = join(homedir(), ".sygil", "templates");

  // If it's a tarball, extract to a tmp dir first
  let bundleDir: string;
  let tempExtractDir: string | null = null;

  if (isTarball(sourcePath)) {
    tempExtractDir = join(tmpdir(), `sygil-bundle-${Date.now()}`);
    await mkdir(tempExtractDir, { recursive: true });
    try {
      await extractBundle(sourcePath, tempExtractDir);
    } catch (err) {
      await rm(tempExtractDir, { recursive: true, force: true });
      console.error(
        chalk.red(
          `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exit(1);
    }
    bundleDir = tempExtractDir;
  } else {
    bundleDir = sourcePath;
  }

  // Read and validate manifest
  let manifest;
  try {
    manifest = await readBundleManifest(bundleDir);
  } catch (err) {
    if (tempExtractDir) await rm(tempExtractDir, { recursive: true, force: true });
    console.error(
      chalk.red(
        `Invalid bundle: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
    return;
  }

  // Validate the workflow inside the bundle
  const workflowFile = join(bundleDir, manifest.workflow);
  let workflowContent: string;
  try {
    workflowContent = await readFile(workflowFile, "utf8");
  } catch (err) {
    if (tempExtractDir) await rm(tempExtractDir, { recursive: true, force: true });
    console.error(
      chalk.red(
        `Bundle workflow file "${manifest.workflow}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
    return;
  }

  const tempJson = join(tmpdir(), `sygil-import-bundle-${Date.now()}.json`);
  await writeFile(tempJson, workflowContent, "utf8");
  let workflow;
  try {
    workflow = await loadWorkflow(tempJson);
  } catch (err) {
    if (tempExtractDir) await rm(tempExtractDir, { recursive: true, force: true });
    console.error(
      chalk.red(`Bundle workflow validation failed:\n${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
    return;
  } finally {
    await unlink(tempJson).catch(() => undefined);
  }

  // Determine install name
  const rawName = workflow.name ?? deriveTemplateName(sourcePath);
  const templateName = rawName.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  if (templateName !== rawName) {
    console.error(
      chalk.red(
        `Bundle name "${rawName}" contains invalid characters and was sanitized to "${templateName}".`,
      ),
    );
  }

  const destDir = join(userTemplatesDir, templateName);
  // Defense-in-depth containment check, mirroring `installTemplate` in
  // utils/registry.ts. The denylist sanitization above strips `/`, `\`, and
  // `..` so escape vectors aren't reachable on POSIX, but post-join verify
  // keeps parity with the registry path and guards against future regex
  // weakening.
  const resolvedDest = resolve(destDir);
  const resolvedBase = resolve(userTemplatesDir) + sep;
  if (!resolvedDest.startsWith(resolvedBase)) {
    if (tempExtractDir) await rm(tempExtractDir, { recursive: true, force: true });
    console.error(chalk.red(`Bundle name "${templateName}" resolves outside the templates directory`));
    process.exit(1);
    return;
  }
  await mkdir(destDir, { recursive: true });

  // Copy all files from bundleDir into destDir (preserving structure)
  await copyDirContents(bundleDir, destDir);

  if (tempExtractDir) {
    await rm(tempExtractDir, { recursive: true, force: true });
  }

  // Print summary
  console.log(chalk.green(`✓ Imported bundle "${templateName}" → ${destDir}/`));
  console.log(chalk.dim(`  Required adapters: ${manifest.adapters.join(", ")}`));
  if (manifest.envVars && manifest.envVars.length > 0) {
    console.log(chalk.dim(`  Required env vars: ${manifest.envVars.join(", ")}`));
  }
  console.log(
    chalk.dim(
      `  Run: sygil run ${join(destDir, manifest.workflow)} "your task here"`,
    ),
  );

  // Pre-flight adapter availability warnings
  warnMissingAdapters(manifest.adapters);
}

async function copyDirContents(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDirContents(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

function warnMissingAdapters(adapters: string[]): void {
  // We check adapter availability by looking for known CLI binaries
  const adapterBinaries: Record<string, string> = {
    "claude-cli": "claude",
    "claude-sdk": "claude",
    codex: "codex",
    cursor: "agent",
    "gemini-cli": "gemini",
    "local-oai": "curl", // local-oai doesn't have a single binary
    echo: "node",
  };

  for (const adapter of adapters) {
    const bin = adapterBinaries[adapter];
    if (!bin) continue;
    try {
      execSync(`which ${bin}`, { stdio: "ignore" });
    } catch {
      console.warn(
        chalk.yellow(
          `  ⚠  Adapter "${adapter}" may not be available (binary "${bin}" not found in PATH).`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function importTemplateCommand(urlOrPath: string): Promise<void> {
  // Check if this is a bundle (tarball or directory with manifest)
  if (isTarball(urlOrPath)) {
    await importBundle(urlOrPath);
    return;
  }

  // Check if it's a directory with a sygil-manifest.json
  try {
    if (await isBundleDir(urlOrPath)) {
      await importBundle(urlOrPath);
      return;
    }
  } catch {
    // Not a directory — fall through to single-file import
  }

  // Single-file (legacy) path
  // Resolve content via priority order: URL → file path → installed template name
  let resolved: { content: string; resolvedPath: string };
  try {
    resolved = await resolveArg(urlOrPath);
  } catch (err) {
    console.error(
      chalk.red(`Failed to read "${urlOrPath}": ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
    return; // unreachable, but satisfies TypeScript
  }

  const { content, resolvedPath } = resolved;

  // Write to a temp file and validate via loadWorkflow
  const tempFile = join(tmpdir(), `sygil-import-${Date.now()}.json`);
  await writeFile(tempFile, content, "utf8");

  let workflow;
  try {
    workflow = await loadWorkflow(tempFile);
  } catch (err) {
    console.error(
      chalk.red(`Validation failed:\n${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
    return; // unreachable, but satisfies TypeScript
  } finally {
    // Always clean up temp file — don't accumulate /tmp garbage
    await unlink(tempFile).catch(() => undefined);
  }

  // Save to ~/.sygil/templates/<safe-name>.json
  // Sanitize workflow.name to prevent path traversal — strip path separators
  // and reject any name containing '..' segments.
  const rawName = workflow.name ?? deriveTemplateName(resolvedPath);
  const templateName = rawName.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  if (templateName !== rawName) {
    console.error(chalk.red(`Template name "${rawName}" contains invalid characters and was sanitized to "${templateName}".`));
  }
  const userTemplatesDir = join(homedir(), ".sygil", "templates");
  await mkdir(userTemplatesDir, { recursive: true });

  const destPath = join(userTemplatesDir, `${templateName}.json`);
  // Defense-in-depth: same parity check as the bundle path above.
  const resolvedDest = resolve(destPath);
  const resolvedBase = resolve(userTemplatesDir) + sep;
  if (!resolvedDest.startsWith(resolvedBase)) {
    console.error(chalk.red(`Template name "${templateName}" resolves outside the templates directory`));
    process.exit(1);
    return;
  }
  await writeFileAtomic(destPath, content);

  console.log(chalk.green(`✓ Imported template "${templateName}" → ${destPath}`));
}
