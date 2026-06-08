import path from "node:path";
import { writeFile, unlink, mkdir, access } from "node:fs/promises";
import chalk from "chalk";
import { ensureGitRepo } from "../utils/git-check.js";
import ora from "ora";
import open from "open";
import { getTemplatesDir } from "../utils/templates.js";
import { loadWorkflow, validateWorkflowInvariants } from "../utils/workflow.js";
import { parseParamPairs, resolveWorkflowParams } from "../utils/params.js";
import { pruneWorktrees } from "../worktree/index.js";
import { readConfigSafe, hooksOpt } from "../utils/config.js";
import { resolveModelTiersAndLog } from "../utils/tier-resolver.js";
import { validateWorkflowTools, ADAPTER_FIELD_SUPPORT, WorkflowGraphSchema } from "@sygil/shared";
import { getAdapter } from "../adapters/index.js";
import { buildSchedulerContext, formatMetricsUrl } from "./_scheduler-bootstrap.js";
import { sanitizeEndpointForDisplay } from "../monitor/otlp-push.js";
import { WorkflowWatcher } from "../utils/watcher.js";
import { logger } from "../utils/logger.js";
import { trackEvent } from "../utils/telemetry.js";
import { topoSort } from "../utils/topo-sort.js";
import {
  createTerminalMonitor,
  formatEventSummary,
  logEvent,
} from "../monitor/terminal-renderer.js";
import type { TerminalMonitorState, NodeMonitorState } from "../monitor/terminal-renderer.js";
import type { AgentEvent } from "@sygil/shared";

/** Resolve bare template names (e.g. "tdd-feature") to their bundled .json path.
 *
 * Priority:
 *  1. "-"            — stdin; return unchanged.
 *  2. path with "/" or ".json" extension — file path; return unchanged.
 *  3. bare name `/^[a-z][a-z0-9-]*$/` — look up in `<cli-install-dir>/templates/<name>.json`.
 *                                         If not found there, return unchanged so loadWorkflow
 *                                         can produce a clear ENOENT.
 */
