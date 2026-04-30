import { readFile } from "node:fs/promises";
import type { AdapterType, WorkflowGraph } from "@sygil/shared";
import { WorkflowGraphSchema } from "@sygil/shared";
import {
  isVerificationEnabled,
  verifyTemplateSignature,
} from "./template-signature.js";

/**
 * Adapters that accept `NodeConfig.tools` for cross-adapter shape parity but
 * have no upstream allowlist flag. They warn-ignore at runtime; we refuse at
 * load time unless the node opts in via `allowUnsafeToolsBypass: true`.
 * See `agentcontext/build-log.md` 2026-04-24 entry for context.
 */
const TOOLS_BYPASS_ADAPTERS: ReadonlySet<AdapterType> = new Set<AdapterType>([
  "codex",
  "cursor",
  "gemini-cli",
]);

function assertToolsAllowlistSupported(graph: WorkflowGraph): void {
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (!TOOLS_BYPASS_ADAPTERS.has(node.adapter)) continue;
    if (!node.tools || node.tools.length === 0) continue;
    if (node.allowUnsafeToolsBypass === true) continue;
    throw new Error(
      `Workflow validation failed: node "${nodeId}" uses adapter "${node.adapter}" with a non-empty tools allowlist, ` +
        `but "${node.adapter}" has no upstream tool-allowlist flag and would silently ignore it. ` +
        `Set "allowUnsafeToolsBypass: true" on the node to acknowledge the unsandboxed run, ` +
        `or switch to an adapter that honors tools (claude-cli, claude-sdk, local-oai).`,
    );
  }
}

/**
 * Reject regex gate patterns with obvious catastrophic-backtracking shapes.
 *
 * `regex.test()` is synchronous and cannot be interrupted by an abort signal
 * once started. A pattern with nested unbounded quantifiers — e.g. `(a+)+`,
 * `(a*)*`, `(.*)+`, `(?:a+)+` — matched against modestly-sized adversarial
 * input causes exponential backtracking and hangs the scheduler indefinitely.
 *
 * This heuristic catches the textbook star-height-2 form: a group whose body
 * contains an unbounded quantifier (`+` or `*`), itself followed by an
 * unbounded quantifier. It does NOT catch every ReDoS pattern (e.g.
 * overlapping alternation `(a|a)*` is missed), but rejects the cases an
 * attacker most commonly reaches for in a crafted workflow.json.
 *
 * Trigger that motivated this: a workflow imported via `sygil import-template`
 * (signature verification is opt-in via SYGIL_VERIFY_TEMPLATES=1, so unsigned
 * workflows pass straight to gate evaluation).
 */
const REDOS_HEURISTIC = /\([^)]*[+*][^)]*\)[+*]/;

function assertRegexPatternsSafe(graph: WorkflowGraph): void {
  for (const edge of graph.edges) {
    if (!edge.gate) continue;
    for (const condition of edge.gate.conditions) {
      if (condition.type !== "regex") continue;
      if (REDOS_HEURISTIC.test(condition.pattern)) {
        throw new Error(
          `Workflow validation failed: edge "${edge.id}" has a regex gate with pattern "${condition.pattern}" ` +
            `that contains nested unbounded quantifiers (e.g. \`(a+)+\`). This shape causes catastrophic ` +
            `backtracking in JavaScript's regex engine and would hang the scheduler indefinitely on ` +
            `adversarial input. Rewrite the pattern without nested \`+\`/\`*\` on a group, or split into ` +
            `multiple simpler gates.`,
        );
      }
    }
  }
}

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

  const graph = result.data as WorkflowGraph;
  validateWorkflowInvariants(graph);
  return graph;
}

/**
 * Post-schema invariant checks (tools allowlist + ReDoS heuristic). Called by
 * `loadWorkflow` for the file path and by `sygil run -` (stdin) so both
 * code paths share the same security surface. Every new entry point that
 * constructs a `WorkflowGraph` from raw input must call this.
 */
export function validateWorkflowInvariants(graph: WorkflowGraph): void {
  assertToolsAllowlistSupported(graph);
  assertRegexPatternsSafe(graph);
}
