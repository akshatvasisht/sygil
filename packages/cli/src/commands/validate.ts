import chalk from "chalk";
import { loadWorkflow } from "../utils/workflow.js";

export async function validateCommand(workflowPath: string): Promise<void> {
  try {
    const workflow = await loadWorkflow(workflowPath);

    // Validate node timeout configuration
    for (const [nodeId, nodeConfig] of Object.entries(workflow.nodes)) {
      if (nodeConfig.timeoutMs != null && nodeConfig.timeoutMs <= 0) {
        throw new Error(`Node "${nodeId}" has invalid timeoutMs: ${nodeConfig.timeoutMs} (must be positive)`);
      }
      if (nodeConfig.idleTimeoutMs != null && nodeConfig.idleTimeoutMs <= 0) {
        throw new Error(`Node "${nodeId}" has invalid idleTimeoutMs: ${nodeConfig.idleTimeoutMs} (must be positive)`);
      }
    }

    // Validate edge maxRetries configuration
    for (const edge of workflow.edges) {
      if (edge.maxRetries != null && edge.maxRetries < 0) {
        throw new Error(`Edge "${edge.id}" has invalid maxRetries: ${edge.maxRetries} (must be non-negative)`);
      }
    }

    const nodeCount = Object.keys(workflow.nodes).length;
    const edgeCount = workflow.edges.length;
    console.log(chalk.green(`✓ Valid — ${nodeCount} nodes, ${edgeCount} edges`));
    process.exit(0);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
