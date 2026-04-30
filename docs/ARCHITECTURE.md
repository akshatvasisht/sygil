# Architecture

## Glossary

| Term | Definition |
|---|---|
| **Workflow Graph** | A directed graph defined in `workflow.json`. Nodes are agent sessions; edges carry gates and optional contracts. Back-edges (`isLoopBack: true`) create retry cycles. |
| **Node** | A single agent session configuration: adapter, model, role prompt, task prompt, tools, outputDir, and optional timeout/budget. Each node runs exactly once per attempt. |
| **Edge** | A directed connection from one node to another. An edge fires when its gate passes. Forward edges advance the workflow; back-edges retry the target node. |
| **Gate** | A set of one or more conditions on an edge. All conditions must pass (AND logic) for the edge to fire. |
| **Contract** | Optional field on an edge that specifies a JSON schema the preceding node's structured output must conform to, or an input mapping that projects fields into the next node's context. |
| **Adapter** | An implementation of the `AgentAdapter` interface for a specific agent runtime. Normalises runtime-specific events into `AgentEvent` values. |
| **AgentSession** | An opaque handle returned by `adapter.spawn()`. Carries a UUID, the adapter name, start timestamp, and an adapter-specific `_internal` field. |
| **AgentEvent** | A discriminated union emitted by `adapter.stream()`: `tool_call`, `tool_result`, `file_write`, `shell_exec`, `text_delta`, `cost_update`, `stall`, `error`. |
| **WorkflowRunState** | The persisted checkpoint written to `.sygil/runs/<id>.json` after every node. Tracks completed nodes, per-node results, retry counters, and run status. |
| **RecordedEvent** | A timestamped `AgentEvent` with node context, written to NDJSON event logs for replay and debugging. |

## System overview

Sygil is a Turborepo monorepo with three packages.

### 1. CLI (`packages/cli`)

The main executable. Responsibilities:

- **Scheduler** (`src/scheduler/`) — loads the workflow graph, maintains a ready queue, executes nodes, evaluates gates, handles loop-back retries and rate-limit pauses, checkpoints state.
- **Gate evaluator** (`src/gates/`) — evaluates the five condition types against a completed node's result and output directory.
- **Adapter registry** (`src/adapters/`) — resolves an `AdapterType` string to the corresponding `AgentAdapter` implementation.
- **WebSocket monitor server** (`src/monitor/`) — starts an HTTP+WebSocket server on a random port after `sygil run`. Serves the embedded monitor UI (static files from `dist-ui/`) via `sirv`. The monitor page connects to the WebSocket on the same port using `?token=<uuid>` for auth.
- **CLI commands** (`src/commands/`) — Commander.js handlers for `init`, `run`, `validate`, `export`, `list`, `resume`, `replay`, `import-template`, `registry`.
- **Templates** (`templates/`) — bundled `workflow.json` files (`tdd-feature`, `code-review`, `bug-fix`) and gate scripts.

### 2. Web UI (`packages/web`)

A Next.js 14 (App Router) application.

- `/` — landing page with animated workflow DAG demo, terminal preview, and feature overview.
- `/editor` — visual workflow editor using React Flow (`@xyflow/react`). Reads and writes `workflow.json` via file import/export.
- `/monitor` — real-time run monitor. Connects to the CLI's WebSocket server on the same port as the HTTP server using `?token=<uuid>` for auth, and renders live node/gate events. In dev mode (`SYGIL_UI_DEV=1`), the Next.js dev server at `:3000` connects to the CLI via `?ws=<port>&workflow=<name>&token=<token>`.

Key hooks: `useWorkflowMonitor` (WebSocket connection + event accumulator), `useWorkflowEditor` (React Flow graph state + serialisation).

### 3. Shared (`packages/shared`)

TypeScript types, Zod schemas, error codes, and contract validation shared between the CLI and the web UI.

- `src/types/workflow.ts` — `WorkflowGraph`, `NodeConfig`, `EdgeConfig`, `GateConfig`, `GateCondition`, `ContractConfig`, `ParameterConfig`, Zod schemas for all of the above.
- `src/types/adapter.ts` — `AgentAdapter` interface, `AgentSession`, `AgentEvent`, `NodeResult`.
- `src/types/events.ts` — `WsServerEvent`, `WsClientEvent`, `WorkflowRunState`, `RecordedEvent`.
- `src/types/errors.ts` — `SygilErrorCode` enum and `SygilError` interface.
- `src/utils/contract-validator.ts` — `validateStructuredOutput()` for JSON schema-like structural validation.
- `src/utils/event-render-data.ts` — `eventRenderData(event)` pure-data projection of every `AgentEvent` variant into `{ title, subtitle?, iconKey, severity }` for downstream terminal and web renderers.

