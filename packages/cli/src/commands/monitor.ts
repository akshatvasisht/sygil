import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import chalk from "chalk";
import type { WsServerEvent } from "@sygil/shared";
import type {
  TerminalMonitorState,
  NodeMonitorState,
} from "../monitor/terminal-renderer.js";
import {
  createTerminalMonitor,
  formatEventSummary,
  logEvent,
} from "../monitor/terminal-renderer.js";
import { topoSort } from "../utils/topo-sort.js";

interface ActiveMonitorInfo {
  port: number;
  token: string;
  workflowId: string;
}

function parseWsUrl(raw: string): {
  url: string;
  token: string;
  workflowId: string;
} {
  const parsed = new URL(raw);
  const token = parsed.searchParams.get("token") ?? "";
  const workflowId = parsed.searchParams.get("workflow") ?? "";
  return { url: raw, token, workflowId };
}

async function readActiveMonitor(): Promise<ActiveMonitorInfo | null> {
  const configDir = process.env["SYGIL_CONFIG_DIR"] || ".sygil";
  const filePath = join(configDir, "active-monitor.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data !== null &&
      "port" in data &&
      "token" in data &&
      "workflowId" in data &&
      typeof (data as ActiveMonitorInfo).port === "number" &&
      typeof (data as ActiveMonitorInfo).token === "string" &&
      typeof (data as ActiveMonitorInfo).workflowId === "string"
    ) {
      return data as ActiveMonitorInfo;
    }
    return null;
  } catch {
    return null;
  }
}


export async function monitorCommand(
  runId: string | undefined,
  options: { url?: string }
): Promise<void> {
  let wsUrl: string;
  let workflowId: string;

  if (options.url) {
    const parsed = parseWsUrl(options.url);
    wsUrl = parsed.url;
    workflowId = parsed.workflowId;
  } else {
    const info = await readActiveMonitor();
    if (!info) {
      console.error(
        chalk.red(
          "No active workflow found. Start one with 'sygil run' or pass --url."
        )
      );
      console.error(chalk.dim("Recent runs: sygil list"));
      process.exit(1);
    }
    wsUrl = `ws://127.0.0.1:${info.port}?token=${info.token}`;
    workflowId = info.workflowId;
  }

  const isTTY = process.stdout.isTTY === true;

  const state: TerminalMonitorState = {
    workflowName: "",
    nodes: new Map<string, NodeMonitorState>(),
    nodeOrder: [],
    totalCostUsd: 0,
    totalTokens: 0,
    startedAt: Date.now(),
  };

  const tui = isTTY ? createTerminalMonitor(state) : null;
  let elapsedInterval: ReturnType<typeof setInterval> | undefined;

  const ws = new WebSocket(wsUrl);

  function cleanup(): void {
    if (elapsedInterval !== undefined) {
      clearInterval(elapsedInterval);
      elapsedInterval = undefined;
    }
    tui?.stop();
  }

  function updateTotalCost(): void {
    let total = 0;
    for (const [, node] of state.nodes) {
      total += node.costUsd;
    }
    state.totalCostUsd = total;
  }

  function updateTotalTokens(): void {
    let total = 0;
    for (const [, node] of state.nodes) {
      total += node.tokenUsage.input + node.tokenUsage.output;
    }
    state.totalTokens = total;
  }

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", workflowId }));

    elapsedInterval = setInterval(() => {
      const now = Date.now();
      for (const [, node] of state.nodes) {
        if (node.status === "running" && node.startedAt !== null) {
          node.elapsedMs = now - node.startedAt;
        }
      }
      tui?.update();
    }, 100);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let event: WsServerEvent;
    try {
      event = JSON.parse(String(data)) as WsServerEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "workflow_start": {
        state.workflowName = event.graph.name;
        state.startedAt = Date.now();
        const nodeIds = Object.keys(event.graph.nodes);
        state.nodeOrder = topoSort(nodeIds, event.graph.edges);
        for (const nodeId of nodeIds) {
          const config = event.graph.nodes[nodeId]!;
          state.nodes.set(nodeId, {
            status: "waiting",
            adapter: config.adapter,
            startedAt: null,
            elapsedMs: 0,
            costUsd: 0,
            tokenUsage: { input: 0, output: 0 },
            recentEvents: [],
          });
        }
        if (!isTTY) {
          logEvent("workflow", { type: "status", summary: `started "${event.graph.name}"` });
        }
        tui?.update();
        break;
      }

      case "node_start": {
        const node = state.nodes.get(event.nodeId);
        if (node) {
          node.status = "running";
          node.startedAt = Date.now();
        }
        if (!isTTY) {
          logEvent(event.nodeId, { type: "status", summary: "running" });
        }
        tui?.update();
        break;
      }

      case "node_event": {
        const node = state.nodes.get(event.nodeId);
        if (node) {
          const summary = formatEventSummary(event.event);
          node.recentEvents.push(summary);
          if (node.recentEvents.length > 3) {
            node.recentEvents.splice(0, node.recentEvents.length - 3);
          }
          if (event.event.type === "cost_update") {
            node.costUsd = event.event.totalCostUsd;
            updateTotalCost();
            updateTotalTokens();
          }
          if (!isTTY) {
            logEvent(event.nodeId, summary);
          }
        }
        tui?.update();
        break;
      }

      case "node_end": {
        const node = state.nodes.get(event.nodeId);
        if (node) {
          node.status = event.result.exitCode === 0 ? "completed" : "failed";
          node.elapsedMs = event.result.durationMs;
          if (event.result.costUsd != null) {
            node.costUsd = event.result.costUsd;
          }
          if (event.result.tokenUsage) {
            node.tokenUsage = event.result.tokenUsage;
          }
          updateTotalCost();
          updateTotalTokens();
        }
        if (!isTTY) {
          const icon = node?.status === "completed" ? "✓" : "✗";
          const elapsed = node ? `${(node.elapsedMs / 1000).toFixed(1)}s` : "";
          logEvent(event.nodeId, { type: "status", summary: `${icon} ${node?.status ?? "ended"}  ${elapsed}` });
        }
        tui?.update();
        break;
      }

      case "workflow_end": {
        tui?.update();
        cleanup();
        const statusText = event.success
          ? chalk.green("completed")
          : chalk.red("failed");
        console.log(
          `\n${chalk.bold("Workflow")} ${statusText} in ${(event.durationMs / 1000).toFixed(1)}s`
        );
        if (event.totalCostUsd != null) {
          console.log(`Total cost: ${chalk.yellow(`$${event.totalCostUsd.toFixed(4)}`)}`);
        }
        ws.close();
        break;
      }

      case "workflow_error": {
        cleanup();
        console.error(chalk.red(`\nWorkflow error: ${event.message}`));
        ws.close();
        break;
      }

      default:
        tui?.update();
        break;
    }
  });

  ws.on("close", () => {
    cleanup();
    console.log(chalk.dim("Disconnected from workflow monitor."));
  });

  ws.on("error", () => {
    cleanup();
    console.error(chalk.red("Disconnected from workflow monitor."));
  });

  // Graceful shutdown on Ctrl+C
  const onSigint = (): void => {
    cleanup();
    ws.close();
    process.exit(0);
  };
  process.once("SIGINT", onSigint);

  // Keep the process alive until WebSocket closes
  await new Promise<void>((resolve) => {
    ws.on("close", resolve);
  });
}
