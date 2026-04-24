import chalk from "chalk";
import { loadWorkflow } from "../utils/workflow.js";
import { WorkflowGraphSchema } from "@sygil/shared";

export async function validateCommand(workflowPath: string): Promise<void> {
  let loaded: unknown;
  try {
    // loadWorkflow parses JSON and validates against WorkflowGraphSchema.
    // We re-validate below for richer Zod issue reporting.
    loaded = await loadWorkflow(workflowPath);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
    return;
  }

  const result = WorkflowGraphSchema.safeParse(loaded);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "(root)";
      console.error(`• ${path}: ${issue.message}`);
    }
    process.exit(1);
    return;
  }

  const nodeCount = Object.keys(result.data.nodes).length;
  const edgeCount = result.data.edges.length;
  console.log(chalk.green(`✓ Valid — ${nodeCount} nodes, ${edgeCount} edges`));
  process.exit(0);
}
