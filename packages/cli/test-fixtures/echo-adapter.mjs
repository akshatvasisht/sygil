#!/usr/bin/env node

/**
 * Echo Adapter — deterministic stub for E2E testing.
 *
 * Outputs NDJSON events in the same wire format as claude-cli,
 * controlled entirely by environment variables:
 *
 *   ECHO_PROMPT       — the prompt text (passed by EchoAdapter from NodeConfig.prompt)
 *   ECHO_EVENTS       — JSON array of NDJSON objects to emit (overrides default behavior)
 *   ECHO_EXIT_CODE    — exit code (default: 0)
 *   ECHO_DELAY_MS     — ms between events (default: 5)
 *   ECHO_OUTPUT_TEXT   — text to emit as a "text" event (default: ECHO_PROMPT or "echo output")
 *   ECHO_WRITE_FILE   — if set, write this filename in cwd with ECHO_WRITE_CONTENT
 *   ECHO_WRITE_CONTENT — content to write to ECHO_WRITE_FILE (default: "ok")
 *   ECHO_COST         — cost to report (default: 0.001)
 *   ECHO_DURATION_MS  — total time before exit (default: 50)
 *   ECHO_STALL        — if "true", emit a stall-like behavior (hang without exiting)
 *   ECHO_COUNTER_FILE — path to invocation counter file (for loop-back retry testing)
 *   ECHO_EVENTS_SEQ   — JSON array of arrays; index by invocation count from counter file
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const exitCode = parseInt(process.env.ECHO_EXIT_CODE ?? "0", 10);
const delayMs = parseInt(process.env.ECHO_DELAY_MS ?? "5", 10);
const durationMs = parseInt(process.env.ECHO_DURATION_MS ?? "50", 10);
const outputText = process.env.ECHO_OUTPUT_TEXT ?? process.env.ECHO_PROMPT ?? "echo output";
const cost = parseFloat(process.env.ECHO_COST ?? "0.001");
const writeFile = process.env.ECHO_WRITE_FILE;
const writeContent = process.env.ECHO_WRITE_CONTENT ?? "ok";
const counterFile = process.env.ECHO_COUNTER_FILE;
const stall = process.env.ECHO_STALL === "true";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  // Track invocation count for loop-back testing
  let invocationCount = 0;
  if (counterFile) {
    try {
      invocationCount = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    } catch {
      invocationCount = 0;
    }
    writeFileSync(counterFile, String(invocationCount + 1));
  }

  // Determine events to emit
  let events;

  // ECHO_EVENTS_SEQ: per-invocation event sequences (for loop-back testing)
  if (process.env.ECHO_EVENTS_SEQ) {
    const seq = JSON.parse(process.env.ECHO_EVENTS_SEQ);
    events = seq[invocationCount] ?? seq[seq.length - 1];
  }
  // ECHO_EVENTS: explicit events
  else if (process.env.ECHO_EVENTS) {
    events = JSON.parse(process.env.ECHO_EVENTS);
  }
  // Default: text + cost
  else {
    events = [
      { type: "text", text: outputText },
      { type: "cost", total_cost_usd: cost },
    ];
  }

  // Write file if requested
  if (writeFile) {
    const filePath = join(process.cwd(), writeFile);
    writeFileSync(filePath, writeContent);
    events.push({ type: "tool_use", name: "Write", input: { path: writeFile, content: writeContent } });
    events.push({ type: "tool_result", name: "Write", content: "ok", is_error: false });
  }

  // Emit events with delay
  for (const event of events) {
    emit(event);
    if (delayMs > 0) await sleep(delayMs);
  }

  // Stall behavior — hang after emitting events
  if (stall) {
    await sleep(durationMs * 10);
    process.exit(1);
    return;
  }

  // Wait for remaining duration
  const elapsed = events.length * delayMs;
  if (elapsed < durationMs) {
    await sleep(durationMs - elapsed);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  emit({ type: "error", message: err.message });
  process.exit(1);
});
