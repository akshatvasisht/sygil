# Bundled Gate Scripts

Gate scripts are shell scripts invoked by `script`-type gate conditions in workflow JSON.
They exit 0 on pass (edge traversed) and non-zero on fail (edge blocked or loop-back triggered).

## Bundled scripts

### `check-approved.sh`

Used by: code-review workflows with a human-review or reviewer-agent verdict file.

Passes when `review/verdict.txt` (or the first argument) contains the string `APPROVED`.
Fails when the file is missing or does not contain `APPROVED`. Pair with
`check-changes-requested.sh` on the loop-back edge to route the workflow back to the
implementer when a reviewer requests changes.

### `check-changes-requested.sh`

Used by: `tdd-feature` loop-back edge (reviewer → implementer).

Passes when `review/verdict.txt` contains `CHANGES_REQUESTED`. The tdd-feature template
uses this on the `isLoopBack: true` edge so the scheduler re-queues the implementer node
when the reviewer is unsatisfied. The forward-pass edge uses `check-approved.sh` to
exit the loop once the review is clean.

### `check-budget.sh`

Used by: `optimize` template score → propose loop-back edge.

Reads `optimize-config.json` (field: `budgetUsd`) and `frontier.json` (array of
`{ costUsd }` objects). Passes while the cumulative cost across all candidates is still
under budget; fails (stops the optimization loop) when the budget is exhausted. No `jq`
dependency — uses a Node.js one-liner for JSON parsing.

### `ralph-done.sh`

Used by: `ralph` self-healing loop termination.

Reads `fix_plan.md` from `$SYGIL_OUTPUT_DIR`. Passes (terminates the loop) when every
`- [ ]` task has been checked off. Fails (keeps the loop alive) while any unchecked TODO
line remains or the plan file has not been created yet. Polarity note: loop-back re-queue
in the scheduler happens on gate *failure*, so "there is still work" must exit non-zero.

## Writing your own gate script

- Exit `0` to pass the gate (edge is traversed / loop exits).
- Exit non-zero to fail the gate (edge is blocked / loop-back re-queues the prior node).
- The script receives these env vars (and only these — parent env is not leaked):
  - `SYGIL_EXIT_CODE` — exit code of the last adapter run for this node.
  - `SYGIL_OUTPUT_DIR` — output directory of the node that produced the output.
  - `SYGIL_OUTPUT` — stdout/last output text from the node.
  - Standard path vars: `PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR`.
- Scripts must live inside `templates/gates/` (or a path explicitly allowed in your
  `.sygil/config.json`). The path containment check in `gates/index.ts > isContainedIn`
  rejects absolute paths, symlink escapes, and `../` traversals.
- Keep scripts fast and side-effect-free where possible. Gate scripts that modify files
  can interfere with replay determinism if the same output directory is reused.
