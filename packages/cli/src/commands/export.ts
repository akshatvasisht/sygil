import chalk from "chalk";
import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowGraphSchema } from "@sygil/shared";

function getTemplatesDir(): string {
  return fileURLToPath(new URL("../../templates", import.meta.url));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function exportCommand(
  templateName: string,
  outputPath: string,
  options: { force?: boolean } = {},
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