## Adapter interface

```typescript
interface AgentAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  spawn(config: NodeConfig): Promise<AgentSession>;
  resume(config: NodeConfig, previousSession: AgentSession, feedbackMessage: string): Promise<AgentSession>;
  stream(session: AgentSession): AsyncIterable<AgentEvent>;
  getResult(session: AgentSession): Promise<NodeResult>;
  kill(session: AgentSession): Promise<void>;
}
```

`stream()` is an async generator that yields `AgentEvent` values as the agent
runs. The scheduler consumes the stream and re-emits events over WebSocket. When
the stream ends, the scheduler calls `getResult()` to obtain the final
`NodeResult` (exit code, output string, optional structured output, cost, and
token usage).

`resume()` is called on loop-back retries instead of `spawn()`, allowing
session-based adapters (e.g. Claude SDK) to continue the same conversation thread
with appended feedback rather than starting fresh.

Adapters that detect a rate-limit condition yield:
```
{ type: "error", message: "rate_limit:<retryAfterMs>" }
```
The scheduler intercepts this signal, kills the session, sleeps for the specified
duration, and re-spawns — without counting the pause against `maxRetries`.

### Adapter implementations

| Adapter | Module | Integration method |
|---|---|---|
| `claude-sdk` | `claude-sdk.ts` | Claude Agent SDK (dynamic import, optional peer dep) |
| `claude-cli` | `claude-cli.ts` | Claude CLI subprocess, NDJSON stdout |
| `codex` | `codex-cli.ts` | Codex CLI subprocess, NDJSON stdout |
| `cursor` | `cursor-cli.ts` | Cursor `agent` binary subprocess, NDJSON stdout |
| `gemini-cli` | `gemini-cli.ts` | Gemini CLI subprocess, NDJSON stdout |
| `local-oai` | `local-oai.ts` | OpenAI-compatible HTTP endpoint (Ollama / llama.cpp / vLLM / LM Studio / etc.), SSE streaming |
| `echo` | `echo.ts` | Deterministic stub for E2E testing |

All adapters populate `errorCode` in `getResult()` by mapping exit codes:
- `exitCode === 0` → no errorCode
- `exitCode === STALL_EXIT_CODE (-2)` → `SygilErrorCode.NODE_STALLED`
- `exitCode === 124` → `SygilErrorCode.NODE_TIMEOUT`
- any other non-zero → `SygilErrorCode.NODE_CRASHED`

### AdapterPool

`AdapterPool` (`adapters/adapter-pool.ts`) provides bounded concurrency for adapter processes. `acquire(adapterType)` blocks when the pool is full (FIFO queue with timeout). `release(slot)` frees a slot. Supports per-adapter-type limits and graceful `drain()`.

## Scheduler

The scheduler (`WorkflowScheduler`) walks the workflow graph node-by-node.

**Graph traversal:**

1. Identify start nodes — nodes with no incoming non-loop-back edges.
2. Execute the start node. After it completes, evaluate outgoing edges.
3. Loop-back edges are evaluated first. If a loop-back gate fails (i.e., the
   retry condition is met), increment the retry counter and re-queue the target
   node. If `maxRetries` is exceeded, throw and fail the workflow.
4. Forward edges are evaluated in order. The first edge whose gate passes
   determines the next node. If a forward gate fails, the workflow fails.
5. If a node has no outgoing edges it is a terminal node; execution ends.

**Parallel execution:** all ready nodes (those whose forward-edge predecessors
have completed) are launched concurrently, fire-and-forget. The main loop then
blocks on `await new Promise(r => { wakeResolve = r })` until any node finishes
via `.finally(wake)`, immediately recomputes the ready successor set, and
launches new ready nodes — no polling, no `Promise.all` batch barrier.

**Priority scheduling:** Nodes are sorted by descending critical-path weight
(longest-path from the node to a terminal) so higher-impact nodes start first
when multiple are ready simultaneously.

**Pause / cancel:** The scheduler checks `this.state` at the top of each node
iteration. `pause()` sets a `Promise` that the loop awaits; `resumeExecution()`
resolves it. `cancel()` causes the loop to throw `"Workflow cancelled"`.

**Rate-limit handling:** Detected inside the `stream()` consumer loop. The
scheduler calls `adapter.kill()`, awaits `sleep(retryAfterMs)`, then calls
`adapter.spawn()` again and restarts streaming. The retry does not increment
`retryCounters`.

