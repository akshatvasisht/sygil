import { readFile } from "node:fs/promises";
import type { WorkflowGraph } from "@sygil/shared";
import { WorkflowGraphSchema } from "@sygil/shared";
import {
  isVerificationEnabled,
  verifyTemplateSignature,
} from "./template-signature.js";

// ---------------------------------------------------------------------------
// Parameter interpolation
// ---------------------------------------------------------------------------

// Sentinels used by the two-pass `{{{{` / `}}}}` escape mechanism. Unicode
// control chars that cannot appear inside a JSON string literal, so they
// cannot collide with legitimate prompt content after JSON.stringify.
const ESCAPE_OPEN_SENTINEL = "\u0000SYGIL_ESC_OPEN\u0000";
const ESCAPE_CLOSE_SENTINEL = "\u0000SYGIL_ESC_CLOSE\u0000";

/**
 * Replace all `{{paramName}}` placeholders in a WorkflowGraph with the
 * supplied parameter values. Throws if any referenced parameter is missing.
 *
 * Literal `{{` / `}}` can be emitted by doubling the braces: `{{{{foo}}}}`
 * renders as the string `{{foo}}` after interpolation. This is the only
 * escape syntax supported — we intentionally avoid a full template engine
 * (see decisions.md 2026-04-20 "Parameter interpolation stays string-literal-only").
 */
export function interpolateWorkflow(
  graph: WorkflowGraph,
  params: Record<string, string>
): WorkflowGraph {
  const json = JSON.stringify(graph);

  // Pass 1: protect doubled braces so pass 2 cannot see them.
  const protectedSource = json
    .replaceAll("{{{{", ESCAPE_OPEN_SENTINEL)
    .replaceAll("}}}}", ESCAPE_CLOSE_SENTINEL);

  // Pass 2: interpolate remaining {{param}} placeholders.
  const interpolatedRaw = protectedSource.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    // Escape the value for safe embedding inside a JSON string.
    // JSON.stringify produces `"value"` with all special chars escaped;
    // slice off the surrounding quotes to get the escaped interior.
    return JSON.stringify(params[key]!).slice(1, -1);
  });

  // Pass 3: restore the escaped braces as literal `{{` / `}}`.
  const interpolated = interpolatedRaw
    .replaceAll(ESCAPE_OPEN_SENTINEL, "{{")
    .replaceAll(ESCAPE_CLOSE_SENTINEL, "}}");

  // Re-validate against the schema after interpolation to prevent
  // structural injection via crafted parameter values.
  const parsed: unknown = JSON.parse(interpolated);
  const result = WorkflowGraphSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Workflow validation failed after parameter interpolation:\n${issues}`);
  }
  return result.data as WorkflowGraph;
}

// ---------------------------------------------------------------------------
// Load and validate a workflow file
// ---------------------------------------------------------------------------

export async function loadWorkflow(filePath: string): Promise<WorkflowGraph> {
  // Optional Sigstore sidecar verification. Runs BEFORE JSON parse so
  // a tampered file is rejected without the scheduler ever seeing its
  // contents. Silently no-ops unless SYGIL_VERIFY_TEMPLATES=1 is set.
  if (isVerificationEnabled()) {
    const outcome = await verifyTemplateSignature(filePath);
    if (outcome.status === "failed") {
      throw new Error(
        `Template signature verification failed for "${filePath}": ${outcome.reason}`,
      );
    }
    if (outcome.status === "verifier-unavailable") {
      throw new Error(outcome.reason);
    }
    // "verified", "no-signature", and "disabled" all allow the load to proceed.
    // "no-signature" is the fail-open path for user-authored workflows.
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read workflow file "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Workflow file "${filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = WorkflowGraphSchema.safeParse(json);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Workflow validation failed:\n${issues}`);
  }

  return result.data as WorkflowGraph;
}
