# Sygil — Pitch & Competitive Positioning

> **One-liner:** Deterministic orchestration for probabilistic agents — define multi-agent AI workflows as typed DAGs with gates, retries, and real-time monitoring.

---

## The Core Idea (30 seconds)

AI coding agents are powerful individually, but chaining them is chaos. You want a planner to write a spec, an implementer to write code, a reviewer to check it, and a validator to run tests — in sequence, with retries if any step fails.

Today your options are: write bash scripts that pipe outputs, use an LLM to decide what runs next (non-deterministic, expensive), or adopt a Python-heavy framework that wasn't designed for coding agents.

**Sygil is a DAG scheduler purpose-built for AI agent workflows.** You define nodes (agents), edges (transitions), and gates (pass/fail conditions) in one JSON file. Sygil handles execution order, parallel dispatch, failure retries, checkpointing, and real-time monitoring. The graph is deterministic. The agents inside each node are probabilistic. You control exactly *when* and *whether* things run — the agents decide *how*.

---

## How It Works (2 minutes)

### 1. Define a workflow graph

```json
{
  "version": "1.0",
  "name": "tdd-feature",
  "nodes": {
    "planner":     { "adapter": "claude-sdk", "model": "claude-opus-4-7",   "role": "Planner",     "prompt": "..." },
    "implementer": { "adapter": "codex",      "model": "o3",               "role": "Implementer", "prompt": "..." },
    "reviewer":    { "adapter": "claude-sdk", "model": "claude-sonnet-4-6", "role": "Reviewer",    "prompt": "..." }
  },
  "edges": [
    { "id": "plan-to-impl",  "from": "planner",     "to": "implementer" },
    { "id": "impl-to-review", "from": "implementer", "to": "reviewer",
      "gate": { "conditions": [{ "type": "exit_code", "value": 0 }] } },
    { "id": "review-loop",   "from": "reviewer",    "to": "implementer",
      "isLoopBack": true, "maxRetries": 3,
      "gate": { "conditions": [{ "type": "regex", "filePath": "review.md", "pattern": "APPROVED" }] } }
  ]
}
```

### 2. Run it

```bash
sygil run ./tdd-feature.json "add OAuth2 login with GitHub provider"
```

### 3. What happens

1. Sygil validates the graph, probes adapters (API keys, binaries), and computes critical-path priorities
2. Starts the planner node (highest critical-path weight)
3. When planner completes, evaluates the gate on the outgoing edge — if exit code is 0, fires the implementer
4. Implementer runs Codex in an isolated git worktree, writes code
5. Gate check: reviewer reads `review.md` — if it doesn't contain "APPROVED", the loop-back edge retries the implementer (up to 3 times), resuming the conversation with feedback
6. Throughout: events stream to terminal and optional WebSocket monitor in real time
7. On completion or failure: checkpoint saved to `.sygil/runs/<id>.json` — resumable with `sygil resume`

---

## What Makes It Different

### vs. the landscape at a glance

| | Sygil | LangGraph | CrewAI | AutoGen | OpenAI Agents | Composio |
|---|---|---|---|---|---|---|
| **Architecture** | Deterministic DAG | State machine graph | Role-based crews | Actor model | Handoff chain | LLM planner |
| **Agent-agnostic** | 4 adapters (Claude, Codex, Cursor) | Via LangChain | Via LLM configs | Multi-provider | OpenAI-centric | Multi-agent |
| **Typed gate system** | 5 condition types | Custom edges | No | No | No | No |
| **Coding-agent-specific** | Yes (worktrees, exit codes, file gates) | No | No | No | No | Yes |
| **Deterministic execution** | Yes | Yes (graph) | Partial (Flows only) | Dual-mode | No | No |
| **Language** | TypeScript / Node.js | Python-first | Python | Python / .NET | Python | Node.js |
| **Real-time monitor** | Embedded WebSocket + web UI | LangSmith (paid) | Cloud platform (paid) | AutoGen Studio | No | No |
| **Open source** | MIT | MIT | Apache 2.0 | MIT | MIT | OSS |

### The five differentiators

