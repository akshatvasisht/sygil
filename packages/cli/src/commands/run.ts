import path from "node:path";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import open from "open";
import { loadWorkflow, interpolateWorkflow } from "../utils/workflow.js";
import { pruneWorktrees } from "../worktree/index.js";
import { readConfig, readConfigSafe } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { validateWorkflowTools, ADAPTER_FIELD_SUPPORT, WorkflowGraphSchema } from "@sygil/shared";
import { getAdapter } from "../adapters/index.js";
import { buildSchedulerContext, formatMetricsUrl } from "./_scheduler-bootstrap.js";
import { WorkflowWatcher } from "../utils/watcher.js";
import { logger } from "../utils/logger.js";
import { trackEvent } from "../utils/telemetry.js";
import {
  createTerminalMonitor,
  formatEventSummary,
  logEvent,
} from "../monitor/terminal-renderer.js";
import type { TerminalMonitorState, NodeMonitorState } from "../monitor/terminal-renderer.js";
import type { AgentEvent } from "@sygil/shared";

// readConfig import is used for side-effect (warm path detection)

interface RunOptions {
  param?: string[];
  dryRun?: boolean;
  isolate?: boolean;
  watch?: boolean;
  open?: boolean;
  monitor?: boolean;
  web?: boolean;
  metricsPort?: string;
}

