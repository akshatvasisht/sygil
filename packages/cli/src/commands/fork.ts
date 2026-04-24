import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ora from "ora";
import { loadWorkflow, interpolateWorkflow } from "../utils/workflow.js";
import { readConfigSafe } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { buildSchedulerContext } from "./_scheduler-bootstrap.js";
import { pruneWorktrees } from "../worktree/index.js";
import type { WorkflowRunState, AgentEvent, NodeResult } from "@sygil/shared";
import { WorkflowRunStateSchema } from "@sygil/shared";

export interface ForkOptions {
  at?: string;
  param?: string[];
}

/**
 * Branch a run from a checkpoint into a new runId. Mirrors `resume` but
 * constructs a fresh WorkflowRunState (new UUID, reset totals, retained
 * completedNodes prefix) and copies the parent's per-node NDJSON events so
 * downstream consumers see a continuous log.
 *
 * Parameters are NOT inherited from the parent run — resolved params are not
 * persisted in checkpoints today. Authors re-specify every param the workflow
 * requires via `--param key=value`.
 */
export async function forkCommand(parentRunId: string, options: ForkOptions): Promise<void> {
  await pruneWorktrees();

  const spinner = ora(`Loading parent run ${chalk.cyan(parentRunId)}...`).start();

  const configDir = process.env["SYGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sygil");
  const parentStateFile = join(configDir, "runs", `${parentRunId}.json`);
  let raw: string;
  try {
    raw = await readFile(parentStateFile, "utf8");
  } catch {
    spinner.fail(`Could not load parent run state from ${parentStateFile}`);
    process.exit(1);
  }

  let parentJson: unknown;
  try {
    parentJson = JSON.parse(raw);
  } catch (err) {
    spinner.fail(
      `Parent checkpoint at ${parentStateFile} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const parseResult = WorkflowRunStateSchema.safeParse(parentJson);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const issueMsg = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : parseResult.error.message;
    spinner.fail(
      `Parent checkpoint at ${parentStateFile} is corrupt or from an incompatible version: ${issueMsg}`,
    );
    process.exit(1);
  }
  const parent = parseResult.data as WorkflowRunState;
  spinner.succeed(`Loaded parent: ${chalk.cyan(parent.workflowName)} (${parent.completedNodes.length} node(s) completed)`);

  // Resolve `--at <checkpointIndex>` against the parent's completedNodes length.
  // Values above the parent's completed count are clamped so "fork from the end"
  // stays a valid request even when omitted.
  let keep = parent.completedNodes.length;
  if (options.at !== undefined) {
    const parsed = Number.parseInt(options.at, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(chalk.red(`Invalid --at value: "${options.at}" — expected a non-negative integer.`));
      process.exit(1);
    }
    keep = Math.min(parsed, parent.completedNodes.length);
  }

  const retained = parent.completedNodes.slice(0, keep);
  const retainedSet = new Set(retained);
  const retainedResults: Record<string, NodeResult> = {};
  for (const [nodeId, result] of Object.entries(parent.nodeResults)) {
    if (retainedSet.has(nodeId)) {
      retainedResults[nodeId] = result;
    }
  }

  // Parse --param overrides (mirrors run.ts).
  const parameters: Record<string, string> = {};
  if (options.param) {
    for (const pair of options.param) {
      const idx = pair.indexOf("=");
      if (idx === -1) {
        console.error(chalk.red(`Invalid parameter format: "${pair}" — expected key=value`));
        process.exit(1);
      }
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (key) parameters[key] = value;
    }
  }

  // Load the parent's workflow file so we can re-run. Fork v1 does NOT search
  // heuristic paths — parents written after workflowPath was persisted always
  // carry the original path, and pre-workflowPath parents are already too old
  // to safely fork (no way to know which workflow produced them).
  const workflowPath = parent.workflowPath;
  if (!workflowPath) {
    console.error(
      chalk.red(
        `Parent run "${parentRunId}" has no workflowPath — it predates the persisted-path feature and cannot be forked.`,
      ),
    );
    process.exit(1);
  }

  let workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch (err) {
    console.error(
      chalk.red(`Failed to reload workflow: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  // Merge workflow defaults + CLI params, then validate required fields.
  const resolvedParams: Record<string, string> = {};
  if (workflow.parameters) {
    for (const [key, paramDef] of Object.entries(workflow.parameters)) {
      if (paramDef.default != null) {
        resolvedParams[key] = String(paramDef.default);
      }
    }
  }
  for (const [key, value] of Object.entries(parameters)) {
    resolvedParams[key] = value;
  }
  if (workflow.parameters) {
    const missing: string[] = [];
    for (const [key, paramDef] of Object.entries(workflow.parameters)) {
      if (paramDef.required && !(key in resolvedParams)) {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      console.error(
        chalk.red(
          `Missing required parameters: ${missing.join(", ")}\n` +
            `Fork does not inherit params from the parent — supply each via --param key=value.`,
        ),
      );
      process.exit(1);
    }
  }

  try {
    workflow = interpolateWorkflow(workflow, resolvedParams);
  } catch (err) {
    console.error(
      chalk.red(`Parameter interpolation failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  const tierConfig = await readConfigSafe(process.env["SYGIL_CONFIG_DIR"]);
  workflow = resolveModelTiersAndLog(workflow, tierConfig?.tiers);

  // Construct the fresh child state.
  const childRunId = randomUUID();
  const childState: WorkflowRunState = {
    id: childRunId,
    workflowName: parent.workflowName,
    ...(parent.workflowPath !== undefined ? { workflowPath: parent.workflowPath } : {}),
    status: "running",
    startedAt: new Date().toISOString(),
    completedNodes: [...retained],
    nodeResults: retainedResults,
    totalCostUsd: 0,
    retryCounters: {},
    sharedContext: { ...(parent.sharedContext ?? {}) },
    forkedFrom: { runId: parent.id, checkpointIndex: keep },
  };

  // Copy the retained nodes' NDJSON event logs from the parent into the child's
  // run directory so replay of the child sees the same prefix history.
  const parentEventsDir = join(configDir, "runs", parent.id, "events");
  const childEventsDir = join(configDir, "runs", childRunId, "events");
  await mkdir(childEventsDir, { recursive: true });
  try {
    const entries = await readdir(parentEventsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ndjson")) continue;
      const nodeId = entry.slice(0, -".ndjson".length);
      if (!retainedSet.has(nodeId)) continue;
      await copyFile(join(parentEventsDir, entry), join(childEventsDir, entry));
    }
  } catch {
    // Parent may have no events directory (all runs before event-recorder
    // landed, or a workflow that never emitted any AgentEvents). That's fine —
    // the child starts with an empty prefix.
  }

  // Persist the child's initial checkpoint so `sygil list` / `sygil resume` /
  // another `sygil fork` can see it even if the run dies before the scheduler
  // flushes.
  const runsDir = join(configDir, "runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${childRunId}.json`), JSON.stringify(childState));

  console.log(
    chalk.dim(`Forking from `) +
      chalk.cyan(parent.id) +
      chalk.dim(` @ checkpoint ${keep} → new run `) +
      chalk.green(childRunId),
  );

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
    if (event.type === "text_delta") process.stdout.write(chalk.dim("."));
  });
  scheduler.on("node_end", (nodeId: string, success: boolean) => {
    const icon = success ? chalk.green("✓") : chalk.red("✗");
    console.log(`\n  ${icon} ${nodeId} ${success ? "completed" : "failed"}`);
  });

  try {
    const resumeOpts = {
      ...(tierConfig?.hooks !== undefined ? { hooks: tierConfig.hooks } : {}),
      runReason: "fork" as const,
    };
    const result = await scheduler.resume(childState, resumeOpts);

    if (result.success) {
      console.log(
        chalk.bold.green(
          `\nFork completed in ${(result.durationMs / 1000).toFixed(1)}s (run ${childRunId})`,
        ),
      );
      if (result.totalCostUsd != null) {
        console.log(chalk.dim(`Fork cost: $${result.totalCostUsd.toFixed(4)} (parent cost not included)`));
      }
    } else {
      console.log(chalk.bold.red("\nFork failed."));
      if (result.error) console.log(chalk.red(result.error));
      process.exit(1);
    }
  } catch (err) {
    console.error(
      chalk.red(`\nError during fork: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  } finally {
    await ctx.teardown();
  }
}
