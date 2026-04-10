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
git clone https://github.com/akshatvasisht/sigil.git
cd sigil
npm install
```

This installs dependencies across all packages (`cli`, `web`, `shared`) via npm workspaces.

## Environment variables

| Variable | Required by | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude-sdk`, `claude-cli` adapters | API key for Claude SDK / CLI sessions |
| `SIGIL_TELEMETRY` | CLI | Set to `0` to disable telemetry (opt-in is default-off) |
| `SIGIL_UI_DEV` | CLI (dev) | Set to `1` to use the Next.js dev server for the monitor UI |

Create a `.env` file in the project root if needed:

```
ANTHROPIC_API_KEY=sk-ant-...
```

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
node dist/index.js run examples/tdd-feature.json
```

## Running the web UI

The monitor UI is embedded in the CLI — `sigil run` serves it automatically and
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
  ➜  Monitor: http://localhost:<port>/monitor?workflow=<name>&token=<token>
```

### Developing the web UI itself

To work on the web UI source, run the Next.js dev server and connect it to a
live `sigil run` session:

```bash
# Terminal 1 — start the Next.js dev server
cd packages/web
npm run dev
# Dev server: http://localhost:3000
# Editor:     http://localhost:3000/editor

# Terminal 2 — run a workflow in dev UI mode
SIGIL_UI_DEV=1 node packages/cli/dist/index.js run workflow.json
# Monitor URL: http://localhost:3000/monitor?ws=<port>&workflow=<name>&token=<token>
```

`SIGIL_UI_DEV=1` makes the CLI print (and open) the `localhost:3000` dev server
URL instead of the embedded UI URL, passing `?ws=<port>` so the dev server can
connect back to the CLI's WebSocket.

## Adapters

The CLI auto-detects available adapters on startup. Run `sigil init` to check your environment:

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

**`@sigil/shared` not found when running CLI tests**
The shared package must be built first: `npm run build --workspace packages/shared`.

**`Module '"@sigil/shared"' has no exported member`**
The shared package needs to be rebuilt after type changes: `cd packages/shared && npx tsc`.

**`agent` binary not found (Cursor adapter)**
The Cursor headless binary is named `agent`, not `cursor`. Check that it is in your `$PATH` after installing Cursor.

**`sigil run` hangs without output**
Pass `--verbose` to see all agent events. If a node stalls, the scheduler emits a `stall` event after 5 seconds of silence and kills the process. Consider adding `idleTimeoutMs` to the node config.

**Stale `.next` cache after package rename**
If you see `Cannot find module '@sigil/shared'` in the web package, clear the cache: `rm -rf packages/web/.next`.

**`process.chdir() not supported in workers`**
The CLI test config uses `pool: "forks"` in `packages/cli/vitest.config.ts`. Do not change this — scheduler tests call `process.chdir()`.
