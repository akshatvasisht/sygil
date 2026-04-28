/**
 * Best-effort: extract the last well-formed JSON object from a text body.
 *
 * Used by CLI adapters as a FALLBACK when the agent's structured output
 * isn't carried by the NDJSON event protocol — the agent has emitted JSON
 * inline in stdout (e.g. inside a markdown fence or just printed at end).
 *
 * Implementation walks each `{` position and counts braces with string-
 * awareness to find the matching `}`. The earlier all-adapters implementation
 * used a single greedy regex `/\{[\s\S]*\}/g` which collapsed multi-JSON
 * outputs into one unparseable span — losing the structured output silently.
 * See agentcontext/build-log.md cycle 20 for the trigger that motivated
 * the rewrite.
 *
 * Worst case: O(n²) on pathological input, but adapter outputs are bounded
 * by the configured `maxBudgetUsd` / `maxTurns` so this is not a hot path.
 */
export function extractJsonFromOutput(text: string): unknown | undefined {
  let lastValid: unknown = undefined;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endIdx = j;
          try {
            lastValid = JSON.parse(text.slice(i, j + 1));
          } catch {
            // Not a valid JSON span starting at i; continue outer scan.
          }
          break;
        }
      }
    }
    // Skip past the matched closing brace so nested `{` inside an already-
    // parsed object aren't re-scanned and overwrite the outer match. If the
    // brace never balanced, advance one char and try again.
    i = endIdx >= 0 ? endIdx + 1 : i + 1;
  }
  return lastValid;
}
