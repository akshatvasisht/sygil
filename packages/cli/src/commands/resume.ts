import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ora from "ora";
import { loadWorkflow } from "../utils/workflow.js";
import { getAdapter } from "../adapters/index.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import { WsMonitorServer } from "../monitor/websocket.js";
import type { WorkflowRunState, AgentEvent } from "@sigil/shared";

export async function resumeCommand(runId: string): Promise<void> {
  const spinner = ora(`Loading run ${chalk.cyan(runId)}...`).start();

  // Load the persisted run state
  const configDir = process.env["SIGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sigil");
  const stateFile = join(configDir, "runs", `${runId}.json`);
  let state: WorkflowRunState;

  try {
    const raw = await readFile(stateFile, "utf8");
    state = JSON.parse(raw) as WorkflowRunState;
    spinner.succeed(`Loaded run: ${chalk.cyan(state.workflowName)} (${state.status})`);
  } catch {
    spinner.fail(`Could not load run state from ${stateFile}`);
    process.exit(1);
  }

  if (state.status === "completed") {
    console.log(chalk.yellow("This run has already completed — nothing to resume."));
    return;
  }
  if (state.status === "cancelled") {
    console.log(chalk.yellow("This run was cancelled — cannot resume."));
    return;
  }
  if (state.status === "running") {
    console.log(
      chalk.yellow(
        "This run is marked as running — it may have crashed. Resuming from last checkpoint..."
      )
    );
  }

  // Use the workflowPath stored in run state.
  // Fall back to heuristic search when the path is absent (old run states pre-v1.1).
  let workflowPath: string | undefined = state.workflowPath || undefined;

  if (!workflowPath) {
    const workflowSearchPaths = [
      join(process.cwd(), `${state.workflowName}.json`),
      join(process.cwd(), "workflow.json"),
      join(process.cwd(), ".sigil", "runs", `${runId}.workflow.json`),
    ];

    for (const p of workflowSearchPaths) {
      try {
        await readFile(p, "utf8");
        workflowPath = p;
        break;
      } catch {
        // try next
      }
    }

    if (!workflowPath) {
      console.error(
        chalk.red(
          `Could not find the original workflow.json for run "${runId}". ` +
            `Tried:\n${workflowSearchPaths.map((p) => `  - ${p}`).join("\n")}`
        )
      );
      process.exit(1);
    }
  }

  let workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch (err) {
    console.error(
      chalk.red(`Failed to reload workflow: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
  }

  // Start monitor
  const monitor = new WsMonitorServer();
  const port = await monitor.start();
  console.log(
    chalk.dim(`WebSocket monitor running on `) + chalk.cyan(`ws://localhost:${port}\n`)
  );

  // Build scheduler and inject the existing state for resume
  const scheduler = new WorkflowScheduler(workflow, getAdapter, monitor);

  scheduler.on("node_start", (nodeId: string) => {
    console.log(chalk.cyan(`  ▶ ${nodeId} starting...`));
  });

  scheduler.on("node_event", (_nodeId: string, event: AgentEvent) => {
    if (event.type === "text_delta") {
      process.stdout.write(chalk.dim("."));
    }
  });

  scheduler.on("node_end", (nodeId: string, success: boolean) => {
    const icon = success ? chalk.green("✓") : chalk.red("✗");
    console.log(`\n  ${icon} ${nodeId} ${success ? "completed" : "failed"}`);
  });

  try {
    const result = await scheduler.resume(state);

    if (result.success) {
      console.log(
        chalk.bold.green(
          `\nWorkflow resumed and completed in ${(result.durationMs / 1000).toFixed(1)}s`
        )
      );
      if (result.totalCostUsd != null) {
        console.log(chalk.dim(`Total cost: $${result.totalCostUsd.toFixed(4)}`));
      }
    } else {
      console.log(chalk.bold.red("\nWorkflow failed after resume."));
      if (result.error) console.log(chalk.red(result.error));
      process.exit(1);
    }
  } catch (err) {
    console.error(
      chalk.red(`\nError during resume: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
  } finally {
    await monitor.stop();
  }
}