**Checkpointing:** After every node (and on pause), the `CheckpointManager`
debounces writes (100ms trailing edge) to `.sygil/runs/<id>.json`. `flush()` is
called at workflow end to ensure the final state is persisted. `sygil resume
<run-id>` reads this file, reconstructs the scheduler, and skips
already-completed nodes.

**Event recording:** The `EventRecorder` writes per-node NDJSON event logs for
replay and debugging. `sygil replay <run-id>` uses `replayEvents()` to stream
these back with original timing.

## Scheduler internal modules

| Module | Purpose |
|---|---|
| `graph-index.ts` | `GraphIndex` — O(1) edge/node lookups (`edgeById`, `edgesByFrom`, `edgesByTo`) |
| `critical-path.ts` | Computes longest-path weights for priority dispatch |
| `abort-tree.ts` | `AbortTree` — root/child `AbortController` tree for structured cancellation |
| `checkpoint-manager.ts` | `CheckpointManager` — debounced background checkpoint writes (100ms trailing edge) |
| `node-cache.ts` | `NodeCache` — content-addressable memoization (SHA-256 of node inputs) |
| `event-recorder.ts` | `EventRecorder` — buffers and flushes NDJSON event logs per node |
| `event-replay.ts` | `replayEvents()` async generator for deterministic replay |

## Gate evaluation

`GateEvaluator.evaluate()` takes a `GateConfig` and a completed `NodeResult`.
All conditions are evaluated in order; the first failure short-circuits (AND
logic). Accepts an optional `signal?: AbortSignal` for cancellation.

| Condition type | Passes when |
|---|---|
| `exit_code` | Node exit code equals the configured value |
| `file_exists` | The file at `outputDir/<path>` exists |
| `regex` | The file at `outputDir/<filePath>` matches the regular expression |
| `script` | The script at `outputDir/<path>` exits with code 0 (30s timeout) |
| `human_review` | A human approves via CLI readline or WebSocket message (5min timeout) |

**`human_review` gate:** In CLI-only mode, a readline prompt is shown on stdout.
When the WebSocket monitor is connected, the evaluator emits a
`human_review_request` event and awaits a `human_review_approve` or
`human_review_reject` message from the client.

**Script security:** `evaluateScript` resolves the script path and rejects any
path that escapes the workflow's `outputDir` or the bundled `templates/gates/`
directory (path traversal guard). Gate scripts receive a restricted environment
variable whitelist: `PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `LOGNAME`,
`TMPDIR`, `TMP`, `TEMP`, plus `SYGIL_*` passthrough.

**Regex gate file size:** Files larger than 10MB are rejected before reading into memory.

**Regex cache:** `GateEvaluator` caches compiled `RegExp` instances across
evaluations. Instantiate one `GateEvaluator` per `executeGraph()` call for cache
reuse.

## WebSocket protocol

When `sygil run` starts, the CLI creates a `WsMonitorServer` that listens on a
random loopback port. It serves both the HTTP monitor UI (static files embedded
from `dist-ui/`) and the WebSocket endpoint on the same port. The URL is printed
to stdout in Vite-style format:

```
  Monitor: http://localhost:<port>/monitor?workflow=<name>&token=<token>
