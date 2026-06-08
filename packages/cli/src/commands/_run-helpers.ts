import chalk from "chalk";
import { getAdapter } from "../adapters/index.js";
import { buildEnvironmentSnapshot, diffEnvironment } from "../scheduler/environment.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import type { EnvironmentSnapshot, WorkflowGraph, AgentEvent } from "@sygil/shared";

/**
 * Drift detection (opt-in via --check-drift). When the flag is set and the
 * checkpoint stored an environment snapshot, refuse to resume/fork on any
 * version/key/platform delta. Default behavior is to proceed silently —
 * most resumes are routine ("agent crashed, run again") and treating any
 * version bump as a hard block was too noisy in practice.
 */
export async function checkEnvironmentDrift(
  enabled: boolean,
  storedEnv: EnvironmentSnapshot | undefined,
  workflow: WorkflowGraph,
): Promise<void> {
  if (enabled && storedEnv) {
    let drift: string[] = [];
    try {
      const currentEnv = await buildEnvironmentSnapshot(workflow, getAdapter);
      drift = diffEnvironment(storedEnv, currentEnv);
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
}

/**
 * Attaches the standard node_start / node_event / node_end console.log
 * listeners used by resume and fork for simple terminal progress reporting.
 */
export function wireSimpleTerminalListeners(scheduler: WorkflowScheduler): void {
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
}
