import chalk from "chalk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WorkflowGraphSchema, zodToJsonSchema } from "@sygil/shared";

const SCHEMA_ID = "https://raw.githubusercontent.com/akshatvasisht/sygil/main/docs/workflow.schema.json";
const SCHEMA_TITLE = "Sygil Workflow Graph";

export function generateWorkflowJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(WorkflowGraphSchema, {
    $id: SCHEMA_ID,
    title: SCHEMA_TITLE,
  });
}

export interface SchemaCommandOptions {
  out?: string;
  check?: boolean;
}

export async function schemaCommand(options: SchemaCommandOptions = {}): Promise<void> {
  const schema = generateWorkflowJsonSchema();
  const serialized = JSON.stringify(schema, null, 2) + "\n";

  if (options.check) {
    if (!options.out) {
      console.error(chalk.red("--check requires --out <path>"));
      process.exit(1);
    }
    const target = resolve(options.out);
    let existing: string;
    try {
      existing = await readFile(target, "utf-8");
    } catch {
      console.error(chalk.red(`Checked-in schema not found at ${target}.`));
      console.error(chalk.dim("Run `sygil schema --out <path>` to generate it."));
      process.exit(1);
    }
    if (existing !== serialized) {
      console.error(chalk.red(`Schema out-of-date at ${target}.`));
      console.error(chalk.dim("Regenerate with `sygil schema --out <path>` and commit the result."));
      process.exit(1);
    }
    console.log(chalk.green(`✓ Schema up-to-date at ${target}`));
    return;
  }

  if (!options.out) {
    process.stdout.write(serialized);
    return;
  }

  const target = resolve(options.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, "utf-8");
  console.log(chalk.green(`✓ Wrote ${target}`));
}
