import chalk from "chalk";
import { readdir, readFile, writeFile, mkdir, access, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowGraphSchema } from "@sygil/shared";
import type { WorkflowGraph } from "@sygil/shared";
import {
  createBundle,
  createTarball,
  isTarball,
} from "./bundle.js";

function getTemplatesDir(): string {
  return fileURLToPath(new URL("../../templates", import.meta.url));
}

// CLI package version — read at startup so no sync I/O inside the command
const SYGIL_VERSION = "0.1.0";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ExportOptions {
  force?: boolean;
  bundle?: boolean;
  format?: "dir" | "tarball";
  includeGateScripts?: boolean;
  includeSpecs?: boolean;
}

export async function exportCommand(
  templateName: string,
  outputPath: string,
  options: ExportOptions = {},
): Promise<void> {
  const templatesDir = getTemplatesDir();

  // Find the template file
  const templateFile = join(templatesDir, `${templateName}.json`);

  let content: string;
  try {
    content = await readFile(templateFile, "utf8");
  } catch {
    // Template not found — list available templates
    let available: string[] = [];
    try {
      const files = await readdir(templatesDir);
      available = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      // ignore
    }

    console.error(chalk.red(`Template "${templateName}" not found.`));
    if (available.length > 0) {
      console.error(chalk.dim(`Available templates: ${available.join(", ")}`));
    } else {
      console.error(chalk.dim("No templates found."));
    }
    process.exit(1);
  }

  // Validate the bundled template before writing to the user's disk.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error(
      chalk.red(
        `Bundled template "${templateName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
  const validation = WorkflowGraphSchema.safeParse(parsed);
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    const issueMsg = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : validation.error.message;
    console.error(
      chalk.red(`Bundled template "${templateName}" failed schema validation: ${issueMsg}`),
    );
    process.exit(1);
  }

  const workflow = validation.data as WorkflowGraph;

  // -------------------------------------------------------------------------
  // --bundle mode
  // -------------------------------------------------------------------------
  if (options.bundle) {
    const format = options.format ?? "dir";
    const isForTarball = format === "tarball" || isTarball(outputPath);

    // For tarball: the "output" is <outputPath>.tar.gz (add extension if missing).
    // The bundle dir is a temp directory we clean up afterward.
    const tarballPath = isForTarball
      ? outputPath.endsWith(".tar.gz") ? outputPath : `${outputPath}.tar.gz`
      : null;
    const bundleDir = isForTarball
      ? `${outputPath}.bundle-tmp`
      : outputPath;

    // Refuse to clobber without --force.
    const finalOutput = tarballPath ?? bundleDir;
    if (!options.force && (await fileExists(finalOutput))) {
      console.error(
        chalk.red(`Refusing to overwrite ${finalOutput} (use --force to replace)`),
      );
      process.exit(1);
    }

    // Ensure parent dir exists.
    const parentDir = dirname(finalOutput);
    if (parentDir && parentDir !== ".") {
      await mkdir(parentDir, { recursive: true });
    }

    let manifest;
    try {
      manifest = await createBundle({
        outputDir: bundleDir,
        workflow,
        workflowContent: content,
        workingDir: process.cwd(),
        bundledTemplatesDir: templatesDir,
        sygilVersion: SYGIL_VERSION,
        includeGateScripts: options.includeGateScripts !== false,
        includeSpecs: options.includeSpecs !== false,
      });
    } catch (err) {
      console.error(
        chalk.red(
          `Failed to create bundle: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exit(1);
    }

    if (isForTarball && tarballPath !== null) {
      try {
        await createTarball(bundleDir, tarballPath);
      } catch (err) {
        console.error(
          chalk.red(
            `Failed to create tarball: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      } finally {
        // Always clean up the temp dir
        await rm(bundleDir, { recursive: true, force: true });
      }
      console.log(chalk.green(`✓ Exported ${templateName} bundle → ${tarballPath}`));
      console.log(chalk.dim(`  Adapters required: ${manifest.adapters.join(", ")}`));
      if (manifest.assets.gates?.length) {
        console.log(chalk.dim(`  Gate scripts: ${manifest.assets.gates.join(", ")}`));
      }
    } else {
      // Directory bundle
      console.log(chalk.green(`✓ Exported ${templateName} bundle → ${bundleDir}/`));
      console.log(chalk.dim(`  Adapters required: ${manifest.adapters.join(", ")}`));
      if (manifest.assets.gates?.length) {
        console.log(chalk.dim(`  Gate scripts: ${manifest.assets.gates.join(", ")}`));
      }
      console.log(chalk.dim(`  Run: sygil import-template ${bundleDir}`));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Single-file (legacy) mode
  // -------------------------------------------------------------------------

  // Refuse to clobber without --force.
  if (!options.force && (await fileExists(outputPath))) {
    console.error(
      chalk.red(`Refusing to overwrite ${outputPath} (use --force to replace)`),
    );
    process.exit(1);
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (outputDir && outputDir !== ".") {
    await mkdir(outputDir, { recursive: true });
  }

  await writeFile(outputPath, content, "utf8");
  console.log(chalk.green(`✓ Exported ${templateName} → ${outputPath}`));
}