/**
 * Read all stdin bytes and return as a UTF-8 string.
 * Used when workflowPath is "-" (workflow JSON piped via stdin).
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCommand(
  workflowPath: string,
  task: string | undefined,
  options: RunOptions
): Promise<void> {
  // Reap orphan `.git/worktrees/` entries from prior SIGINT'd runs.
  // Cheap, idempotent, and silent on non-git directories.
  await pruneWorktrees();

  // 1. Load and validate workflow
  //    If workflowPath is "-", read workflow JSON from stdin instead of a file.
  const spinner = ora("Loading workflow...").start();

  let workflow;
  try {
    if (workflowPath === "-") {
      const raw = await readStdin();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const result = WorkflowGraphSchema.safeParse(json);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(`Workflow validation failed:\n${issues}`);
      }
      workflow = result.data as import("@sygil/shared").WorkflowGraph;
    } else {
      workflow = await loadWorkflow(workflowPath);
    }
    spinner.succeed(`Loaded workflow: ${chalk.cyan(workflow.name)}`);
  } catch (err) {
    spinner.fail(
      `Failed to load workflow: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
    return;
  }

  // 2. Adapter availability pre-flight — runs before parameter interpolation because
  //    adapter types are hard-coded at the node level (no {{...}} on adapter field).
  //    Failing fast here avoids wasted interpolation on missing adapters.
  const requiredAdaptersPreflight = [...new Set(Object.values(workflow.nodes).map((n) => n.adapter))];
  for (const adapterType of requiredAdaptersPreflight) {
    const adapter = getAdapter(adapterType);
    const available = await adapter.isAvailable();
    if (!available) {
      console.error(chalk.red(`✗ Adapter '${adapterType}' is not available.`));
      console.error(chalk.dim(`  Run 'sygil init' to see adapter status and setup instructions.`));
      process.exit(1);
      return;
    }
  }

  // 2a. Parity walk — warn when a node uses a field its adapter silently ignores.
  const FIELDS_WITH_DIVERGENCE = ["tools", "disallowedTools", "sandbox", "outputSchema", "maxBudgetUsd", "maxTurns"];
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    const support = ADAPTER_FIELD_SUPPORT[node.adapter] ?? {};
    const nodeAsRecord = node as unknown as Record<string, unknown>;
    for (const f of FIELDS_WITH_DIVERGENCE) {
      const hasField = nodeAsRecord[f] !== undefined && nodeAsRecord[f] !== null;
      if (!hasField) continue;
      const s = support[f] ?? "enforced";
      if (s === "ignored" || s === "na") {
        logger.warn(`Node "${nodeId}" sets \`${f}\` but adapter "${node.adapter}" ${s === "ignored" ? "silently ignores it" : "does not apply"} — value will have no effect.`);
      }
    }
  }

  // 3. Parse parameters
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

  // 4. Resolve parameters: merge CLI params with workflow defaults, then interpolate
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

  // Resolve static modelTier → concrete model IDs using the project's tier
  // mapping. Happens AFTER interpolation and BEFORE the scheduler
  // starts so checkpoints record the concrete model.
  const tierConfig = await readConfigSafe(process.env["SYGIL_CONFIG_DIR"]);
  workflow = resolveModelTiersAndLog(workflow, tierConfig?.tiers);

  // Cross-check each node's `tools` against the adapter's advertised catalog.
  // Best-effort — never blocks the run, because the catalog will
  // drift behind upstream CLIs and MCP servers inject arbitrary tool names.
  for (const warning of validateWorkflowTools(workflow.nodes)) {
    logger.warn(warning.message);
  }

  // Dry run — just validate and show interpolated graph summary
  if (options.dryRun) {
    console.log(chalk.green("\nWorkflow is valid."));
    console.log(`  Nodes: ${Object.keys(workflow.nodes).join(", ")}`);
    console.log(`  Edges: ${workflow.edges.length}`);
    return;
  }

  // 5. Load config (used for default adapter hints if needed)
  await readConfig(process.env["SYGIL_CONFIG_DIR"]).catch(() => null);

  // Warn if any node uses claude-cli with an outputSchema (unreliable structured output)
  for (const [nodeId, nodeConfig] of Object.entries(workflow.nodes)) {
    if (nodeConfig.adapter === "claude-cli") {
      const outgoingEdges = workflow.edges.filter(e => e.from === nodeId);
      if (outgoingEdges.some(e => e.contract?.outputSchema)) {
        logger.warn(`Node "${nodeId}" uses claude-cli adapter with outputSchema — structured output is unreliable for this adapter. Consider using claude-sdk instead.`);
      }
    }
  }

  // 4b. Validate --metrics-port flag (parsing stays in the command; the
  //     bootstrap owns construction). Invalid values exit before touching any
  //     server resources.
  let parsedMetricsPort: number | undefined;
  if (options.metricsPort !== undefined) {
    const port = Number.parseInt(options.metricsPort, 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      console.error(chalk.red(`Invalid --metrics-port value: "${options.metricsPort}"`));
      process.exit(1);
    }
    parsedMetricsPort = port;
  }

  // 5. Build shared scheduler context (monitor, Prometheus, OTLP, scheduler).
  //    Consolidated bootstrap — see commands/_scheduler-bootstrap.ts.
  let ctx;
  try {
    ctx = await buildSchedulerContext({
      workflow,
      workflowPath,
      ...(tierConfig?.hooks !== undefined ? { hooks: tierConfig.hooks } : {}),
      enableMonitor: options.monitor !== false,
      ...(parsedMetricsPort !== undefined ? { metricsPort: parsedMetricsPort } : {}),
    });
  } catch (err) {
    console.error(
      chalk.red(err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
    return;
  }
  const { scheduler, monitor } = ctx!;

  if (ctx.metricsPort !== null && ctx.metricsAuthToken !== null) {
    console.log(formatMetricsUrl(ctx.metricsPort, ctx.metricsAuthToken) + "\n");
    if (ctx.otlpEndpoint) {
      console.log(chalk.dim(`  OTLP export: ${ctx.otlpEndpoint}\n`));
    }
  }

  if (options.monitor !== false && ctx.monitorPort !== null && ctx.monitorAuthToken !== null) {
    const port = ctx.monitorPort;
    const authToken = ctx.monitorAuthToken;
    const workflowSlug = encodeURIComponent(workflow.name);

    // In dev mode, point at the Next.js dev server and include ?ws= so it knows the port.
    const isDevMode = process.env["SYGIL_UI_DEV"] === "1";
    const monitorUrl = isDevMode
      ? `http://localhost:3000/monitor?ws=${port}&workflow=${workflowSlug}&token=${authToken}`
      : `http://localhost:${port}/monitor?workflow=${workflowSlug}&token=${authToken}`;

    // Only auto-open browser when --web flag is passed
    if (options.web && options.open !== false && process.stdout.isTTY) {
      await open(monitorUrl).catch(() => { });
    }

    if (options.web) {
      console.log(chalk.dim(`\n  Monitor: `) + chalk.cyan(monitorUrl) + "\n");
    } else {
      console.log(chalk.dim(`  Web monitor available at: ${monitorUrl}`) + "\n");
    }

    // Write connection info for standalone `sygil monitor` command
    const configDir = process.env["SYGIL_CONFIG_DIR"] || ".sygil";
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "active-monitor.json"),
      JSON.stringify({ port, token: authToken, workflowId: workflow.name }),
      "utf8"
    );
  } else {
    console.log(chalk.dim(`\n  Monitor disabled (headless mode)\n`));
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

  // 8. Wire client control events (pause/resume/cancel) from WebSocket to scheduler
  monitor.onClientControl = (event) => {
    if (event.type === "pause") scheduler.pause();
    if (event.type === "resume_workflow") scheduler.resumeExecution();
    if (event.type === "cancel") scheduler.cancel();
  };

  // Graceful SIGINT/SIGTERM: cancel the scheduler, let the final
  // `workflow_end` / `workflow_error` event reach subscribers via the fanout,
  // then drain per-client buffers before the process exits. Without this, a
  // Ctrl+C kills the node immediately and remote monitors see an abrupt drop.
  //
  // In --watch mode the process blocks on `new Promise<never>(() => {})` below
  // and chokidar keeps the event loop alive, so the handler must also stop the
  // watcher and exit explicitly — without this, the first Ctrl+C hangs and the
  // user has to press it twice to hard-kill the process.
  let activeWatcher: WorkflowWatcher | null = null;
  const onShutdownSignal = async (): Promise<void> => {
    scheduler.cancel();
    try { await monitor.drain(); } catch { /* best-effort */ }
    if (activeWatcher) {
      activeWatcher.stop();
      await monitor.stop();
      process.exit(0);
    }
  };
  process.once("SIGINT", onShutdownSignal);
  process.once("SIGTERM", onShutdownSignal);

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
      console.log(chalk.yellow(`  Loop-back on edge ${chalk.bold(edgeId)} — attempt ${attempt}/${maxRetries}`));
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
    const runOpts: import("../scheduler/index.js").RunOptions = {
      ...(options.isolate !== undefined ? { isolate: options.isolate } : {}),
      ...(tierConfig?.hooks !== undefined ? { hooks: tierConfig.hooks } : {}),
      ...(ctx.prometheusMetrics !== null ? { metricsObserver: ctx.prometheusMetrics } : {}),
    };
    // Pass workflow.name (not workflowPath) as the canonical workflowId so it
    // matches the `workflow=` URL slug the web monitor forwards in `subscribe`.
    // Using the filesystem path caused the fanout filter to silently
    // drop every workflow-scoped event — UI connected but rendered nothing.
    const result = await scheduler.run(workflow.name, parameters, runOpts);

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

      // Non-TTY compact summary table — printed in CI / pipe mode where the
      // live TUI wasn't rendered. Hand-rolled column padding; no new deps.
      if (!process.stdout.isTTY) {
        const runIdShort = result.runId.slice(0, 12);
        console.log(`\nWorkflow: ${workflow.name}  (runId: ${runIdShort})`);
        let totalDurationMs = 0;
        let totalCost = 0;
        let totalTokens = 0;
        // Determine column widths for node ID column
        const nodeIds = nodeOrder.length > 0 ? nodeOrder : Object.keys(workflow.nodes);
        const maxNodeIdLen = Math.max(...nodeIds.map(id => id.length), 4);
        for (const nodeId of nodeIds) {
          const ns = monitorState.nodes.get(nodeId);
          if (!ns) continue;
          const durationStr = `${(ns.elapsedMs / 1000).toFixed(1)}s`;
          const costStr = ns.costUsd > 0 ? `$${ns.costUsd.toFixed(4)}` : "$0.0000";
          const tokens = ns.tokenUsage.input + ns.tokenUsage.output;
          const tokensStr = `${tokens} tokens`;
          const statusIcon = ns.status === "completed" ? "✓" : ns.status === "failed" ? "✗" : "-";
          const paddedId = nodeId.padEnd(maxNodeIdLen);
          console.log(`  ${paddedId}  ${durationStr.padStart(8)}  ${costStr.padStart(9)}  ${tokensStr.padStart(12)}  ${statusIcon}`);
          totalDurationMs += ns.elapsedMs;
          totalCost += ns.costUsd;
          totalTokens += tokens;
        }
        const totalCostStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : "$0.0000";
        console.log(`Total: ${(totalDurationMs / 1000).toFixed(1)}s  ${totalCostStr}  ${totalTokens} tokens`);
      }
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
      await ctx.teardown();
    }
    // Clean up active-monitor.json
    const configDir = process.env["SYGIL_CONFIG_DIR"] || ".sygil";
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
    activeWatcher = watcher;
    const watchDirs = Object.values(workflow.nodes).map(n => n.outputDir).filter(Boolean) as string[];
    watcher.watch(workflowPath, watchDirs);
    logger.info("Watching for changes. Press Ctrl+C to stop.");

    watcher.on("change", async ({ path: changedPath }: { path: string }) => {
      rerunCount++;
      if (rerunCount > MAX_RERUNS) {
        logger.warn(`Maximum reruns (${MAX_RERUNS}) exceeded. Stopping watcher to prevent infinite loop.`);
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