```

The browser is auto-opened to this URL (unless `--no-open` is passed or running
in CI/non-TTY). The monitor page connects to the WebSocket on the **same port**
using `?token=<token>` for authentication — there is no separate WS port.

In dev mode (`SYGIL_UI_DEV=1`), the URL instead points at the Next.js dev server
(`localhost:3000`) with `?ws=<port>&workflow=<name>&token=<token>` so the dev
server proxies the WebSocket connection to the CLI.

### Authentication

`WsMonitorServer` generates a per-run `authToken` (UUID) on construction. Control
events (`pause`, `resume_workflow`, `cancel`, `human_review_approve`,
`human_review_reject`) are silently dropped for unauthenticated clients. Read-only
events (`subscribe`, `unsubscribe`) work without auth. Clients authenticate by
connecting with `?token=<uuid>` in the WebSocket URL.

### Server → client events (`WsServerEvent`)

| Type | Payload |
|---|---|
| `workflow_start` | `workflowId`, full `WorkflowGraph`, `timestamp` |
| `node_start` | `workflowId`, `nodeId`, `NodeConfig`, `attempt`, `timestamp` |
| `node_event` | `workflowId`, `nodeId`, `AgentEvent`, `timestamp` |
| `node_end` | `workflowId`, `nodeId`, `NodeResult`, `timestamp` |
| `gate_eval` | `workflowId`, `edgeId`, `passed`, `reason`, `timestamp` |
| `loop_back` | `workflowId`, `edgeId`, `attempt`, `maxRetries`, `timestamp` |
| `rate_limit` | `workflowId`, `nodeId`, `retryAfterMs`, `timestamp` |
| `workflow_end` | `workflowId`, `success`, `durationMs`, `totalCostUsd`, `timestamp` |
| `workflow_error` | `workflowId`, optional `nodeId`, `message`, `timestamp` |
| `human_review_request` | `workflowId`, `nodeId`, `edgeId`, `prompt`, `timestamp` |
| `human_review_response` | `workflowId`, `edgeId`, `approved`, `timestamp` |

All events include an optional `timestamp?: string` field injected by
`WsMonitorServer.emit()` as `new Date().toISOString()`.

### Client → server events (`WsClientEvent`)

| Type | Effect |
|---|---|
| `subscribe` | Start receiving events for a `workflowId` |
| `unsubscribe` | Stop receiving events for a `workflowId` |
| `pause` | Pause execution between nodes |
| `resume_workflow` | Resume a paused workflow |
| `cancel` | Cancel the workflow |
| `human_review_approve` | Approve a pending human-review gate |
| `human_review_reject` | Reject a pending human-review gate |

### EventFanOut

`EventFanOut` provides non-blocking event delivery to WebSocket clients. Each
client gets its own `RingBuffer` (default 1024 events). Consecutive `text_delta`
events are coalesced. Flush interval defaults to 16ms (~60fps). Slow clients
exceeding `maxBufferedAmount` (if configured) are disconnected.

## Monitor modules

| Module | Purpose |
|---|---|
| `websocket.ts` | `WsMonitorServer` — HTTP+WebSocket server with per-run auth token |
| `event-fanout.ts` | `EventFanOut` — non-blocking ring-buffer fan-out with text_delta coalescing |
| `ring-buffer.ts` | `RingBuffer<T>` — bounded circular buffer (drop-oldest on overflow) |

## Worktree modules

| Module | Purpose |
|---|---|
| `worktree/index.ts` | `WorktreeManager` — per-node git worktree create/merge/remove (accepts `AbortSignal`) |
| `worktree/lazy-worktree-manager.ts` | `LazyWorktreeManager` — lazy creation + sparse checkout + mutex-protected ops; serializes `git worktree add`/`remove` via an `async-mutex` `Mutex` to avoid `.git/index.lock` contention |
| `worktree/isolation-check.ts` | `needsIsolation(nodeConfig)` — returns true only for nodes with write-capable tools |

## Structured cancellation

The `AbortTree` creates a root `AbortController` per workflow execution. Each
node gets a child signal via `AbortSignal.any([root, child])`. On `cancel()`,
the root aborts, propagating to:
- Gate `execFileAsync` calls (script gates)
- Worktree git operations
- Adapter streaming loops
- Human review wait promises

## Directory structure

```
packages/
  cli/
    src/
      adapters/     AgentAdapter implementations (claude-sdk, claude-cli, codex, cursor, gemini-cli, local-oai, echo)
                    adapter-pool.ts — AdapterPool, bounded concurrency for adapter processes
                    ndjson-stream.ts — NDJSON line parser for CLI adapter stdout
      commands/     CLI command handlers (init, run, validate, export, list, resume, replay, import-template, registry)
      gates/        GateEvaluator
      monitor/      WsMonitorServer (HTTP+WebSocket server, serves embedded UI via sirv)
                    event-fanout.ts — EventFanOut, non-blocking ring-buffer fan-out
                    ring-buffer.ts  — RingBuffer<T>, bounded circular buffer
      scheduler/    WorkflowScheduler
                    graph-index.ts        — GraphIndex, O(1) edge/node lookups
                    critical-path.ts      — longest-path weights for priority dispatch
                    abort-tree.ts         — AbortTree, root/child AbortController tree
                    checkpoint-manager.ts — CheckpointManager, debounced background checkpoint writes
                    node-cache.ts         — NodeCache, content-addressable memoization (SHA-256)
                    event-recorder.ts     — EventRecorder, NDJSON event logs per node
                    event-replay.ts       — replayEvents() async generator for replay
      utils/        config, workflow loading, logger, telemetry, watcher
      worktree/     WorktreeManager, LazyWorktreeManager, isolation-check (serialization via `async-mutex`)
    templates/      Bundled workflow.json templates (tdd-feature, code-review, bug-fix)
      gates/        Bundled gate scripts (e.g. check-approved.sh)
  shared/
    src/
      types/        TypeScript types + Zod schemas (workflow, adapter, events, errors)
      utils/        contract-validator.ts — structural JSON schema validation
  web/
    src/
      app/          Next.js App Router pages (landing, editor, monitor)
      components/   editor/, monitor/, landing/, ui/ React components
      hooks/        useWorkflowMonitor, useWorkflowEditor
      lib/          monitor-url.ts — resolveMonitorWsUrl(), determines WS URL mode
      utils/        exportLog and other utilities
    e2e/            Playwright end-to-end tests
