# Sigil


[![npm version](https://img.shields.io/npm/v/sigil.svg)](https://www.npmjs.com/package/sigil)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Deterministic orchestration for probabilistic coding agents.

## What it is

Sigil is a TypeScript/Node.js CLI tool that runs multi-agent coding workflows as
deterministic graph executions. You define a **Workflow Graph** in `workflow.json`
— nodes are agent sessions, edges carry gates that determine whether to advance,
retry, or fail. Sigil drives the agents, evaluates the gates, and checkpoints
state so runs are resumable.

## Core concepts

- **Workflow Graph** — a directed graph (with optional back-edges for retries)
  defined entirely in `workflow.json`. The single source of truth for a run.
- **Node** — one agent session: an adapter type, model, role prompt, task prompt,
  tool list, output directory, and optional budget/timeout.
- **Edge + Gate** — a directed connection between two nodes. A gate is a set of
  conditions (AND logic) that must all pass before the edge fires. Five condition
  types: `exit_code`, `file_exists`, `regex`, `script`, `human_review`.
  Back-edges (`isLoopBack: true`) create retry cycles; `maxRetries` is required.
- **Contract** — optional schema validation and input mapping on edges. Ensures
  structured output from one node conforms to a JSON schema before passing to
  the next.
- **Adapter** — a thin interface over a specific agent runtime. Sigil calls
  `spawn`, `stream`, `getResult`, `resume`, and `kill` on whichever adapter is
  configured per node.

## Quick start

```bash
npm install -g sigil
cd my-project
sigil init
sigil run tdd-feature "add OAuth2 login"
```

## CLI commands

| Command | Description |
|---|---|
| `sigil init` | Check adapter availability and write initial config |
| `sigil run <workflow> [task]` | Run a workflow file or built-in template |
| `sigil validate <workflow>` | Validate a workflow.json without running it |
| `sigil resume <run-id>` | Resume a checkpointed run from `.sigil/runs/` |
| `sigil replay <run-id>` | Replay recorded events from a previous run |
| `sigil list` | List available adapters and recent workflow runs |
| `sigil export <template> <output>` | Copy a bundled template to a file |
| `sigil import-template <file>` | Import a workflow template from a URL or local path |
| `sigil registry list` | List templates available in the remote registry |
| `sigil registry search <query>` | Search the remote registry by name or tag |
| `sigil registry install <name>` | Download a registry template to `~/.sigil/templates/` |

### Options for `sigil run`

```
--param key=value   Set a workflow parameter (repeatable)
--dry-run           Validate and interpolate without executing
--isolate           Run each node in an isolated git worktree
--watch             Re-run the workflow when the workflow file changes
--verbose           Print all agent events to stdout
--no-open           Do not automatically open the monitor in a browser
--no-monitor        Disable the web monitor entirely (headless/CI mode)
--config <path>     Path to sigil.config.json (default: ./sigil.config.json)
```

### Options for `sigil replay`

```
--node <nodeId>     Only replay events from this node
--speed <n>         Playback speed (0=instant, 1=real-time, 2=2x; default: 1)
```

## Adapters

| Adapter | Integration | Structured output | Sandbox |
|---|---|---|---|
| `claude-sdk` | Claude Agent SDK (primary) | Yes | Application-level (outputDir restriction) |
| `codex` | Codex CLI subprocess | Yes | OS-level (Seatbelt on macOS, Landlock on Linux) |
| `claude-cli` | Claude CLI subprocess (fallback) | Partial | Application-level |
| `cursor` | Cursor CLI | No | None (Phase 2) |
| `echo` | Deterministic stub (testing only) | Yes | None |

The adapter is set per node in `workflow.json`. `sigil init` checks which
adapters are available in the current environment.

## Web UI

The `packages/web` Next.js app ships three views:

- `/` — landing page with animated workflow demo and feature overview.
- `/editor` — visual workflow editor backed by React Flow; reads and writes
  `workflow.json` directly.
- `/monitor` — real-time execution monitor; connects to the CLI's WebSocket
  server via the `?ws=<port>&token=<token>` URL parameter.

The monitor UI is embedded in the CLI binary — `sigil run` serves it
automatically and auto-opens the browser. No separate web server needed.

## Bundled templates

| Template | Description |
|---|---|
| `tdd-feature` | TDD workflow: planner writes tests, implementer makes them pass, reviewer loops back |
| `code-review` | Review workflow with automated gate checks |
| `bug-fix` | Bug fix workflow with regression guard |

## Run state and checkpointing

Each run is assigned a UUID. State is written to `.sigil/runs/<id>.json` after
every node completion and on pause. Use `sigil resume <run-id>` to continue from
the last completed node after a crash or cancellation. Use `sigil replay <run-id>`
to replay recorded events from a completed run for debugging.

## Monorepo structure

```
packages/
  cli/          Node.js CLI binary — package name: sigil
  shared/       Shared types, Zod schemas, contract validator — package name: @sigil/shared
  web/          Next.js 14 web UI — package name: @sigil/web
```

## Documentation

- [docs/API.md](docs/API.md) — CLI reference and `workflow.json` schema
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, component overview, gate types, WebSocket protocol
- [docs/SETUP.md](docs/SETUP.md) — installation, environment setup, adapter configuration
- [docs/STYLE.md](docs/STYLE.md) — coding standards and repository conventions
- [docs/TESTING.md](docs/TESTING.md) — testing guidelines, mocking conventions, coverage

## License

See [LICENSE](LICENSE) for details.
