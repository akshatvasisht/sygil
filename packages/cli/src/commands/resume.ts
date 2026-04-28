import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ora from "ora";
import { loadWorkflow } from "../utils/workflow.js";
import { readConfigSafe } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { buildSchedulerContext } from "./_scheduler-bootstrap.js";
import { pruneWorktrees } from "../worktree/index.js";
import { getAdapter } from "../adapters/index.js";
import { buildEnvironmentSnapshot, diffEnvironment } from "../scheduler/environment.js";
import { isContainedIn } from "../gates/index.js";
import type { WorkflowRunState, AgentEvent } from "@sygil/shared";
import { WorkflowRunStateSchema } from "@sygil/shared";

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

export async function resumeCommand(runId: string, options: { checkDrift?: boolean } = {}): Promise<void> {
  // Reject runIds with path-traversal characters before constructing any path.
  // Mirror of `replay.ts`'s guard — without this, `sygil resume "../../etc/passwd"`
  // probes for `<configDir>/runs/../../etc/passwd.json` and the differential error
  // ("file not found" vs "JSON parse failure") leaks file existence.
  if (!RUN_ID_RE.test(runId)) {
    console.error(chalk.red(`Invalid runId "${runId}": must be alphanumeric/_/-`));
    process.exit(1);
  }

  // Reap orphan `.git/worktrees/` entries from prior SIGINT'd runs.
  // Cheap, idempotent, and silent on non-git directories.
  await pruneWorktrees();

  const spinner = ora(`Loading run ${chalk.cyan(runId)}...`).start();

  // Load the persisted run state
  const configDir = process.env["SYGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sygil");
  const runsRoot = join(configDir, "runs");
  const stateFile = join(runsRoot, `${runId}.json`);
  if (!isContainedIn(stateFile, runsRoot)) {
    spinner.fail(`Invalid runId "${runId}": resolved path escapes the runs directory`);
    process.exit(1);
  }
  let state: WorkflowRunState;

  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    spinner.fail(`Could not load run state from ${stateFile}`);
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    spinner.fail(
      `Checkpoint at ${stateFile} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const parseResult = WorkflowRunStateSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const issueMsg = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : parseResult.error.message;
    spinner.fail(
      `Checkpoint at ${stateFile} is corrupt or from an incompatible version: ${issueMsg}`,
    );
    process.exit(1);
  }
  state = parseResult.data as WorkflowRunState;
  spinner.succeed(`Loaded run: ${chalk.cyan(state.workflowName)} (${state.status})`);

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
      join(process.cwd(), ".sygil", "runs", `${runId}.workflow.json`),
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

  // Resolve static model tiers against the current project config
  // so resumed runs see the same override logic the original run used.
  const tierConfig = await readConfigSafe(process.env["SYGIL_CONFIG_DIR"]);
  workflow = resolveModelTiersAndLog(workflow, tierConfig?.tiers);

  // Drift detection (opt-in via --check-drift). When the flag is set and the
  // checkpoint stored an environment snapshot, refuse to resume on any
  // version/key/platform delta. Default behavior is to proceed silently —
  // most resumes are routine ("agent crashed, run again") and treating any
  // version bump as a hard block was too noisy in practice.
  if (options.checkDrift && state.environment) {
    let drift: string[] = [];
    try {
      const currentEnv = await buildEnvironmentSnapshot(workflow, getAdapter);
      drift = diffEnvironment(state.environment, currentEnv);
    } catch {
      // Drift check failure must not block resume
    }
    if (drift.length > 0) {
      console.warn(chalk.yellow("Environment drift detected:"));
      for (const d of drift) console.warn(`  • ${d}`);
      console.warn(chalk.dim("Drop --check-drift to proceed without the check."));
      process.exit(1);
    }
  }

  // Build scheduler context (monitor + scheduler) via the shared bootstrap.
  const ctx = await buildSchedulerContext({
    workflow,
    ...(tierConfig?.hooks !== undefined ? { hooks: tierConfig.hooks } : {}),
  });
  const { scheduler } = ctx;
  if (ctx.monitorPort !== null) {
    console.log(
      chalk.dim(`WebSocket monitor running on `) +
        chalk.cyan(`ws://localhost:${ctx.monitorPort}\n`),
    );
  }

  scheduler.on("node_start", (nodeId: string) => {
    console.log(chalk.cyan(`  ${nodeId} starting...`));
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
    const resumeOpts = tierConfig?.hooks !== undefined ? { hooks: tierConfig.hooks } : {};
    const result = await scheduler.resume(state, resumeOpts);

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
    await ctx.teardown();
  }
}
