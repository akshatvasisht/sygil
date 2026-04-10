import type { NodeConfig } from "@sigil/shared";

/**
 * Tool names that can modify the filesystem or execute arbitrary commands.
 * If a node uses any of these, it needs worktree isolation.
 */
const WRITE_TOOLS = new Set([
  "file_write",
  "shell_exec",
  "Edit",
  "Write",
  "Bash",
  "create_file",
  "execute_command",
  "run_terminal_command",
]);

/**
 * Determines whether a node needs worktree isolation based on its configured tools.
 *
 * - Returns `true` if the node has any tool that can write to the filesystem.
 * - Returns `true` (conservative default) if `tools` is undefined or empty.
 * - Returns `false` only for purely read-only tool sets.
 */
export function needsIsolation(nodeConfig: NodeConfig): boolean {
  const { tools } = nodeConfig;

  // Conservative default: if no tools specified, assume it needs isolation
  if (!tools || tools.length === 0) {
    return true;
  }

  return tools.some((tool) => WRITE_TOOLS.has(tool));
}
