#!/usr/bin/env bash
# Gate: passes (exit 0) while cumulative outer-loop cost is under budget.
# Used on the score → propose loop-back edge in optimize.json.
#
# Reads optimize-config.json (budgetUsd) and frontier.json (totalCostUsd) from
# the gate's cwd (= the score node's outputDir = the optimize run's outputDir).
#
# Rules:
#   - If optimize-config.json is missing, budgetUsd = 0 → fail (exit 1).
#   - If frontier.json is missing, cumulative = 0 → pass as long as budget > 0.
#   - Otherwise pass iff sum(candidate.costUsd) < budgetUsd.
#
# No jq dependency — uses a tiny node one-liner for JSON parsing.

set -u

CONFIG="${OPTIMIZE_CONFIG:-optimize-config.json}"
FRONTIER="${FRONTIER:-frontier.json}"

if [ ! -f "$CONFIG" ]; then
  echo "check-budget: $CONFIG not found — failing closed" >&2
  exit 1
fi

BUDGET=$(node -e "try { process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).budgetUsd ?? 0)) } catch { process.stdout.write('0') }" "$CONFIG")

if [ ! -f "$FRONTIER" ]; then
  CUMULATIVE=0
else
  CUMULATIVE=$(node -e "try { const a = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(Array.isArray(a) ? a.reduce((s,c)=>s+(Number.isFinite(c.costUsd)?c.costUsd:0),0) : 0)) } catch { process.stdout.write('0') }" "$FRONTIER")
fi

RESULT=$(node -e "process.stdout.write(Number(process.argv[1]) < Number(process.argv[2]) ? 'under' : 'over')" "$CUMULATIVE" "$BUDGET")

echo "check-budget: budget=\$${BUDGET} cumulative=\$${CUMULATIVE} -> ${RESULT}" >&2

if [ "$RESULT" = "under" ]; then
  exit 0
else
  exit 1
fi
