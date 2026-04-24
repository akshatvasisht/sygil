# Bundled Workflow Templates

These JSON files are the workflow templates shipped with the Sygil CLI and copied to `.sygil/templates/` on `sygil init`. Each is a runnable `WorkflowGraph` validated against `packages/shared/src/types/workflow.ts`.

## `NodeConfig.tools` — keep the allowlist minimal

Every entry in `NodeConfig.tools` is a tool the model may invoke during that node. The allowlist flows straight through to the adapter:

- `claude-cli` — passed to `claude --allowedTools <csv>`.
- `claude-sdk` — passed to `query({ allowedTools })` in the SDK.
- `local-oai` — mapped to OpenAI-style `tools: [{ type: "function", function: { name } }]`.

Minimal allowlists matter because the adapter presents each tool's description to the model on every turn. A bloated list spends the context budget on tools the node will never use and pushes load-bearing instructions further from the model's attention.

**Recommendation.** Start a new node with only the tools its prompt actually asks for — typically some subset of `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` for Claude; the equivalent named functions for `local-oai`. Add more only when you observe the model blocked on something it genuinely needs. The cost of a retry is cheaper than the context cost of a permanent wide allowlist.

A few anchors from the bundled templates below:

- A node whose prompt is "produce a report at review/analysis.md" needs `Read`, `Glob`, `Grep`, `Write` — not `Edit` or `Bash`.
- A node that reproduces a bug with a failing test but "never fixes the bug" needs `Read`, `Glob`, `Grep`, `Bash`, `Write` — `Edit` is optional depending on whether the test is added to an existing file.
- A node that runs a single vetted script (`node optimize-scripts/update-frontier.mjs`) needs `Bash` alone.

## Adapters that do not honor `tools`

`codex-cli`, `cursor-cli`, and `gemini-cli` currently have no upstream allowlist flag; `echo` is a no-op adapter. For these, the scheduler logs a warning when `tools` is non-empty and proceeds without enforcement. This is intentional — the warning surfaces a mismatch between the authored intent and the adapter's actual capability, so the author can either switch adapters or drop the allowlist. Do not try to route around the warning by leaving `tools` empty when you really want enforcement; use a honoring adapter instead.

## Template inventory

| File | Graph shape | Notes |
| --- | --- | --- |
| `quick-review.json` | analyzer → summarizer | Two-node review, tightest tool sets |
| `code-review.json` | analyzer → {security, perf} → synthesizer | Fan-out review with separate domain analysts |
| `bug-fix.json` | reproducer → fixer → verifier | Reproduce-first loop; reproducer must not fix |
| `tdd-feature.json` | planner → implementer ↔ reviewer | Implementer and reviewer loop on `CHANGES_REQUESTED` |
| `ralph.json` | worker (self-loop) | Ralph loop — one TODO per iteration |
| `optimize.json` | propose → evaluate → score | Outer-loop workflow optimizer (see `optimize-scripts/`) |

Templates are authored in raw JSON so they can be diff-reviewed. The editor under `packages/web` imports the same `WorkflowGraphSchema`, so anything that parses here opens cleanly there.
