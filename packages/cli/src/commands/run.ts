import path from "node:path";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import open from "open";
import { loadWorkflow, interpolateWorkflow } from "../utils/workflow.js";
import { readConfig } from "../utils/config.js";
import { getAdapter } from "../adapters/index.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import { WsMonitorServer } from "../monitor/websocket.js";
import { WorkflowWatcher } from "../utils/watcher.js";
import { logger } from "../utils/logger.js";
import { trackEvent } from "../utils/telemetry.js";
import {
  createTerminalMonitor,
  formatEventSummary,
  logEvent,
} from "../monitor/terminal-renderer.js";
import type { TerminalMonitorState, NodeMonitorState } from "../monitor/terminal-renderer.js";
import type { AgentEvent } from "@sigil/shared";

// readConfig import is used for side-effect (warm path detection)

interface RunOptions {
  param?: string[];
  dryRun?: boolean;
  isolate?: boolean;
  watch?: boolean;
  open?: boolean;
  monitor?: boolean;
  web?: boolean;
}

export async function runCommand(
  workflowPath: string,
  task: string | undefined,
  options: RunOptions
): Promise<void> {
  // 1. Load and validate workflow
  const spinner = ora("Loading workflow...").start();

  let workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
    spinner.succeed(`Loaded workflow: ${chalk.cyan(workflow.name)}`);
  } catch (err) {
    spinner.fail(
      `Failed to load workflow: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // 2. Parse parameters
  const parameters: Record<string, string> = {};
  if (task) {
    parameters["task"] = task;
  }
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

  // 3. Resolve parameters: merge CLI params with workflow defaults, then interpolate
  const resolvedParams: Record<string, string> = {};

  // Apply defaults from graph.parameters first
  if (workflow.parameters) {
    for (const [key, paramDef] of Object.entries(workflow.parameters)) {
      if (paramDef.default != null) {
        resolvedParams[key] = String(paramDef.default);
      }
    }
  }

  // CLI-supplied params override defaults
  for (const [key, value] of Object.entries(parameters)) {
    resolvedParams[key] = value;
  }

  // Validate required parameters are present
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
          `Supply them with --param key=value`
        )
      );
      process.exit(1);
    }
  }

  // Interpolate {{param}} placeholders in the workflow graph
  try {
    workflow = interpolateWorkflow(workflow, resolvedParams);
  } catch (err) {
    console.error(
      chalk.red(`Parameter interpolation failed: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
  }

  // Dry run — just validate and show interpolated graph summary
  if (options.dryRun) {
    console.log(chalk.green("\nWorkflow is valid."));
    console.log(`  Nodes: ${Object.keys(workflow.nodes).join(", ")}`);
    console.log(`  Edges: ${workflow.edges.length}`);
    return;
  }

  // 4. Load config (used for default adapter hints if needed)
  await readConfig(process.env["SIGIL_CONFIG_DIR"]).catch(() => null);

  // 4a. Adapter preflight check
  const requiredAdapters = [...new Set(Object.values(workflow.nodes).map((n) => n.adapter))];
  for (const adapterType of requiredAdapters) {
    const adapter = getAdapter(adapterType);
    const available = await adapter.isAvailable();
    if (!available) {
      console.error(chalk.red(`✗ Adapter '${adapterType}' is not available.`));
      console.error(chalk.dim(`  Run 'sigil init' to see adapter status and setup instructions.`));
      process.exit(1);
    }
  }

  // Warn if any node uses claude-cli with an outputSchema (unreliable structured output)
  for (const [nodeId, nodeConfig] of Object.entries(workflow.nodes)) {
    if (nodeConfig.adapter === "claude-cli") {
      const outgoingEdges = workflow.edges.filter(e => e.from === nodeId);
      if (outgoingEdges.some(e => e.contract?.outputSchema)) {
        logger.warn(`⚠ Node "${nodeId}" uses claude-cli adapter with outputSchema — structured output is unreliable for this adapter. Consider using claude-sdk instead.`);
      }
    }
  }

  // 5. Start monitor server (serves pre-built UI + WebSocket on the same port)
  //    Skip if --no-monitor is set (headless mode)
  const monitor = new WsMonitorServer();

  if (options.monitor !== false) {
    const port = await monitor.start();
    const authToken = monitor.getAuthToken();
    const workflowSlug = encodeURIComponent(workflow.name);

    // In dev mode, point at the Next.js dev server and include ?ws= so it knows the port.
    const isDevMode = process.env["SIGIL_UI_DEV"] === "1";
    const monitorUrl = isDevMode
      ? `http://localhost:3000/monitor?ws=${port}&workflow=${workflowSlug}&token=${authToken}`
      : `http://localhost:${port}/monitor?workflow=${workflowSlug}&token=${authToken}`;

    // Only auto-open browser when --web flag is passed
    if (options.web && options.open !== false && process.stdout.isTTY) {
      await open(monitorUrl).catch(() => { });
    }

    if (options.web) {
      console.log(chalk.dim(`\n  ➜  Monitor: `) + chalk.cyan(monitorUrl) + "\n");
    } else {
      console.log(chalk.dim(`  ➜  Web monitor available at: ${monitorUrl}`) + "\n");
    }

    // Write connection info for standalone `sigil monitor` command
    const configDir = process.env["SIGIL_CONFIG_DIR"] || ".sigil";
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "active-monitor.json"),
      JSON.stringify({ port, token: authToken, workflowId: workflow.name }),
      "utf8"
    );
  } else {
    console.log(chalk.dim(`\n  ℹ  Monitor disabled (headless mode)\n`));
  }

  // 6. Compute topological node order for display
  const nodeOrder = topoSort(workflow);

  // 7. Set up monitoring display
  const isTTY = Boolean(process.stdout.isTTY);
  const useWebMonitor = Boolean(options.web);
  const useTUI = !useWebMonitor && isTTY && options.monitor !== false;

  // Build shared state for TUI
  const monitorState: TerminalMonitorState = {
    nodes: new Map<string, NodeMonitorState>(),
    nodeOrder,
    totalCostUsd: 0,
    totalTokens: 0,
    workflowName: workflow.name,
    startedAt: Date.now(),
  };

  // Pre-populate all nodes as waiting
  for (const nodeId of nodeOrder) {
    const nodeConfig = workflow.nodes[nodeId];
    monitorState.nodes.set(nodeId, {
      status: "waiting",
      adapter: nodeConfig?.adapter ?? "unknown",
      startedAt: null,
      elapsedMs: 0,
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      recentEvents: [],
    });
  }

  const tui = useTUI ? createTerminalMonitor(monitorState) : null;

  // 8. Run the scheduler
  const scheduler = new WorkflowScheduler(workflow, getAdapter, monitor, workflowPath);

  // Wire client control events (pause/resume/cancel) from WebSocket to scheduler
  monitor.onClientControl = (event) => {
    if (event.type === "pause") scheduler.pause();
    if (event.type === "resume_workflow") scheduler.resumeExecution();
    if (event.type === "cancel") scheduler.cancel();
  };

  scheduler.on("node_start", (nodeId: string) => {
    const node = monitorState.nodes.get(nodeId);
    if (node) {
      node.status = "running";
      node.startedAt = Date.now();
    }
    if (!useTUI) {
      const nodeConfig = workflow.nodes[nodeId];
      logEvent(nodeId, { type: "status", summary: `running  (${nodeConfig?.adapter ?? "?"})` });
    }
  });

  scheduler.on("node_event", (nodeId: string, event: AgentEvent) => {
    const node = monitorState.nodes.get(nodeId);
    if (!node) return;

    const summary = formatEventSummary(event);

    // Keep last 3 events
    node.recentEvents.push(summary);
    if (node.recentEvents.length > 3) node.recentEvents.shift();

    if (event.type === "cost_update") {
      node.costUsd = event.totalCostUsd;
      monitorState.totalCostUsd = 0;
      for (const [, n] of monitorState.nodes) {
        monitorState.totalCostUsd += n.costUsd;
      }
    }

    if (!useTUI) {
      logEvent(nodeId, summary);
    }
  });

  scheduler.on("node_end", (nodeId: string, success: boolean) => {
    const node = monitorState.nodes.get(nodeId);
    if (node) {
      node.status = success ? "completed" : "failed";
    }
    if (!useTUI) {
      const icon = success ? chalk.green("✓") : chalk.red("✗");
      const elapsed = node ? `${(node.elapsedMs / 1000).toFixed(1)}s` : "";
      const cost = node && node.costUsd > 0 ? `  $${node.costUsd.toFixed(4)}` : "";
      logEvent(nodeId, { type: "status", summary: `${icon} ${success ? "completed" : "failed"}  ${elapsed}${cost}` });
    }
  });

  scheduler.on("loop_back", (edgeId: string, attempt: number, maxRetries: number) => {
    if (!useTUI) {
      console.log(chalk.yellow(`  ↩ Loop-back on edge ${chalk.bold(edgeId)} — attempt ${attempt}/${maxRetries}`));
    }
  });

  scheduler.on("gate_eval", (edgeId: string, passed: boolean, reason: string) => {
    if (!useTUI) {
      const icon = passed ? chalk.green("✓") : chalk.red("✗");
      console.log(chalk.dim(`  Gate [${edgeId}]: ${icon} ${reason}`));
    }
  });

  let runFailed = false;
  try {
    trackEvent("workflow_run_started", {
      nodeCount: Object.keys(workflow.nodes).length,
      adapterTypes: [...new Set(Object.values(workflow.nodes).map(n => n.adapter))],
      templateName: path.basename(workflowPath, ".json"),
    });
    const runOpts = options.isolate !== undefined ? { isolate: options.isolate } : {};
    const result = await scheduler.run(workflowPath, parameters, runOpts);

    if (result.success) {
      trackEvent("workflow_run_completed", {
        success: true,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
        nodeCount: Object.keys(workflow.nodes).length,
      });
      console.log(
        chalk.bold.green(
          `\nWorkflow completed in ${(result.durationMs / 1000).toFixed(1)}s`
        )
      );
      if (result.totalCostUsd != null) {
        console.log(chalk.dim(`Total cost: $${result.totalCostUsd.toFixed(4)}`));
      }
      console.log(chalk.dim(`Run ID: ${result.runId}`));
    } else {
      trackEvent("workflow_run_failed", {
        success: false,
        nodeCount: Object.keys(workflow.nodes).length,
      });
      console.log(chalk.bold.red("\nWorkflow failed."));
      if (result.error) console.log(chalk.red(result.error));
      runFailed = true;
    }
  } catch (err) {
    trackEvent("workflow_run_failed", {
      success: false,
      nodeCount: Object.keys(workflow.nodes).length,
    });
    console.error(
      chalk.red(`\nUnexpected error: ${err instanceof Error ? err.message : String(err)}`)
    );
    runFailed = true;
  } finally {
    tui?.stop();
    if (!options.watch) {
      await monitor.stop();
    }
    // Clean up active-monitor.json
    const configDir = process.env["SIGIL_CONFIG_DIR"] || ".sigil";
    await unlink(path.join(configDir, "active-monitor.json")).catch(() => {});
  }

  if (options.watch) {
    // Only enter --watch mode if the initial run succeeded.
    // On failure, exit so the user sees the error clearly.
    if (runFailed) {
      await monitor.stop();
      process.exit(1);
    }

    // Track rerun count to prevent infinite loops (max 100 reruns)
    const MAX_RERUNS = 100;
    let rerunCount = 0;

    const watcher = new WorkflowWatcher();
    const watchDirs = Object.values(workflow.nodes).map(n => n.outputDir).filter(Boolean) as string[];
    watcher.watch(workflowPath, watchDirs);
    logger.info("Watching for changes. Press Ctrl+C to stop.");

    watcher.on("change", async ({ path: changedPath }: { path: string }) => {
      rerunCount++;
      if (rerunCount > MAX_RERUNS) {
        logger.warn(`⚠ Maximum reruns (${MAX_RERUNS}) exceeded. Stopping watcher to prevent infinite loop.`);
        watcher.stop();
        await monitor.stop();
        process.exit(0);
        return;
      }

      logger.info(`Change detected: ${changedPath}. Re-running workflow... (${rerunCount}/${MAX_RERUNS})`);
      watcher.stop();
      await monitor.stop();
      // Re-run by recursively invoking the run command
      await runCommand(workflowPath, task, options);
    });

    // Keep process alive
    await new Promise<never>(() => { }); // block until Ctrl+C
  }

  if (runFailed) {
    process.exit(1);
  }
}

/** Kahn's algorithm topological sort for display ordering. Falls back to Object.keys order. */
function topoSort(workflow: { nodes: Record<string, unknown>; edges: Array<{ from: string; to: string; isLoopBack?: boolean }> }): string[] {
  const nodeIds = Object.keys(workflow.nodes);
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);

  const forwardEdges = workflow.edges.filter(e => !e.isLoopBack);
  for (const e of forwardEdges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const e of forwardEdges) {
      if (e.from === current) {
        const newDeg = (inDegree.get(e.to) ?? 1) - 1;
        inDegree.set(e.to, newDeg);
        if (newDeg === 0) queue.push(e.to);
      }
    }
  }

  return sorted.length === nodeIds.length ? sorted : nodeIds;
}
