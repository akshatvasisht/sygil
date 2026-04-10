import { readFile } from "node:fs/promises";
import type { WorkflowGraph } from "@sigil/shared";
import { WorkflowGraphSchema } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Parameter interpolation
// ---------------------------------------------------------------------------

/**
 * Replace all `{{paramName}}` placeholders in a WorkflowGraph with the
 * supplied parameter values. Throws if any referenced parameter is missing.
 */
export function interpolateWorkflow(
  graph: WorkflowGraph,
  params: Record<string, string>
): WorkflowGraph {
  const json = JSON.stringify(graph);
  const interpolated = json.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    // Escape the value for safe embedding inside a JSON string.
    // JSON.stringify produces `"value"` with all special chars escaped;
    // slice off the surrounding quotes to get the escaped interior.
    return JSON.stringify(params[key]!).slice(1, -1);
  });

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
