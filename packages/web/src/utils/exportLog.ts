import type { WsServerEvent, WorkflowRunState } from "@sigil/shared";

export function exportAsJson(state: WorkflowRunState | null, events: WsServerEvent[]): string {
  return JSON.stringify({ state, events, exportedAt: new Date().toISOString() }, null, 2);
}

export function exportAsMarkdown(state: WorkflowRunState | null, events: WsServerEvent[]): string {
  const lines: string[] = [];
  lines.push(`# Workflow Run: ${state?.workflowName ?? "Unknown"}`);
  lines.push(`**Status:** ${state?.status ?? "unknown"}`);
  if (state?.startedAt && state?.completedAt) {
    const durationMs = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
    lines.push(`**Duration:** ${(durationMs / 1000).toFixed(1)}s`);
  }
  if (state?.totalCostUsd) {
    lines.push(`**Total cost:** $${state.totalCostUsd.toFixed(4)}`);
  }
  lines.push("");
  lines.push("## Nodes");
  for (const [nodeId, result] of Object.entries(state?.nodeResults ?? {})) {
    lines.push(`### ${nodeId}`);
    lines.push(`- Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.costUsd) lines.push(`- Cost: $${result.costUsd.toFixed(4)}`);
    lines.push("");
  }
  lines.push("## Event Log");
  for (const event of events) {
    lines.push(`- [${event.type}] ${JSON.stringify(event)}`);
  }
  return lines.join("\n");
}

export function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
