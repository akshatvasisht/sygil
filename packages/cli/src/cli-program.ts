import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { resumeCommand } from "./commands/resume.js";
import { forkCommand } from "./commands/fork.js";
import { listCommand } from "./commands/list.js";
import { validateCommand } from "./commands/validate.js";
import { exportCommand } from "./commands/export.js";
import { replayCommand } from "./commands/replay.js";
import { monitorCommand } from "./commands/monitor.js";
import { importTemplateCommand } from "./commands/import-template.js";
import { registryCommand } from "./commands/registry.js";
import { schemaCommand } from "./commands/schema.js";
import { setVerbose } from "./utils/logger.js";

/**
 * Build the Commander program graph. Extracted from the CLI entry point so
 * that `--help` output can be exercised in tests without triggering
 * `parseAsync`.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("sygil")
    .description("Deterministic orchestrator for coding agent sessions")
    .version("0.1.0");

  program.option("--config <path>", "Path to .sygil config directory");
  program.option("-v, --verbose", "Verbose output");

  program
    .command("init")
    .description("Detect available adapters and write .sygil/config.json")
    .option("--telemetry", "Enable anonymous usage telemetry")
    .option("--no-telemetry", "Disable anonymous usage telemetry")
    .addHelpText("after", `
Examples:
  $ sygil init                  # detect adapters and write .sygil/config.json
  $ sygil init --no-telemetry   # opt out of anonymous usage telemetry
`)
    .action(initCommand);

  program
    .command("run")
    .description("Run a workflow from a workflow.json file (or - to read from stdin)")
    .argument("<workflow>", "Path to workflow.json file, or - to read JSON from stdin")
    .argument("[task]", "Optional task description to pass as a parameter")
    .option("-p, --param <pairs...>", "Parameters as key=value pairs")
    .option("--dry-run", "Validate the workflow without executing it")
    .option("--isolate", "Run each node in an isolated git worktree")
    .option("-w, --watch", "Watch workflow file for changes and re-run")
    .option("--no-open", "Do not automatically open the monitor in a browser")
    .option("--no-monitor", "Disable the web monitor (headless mode)")
    .option("--web", "Open the web browser monitor instead of terminal TUI")
    .option("--metrics-port <port>", "Expose Prometheus metrics on an HTTP port (see CLAUDE.md)")
    .addHelpText("after", `
Examples:
  $ sygil run templates/tdd-feature.json "Add rate-limiting middleware"
  $ sygil run workflow.json -p task="Fix the flaky test in auth.test.ts"
  $ sygil run workflow.json --no-monitor --metrics-port 9090
  $ OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 sygil run workflow.json --metrics-port 9090
  $ sygil run workflow.json --dry-run       # validate only, don't execute
  $ sygil run workflow.json --isolate       # each node in its own git worktree

The monitor URL printed to stdout includes a per-run auth token:
  http://localhost:3000/monitor?ws=<port>&workflow=<name>&token=<uuid>
Control-channel clients (pause/cancel/human-review) must include ?token=<uuid>.
`)
    .action(runCommand);

  program
    .command("resume")
    .description("Resume a paused or failed workflow run")
    .argument("<run-id>", "The run ID to resume (from .sygil/runs/<id>.json)")
    .option("--ignore-drift", "Proceed even if environment has drifted since the checkpoint was created")
    .addHelpText("after", `
Examples:
  $ sygil resume run-1712345678901-abc123   # full run ID (see \`sygil list\`)

The <run-id> must match a checkpoint at .sygil/runs/<id>.json exactly.
Partial or prefix matching is NOT supported — use \`sygil list\` to copy the full ID.
`)
    .action((runId: string, options: { ignoreDrift?: boolean }) => resumeCommand(runId, options));

  program
    .command("fork")
    .description("Branch a run from a checkpoint into a new runId")
    .argument("<run-id>", "Parent run ID to fork from (see `sygil list`)")
    .option(
      "--at <checkpointIndex>",
      "Keep only the first N completed nodes of the parent. Clamped to the parent's completed count. Default: keep all.",
    )
    .option(
      "-p, --param <pairs...>",
      "Parameter overrides for the fork, as key=value. Parent params are NOT inherited — re-specify each required param.",
    )
    .addHelpText("after", `
Examples:
  $ sygil fork <parent-run-id>                       # branch at the end of parent's completed nodes
  $ sygil fork <parent-run-id> --at 2                # keep only the first 2 completed nodes
  $ sygil fork <parent-run-id> --param task="altA"   # diverge with different params

Semantics:
  - The child receives a fresh run-id (UUID). totalCostUsd resets to 0 — parent's
    accumulated cost is NOT carried over. Sum totals externally if needed.
  - sharedContext is inherited from the parent at the branch point.
  - Per-node event logs for retained nodes are copied from the parent's run dir.
  - Hooks see SYGIL_RUN_REASON=fork.
  - Fork v1 does not inherit resolved parameters from the parent checkpoint
    (they aren't persisted). Supply every required parameter via --param.
`)
    .option("--ignore-drift", "Proceed even if environment has drifted since the checkpoint was created")
    .action((parentRunId: string, options: { at?: string; param?: string[]; ignoreDrift?: boolean }) =>
      forkCommand(parentRunId, options),
    );

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
    .description("Export a bundled template to a file or bundle directory")
    .argument("<template>", "Template name (e.g. tdd-feature)")
    .argument("<output>", "Output path — a .json file (default) or directory/tarball when --bundle is set")
    .option("--force", "Overwrite the output if it already exists")
    .option("--bundle", "Emit a bundle directory (workflow.json + gate scripts + manifest) instead of a single file")
    .option("--format <format>", "Bundle format: dir (default) or tarball (.tar.gz)", "dir")
    .option("--no-include-gate-scripts", "Exclude gate scripts from the bundle")
    .option("--no-include-specs", "Exclude spec files from the bundle")
    .addHelpText("after", `
Examples:
  $ sygil export tdd-feature ./my-workflow.json
  $ sygil export tdd-feature ./my-bundle --bundle
  $ sygil export tdd-feature ./my-bundle --bundle --format=tarball
  $ sygil export optimize ./outer-loop.json --force

Bundled templates: bug-fix, code-review, optimize, quick-review, ralph, tdd-feature.
`)
    .action((
      template: string,
      output: string,
      options: {
        force?: boolean;
        bundle?: boolean;
        format?: string;
        includeGateScripts?: boolean;
        includeSpecs?: boolean;
      },
    ) =>
      exportCommand(template, output, {
        force: options.force === true,
        bundle: options.bundle === true,
        format: (options.format === "tarball" ? "tarball" : "dir") as "dir" | "tarball",
        includeGateScripts: options.includeGateScripts !== false,
        includeSpecs: options.includeSpecs !== false,
      }),
    );

  program
    .command("replay")
    .description("Replay recorded events from a previous workflow run")
    .argument("<run-id>", "The run ID to replay (from .sygil/runs/<id>/)")
    .option("-n, --node <nodeId>", "Only replay events from this node")
    .option("-s, --speed <multiplier>", "Playback speed (0=instant, 1=real-time, 2=2x)", "1")
    .addHelpText("after", `
Examples:
  $ sygil replay run-abc12345                   # real-time replay
  $ sygil replay run-abc12345 -s 0              # instant (no waits)
  $ sygil replay run-abc12345 --node planner    # only replay one node's events
`)
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

  program
    .command("schema")
    .description("Emit the JSON Schema for workflow.json (draft-07)")
    .option("--out <path>", "Write the schema to the given path (default: stdout)")
    .option("--check", "Fail if the checked-in file at --out differs from a fresh regen")
    .action((options: { out?: string; check?: boolean }) => schemaCommand(options));

  program.addCommand(registryCommand);

  program.addHelpText("afterAll", `
Quick start:
  $ sygil init                                        # detect adapters + write config
  $ sygil export tdd-feature ./workflow.json          # export a bundled template
  $ sygil run ./workflow.json "Add auth middleware"   # run it

Environment variables (full list in CLAUDE.md):
  ANTHROPIC_API_KEY             claude-sdk / claude-cli adapter auth
  CURSOR_API_KEY                cursor adapter auth (alt to ~/.cursor/credentials.json)
  GEMINI_API_KEY                gemini-cli adapter auth (alt to ~/.gemini/)
  SYGIL_LOCAL_OAI_URL           local-oai base URL (default http://localhost:11434/v1)
  SYGIL_LOCAL_OAI_KEY           local-oai bearer token (default sentinel "ollama")
  OTEL_EXPORTER_OTLP_ENDPOINT   activates OTLP/HTTP JSON push alongside --metrics-port
  SYGIL_CONFIG_DIR              override .sygil config location (same as --config)
  SYGIL_VERIFY_TEMPLATES=1      verify bundled-template Sigstore sidecars at load time

Monitor URL format (printed by \`sygil run\`):
  http://localhost:3000/monitor?ws=<port>&workflow=<name>&token=<uuid>
Control clients (pause/cancel/human-review) must include ?token=<uuid>.

Docs: https://github.com/akshatvasisht/sygil — see CLAUDE.md for the full reference.
`);

  program.hook("preAction", () => {
    const opts = program.opts<{ config?: string; verbose?: boolean }>();
    if (opts.config) {
      process.env["SYGIL_CONFIG_DIR"] = opts.config;
    }
    if (opts.verbose) {
      setVerbose(true);
    }
  });

  return program;
}
