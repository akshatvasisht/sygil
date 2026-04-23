#!/usr/bin/env node
/**
 * Replay-CI — regression harness for the 2026-04-16 determinism contract.
 *
 * Reads a checked-in fixture of recorded NDJSON events, feeds it through the
 * same replay pipeline `sygil replay` uses (`scheduler/event-replay.ts > replayEvents`),
 * and asserts that the yielded event tuples structurally match the recorded
 * log. Timestamps are compared on ordering and monotonicity only — absolute
 * values would flake across machines.
 *
 * Exit 0 on match, 1 on divergence. Prints a unified diff of the first
 * mismatching tuple to make regressions obvious.
 *
 * Used by CI (`npm run replay:ci`) and locally to validate determinism before
 * shipping scheduler / event-recorder changes. Fail-closed on mismatch — the
 * fixture is frozen and regenerating it is an explicit, human-reviewed action.
 */

import { readdir, readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "..", "templates", "__replay-fixtures__");
const DEFAULT_FIXTURE = "tdd-feature-v1";

/**
 * Extract the structural tuple we assert on. Excludes timestamps (wall-clock),
 * absolute paths (vary by checkout dir), and auth tokens (regenerated per run).
 */
function structuralTuple(recorded) {
  const { nodeId, event } = recorded;
  // Only preserve fields that are part of the determinism contract.
  switch (event.type) {
    case "text_delta":
      return { nodeId, type: event.type, text: event.text };
    case "tool_call":
      return { nodeId, type: event.type, tool: event.tool, input: event.input };
    case "tool_result":
      return {
        nodeId,
        type: event.type,
        tool: event.tool,
        output: event.output,
        success: event.success,
      };
    case "file_write":
      return { nodeId, type: event.type, path: event.path };
    case "shell_exec":
      return { nodeId, type: event.type, command: event.command, exitCode: event.exitCode };
    case "cost_update":
      return { nodeId, type: event.type, totalCostUsd: event.totalCostUsd };
    case "error":
      return { nodeId, type: event.type, message: event.message };
    case "stall":
      return { nodeId, type: event.type, reason: event.reason };
    case "adapter_failover":
      return {
        nodeId,
        type: event.type,
        fromAdapter: event.fromAdapter,
        toAdapter: event.toAdapter,
        reason: event.reason,
      };
    case "retry_scheduled":
      return {
        nodeId,
        type: event.type,
        attempt: event.attempt,
        nextAttempt: event.nextAttempt,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    case "context_set":
      return { nodeId, type: event.type, key: event.key };
    case "hook_result":
      return {
        nodeId,
        type: event.type,
        hook: event.hook,
        exitCode: event.exitCode,
      };
    default:
      return { nodeId, type: event.type };
  }
}

async function readFixtureNodes(fixtureDir) {
  const nodesDir = join(fixtureDir, "nodes");
  const files = await readdir(nodesDir);
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".ndjson")) continue;
    const nodeId = f.replace(/\.ndjson$/, "");
    const raw = await readFile(join(nodesDir, f), "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const events = lines.map((line) => JSON.parse(line));
    for (const e of events) {
      if (e.nodeId !== nodeId) {
        throw new Error(
          `Fixture file nodes/${f} contains event with nodeId="${e.nodeId}" — expected "${nodeId}"`,
        );
      }
    }
    out.push({ nodeId, events });
  }
  return out;
}

/**
 * Replay the fixture through the actual scheduler/event-replay pipeline by
 * stage-coping fixture events into a temp runs dir and invoking `replayEvents`.
 * speed=0 = instant (no wall-clock waits).
 */
async function replayFixture(fixtureDir) {
  const tmp = await mkdtemp(join(tmpdir(), "sygil-replay-ci-"));
  try {
    const runDir = join(tmp, "run");
    const eventsDir = join(runDir, "events");
    await mkdir(eventsDir, { recursive: true });

    const nodesDir = join(fixtureDir, "nodes");
    const files = await readdir(nodesDir);
    for (const f of files) {
      if (!f.endsWith(".ndjson")) continue;
      const src = join(nodesDir, f);
      const dst = join(eventsDir, f);
      await writeFile(dst, await readFile(src, "utf8"), "utf8");
    }

    // Import from the built CLI dist so this script has no TS runtime dep.
    const replayModule = await import("../dist/scheduler/event-replay.js");
    const { replayEvents } = replayModule;

    const out = [];
    for await (const event of replayEvents(runDir, { speed: 0 })) {
      out.push(event);
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function diffTuples(a, b) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  return `  recorded:  ${aStr}\n  replayed:  ${bStr}`;
}

async function main() {
  const fixtureName = process.argv[2] ?? DEFAULT_FIXTURE;
  const fixtureDir = join(FIXTURE_ROOT, fixtureName);

  console.log(`[replay-ci] fixture: ${fixtureName}`);

  const byNode = await readFixtureNodes(fixtureDir);
  const recorded = [];
  for (const { events } of byNode) {
    for (const e of events) recorded.push(e);
  }
  recorded.sort((a, b) => a.timestamp - b.timestamp);

  const replayed = await replayFixture(fixtureDir);

  if (replayed.length !== recorded.length) {
    console.error(
      `[replay-ci] FAIL — event count mismatch: recorded=${recorded.length} replayed=${replayed.length}`,
    );
    process.exit(1);
  }

  for (let i = 0; i < recorded.length; i++) {
    const r = structuralTuple(recorded[i]);
    const p = structuralTuple(replayed[i]);
    if (JSON.stringify(r) !== JSON.stringify(p)) {
      console.error(`[replay-ci] FAIL — tuple mismatch at index ${i}:`);
      console.error(diffTuples(r, p));
      process.exit(1);
    }
  }

  console.log(`[replay-ci] OK — ${recorded.length} event tuples match across ${byNode.length} nodes`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[replay-ci] ERROR — ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