**1. Deterministic graph, probabilistic agents.**
The DAG structure — which nodes run, in what order, under what conditions — is fully deterministic and inspectable. You can read the JSON and know exactly what will happen. The AI reasoning inside each node is probabilistic, but the orchestration layer never guesses. LangGraph comes closest but requires programming the graph in Python. Sygil is JSON-declarative.

**2. Purpose-built for coding agents.**
Gate conditions check exit codes, file existence, and regex patterns on output files — the natural artifacts of coding agents. Git worktree isolation gives each node a clean filesystem. Loop-back edges use `adapter.resume()` (continue the conversation) rather than respawning, preserving the agent's context across retries. No other framework has this combination.

**3. Adapter-agnostic across coding agent runtimes.**
One workflow can mix Claude SDK (programmatic API), Codex CLI (OpenAI subprocess), Claude CLI (Anthropic subprocess), and Cursor in the same graph. Each adapter normalizes its runtime's event model into a unified `AgentEvent` stream. Adding a new runtime is one adapter implementation — no scheduler changes.

**4. Zero-config real-time monitoring.**
`sygil run --monitor` starts an embedded WebSocket server on a random loopback port and opens a Next.js dashboard. Events are fan-out via per-client ring buffers with text-delta coalescing at 60fps. The monitor supports human-in-the-loop approval gates, live cost tracking, and event filtering — all authenticated per-run. No external service, no API key, no paid platform.

**5. Resume from any failure.**
Every node completion triggers a debounced checkpoint write. If a workflow fails at node 7 of 12, `sygil resume <run-id>` picks up from node 7 with full context — completed outputs, retry counters, and session state. Event logs are recorded as NDJSON for deterministic replay and debugging.

---

## Architectural Edges (Unbenchmarked — Design Advantages)

These are design decisions that *should* yield performance and reliability advantages over alternatives, but haven't been formally benchmarked yet.

### Completion-driven dispatch (vs. polling/batch barriers)

**The problem:** Traditional DAG schedulers (Airflow, Prefect) either poll a ready queue every N seconds or use batch barriers — wait for all nodes in a "wave" to finish before dispatching the next wave.

**Sygil's approach:** Each node's `Promise.finally(wake)` resolves a shared wakeup promise. The main loop blocks on this promise, then immediately computes the next set of ready nodes. No polling interval. No batch barrier. A fast node unblocks its successors instantly, even if sibling nodes are still running.

**Expected advantage:** In workflows with heterogeneous node durations (common — a planner might take 10s, an implementer 120s), batch barriers force the fast path to wait for the slow path. Completion-driven dispatch eliminates this idle time. For deep DAGs, this could reduce end-to-end latency by 30-50%.

### Critical-path scheduling

**The problem:** When multiple nodes are ready simultaneously, dispatch order matters. Random or FIFO ordering may start short-duration leaf nodes while the critical-path bottleneck sits in the queue.

**Sygil's approach:** At workflow start, compute the longest path from each node to workflow completion (using historical `durationMs` or a default weight). Ready nodes are sorted by descending critical-path weight. The bottleneck node always starts first.

**Expected advantage:** In wide DAGs (fan-out patterns with 5-10+ parallel nodes), this ensures the slowest dependency chain starts earliest. The practical effect is that total wall-clock time approaches the theoretical minimum (the critical path length), rather than being dominated by scheduling luck.

### Lazy sparse-checkout worktrees

**The problem:** Per-node filesystem isolation typically means full `git clone` per node — expensive in large monorepos (multiple GB).

**Sygil's approach:** `LazyWorktreeManager` creates git worktrees on-demand (only for nodes with write-capable tools) using sparse checkout — only the directories the node needs are checked out. An `async-mutex` `Mutex` serializes `git worktree add`/`remove` to avoid `.git/index.lock` contention. At fan-in points, worktrees are automatically merged back.

**Expected advantage:** Disk usage and creation time scale with the *relevant* directory tree, not the full repo. For a 2GB monorepo where a node only writes to `src/auth/`, the worktree might be 50MB. Mutex serialization prevents the flaky failures that occur when multiple git operations race on the same repo.

### Non-blocking checkpoint debouncing