```

## Shared types

Key types exported from `@sygil/shared`:

| Type | Module | Description |
|---|---|---|
| `WorkflowGraph` | `workflow.ts` | Root workflow structure (version, name, nodes, edges, parameters) |
| `NodeConfig` | `workflow.ts` | Per-node agent config (adapter, model, role, prompt, tools, timeoutMs, idleTimeoutMs...) |
| `EdgeConfig` | `workflow.ts` | Directed edge (id, from, to, gate?, contract?, isLoopBack?, maxRetries?) |
| `GateCondition` | `workflow.ts` | Discriminated union of 5 condition types |
| `ContractConfig` | `workflow.ts` | Output schema + input mapping on edges |
| `ParameterConfig` | `workflow.ts` | Workflow parameter definition (type, description, required, default) |
| `AdapterType` | `workflow.ts` | `"claude-sdk" \| "claude-cli" \| "codex" \| "cursor" \| "gemini-cli" \| "local-oai" \| "echo"` |
| `AgentAdapter` | `adapter.ts` | Interface all adapters implement |
| `AgentEvent` | `adapter.ts` | Discriminated union: tool_call, tool_result, file_write, shell_exec, text_delta, cost_update, stall, error |
| `NodeResult` | `adapter.ts` | Execution result (output, exitCode, durationMs, costUsd?, errorCode?, tokenUsage?) |
| `WsServerEvent` | `events.ts` | 11 event types emitted to monitor clients |
| `WsClientEvent` | `events.ts` | 7 event types sent from monitor clients |
| `WorkflowRunState` | `events.ts` | Persisted checkpoint (status, completedNodes, nodeResults, totalCostUsd, retryCounters) |
| `RecordedEvent` | `events.ts` | Timestamped AgentEvent with node context for replay |
| `SygilErrorCode` | `errors.ts` | Structured error code enum (gate, node, adapter, workflow, checkpoint categories) |
| `SygilError` | `errors.ts` | Error interface with code, message, optional nodeId/edgeId/details |

## Tech stack

| Component | Technology | Rationale |
|---|---|---|
| Language | TypeScript 5 | End-to-end type safety across CLI, web, and shared |
| Runtime | Node.js >= 20 | Native async iterators, `fs/promises`, `crypto.randomUUID` |
| CLI framework | Commander.js | Minimal, well-typed command/option parsing |
| WebSocket | `ws` | Lightweight WS server in Node.js without an HTTP framework dependency |
| Schema validation | Zod | Runtime validation with TypeScript type inference; used for `workflow.json` |
| Monorepo | Turborepo | Incremental builds and task pipeline across packages |
| Web framework | Next.js 14 (App Router) | File-based routing; server components for static pages |
| Graph editor | `@xyflow/react` (React Flow) | Production-grade canvas, custom nodes, and edge rendering |
| Styling | Tailwind CSS | Utility-first; no separate stylesheet maintenance |
| Test runner | Vitest | Native ESM support; compatible with the `"type": "module"` CLI package |
| E2E testing | Playwright | Browser-based end-to-end tests for the web UI |

## Environment variables

| Variable | Where set | Purpose |
|---|---|---|
| `SYGIL_CONFIG_DIR` | CLI `--config` flag | Path to `.sygil/` config directory |
| `ANTHROPIC_API_KEY` | Shell environment | Required for claude-sdk and claude-cli adapters |
| `SYGIL_TELEMETRY` | Shell environment | Set to `0` to disable telemetry |
| `SYGIL_UI_DEV` | Shell environment | Set to `1` to use the Next.js dev server for the monitor UI |
| `SYGIL_EXIT_CODE` | Internal | Exit code from node execution (passed to gate scripts) |
| `SYGIL_OUTPUT` | Internal | Node output text (passed to gate scripts) |
| `SYGIL_OUTPUT_DIR` | Internal | Output directory for node artifacts (passed to gate scripts) |
