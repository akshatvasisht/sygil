#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { resumeCommand } from "./commands/resume.js";
import { listCommand } from "./commands/list.js";
import { validateCommand } from "./commands/validate.js";
import { exportCommand } from "./commands/export.js";
import { replayCommand } from "./commands/replay.js";
import { monitorCommand } from "./commands/monitor.js";
import { importTemplateCommand } from "./commands/import-template.js";
import { registryCommand } from "./commands/registry.js";
import { setVerbose } from "./utils/logger.js";

const program = new Command();

program
  .name("sigil")
  .description("Deterministic orchestrator for coding agent sessions")
  .version("0.1.0");

// Global options
program.option("--config <path>", "Path to .sigil config directory");
program.option("-v, --verbose", "Verbose output");

program
  .command("init")
  .description("Detect available adapters and write .sigil/config.json")
  .option("--telemetry", "Enable anonymous usage telemetry")
  .option("--no-telemetry", "Disable anonymous usage telemetry")
  .action(initCommand);


program
  .command("run")
  .description("Run a workflow from a workflow.json file")
  .argument("<workflow>", "Path to workflow.json file")
  .argument("[task]", "Optional task description to pass as a parameter")
  .option("-p, --param <pairs...>", "Parameters as key=value pairs")
  .option("--dry-run", "Validate the workflow without executing it")
  .option("--isolate", "Run each node in an isolated git worktree")
  .option("-w, --watch", "Watch workflow file for changes and re-run")
  .option("--no-open", "Do not automatically open the monitor in a browser")
  .option("--no-monitor", "Disable the web monitor (headless mode)")
  .option("--web", "Open the web browser monitor instead of terminal TUI")
  .action(runCommand);

program
  .command("resume")
  .description("Resume a paused or failed workflow run")
  .argument("<run-id>", "The run ID to resume (from .sigil/runs/<id>.json)")
  .action(resumeCommand);

program
  .command("list")
  .description("List available adapters and recent workflow runs")
  .action(listCommand);

program
  .command("validate")
  .description("Validate a workflow.json file")
  .argument("<workflow>", "Path to workflow.json file")
  .action(validateCommand);

program
  .command("export")
  .description("Export a bundled template to a file")
  .argument("<template>", "Template name (e.g. tdd-feature)")
  .argument("<output>", "Output file path (e.g. ./my-workflow.json)")
  .action(exportCommand);

program
  .command("replay")
  .description("Replay recorded events from a previous workflow run")
  .argument("<run-id>", "The run ID to replay (from .sigil/runs/<id>/)")
  .option("-n, --node <nodeId>", "Only replay events from this node")
  .option("-s, --speed <multiplier>", "Playback speed (0=instant, 1=real-time, 2=2x)", "1")
  .action(replayCommand);

program
  .command("monitor")
  .description("Attach to a running workflow and show live terminal status")
  .argument("[run-id]", "Run ID to monitor (auto-detects if omitted)")
  .option("--url <url>", "WebSocket URL to connect to directly")
  .action(monitorCommand);

program
  .command("import-template")
  .description("Import a workflow template from a URL or local path")
  .argument("<url-or-path>", "URL or local file path of the template JSON")
  .action(importTemplateCommand);

program.addCommand(registryCommand);

// Pre-parse hook: extract global options before commands run
program.hook("preAction", () => {
  const opts = program.opts<{ config?: string; verbose?: boolean }>();
  if (opts.config) {
    process.env["SIGIL_CONFIG_DIR"] = opts.config;
  }
  if (opts.verbose) {
    setVerbose(true);
  }
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
