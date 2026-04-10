import chalk from "chalk";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { replayEvents } from "../scheduler/event-replay.js";
import type { RecordedEvent } from "@sigil/shared";

export async function replayCommand(
  runId: string,
  options: { node?: string; speed?: string }
): Promise<void> {
  const runDir = join(process.cwd(), ".sigil", "runs", runId);

  if (!existsSync(runDir)) {
    console.error(chalk.red(`Run directory not found: ${runDir}`));
    process.exit(1);
  }

  const speed = options.speed !== undefined ? parseFloat(options.speed) : 1;
  if (isNaN(speed) || speed < 0) {
    console.error(chalk.red("Invalid speed — must be a non-negative number"));
    process.exit(1);
  }

  console.log(
    chalk.bold(`\nReplaying run ${chalk.cyan(runId)}`) +
      (options.node ? chalk.dim(` (node: ${options.node})`) : "") +
      chalk.dim(` at ${speed}× speed\n`)
  );

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  let eventCount = 0;
  try {
    for await (const event of replayEvents(runDir, {
      ...(options.node !== undefined ? { nodeId: options.node } : {}),
      speed,
      signal: ac.signal,
    })) {
      eventCount++;
      printEvent(event);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log(chalk.dim("\nReplay interrupted."));
    } else {
      throw err;
    }
  }

  console.log(chalk.dim(`\n${eventCount} events replayed.\n`));
}

function printEvent(event: RecordedEvent): void {
  const ts = new Date(event.timestamp).toISOString().slice(11, 23); // HH:MM:SS.mmm
  const nodeId = chalk.cyan(event.nodeId);

  const inner = event.event;
  switch (inner.type) {
    case "text_delta":
      process.stdout.write(inner.text);
      break;
    case "tool_call":
      console.log(
        chalk.dim(`[${ts}]`) +
          ` ${nodeId} ${chalk.yellow(`→ ${inner.tool}`)}(${JSON.stringify(inner.input).slice(0, 80)})`
      );
      break;
    case "tool_result":
      console.log(
        chalk.dim(`[${ts}]`) + ` ${nodeId} ${chalk.dim(`✓ ${inner.tool}`)}`
      );
      break;
    case "error":
      console.log(
        chalk.dim(`[${ts}]`) + ` ${nodeId} ${chalk.red(`✗ ${inner.message}`)}`
      );
      break;
    case "cost_update":
      // Skip — not interesting for replay
      break;
    default:
      console.log(
        chalk.dim(`[${ts}]`) + ` ${nodeId} ${chalk.dim(inner.type)}`
      );
  }
}
