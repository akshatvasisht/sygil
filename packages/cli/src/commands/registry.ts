import { Command } from "commander";
import chalk from "chalk";
import {
  fetchRegistryIndex,
  searchTemplates,
  installTemplate,
  listUserTemplates,
  USER_TEMPLATES_DIR,
  type RegistryEntry,
} from "../utils/registry.js";

function formatTemplateRow(entry: RegistryEntry): void {
  const name = entry.name.padEnd(20);
  const desc = entry.description.padEnd(24);
  const adapters = entry.adapterRequirements.join(", ").padEnd(20);
  const stars = entry.stars !== undefined ? chalk.yellow(`★ ${entry.stars}`) : "";
  console.log(`  ${chalk.bold(name)} ${chalk.dim(desc)} ${chalk.cyan(adapters)} ${stars}`);
}

async function handleNetworkError(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("fetch") ||
      message.includes("network") ||
      message.includes("ENOTFOUND") ||
      message.includes("ECONNREFUSED") ||
      message.includes("abort") ||
      message.includes("Registry fetch failed") ||
      message.includes("Could not reach")
    ) {
      console.error(chalk.red("Could not reach template registry. Check your connection."));
    } else {
      console.error(chalk.red(message));
    }
    process.exit(1);
  }
}

const listSubCommand = new Command("list")
  .description("List all templates in the registry")
  .action(() =>
    handleNetworkError(async () => {
      const index = await fetchRegistryIndex();
      console.log(chalk.bold("\nAvailable templates (registry.sigil.dev)\n"));
      if (index.templates.length === 0) {
        console.log(chalk.dim("  No templates found in registry."));
        return;
      }
      for (const entry of index.templates) {
        formatTemplateRow(entry);
      }
      console.log("");
    })
  );

const searchSubCommand = new Command("search")
  .description("Search templates by name, description, or tags")
  .argument("<query>", "Search query")
  .action((query: string) =>
    handleNetworkError(async () => {
      const index = await fetchRegistryIndex();
      const results = searchTemplates(index, query);
      if (results.length === 0) {
        console.log(chalk.yellow(`No templates found matching '${query}'.`));
        return;
      }
      console.log(chalk.bold(`\nTemplates matching '${query}'\n`));
      for (const entry of results) {
        formatTemplateRow(entry);
      }
      console.log("");
    })
  );

const installSubCommand = new Command("install")
  .description("Download and install a template from the registry")
  .argument("<name>", "Template name to install")
  .action((name: string) =>
    handleNetworkError(async () => {
      const index = await fetchRegistryIndex();
      const entry = index.templates.find(t => t.name === name);
      if (!entry) {
        console.error(chalk.red(`Template '${name}' not found in registry.`));
        console.log(chalk.dim("Run 'sigil registry list' to see available templates."));
        process.exit(1);
      }

      // Download and validate JSON structure
      const res = await fetch(entry.url);
      if (!res.ok) {
        throw new Error(`Failed to download template: ${res.status}`);
      }
      const json = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        console.error(chalk.red(`Template '${name}' contains invalid JSON.`));
        process.exit(1);
      }

      const obj = parsed as Record<string, unknown>;
      if (!obj["name"] || !obj["nodes"] || !obj["edges"]) {
        console.error(
          chalk.red(
            `Template '${name}' is missing required fields (name, nodes, edges).`
          )
        );
        process.exit(1);
      }

      const destDir = USER_TEMPLATES_DIR();
      const destPath = await installTemplate(entry, destDir);

      console.log(chalk.green(`✓ Installed template '${name}' → ${destPath}`));
      console.log(
        chalk.dim(`Run 'sigil export ${name} ./workflow.json' to use it`)
      );
    })
  );

export const registryCommand = new Command("registry")
  .description("Browse and install templates from the Sigil registry")
  .addCommand(listSubCommand)
  .addCommand(searchSubCommand)
  .addCommand(installSubCommand);
