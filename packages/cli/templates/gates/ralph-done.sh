#!/usr/bin/env bash
# Ralph loop-back gate. Exits 0 (gate PASSES → scheduler exits the loop) when
# fix_plan.md has no unchecked TODOs left. Exits 1 (gate FAILS → scheduler
# re-queues the worker via adapter.resume) while any `- [ ]` line remains.
#
# The polarity matters: loop-back re-queue happens on gate FAILURE (see
# scheduler/index.ts:620 `if (!gateResult.passed)`). A "there is still work"
# predicate must therefore FAIL to keep the loop alive.
#
# Invoked by the `script` gate condition in templates/ralph.json. Runs with
# cwd = node outputDir (whatever `sygil run` was invoked from). Takes no args
# and receives only the documented whitelisted env.

set -u

PLAN="${SYGIL_OUTPUT_DIR:-.}/fix_plan.md"

if [ ! -f "$PLAN" ]; then
  echo "ralph-done: $PLAN not found — treating as failure (gate fails, loop continues so the worker can create it)" >&2
  exit 1
fi

# -E = extended regex so `\[ \]` parses predictably; -q = silent; -m1 = stop at first match.
if grep -Eqm1 '^[[:space:]]*- \[ \]' "$PLAN"; then
  # Unchecked TODO exists → loop must continue → gate must FAIL.
  exit 1
fi

# Every TODO is either checked off or escalated → loop terminates → gate PASSES.
exit 0
