# Sygil

[![npm version](https://img.shields.io/npm/v/sygil.svg)](https://www.npmjs.com/package/sygil)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/akshatvasisht/sygil?style=flat&labelColor=18181b&color=71717a)](https://github.com/akshatvasisht/sygil/stargazers)
[![CI](https://img.shields.io/github/actions/workflow/status/akshatvasisht/sygil/ci.yml?style=flat&labelColor=18181b&color=71717a)](https://github.com/akshatvasisht/sygil/actions/workflows/ci.yml)

> **Try the editor in your browser:** https://sygil-editor.vercel.app — no install required. Read-only demo; clone the repo to execute workflows.

Deterministic orchestration for probabilistic coding agents.

## What it is

Sygil is a TypeScript/Node.js CLI tool that runs multi-agent coding workflows as
deterministic graph executions. You define a **Workflow Graph** in `workflow.json`
— nodes are agent sessions, edges carry gates that determine whether to advance,
retry, or fail. Sygil drives the agents, evaluates the gates, and checkpoints
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
- **Adapter** — a thin interface over a specific agent runtime. Sygil calls
  `spawn`, `stream`, `getResult`, `resume`, and `kill` on whichever adapter is
  configured per node.

## Quick start

```bash
git clone https://github.com/akshatvasisht/sygil.git
cd sygil
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
cd my-project
node /path/to/sygil/packages/cli/dist/index.js init
node /path/to/sygil/packages/cli/dist/index.js run tdd-feature "add OAuth2 login"
```

> Note: an npm-published release is on the way — the `git clone` flow is the current path.

## Install via Docker (Windows, Linux, macOS)

No Node.js required. Works on Windows without WSL.

    docker run --rm -v "$PWD:/workspace" \
      -e ANTHROPIC_API_KEY \
      ghcr.io/akshatvasisht/sygil:latest \
      run tdd-feature "add OAuth2 login"

Mount your project as `/workspace`, pass whatever adapter credentials you
need via `-e VAR` (or `--env-file .env`), and use `--rm` for one-shot runs.

The image ships all adapters that don't need platform-specific binaries:
`claude-sdk`, `codex` (SDK mode), `local-oai`, `echo`. Users of CLI-based
adapters (`claude-cli`, `cursor`, `gemini-cli`) should install those CLIs
on the host and mount them: `-v /usr/local/bin/claude:/usr/local/bin/claude`.

## Running in the cloud

Sygil is local-first — there's no hosted Sygil service. To run on cloud
infrastructure, mount the Docker image on any container platform:

| Provider | Quick path |
|---|---|
| Fly.io | `fly launch --image ghcr.io/akshatvasisht/sygil:latest` |
| Render | Create a Web Service, select "Existing image", use `ghcr.io/akshatvasisht/sygil:latest` |
| Railway | Create a new service → "Deploy a Docker image" → paste the image URL |
| Kubernetes | Standard Deployment + PVC for state — see `docs/DEPLOYMENT.md` (TODO) |

State (checkpoints, NDJSON logs) persists to whatever you mount at
`/workspace` — use a volume/bind-mount your platform provides.

## CLI commands

| Command | Description |
|---|---|
| `sygil init` | Check adapter availability and write initial config |
| `sygil run <workflow> [task]` | Run a workflow file or built-in template |
| `sygil validate <workflow>` | Validate a workflow.json without running it |
| `sygil resume <run-id>` | Resume a checkpointed run from `.sygil/runs/` |
| `sygil replay <run-id>` | Replay recorded events from a previous run |
| `sygil list` | List available adapters and recent workflow runs |
| `sygil export <template> <output>` | Copy a bundled template to a file |
| `sygil import-template <file>` | Import a workflow template from a URL or local path |
| `sygil registry list` | List templates available in the remote registry |
| `sygil registry search <query>` | Search the remote registry by name or tag |
| `sygil registry install <name>` | Download a registry template to `~/.sygil/templates/` |

### Options for `sygil run`

```
--param key=value   Set a workflow parameter (repeatable)
--dry-run           Validate and interpolate without executing
--isolate           Run each node in an isolated git worktree
--watch             Re-run the workflow when the workflow file changes
--verbose           Print all agent events to stdout
--no-open           Do not automatically open the monitor in a browser
--no-monitor        Disable the web monitor entirely (headless/CI mode)
--config <path>     Path to sygil.config.json (default: ./sygil.config.json)
```

### Options for `sygil replay`

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
| `cursor` | Cursor CLI | Partial | None |
| `gemini-cli` | Gemini CLI subprocess | Partial | None |
| `local-oai` | Local OpenAI-compatible endpoint (Ollama, LM Studio, etc.) | Yes | None |
| `echo` | Deterministic stub (testing only) | Yes | None |

The adapter is set per node in `workflow.json`. `sygil init` checks which
adapters are available in the current environment.

### Local models

The `local-oai` adapter defaults to Ollama at `http://localhost:11434/v1` and
works with any OpenAI-compatible server. Known-good: **Qwen 2.5 7B+**, Llama
3.2 8B+, Mistral Nemo. No API key required for local runs. Override the
endpoint via `SYGIL_LOCAL_OAI_URL`.

## Web UI

The `packages/web` Next.js app ships three views:

- `/` — landing page with animated workflow demo and feature overview.
- `/editor` — visual workflow editor backed by React Flow; reads and writes
  `workflow.json` directly.
- `/monitor` — real-time execution monitor; connects to the CLI's WebSocket
  server via the `?ws=<port>&token=<token>` URL parameter.

The monitor UI is embedded in the CLI binary — `sygil run` serves it
automatically and auto-opens the browser. No separate web server needed.

## Bundled templates

| Template | Description |
|---|---|
| `tdd-feature` | TDD workflow: planner writes tests, implementer makes them pass, reviewer loops back |
| `code-review` | Review workflow with automated gate checks |
| `bug-fix` | Bug fix workflow with regression guard |

## Run state and checkpointing

Each run is assigned a UUID. State is written to `.sygil/runs/<id>.json` after
every node completion and on pause. Use `sygil resume <run-id>` to continue from
the last completed node after a crash or cancellation. Use `sygil replay <run-id>`
to replay recorded events from a completed run for debugging.

## Monorepo structure

```
packages/
  cli/          Node.js CLI binary — package name: sygil
  shared/       Shared types, Zod schemas, contract validator — package name: @sygil/shared
  web/          Next.js 14 web UI — package name: @sygil/web
```

## Documentation

- [docs/API.md](docs/API.md) — CLI reference and `workflow.json` schema
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, component overview, gate types, WebSocket protocol
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) — Prometheus scrape + OTLP push
- [docs/SETUP.md](docs/SETUP.md) — installation, environment setup, adapter configuration
- [docs/STYLE.md](docs/STYLE.md) — coding standards and repository conventions
- [docs/TESTING.md](docs/TESTING.md) — testing guidelines, mocking conventions, coverage

## License

See [LICENSE](LICENSE) for details.
