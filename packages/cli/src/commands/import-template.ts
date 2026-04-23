import chalk from "chalk";
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadWorkflow } from "../utils/workflow.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { listUserTemplates, USER_TEMPLATES_DIR } from "../utils/registry.js";

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
  return base.endsWith(".json") ? base.slice(0, -5) : base;
}

export async function importTemplateCommand(urlOrPath: string): Promise<void> {
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
  await writeFileAtomic(destPath, content);

  console.log(chalk.green(`✓ Imported template "${templateName}" → ${destPath}`));
}