async function resolveWorkflowPath(workflowPath: string): Promise<string> {
  if (workflowPath === "-") return workflowPath;
  // If it contains a path separator or .json extension, treat as a file path
  if (workflowPath.includes("/") || workflowPath.includes("\\") || workflowPath.endsWith(".json")) {
    return workflowPath;
  }
  // Bare template-name shape: lowercase, digits, hyphens, starts with a letter
  if (/^[a-z][a-z0-9-]*$/.test(workflowPath)) {
    // Probe the canonical templates dir first, then templates/experimental/ so
    // bare names still resolve for experimental templates (e.g. `sygil run
    // optimize`) even though `sygil list` hides them from default output.
    const templatesDir = getTemplatesDir();
    const candidates = [
      path.join(templatesDir, `${workflowPath}.json`),
      path.join(templatesDir, "experimental", `${workflowPath}.json`),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
  }
  return workflowPath;
}

interface RunOptions {
  param?: string[];
  dryRun?: boolean;
  isolate?: boolean;
  watch?: boolean;
  open?: boolean;
  monitor?: boolean;
  web?: boolean;
  metricsPort?: string;
  /**
   * Stream agent events directly to stdout instead of the ora spinner / TUI.
   * Mutually exclusive renderer: when true the spinner never starts and the TUI
   * is skipped; the WsMonitorServer still runs so web clients are unaffected.
   * Register the CLI flag in packages/cli/src/cli-program.ts:
   *   .option("--stream", "Stream agent output to the terminal in real time")
   */
  stream?: boolean;
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

  // Worktree isolation requires git + a repo. Fail fast with a clear, actionable
  // message rather than surfacing a cryptic error from the first worktree op
  // mid-run. (No-op under VITEST per ensureGitRepo's own test guard.)
  if (options.isolate) {
    try {
      await ensureGitRepo();
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  // Load and validate workflow
  //    If workflowPath is "-", read workflow JSON from stdin instead of a file.
  //    If workflowPath is a bare template name, resolve it to the bundled file.
  workflowPath = await resolveWorkflowPath(workflowPath);

  // In --stream mode the spinner is suppressed — raw events go to stdout
  // instead. Use a no-op shim that keeps the rest of the loading block clean.
  const spinner = options.stream
    ? { succeed: (msg: string) => console.log(msg), fail: (msg: string) => console.error(msg) }
    : ora("Loading workflow...").start();

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
      // Stdin path must run the same post-schema invariants as `loadWorkflow`
      // (tools allowlist + ReDoS heuristic). Without this, `echo '...' | sygil run -`
      // bypasses both protections.
      validateWorkflowInvariants(workflow);
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

  // Adapter availability pre-flight — runs before parameter interpolation because
  //    adapter types are hard-coded at the node level (no {{...}} on adapter field).
  //    Failing fast here avoids wasted interpolation on missing adapters.
  const requiredAdaptersPreflight = [...new Set(Object.values(workflow.nodes).map((n) => n.adapter))];
  for (const adapterType of requiredAdaptersPreflight) {
    const adapter = getAdapter(adapterType);
    // Probe with a representative node so config-scoped endpoints (e.g.
    // local-oai's adapterOptions.localOai.baseUrl) are checked at the same
    // endpoint spawn() will use, not just the env/default one. Pass the first
    // node declaring this adapter; adapters that ignore per-node config keep
    // their env/default behavior via the optional param.
    const representativeNode = Object.values(workflow.nodes).find((n) => n.adapter === adapterType);
    const available = await adapter.isAvailable(representativeNode);
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

  // Parse parameters. The positional `task` arg is a run-only convenience
  //    that seeds the `task` parameter; CLI --param pairs override it.
  const parameters: Record<string, string> = {};
  if (task) {
    parameters["task"] = task;
  }
  if (options.param) {
    Object.assign(parameters, parseParamPairs(options.param));
  }

  // Resolve parameters: merge CLI params with workflow defaults, validate
  //    required fields, then interpolate {{param}} placeholders.
  workflow = resolveWorkflowParams(workflow, parameters, "Supply them with --param key=value");

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

  // Build shared scheduler context (monitor, Prometheus, OTLP, scheduler).
  //    Consolidated bootstrap — see commands/_scheduler-bootstrap.ts.
  let ctx;
  try {
    ctx = await buildSchedulerContext({
      workflow,
      workflowPath,
      ...hooksOpt(tierConfig),
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
      console.log(chalk.dim(`  OTLP export: ${sanitizeEndpointForDisplay(ctx.otlpEndpoint)}\n`));
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

  // Compute topological node order for display
  const nodeOrder = topoSort(Object.keys(workflow.nodes), workflow.edges);

  // Set up monitoring display
  const isTTY = Boolean(process.stdout.isTTY);
  const useWebMonitor = Boolean(options.web);
  // --stream is a third renderer: direct stdout streaming, mutually exclusive
  // with both the TUI and the per-event logEvent calls in the non-TUI path.
  const useStream = Boolean(options.stream);
  const useTUI = !useWebMonitor && !useStream && isTTY && options.monitor !== false;

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

  // Wire client control events (pause/resume/cancel) from WebSocket to scheduler
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
      // Watch-mode bypasses the non-watch finally block at line ~542 that
      // calls ctx.teardown() — without this call, --watch + --metrics-port
      // leaks the metrics server and skips the final OTLP flush on Ctrl+C.
      try { await ctx.teardown(); } catch { /* best-effort */ }
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
    if (!useTUI && !useStream) {
      const nodeConfig = workflow.nodes[nodeId];
      logEvent(nodeId, { type: "status", summary: `running  (${nodeConfig?.adapter ?? "?"})` });
    }
  });

  scheduler.on("node_event", (nodeId: string, event: AgentEvent) => {
    const node = monitorState.nodes.get(nodeId);
    if (!node) return;

    const summary = formatEventSummary(event);

    node.recentEvents.push(summary);
    if (node.recentEvents.length > 3) node.recentEvents.shift();

    if (event.type === "cost_update") {
      node.costUsd = event.totalCostUsd;
      monitorState.totalCostUsd = 0;
      for (const [, n] of monitorState.nodes) {
        monitorState.totalCostUsd += n.costUsd;
      }
    }

    if (!useTUI && !useStream) {
      logEvent(nodeId, summary);
    }
  });

  scheduler.on("node_end", (nodeId: string, success: boolean) => {
    const node = monitorState.nodes.get(nodeId);
    if (node) {
      node.status = success ? "completed" : "failed";
    }
    if (!useTUI && !useStream) {
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

  // --stream renderer: write agent events directly to stdout.
  // The WsMonitorServer still runs — this only changes the terminal output.
  // loop_back and gate_eval fall through to the non-TUI handlers above (they
  // are already gated on !useTUI, not on !useStream, so they always print).
  if (useStream) {
    scheduler.on("node_start", (nodeId: string) => {
      console.log(chalk.cyan(`\n▶ ${nodeId}`));
    });

    scheduler.on("node_event", (_nodeId: string, event: AgentEvent) => {
      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      } else if (event.type === "tool_call") {
        const inputSlice = JSON.stringify(event.input).slice(0, 80);
        console.log(chalk.yellow(`\n  → tool(${inputSlice})`));
      } else if (event.type === "tool_result") {
        console.log(chalk.dim(`  ✓ tool`));
      } else if (event.type === "error") {
        console.log(chalk.red(`  ✗ ${event.message}`));
      }
    });

    scheduler.on("node_end", (nodeId: string, success: boolean) => {
      if (success) {
        console.log(chalk.green(`✓ ${nodeId}`));
      } else {
        console.log(chalk.red(`✗ ${nodeId}`));
      }
    });
  }

  let runFailed = false;
  try {
    trackEvent("workflow_run_started", {
      nodeCount: Object.keys(workflow.nodes).length,
      adapterTypes: [...new Set(Object.values(workflow.nodes).map(n => n.adapter))],
      templateName: path.basename(workflowPath, ".json"),
    });
    const runOpts: import("../scheduler/index.js").RunOptions = {
      ...(options.isolate !== undefined ? { isolate: options.isolate } : {}),
      ...hooksOpt(tierConfig),
      ...(ctx.prometheusMetrics !== null ? { metricsObserver: ctx.prometheusMetrics } : {}),
      ...(tierConfig?.performance?.nodeCache === true ? { nodeCacheEnabled: true } : {}),
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
        try { await ctx.teardown(); } catch { /* best-effort */ }
        process.exit(0);
        return;
      }

      logger.info(`Change detected: ${changedPath}. Re-running workflow... (${rerunCount}/${MAX_RERUNS})`);
      watcher.stop();
      await monitor.stop();
      // Tear down this run's metrics/OTLP server before recursing — the new
      // runCommand call builds a fresh ctx, and without teardown the old one
      // leaks its listening port and skips its final OTLP flush.
      try { await ctx.teardown(); } catch { /* best-effort */ }
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

