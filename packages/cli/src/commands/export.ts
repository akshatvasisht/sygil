import chalk from "chalk";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getTemplatesDir(): string {
  return fileURLToPath(new URL("../../templates", import.meta.url));
}

export async function exportCommand(
  templateName: string,
  outputPath: string
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

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (outputDir && outputDir !== ".") {
    await mkdir(outputDir, { recursive: true });
  }

  await writeFile(outputPath, content, "utf8");
  console.log(chalk.green(`✓ Exported ${templateName} → ${outputPath}`));
}
