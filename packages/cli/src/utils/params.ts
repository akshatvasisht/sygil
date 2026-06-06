import chalk from "chalk";
import type { WorkflowGraph } from "@sygil/shared";
import { interpolateWorkflow } from "./workflow.js";

/**
 * Parse `--param key=value` pairs into a flat record.
 *
 * Shared by `run` and `fork`. The first `=` splits key from value, so values
 * may contain `=` (e.g. `--param query="a=b"`). Pairs with no `=` are a usage
 * error and exit 1. Empty keys are silently skipped (matching the prior inline
 * behaviour in both commands).
 */
export function parseParamPairs(pairs: string[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      console.error(chalk.red(`Invalid parameter format: "${pair}" — expected key=value`));
      process.exit(1);
    }
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (key) parameters[key] = value;
  }
  return parameters;
}

/**
 * Merge workflow parameter defaults with CLI-supplied overrides, enforce
 * required parameters, then interpolate `{{param}}` placeholders.
 *
 * Shared by `run` and `fork`. The two commands differ only in the message shown
 * when required parameters are missing (run points at `--param key=value`; fork
 * also notes that params aren't inherited from the parent), so that string is
 * passed in via `missingParamsHint`.
 *
 * Returns the interpolated workflow. On a missing-required or interpolation
 * error, prints the message and exits the process.
 */
export function resolveWorkflowParams(
  workflow: WorkflowGraph,
  cliParams: Record<string, string>,
  missingParamsHint: string,
): WorkflowGraph {
  const resolvedParams: Record<string, string> = {};

  // Apply defaults from graph.parameters first.
  if (workflow.parameters) {
    for (const [key, paramDef] of Object.entries(workflow.parameters)) {
      if (paramDef.default != null) {
        resolvedParams[key] = String(paramDef.default);
      }
    }
  }

  // CLI-supplied params override defaults.
  for (const [key, value] of Object.entries(cliParams)) {
    resolvedParams[key] = value;
  }

  // Validate required parameters are present.
  if (workflow.parameters) {
    const missing: string[] = [];
    for (const [key, paramDef] of Object.entries(workflow.parameters)) {
      if (paramDef.required && !(key in resolvedParams)) {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      console.error(
        chalk.red(`Missing required parameters: ${missing.join(", ")}\n${missingParamsHint}`),
      );
      process.exit(1);
    }
  }

  // Interpolate {{param}} placeholders in the workflow graph.
  try {
    return interpolateWorkflow(workflow, resolvedParams);
  } catch (err) {
    console.error(
      chalk.red(`Parameter interpolation failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  // Unreachable — process.exit() above terminates. Satisfies the compiler's
  // "not all code paths return a value" check without an `as` cast.
  throw new Error("unreachable");
}
