import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { WorkflowGraphSchema, type WorkflowGraph } from "@sygil/shared";
import { validateWorkflowInvariants } from "../utils/workflow.js";

export async function validateCommand(workflowPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(workflowPath, "utf8");
  } catch (err) {
    console.error(
      chalk.red(
        `Cannot read workflow file "${workflowPath}": ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(
      chalk.red(
        `Workflow file "${workflowPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
    return;
  }

  const result = WorkflowGraphSchema.safeParse(json);
  if (!result.success) {
    console.error(chalk.red("Workflow validation failed:"));
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "(root)";
      console.error(`• ${path}: ${issue.message}`);
    }
    process.exit(1);
    return;
  }

  // Run the same post-schema invariants that loadWorkflow + the `sygil run -`
  // stdin path enforce (tools allowlist, ReDoS heuristic). Without this,
  // `sygil validate` would give false confidence: a workflow passes here but
  // fails on `sygil run` with a confusing "validation failed at load time"
  // error after the user thinks they've already validated.
  try {
    validateWorkflowInvariants(result.data as WorkflowGraph);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
    return;
  }

  const nodeCount = Object.keys(result.data.nodes).length;
  const edgeCount = result.data.edges.length;
  console.log(chalk.green(`✓ Valid — ${nodeCount} nodes, ${edgeCount} edges`));
  process.exit(0);
}
