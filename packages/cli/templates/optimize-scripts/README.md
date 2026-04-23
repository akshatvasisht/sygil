# optimize-scripts

Helper scripts for `optimize.json`, the outer-loop workflow optimizer template (decisions.md 2026-04-20).

All scripts are pure Node with no dependencies — they can be invoked from any
sygil run working directory that has copies of these files, or referenced
directly from this templates/ directory.

## Scripts

### `pareto.mjs`

Pure functions for Pareto dominance and archive update. No I/O.
Objective: `gatePassRate` (max), `costUsd` (min).

- `dominates(a, b)` — does `a` strictly dominate `b`?
- `updateFrontier(archive, entry)` — returns new archive with `entry` merged
 and any dominated entries pruned. Never mutates the input.
- `totalCost(archive)` — sum of `costUsd` across archive.

Exported as ESM so both Node scripts and vitest tests (`pareto.test.ts`) can
import it.

### `update-frontier.mjs`

CLI wrapper invoked by the `score` node.

```
node update-frontier.mjs --candidate <dir> --frontier <path>
```

Reads `<candidate>/eval-results.json`, updates `<frontier>` atomically (tmp +
rename), prints a one-line JSON summary to stdout.

Expected `eval-results.json` shape (written by the `evaluate` node):

```json
{
 "cases": [{"task": "...", "passed": true, "costUsd": 0.02, "innerRunId": "..."}],
 "passRate": 1.0,
 "costUsd": 0.02
}
```

Summary line shape:

```json
{"candidate":"candidate-3","gatePassRate":1.0,"costUsd":0.02,"admittedToFrontier":true,"frontierSize":2,"cumulativeCostUsd":0.11}
```

## Gate script: `../gates/check-budget.sh`

Loop-back gate for `score → propose`. Passes (exit 0) while
`totalCost(frontier.json) < optimize-config.json.budgetUsd`. The outer-loop
stops when this fails.

## Invocation

The template is invoked like any other Sygil workflow:

```
sygil run /path/to/optimize.json \
 --param workflow=/path/to/seed-workflow.json \
 --param evalTask=/path/to/eval-cases.json \
 --param budget=5.00
```

`eval-cases.json` shape:

```json
{ "cases": [ { "task": "…first case…" }, { "task": "…second case…" } ] }
```

Deliverables after the run:

- `frontier.json` — Pareto archive (JSON array of candidates)
- `candidate-N/workflow.json` — every proposed workflow
- `candidate-N/rationale.md` — proposer's notes + trace citations
- `candidate-N/eval-results.json` — per-case pass/fail + cost
- `candidate-N/.sygil/runs/<innerId>/` — full NDJSON of each inner run

To inspect the winning candidates:

```
jq 'sort_by(-.gatePassRate,.costUsd)' frontier.json
```
