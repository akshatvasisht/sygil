import chalk from "chalk";
import { eventRenderData, type AgentEvent } from "@sygil/shared";

export type NodeStatus = "waiting" | "running" | "completed" | "failed";

export interface NodeMonitorState {
  status: NodeStatus;
  adapter: string;
  startedAt: number | null;
  elapsedMs: number;
  costUsd: number;
  tokenUsage: { input: number; output: number };
  recentEvents: Array<{ type: string; summary: string }>;
}

export interface TerminalMonitorState {
  nodes: Map<string, NodeMonitorState>;
  nodeOrder: string[];
  totalCostUsd: number;
  totalTokens: number;
  workflowName: string;
  startedAt: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const MAX_RECENT_EVENTS = 2;
const MAX_EVENT_SUMMARY_LEN = 60;
const SPINNER_INTERVAL_MS = 80;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    const tenths = Math.floor((ms % 1000) / 100);
    return `${totalSeconds}.${tenths}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function statusIcon(status: NodeStatus, spinnerFrame: number): string {
  switch (status) {
    case "waiting":
      return chalk.dim("○");
    case "running":
      return chalk.cyan(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!);
    case "completed":
      return chalk.green("✓");
    case "failed":
      return chalk.red("✗");
  }
}

function statusLabel(status: NodeStatus): string {
  switch (status) {
    case "waiting":
      return chalk.dim("waiting");
    case "running":
      return chalk.cyan("running");
    case "completed":
      return chalk.green("completed");
    case "failed":
      return chalk.red("failed");
  }
}

const STATUS_LABEL_WIDTH = 9; // "completed" is the longest

function renderTree(state: TerminalMonitorState, spinnerFrame: number): string {
  const { nodeOrder, nodes } = state;
  const lines: string[] = [];
  const count = nodeOrder.length;

  if (count === 0) {
    lines.push(chalk.dim("  No nodes"));
    lines.push("");
    lines.push(chalk.dim(`  Total: ${formatCost(state.totalCostUsd)}  ${formatTokenCount(state.totalTokens)} tokens`));
    return lines.join("\n");
  }

  const maxIdLen = Math.max(...nodeOrder.map((id) => id.length));

  for (let i = 0; i < count; i++) {
    const nodeId = nodeOrder[i]!;
    const node = nodes.get(nodeId);
    if (!node) continue;

    // Tree connector
    let connector: string;
    let continuationPrefix: string;
    if (count === 1) {
      connector = "─";
      continuationPrefix = "    ";
    } else if (i === 0) {
      connector = "┌─";
      continuationPrefix = chalk.dim("│") + "   ";
    } else if (i === count - 1) {
      connector = "└─";
      continuationPrefix = "    ";
    } else {
      connector = "├─";
      continuationPrefix = chalk.dim("│") + "   ";
    }

    const paddedId = nodeId.padEnd(maxIdLen);
    const icon = statusIcon(node.status, spinnerFrame);
    const rawLabel = statusLabel(node.status);
    const label = rawLabel.padEnd(STATUS_LABEL_WIDTH + (rawLabel.length - node.status.length));

    let timePart = "";
    if (node.status === "running" || node.status === "completed" || node.status === "failed") {
      timePart = chalk.dim(formatElapsed(node.elapsedMs));
    }

    let costPart = "";
    if (node.costUsd > 0) {
      costPart = chalk.dim(formatCost(node.costUsd));
    }

    const spinnerPart = node.status === "running" ? chalk.dim(" ···") : "";

    const segments = [
      `  ${chalk.dim(connector)} ${chalk.bold(paddedId)}  ${icon} ${label}`,
      timePart,
      costPart,
      spinnerPart,
    ].filter(Boolean);

    lines.push(segments.join("   "));

    // Recent events (up to 2)
    const events = node.recentEvents.slice(-MAX_RECENT_EVENTS);
    for (const ev of events) {
      lines.push(`  ${continuationPrefix} ${truncate(ev.summary, MAX_EVENT_SUMMARY_LEN)}`);
    }

    // Empty line between nodes (not after the last one)
    if (i < count - 1) {
      lines.push(`  ${continuationPrefix}`);
    }
  }

  lines.push("");
  lines.push(
    chalk.dim(`  Total: ${formatCost(state.totalCostUsd)}  ${formatTokenCount(state.totalTokens)} tokens`),
  );

  return lines.join("\n");
}

export function createTerminalMonitor(state: TerminalMonitorState): { update(): void; stop(): void } {
  let spinnerFrame = 0;
  let lastLineCount = 0;

  const isTTY = process.stdout.isTTY === true;

  const spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    if (isTTY) {
      writeFrame();
    }
  }, SPINNER_INTERVAL_MS);

  function writeFrame(): void {
    const output = renderTree(state, spinnerFrame);
    const outputLines = output.split("\n");

    if (isTTY && lastLineCount > 0) {
      // Move cursor up and clear previous output
      process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    }

    process.stdout.write(output + "\n");
    lastLineCount = outputLines.length;
  }

  function update(): void {
    writeFrame();
  }

  function stop(): void {
    clearInterval(spinnerInterval);
    writeFrame();
    process.stdout.write("\n");
  }

  return { update, stop };
}

export function logEvent(nodeId: string, event: { type: string; summary: string }): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  process.stdout.write(`[${hh}:${mm}:${ss}] ${nodeId}  ${event.type}: ${event.summary}\n`);
}

export function formatEventSummary(event: AgentEvent): { type: string; summary: string } {
  // Single source of truth: the shared `eventRenderData` projection. The CLI
  // flattens its { title, subtitle } into one summary line; the web renders the
  // same projection with its own icons/layout. New AgentEvent variants are
  // covered automatically (exhaustiveness enforced in eventRenderData).
  const d = eventRenderData(event);
  return { type: event.type, summary: d.subtitle ? `${d.title} ${d.subtitle}` : d.title };
}