**The problem:** Checkpointing after every node completion (synchronous write to disk) blocks the scheduler. In fast workflows with many small nodes, this becomes a bottleneck.

**Sygil's approach:** `CheckpointManager` uses a 100ms trailing-edge debounce. `markDirty()` snapshots the state and schedules a write. If another `markDirty()` arrives within 100ms, the timer resets. The write itself is `await`-ed in the background — the scheduler never blocks. A `flush()` at workflow end ensures all writes complete.

**Expected advantage:** In workflows where 5 nodes complete within 100ms of each other (common in parallel execution), only one disk write occurs instead of five. The scheduler's hot path never waits for I/O.

### Ring-buffer event fan-out

**The problem:** Broadcasting events to N WebSocket clients synchronously means one slow client can back-pressure the scheduler.

**Sygil's approach:** `EventFanOut` gives each client a `RingBuffer<string>` (1024 events). `emit()` pushes a pre-serialized JSON string into each buffer — O(n) with zero I/O. A 16ms interval timer drains each buffer, coalesces consecutive `text_delta` events, and batch-sends. Clients exceeding `maxBufferedAmount` are disconnected.

**Expected advantage:** The scheduler's `emit()` call costs ~1μs per client (memory push only). Even 50 connected monitors won't add measurable latency. Slow clients drop old events gracefully rather than blocking the pipeline.

### Structured cancellation via AbortTree

**The problem:** Killing a multi-node workflow requires cancelling running adapters, pending gate evaluations, worktree operations, and human review prompts — without leaving orphaned processes.

**Sygil's approach:** `AbortTree` creates a root `AbortController` per workflow. Each node gets a child signal via `AbortSignal.any([root, child])`. On cancel, the root aborts, propagating to every async operation that accepted the signal — `execFile` calls in gate scripts, `readline` in human review, git operations in worktrees, and streaming loops in adapters. All `finally` blocks still run.

