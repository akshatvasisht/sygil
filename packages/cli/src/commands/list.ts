import chalk from "chalk";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAdapter } from "../adapters/index.js";
import type { AdapterType, WorkflowRunState } from "@sygil/shared";

const ADAPTER_TYPES: AdapterType[] = ["claude-sdk", "claude-cli", "codex", "cursor"];

export async function listCommand(): Promise<void> {
  console.log(chalk.bold("\nSigil — adapters & recent runs\n"));

  // --- Adapters ---
  console.log(chalk.underline("Adapters"));
  for (const type of ADAPTER_TYPES) {
    const adapter = getAdapter(type);
    const available = await adapter.isAvailable();
    const icon = available ? chalk.green("✓") : chalk.red("✗");
    const name = available ? chalk.green(type) : chalk.dim(type);
    console.log(`  ${icon} ${name}`);
  }

  // --- Templates ---
  console.log(`\n${chalk.underline("Available templates")}`);

  interface TemplateInfo {
    name: string;
    description?: string;
    parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
    source: "bundled" | "user";
  }

  async function scanTemplatesDir(dir: string, source: "bundled" | "user"): Promise<TemplateInfo[]> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const results: TemplateInfo[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(join(dir, file), "utf8");
        const data = JSON.parse(raw) as {
          name?: string;
          description?: string;
          parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
        };
        results.push({
          name: data.name ?? file.replace(/\.json$/, ""),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.parameters !== undefined ? { parameters: data.parameters } : {}),
          source,
        } as TemplateInfo);
      } catch {
        // skip malformed files
      }
    }
    return results;
  }

  const bundledTemplatesDir = fileURLToPath(new URL("../../templates", import.meta.url));
  const userTemplatesDir = join(homedir(), ".sygil", "templates");

  const [bundledTemplates, userTemplates] = await Promise.all([
    scanTemplatesDir(bundledTemplatesDir, "bundled"),
    scanTemplatesDir(userTemplatesDir, "user"),
  ]);

  const allTemplates = [...bundledTemplates, ...userTemplates];

  if (allTemplates.length === 0) {
    console.log(chalk.dim("  No templates found."));
  } else {
    for (const tpl of allTemplates) {
      const sourceTag = tpl.source === "user" ? chalk.dim(" [user]") : "";
      console.log(`  ${chalk.bold(tpl.name)}${sourceTag}`);
      if (tpl.description) {
        console.log(`    ${chalk.dim(tpl.description)}`);
      }
      if (tpl.parameters && Object.keys(tpl.parameters).length > 0) {
        const paramList = Object.entries(tpl.parameters)
          .map(([key, p]) => {
            const req = p.required ? chalk.yellow("*") : "";
            return `${key}${req}:${p.type}`;
          })
          .join(", ");
        console.log(`    ${chalk.dim("params:")} ${paramList}`);
      }
    }
  }

  // --- Recent Runs ---
  console.log(`\n${chalk.underline("Recent runs")}`);

  const configDir = process.env["SYGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sygil");
  const runsDir = join(configDir, "runs");
  let runFiles: string[];
  try {
    runFiles = await readdir(runsDir);
  } catch {
    console.log(chalk.dim("  No runs found (run `sygil run <workflow>` to start one)"));
    return;
  }

  const jsonFiles = runFiles
    .filter((f) => f.endsWith(".json") && !f.endsWith(".workflow.json"))
    .sort()
    .reverse()
    .slice(0, 10); // show last 10

  if (jsonFiles.length === 0) {
    console.log(chalk.dim("  No runs found."));
    return;
  }

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(runsDir, file), "utf8");
      const state = JSON.parse(raw) as WorkflowRunState;

      const statusColor: Record<WorkflowRunState["status"], typeof chalk> = {
        completed: chalk.green,
        failed: chalk.red,
        paused: chalk.yellow,
        running: chalk.cyan,
        cancelled: chalk.dim,
      };
      const colorFn = statusColor[state.status] ?? chalk.white;

      const startedAt = new Date(state.startedAt).toLocaleString();
      const cost =
        state.totalCostUsd > 0 ? chalk.dim(` $${state.totalCostUsd.toFixed(4)}`) : "";

      const shortId = state.id.length > 12 ? state.id.slice(0, 12) + "…" : state.id;
      console.log(
        `  ${colorFn(state.status.padEnd(10))} ` +
          `${chalk.bold(shortId)}  ` +
          `${chalk.cyan(state.workflowName.padEnd(20))} ` +
          `${chalk.dim(startedAt)}${cost}`
      );
    } catch {
      console.log(chalk.dim(`  ${file} (could not parse)`));
    }
  }

  console.log(chalk.dim("\nRun IDs are truncated to 12 characters above. Full run IDs are shown in"));
  console.log(chalk.dim(".sygil/runs/<id>.json filenames; paste the full file name (minus .json) into `sygil resume`."));
  console.log("");
}
