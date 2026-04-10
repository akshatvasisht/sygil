# Testing

## Test runner

All unit and integration tests use [Vitest](https://vitest.dev). End-to-end browser tests use [Playwright](https://playwright.dev).

## Running tests

```bash
# All packages (via Turborepo — builds shared first, then tests in parallel)
npm test

# Individual packages
cd packages/cli && npx vitest run       # CLI: 49 test files
cd packages/shared && npx vitest run    # Shared: 4 test files
cd packages/web && npx vitest run       # Web: 10 test files

# Watch mode (re-runs on file save)
npx vitest

# Coverage
npx vitest run --coverage

# E2E browser tests (requires Next.js dev server at localhost:3000)
cd packages/web && npm run e2e          # Headless
cd packages/web && npm run e2e:ui       # Interactive Playwright UI
```

## Test configuration

| Package | Pool | Environment | Notes |
|---|---|---|---|
| `cli` | `forks` | Node | Required because scheduler tests call `process.chdir()` |
| `shared` | default (threads) | Node | Standard config |
| `web` | default (threads) | `jsdom` | Setup file `src/test-setup.ts` imports `@testing-library/jest-dom` |

## Package test map

### `packages/cli` — 49 test files

| Directory | Files | What they test |
|---|---|---|
| `src/adapters/` | `claude-sdk.test.ts`, `claude-cli.test.ts`, `codex-cli.test.ts`, `cursor-cli.test.ts`, `adapter-pool.test.ts`, `index.test.ts` | Each `AgentAdapter` implementation: `isAvailable`, `spawn`, stream event normalisation, `resume`, `kill`, stall detection. `AdapterPool` concurrency and drain. |
| `src/scheduler/` | `index.test.ts`, `graph-index.test.ts`, `critical-path.test.ts`, `abort-tree.test.ts`, `abort-signal.test.ts`, `checkpoint-manager.test.ts`, `node-cache.test.ts`, `event-recorder.test.ts`, `event-replay.test.ts` | `WorkflowScheduler` execution, graph indexing, critical path computation, structured cancellation, checkpointing, event recording and replay. |
| `src/gates/` | `index.test.ts` | `GateEvaluator` — all five condition types against real temp files |
| `src/monitor/` | `websocket.test.ts`, `event-fanout.test.ts`, `ring-buffer.test.ts` | WebSocket server lifecycle, event fan-out with coalescing, ring buffer semantics |
| `src/worktree/` | `index.test.ts`, `lazy-worktree-manager.test.ts`, `isolation-check.test.ts`, `worktree-mutex.test.ts` | Worktree create/merge/remove, lazy creation, isolation check, mutex serialization |
| `src/commands/` | `init.test.ts`, `list.test.ts`, `validate.test.ts`, `export.test.ts`, `resume.test.ts`, `registry.test.ts`, `import-template.test.ts` | CLI command handlers |
| `src/utils/` | `config.test.ts`, `workflow.test.ts`, `logger.test.ts`, `registry.test.ts`, `telemetry.test.ts`, `watcher.test.ts` | Config loading, workflow interpolation, logging, registry client, telemetry, file watcher |
| `src/adapters/` | `ndjson-stream.test.ts` | NDJSON line parsing |
| `src/integration/` | `tdd-feature.test.ts`, `worktree.integration.test.ts`, `ndjson-snapshot.integration.test.ts`, `scheduler-perf-modules.integration.test.ts`, `human-review-gate.integration.test.ts`, `stall-detection.integration.test.ts`, `contract-validation.integration.test.ts`, `full-workflow.integration.test.ts`, `cross-package.test.ts`, `node-output-passing.integration.test.ts` | End-to-end scheduler flows, worktree integration, contract validation, cross-package type checks |
| `src/e2e/` | `cli-run.e2e.test.ts` | Full CLI invocation end-to-end |
| `templates/` | `tdd-feature.test.ts` | Bundled template schema validation |

### `packages/shared` — 4 test files

| File | What it tests |
|---|---|
| `src/types/workflow.test.ts` | Zod schema validation for `WorkflowGraph`, `NodeConfig`, `EdgeConfig`, `GateCondition`, `ContractConfig`, `ParameterConfig` |
| `src/types/events.test.ts` | `WsServerEvent`, `WsClientEvent`, `WorkflowRunState`, `RecordedEvent` type validation |
| `src/types/errors.test.ts` | `SigilErrorCode` enum coverage and `SigilError` interface |
| `src/utils/contract-validator.test.ts` | `validateStructuredOutput()` — schema validation, required fields, type checking |

### `packages/web` — 10 test files

| File | What it tests |
|---|---|
| `src/hooks/useWorkflowEditor.test.ts` | Node/edge CRUD, undo/redo, load/export, Zod validation, stale-closure correctness |
| `src/hooks/useWorkflowMonitor.test.ts` | WebSocket connection lifecycle, event-driven state updates |
| `src/components/monitor/ExecutionMonitor.test.ts` | `buildExecutionStateMap` and `buildTimelineEntries` pure functions |
| `src/components/monitor/EventStream.test.tsx` | Event stream rendering, filtering, animation |
| `src/components/monitor/NodeTimeline.test.tsx` | Timeline entry rendering, expand/collapse, status display |
| `src/components/editor/NodeCard.test.tsx` | Node card rendering, adapter icons, status display |
| `src/components/editor/NodePalette.test.tsx` | Palette rendering, drag-and-drop, keyboard interaction |
| `src/components/ui/SigilLogo.test.tsx` | SVG logo rendering with size and color props |
| `src/utils/exportLog.test.ts` | JSON and Markdown export formatting |
| `src/lib/monitor-url.test.ts` | `resolveMonitorWsUrl()` URL resolution across embedded/dev/direct modes |

### `packages/web/e2e` — 4 Playwright specs

| File | What it tests |
|---|---|
| `e2e/editor.spec.ts` | Editor canvas interactions, node palette, property panel |
| `e2e/monitor.spec.ts` | Monitor page rendering and event display |
| `e2e/landing.spec.ts` | Landing page rendering, navigation, accessibility |
| `e2e/live-monitor.spec.ts` | Live WebSocket connection and event streaming |

## Mocking conventions

**CLI adapters** — mock `node:child_process` (`spawn`, `execSync`, `execFile`) and `node:fs` (`existsSync`). Use the `makeFakeProc()` helper from `src/adapters/__test-helpers__.ts` that returns an `EventEmitter` with `stdout`, `stderr`, and `kill`. Drive the stream by calling `pushLines(stdout, lines, close?)` and `proc.emit("exit", code)` in tests. Use `collectEvents(stream)` to drain an async iterable.

**Web hooks** — mock `WebSocket` via `vi.stubGlobal("WebSocket", MockWebSocket)`. The mock class exposes `simulateOpen()`, `simulateMessage(event)`, `simulateClose()` helpers.

**React Flow** — mock `@xyflow/react` in hook tests. Back `useNodesState`/`useEdgesState` with real `React.useState` (dynamic-import inside the `vi.mock` factory) so state updates actually propagate under `renderHook`.

**SDK** — mock `@anthropic-ai/claude-agent-sdk` with a `FakeSession` class that yields predictable `text_delta` and `cost_update` events.

**Mock casting** — when accessing `mock.calls[i]`, always use `!` or cast: `mock.calls[0]![1] as string[]`. The CLI tsconfig has `noUncheckedIndexedAccess: true`.

## Stall detection tests

Use `vi.useFakeTimers()` before calling `stream()`, close stdout without emitting exit, then advance the clock with `vi.advanceTimersByTimeAsync(6_000)` to fire the 5-second grace timer. Call `vi.useRealTimers()` in the assertion block.

## What not to mock

- `node:fs/promises` for gate tests — `GateEvaluator` runs against real temp directories created with `mkdtemp`.
- Zod validation in shared — test against the real schemas.
- `@sigil/shared` types in web tests — import real types for type-level correctness.

## Zod schema testing

Use `const edge: EdgeConfig = {...}` not `{} satisfies EdgeConfig` — `satisfies` preserves literal types and breaks discriminated union narrowing.

## Coverage

Run with coverage using:

```bash
npx vitest run --coverage
```

Coverage is generated by `@vitest/coverage-v8`. The report is written to `coverage/`.
