#!/usr/bin/env node
// update-frontier.mjs — CLI wrapper invoked by the `score` node of optimize.json.
// Reads a candidate's eval-results.json + any inner-run checkpoint cost, updates
// the Pareto archive atomically, and prints a one-line summary to stdout.
//
// Usage:
//   node update-frontier.mjs \
//     --candidate <dir> \
//     --frontier <path>
//
// Expectations:
//   <candidate>/eval-results.json = { cases: [{passed, costUsd?}], passRate, costUsd, innerRunId? }
//   <frontier> exists or will be created with []
//
// The frontier file is rewritten atomically (tmp + rename).

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { updateFrontier, totalCost } from "./pareto.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = val;
    i++;
  }
  return out;
}

async function readJsonOrDefault(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidateDir = args.candidate;
  const frontierPath = args.frontier;

  if (!candidateDir || !frontierPath) {
    console.error("usage: update-frontier.mjs --candidate <dir> --frontier <path>");
    process.exit(2);
  }

  const candidateId = basename(candidateDir.replace(/\/+$/, ""));
  const evalResultsPath = join(candidateDir, "eval-results.json");

  let evalResults;
  try {
    await stat(evalResultsPath);
    evalResults = JSON.parse(await readFile(evalResultsPath, "utf8"));
  } catch {
    console.error(`eval-results.json not found for ${candidateId} — recording failure.`);
    evalResults = { cases: [], passRate: 0, costUsd: 0 };
  }

  const entry = {
    id: candidateId,
    gatePassRate: Number.isFinite(evalResults.passRate) ? evalResults.passRate : 0,
    costUsd: Number.isFinite(evalResults.costUsd) ? evalResults.costUsd : 0,
    ...(evalResults.durationMs != null ? { durationMs: evalResults.durationMs } : {}),
    ...(evalResults.innerRunId ? { innerRunId: evalResults.innerRunId } : {}),
  };

  const archive = await readJsonOrDefault(frontierPath, []);
  if (!Array.isArray(archive)) {
    console.error(`frontier at ${frontierPath} is not an array — refusing to overwrite`);
    process.exit(1);
  }

  const next = updateFrontier(archive, entry);
  const cumulativeCost = totalCost(next);

  await atomicWriteJson(frontierPath, next);

  const admitted = next.some((c) => c.id === entry.id);
  console.log(
    JSON.stringify({
      candidate: entry.id,
      gatePassRate: entry.gatePassRate,
      costUsd: entry.costUsd,
      admittedToFrontier: admitted,
      frontierSize: next.length,
      cumulativeCostUsd: cumulativeCost,
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
