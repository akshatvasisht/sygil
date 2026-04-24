import type { AdapterType, NodeConfig } from "../types/workflow.js";

/**
 * Catalog of tools each adapter is known to advertise as of this writing.
 * This is intentionally a best-effort reference list — it will drift behind
 * upstream CLIs and must NEVER block a run. The validator only emits warnings.
 *
 * The `null` sentinel means "any tool name is accepted" (e.g. local-oai
 * forwards tools to an OpenAI-compatible endpoint where function names are
 * arbitrary; echo ignores tools entirely). MCP prefixes (`mcp__<server>__*`)
 * are always allowed on any adapter.
 */
export const ADAPTER_TOOL_CATALOG: Record<AdapterType, ReadonlySet<string> | null> = {
  // Claude Code built-in tool names (subset that reaches adapter configs).
  "claude-sdk": new Set<string>([
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "BashOutput",
    "KillBash",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Task",
    "TodoWrite",
    "SlashCommand",
    "ExitPlanMode",
  ]),
  "claude-cli": new Set<string>([
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "BashOutput",
    "KillBash",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Task",
    "TodoWrite",
    "SlashCommand",
    "ExitPlanMode",
  ]),
  // Cursor headless mode ignores the tools allowlist but these are the names users expect.
  cursor: new Set<string>(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]),
  // Codex CLI's documented built-ins.
  codex: new Set<string>(["shell", "read", "edit", "write", "apply_patch"]),
  // Gemini CLI's documented built-ins.
  "gemini-cli": new Set<string>([
    "read_file",
    "write_file",
    "edit",
    "shell",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
  ]),
  // local-oai forwards arbitrary function names to the model.
  "local-oai": null,
  // echo ignores tools.
  echo: null,
};

export interface ToolValidationWarning {
  nodeId: string;
  adapter: AdapterType;
  unknownTools: string[];
  message: string;
}

function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Cross-check a node's `tools` list against the adapter's advertised catalog.
 * Returns zero or one warning per node — nodes without `tools`, with an empty
 * `tools` list, or on adapters whose catalog is `null` (wildcard) never warn.
 *
 * This is a load-time diagnostic only. Do NOT block execution on the result —
 * catalogs drift and MCP-injected tools always pass through.
 */
export function validateTools(
  nodeId: string,
  node: NodeConfig
): ToolValidationWarning | null {
  if (!node.tools || node.tools.length === 0) return null;
  const catalog = ADAPTER_TOOL_CATALOG[node.adapter];
  if (catalog === null) return null;
  const unknown = node.tools.filter((t) => !catalog.has(t) && !isMcpTool(t));
  if (unknown.length === 0) return null;
  return {
    nodeId,
    adapter: node.adapter,
    unknownTools: unknown,
    message: `Node "${nodeId}" (adapter "${node.adapter}") lists tools not in the known catalog: ${unknown.join(", ")}. This is likely a typo or a new upstream tool — the run will proceed.`,
  };
}

/**
 * Validate every node in a workflow graph. Returns one warning per node that
 * lists unknown tools (empty result == all clean).
 */
export function validateWorkflowTools(
  nodes: Record<string, NodeConfig>
): ToolValidationWarning[] {
  const warnings: ToolValidationWarning[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const w = validateTools(id, node);
    if (w) warnings.push(w);
  }
  return warnings;
}