**Expected advantage:** Clean shutdown without orphaned processes or leaked file handles. Per-node cancellation (e.g., skip a node that's no longer needed) without affecting siblings. No manual cleanup code required in adapter implementations.

### Content-addressable node caching

**The problem:** During iterative development, you re-run the same workflow many times. Nodes with identical inputs (same prompt, model, tools, upstream outputs) produce the same results — but re-execute every time.

**Sygil's approach:** `NodeCache` computes a SHA-256 hash of the node's canonical inputs (prompt, adapter, model, tools, resolved input mappings, upstream node hashes). If a cache hit exists and all outgoing gates are deterministic (`exit_code`, `file_exists`, `regex` — but NOT `human_review` or `script`), the cached result is returned without execution.

**Expected advantage:** On iterative runs where only one node's prompt changed, all upstream and downstream nodes with unchanged inputs are skipped. The determinism check prevents cache hits when outcomes depend on non-repeatable conditions.

---

## Competitive Landscape (Extended)

### Closest competitors

**LangGraph (LangChain)** — The nearest architectural peer. Also graph-based, also deterministic, also checkpointed. But: Python-first (TypeScript support lags), requires LangChain abstractions (can be leaky), not coding-agent-specific (no worktrees, no exit-code gates, no adapter abstraction). LangSmith monitoring is a paid service. ~29k GitHub stars.

**Composio Agent Orchestrator** — The nearest use-case peer. Also targets parallel coding agents, also uses git worktrees. But: the orchestrator itself is LLM-driven (plans tasks via AI, not a deterministic DAG), has no gate system, no checkpoint/resume, no monitoring UI. Newer and less mature.

**CrewAI** — Popular (48k stars) but architecturally different. Role-based autonomous crews are non-deterministic. Their newer "Flows" mode adds event-driven pipelines, but lacks typed gates, coding-agent features, and TypeScript support. Cloud platform features (monitoring, deployment) are paid.

**Microsoft Agent Framework (AutoGen + Semantic Kernel)** — Just hit GA (April 2026). Actor-model architecture with dual-mode (deterministic workflow + LLM agent). Impressive but .NET/Python only, not coding-specific, and the unified framework is brand new with ecosystem fragmentation between legacy AutoGen and Semantic Kernel users.

**Claude Agent SDK / Managed Agents** — Anthropic's own solution. Subagent hierarchy with shared task lists and peer messaging. Powerful, but Claude-only (complete provider lock-in), non-deterministic (LLM decides what runs), and Managed Agents is a paid hosted service ($0.08/session-hour). No DAG, no gates, no visual editor.

**OpenAI Agents SDK** — Intentionally minimal. Handoff-based delegation, stateless by default, no graph structure. Practical lock-in to OpenAI. Not designed for multi-step coding workflows.

### What no competitor offers

No other framework combines **all** of these in one tool:

1. Deterministic DAG execution with typed gate conditions (5 types)
2. Multi-adapter support across coding agent runtimes (not just LLM providers)
3. Git worktree isolation with sparse checkout and automatic fan-in merge
4. Conversation-preserving retries via `adapter.resume()` (not respawn)
5. Embedded zero-config WebSocket monitoring with human-in-the-loop gates
6. Content-addressable node caching with determinism-aware skip logic
7. TypeScript/Node.js (the ecosystem most coding agents already live in)
8. Fully open source, no paid platform dependency

---

## Appendix: Technical Architecture Summary

### Execution flow

```
workflow.json
  → Zod validation (WorkflowGraphSchema)
  → GraphIndex (O(1) edge/node lookups)
  → Critical-path weight computation
  → AbortTree + EventRecorder initialization
  → Identify start nodes (no incoming forward edges)
  → Main loop:
      Sort ready nodes by critical-path weight (descending)
      Launch all ready (fire-and-forget)
      Block on wakeup promise (no polling)
      On node complete → evaluate outgoing gates
        → Forward gate pass → mark complete, wake
        → Forward gate fail → mark failed, abort workflow
        → Loop-back gate fail → resume() node, re-queue
      CheckpointManager.markDirty() after each node
  → flush() checkpoints and event logs on workflow end
```

### Module map

| Module | Purpose |
|--------|---------|
| `scheduler/` | WorkflowScheduler — main execution loop |
| `scheduler/graph-index.ts` | O(1) edge/node lookups (replaces linear scans) |
| `scheduler/critical-path.ts` | Longest-path priority computation |
| `scheduler/abort-tree.ts` | Structured cancellation via AbortSignal.any() |
| `scheduler/checkpoint-manager.ts` | Debounced, non-blocking state persistence |
| `scheduler/node-cache.ts` | SHA-256 content-addressable memoization |
| `scheduler/event-recorder.ts` | Per-node NDJSON event logging |
| `scheduler/event-replay.ts` | Deterministic replay from recorded events |
| `adapters/` | claude-sdk, claude-cli, codex, cursor, echo |
| `adapters/adapter-pool.ts` | Bounded concurrency with per-adapter limits |
| `gates/` | GateEvaluator — 5 condition types, path containment |
| `worktree/` | Lazy sparse-checkout worktrees with mutex |
| `monitor/` | WebSocket server + ring-buffer fan-out |

### Security model

- **Parameter interpolation:** JSON-escaped before substitution, re-validated against schema after
- **Gate path containment:** All file-based gates enforce `isContainedIn()` with symlink-aware `realpath`
- **Gate script environment:** Whitelist-only env vars (`PATH`, `HOME`, `SHELL`, `SYGIL_*`)
- **WebSocket auth:** Per-run UUID token; control events silently dropped for unauthenticated clients
- **Worktree isolation:** Prevents cross-node filesystem interference

### Type system

```
WorkflowGraph      — root schema (version, name, nodes, edges, parameters)
NodeConfig         — per-node config (adapter, model, role, prompt, tools, timeouts)
EdgeConfig         — directed edge (from, to, gate?, isLoopBack?, maxRetries?)
GateCondition      — discriminated union of 5 condition types
AgentAdapter       — interface: isAvailable, spawn, resume, stream, getResult, kill
AgentEvent         — discriminated union: tool_call | tool_result | file_write | shell_exec | text_delta | cost_update | stall | error
NodeResult         — output, exitCode, durationMs, costUsd?, tokenUsage?
WorkflowRunState   — checkpoint: status, completedNodes, nodeResults, totalCostUsd, retryCounters
```
