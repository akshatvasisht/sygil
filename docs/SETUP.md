# Setup

## Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Node.js | 20 | Required for native `fetch`, `crypto.randomUUID`, async iterators |
| npm | 10 | Workspace support |
| Git | 2.x | Required for `--isolate` worktree mode |

At least one agent adapter must be available at runtime (see below).

## Installation

```bash
git clone https://github.com/akshatvasisht/sygil.git
cd sygil
npm install
```

This installs dependencies across all packages (`cli`, `web`, `shared`) via npm workspaces.

## Environment variables

**Adapter credentials** (supply the ones whose adapters you use):

| Variable | Required by | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude-sdk`, `claude-cli` | Claude SDK / CLI sessions |
| `GEMINI_API_KEY` | `gemini-cli` | Google Gemini CLI adapter |
| `CURSOR_API_KEY` | `cursor-cli` | Cursor CLI adapter |
| `OPENAI_API_KEY` | `codex-cli` | OpenAI (used by Codex CLI) |
| `SYGIL_LOCAL_OAI_URL` | `local-oai` | OpenAI-compatible endpoint for local models (Ollama, vLLM, LM Studio, …). Default: `http://localhost:11434/v1` |
| `SYGIL_LOCAL_OAI_KEY` | `local-oai` | Auth key for the local endpoint (often a placeholder like `ollama`) |

**Observability** (optional):

| Variable | Description |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for OpenTelemetry export. See `docs/OBSERVABILITY.md`. |

**Runtime toggles**:

| Variable | Description |
|---|---|
| `SYGIL_TELEMETRY` | Set to `0` to disable telemetry (opt-in; default off) |
| `SYGIL_UI_DEV` | Set to `1` to use the Next.js dev server for the monitor UI (development only) |

Create a `.env` file in your project's working directory:

```env
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

Sygil auto-loads `.env` from the current working directory at startup
via Node's native `process.loadEnvFile()` (Node 20.12+). See
`.env.example` at the repo root for all supported variables.

## Building

```bash
# Build the shared package (required before running CLI or web in dev)
npm run build --workspace packages/shared

# Build everything (shared → cli + web via Turborepo dependency graph)
npm run build
```

## Running the CLI

```bash
# Development (runs TypeScript directly via tsx)
cd packages/cli
npm run dev

# After build — run the compiled binary
node packages/cli/dist/index.js run tdd-feature "your task"
```

## Running the web UI

The monitor UI is embedded in the CLI — `sygil run` serves it automatically and
auto-opens the browser. You do **not** need to run the web dev server to use the
monitor.

```bash
# Run a workflow — monitor UI opens automatically in the browser
node packages/cli/dist/index.js run workflow.json

# Pass --no-open to suppress auto-open (e.g. in CI or headless environments)
node packages/cli/dist/index.js run workflow.json --no-open

# Disable the monitor entirely (headless mode)
node packages/cli/dist/index.js run workflow.json --no-monitor
```

The terminal will print a Vite-style URL:

```
  Monitor: http://localhost:<port>/monitor?workflow=<name>&token=<token>
```

### Developing the web UI itself

To work on the web UI source, run the Next.js dev server and connect it to a
live `sygil run` session:

```bash
# Terminal 1 — start the Next.js dev server
cd packages/web
npm run dev
# Dev server: http://localhost:3000
# Editor:     http://localhost:3000/editor

# Terminal 2 — run a workflow in dev UI mode
SYGIL_UI_DEV=1 node packages/cli/dist/index.js run workflow.json
# Monitor URL: http://localhost:3000/monitor?ws=<port>&workflow=<name>&token=<token>
```

`SYGIL_UI_DEV=1` makes the CLI print (and open) the `localhost:3000` dev server
URL instead of the embedded UI URL, passing `?ws=<port>` so the dev server can
connect back to the CLI's WebSocket.

## Adapters

The CLI auto-detects available adapters on startup. Run `sygil init` to check your environment:

```bash
node packages/cli/dist/index.js init
```

| Adapter | What to install |
|---|---|
| `claude-sdk` | `npm install @anthropic-ai/claude-agent-sdk` + set `ANTHROPIC_API_KEY` |
| `codex` | Install [OpenAI Codex CLI](https://github.com/openai/codex) and ensure `codex` is in `$PATH` |
| `claude-cli` | Install [Claude CLI](https://github.com/anthropics/claude-code) and ensure `claude` is in `$PATH` |
| `cursor` | Install [Cursor](https://cursor.sh) and ensure the `agent` binary is in `$PATH`; sign in to Cursor first |
| `echo` | Built-in deterministic stub for E2E testing — no installation required |

## Running tests

```bash
# All packages (via Turborepo)
npm test

# Individual packages
cd packages/cli && npx vitest run       # CLI unit + integration tests
cd packages/shared && npx vitest run    # Shared schema + contract tests
cd packages/web && npx vitest run       # Web component + hook tests

# Watch mode (re-runs on file save)
npx vitest

# Coverage
npx vitest run --coverage

# E2E browser tests (requires the Next.js dev server at localhost:3000)
cd packages/web && npm run e2e          # Headless
cd packages/web && npm run e2e:ui       # Interactive Playwright UI
```

## Replaying runs

After a workflow completes, replay its recorded events for debugging:

```bash
node packages/cli/dist/index.js replay <run-id>
node packages/cli/dist/index.js replay <run-id> --node implementer --speed 2
```

## Troubleshooting

**`@sygil/shared` not found when running CLI tests**
The shared package must be built first: `npm run build --workspace packages/shared`.

**`Module '"@sygil/shared"' has no exported member`**
The shared package needs to be rebuilt after type changes: `cd packages/shared && npx tsc`.

**`agent` binary not found (Cursor adapter)**
The Cursor headless binary is named `agent`, not `cursor`. Check that it is in your `$PATH` after installing Cursor.

**`sygil run` hangs without output**
Pass `--verbose` to see all agent events. If a node stalls, the scheduler emits a `stall` event after 5 seconds of silence and kills the process. Consider adding `idleTimeoutMs` to the node config.

**Stale `.next` cache after package rename**
If you see `Cannot find module '@sygil/shared'` in the web package, clear the cache: `rm -rf packages/web/.next`.

**`process.chdir() not supported in workers`**
The CLI test config uses `pool: "forks"` in `packages/cli/vitest.config.ts`. Do not change this — scheduler tests call `process.chdir()`.
