# Sygil

Deterministic orchestration for probabilistic agents. Runs multi-step workflows across heterogeneous AI coding agents (Claude, Cursor, Codex, Gemini, local OpenAI-compatible models) with replayable execution, structured cancellation, and typed gates.

This file captures **load-bearing invariants and gotchas** — the non-obvious constraints that break if violated. For everything else:

- Architecture, scheduler internals, WebSocket protocol, shared types → `docs/ARCHITECTURE.md`
- Setup, commands, environment variables, adapters → `docs/SETUP.md`
- CLI flags and `workflow.json` schema → `docs/API.md`
- Style conventions → `docs/STYLE.md`
- Testing strategy → `docs/TESTING.md`
- Rationale and rejected alternatives → `agentcontext/decisions.md`

---

## Repository layout

Turborepo monorepo, npm workspaces (`packages/*`):

```
packages/cli/      Node.js CLI binary           (sygil)
packages/shared/   Shared types + Zod schemas   (@sygil/shared)
packages/web/      Next.js 14 web UI            (@sygil/web)
```

Dependency graph: `cli → @sygil/shared`, `web → @sygil/shared`, `shared → nothing`.

---

## Working in the codebase

1. **Reproduce first.** Read the source and the failing test, then run it and observe the actual error before proposing a fix.
2. **Check existing patterns.** Grep before introducing a new one — conventions here are consistent.
3. **Parallelize research.** For tasks spanning CLI + web + shared, research each area independently before changing code.
4. **Fix root causes, not symptoms.** No `// @ts-ignore` unless the error is a missing optional peer dep (e.g. `@anthropic-ai/claude-agent-sdk`).
5. **Verify TS after edits** — `npx tsc --noEmit` in the affected package.

---

## Non-obvious conventions

### Import style

Relative imports in CLI and shared use **`.js` extensions** even though files are `.ts` — required for Node ESM resolution:

```ts
import { initCommand } from "./commands/init.js";  // correct
import { initCommand } from "./commands/init";     // breaks at runtime
```

### TypeScript strictness (CLI + shared only)

CLI and shared run with `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`. See `docs/STYLE.md` for the full tsconfig. Three patterns recur:

- **Optional properties:** never assign `undefined`. Use conditional spread: `...(val !== undefined ? { key: val } : {})`.
- **Array index reads:** `arr[i]` is `T | undefined`. Use `arr[i]!` or `arr[i]?.method()`.
- **Narrowing across `await`:** TS preserves narrowing of class properties, making post-`await` rechecks look unreachable. Fix with `(this.state as string) === "cancelled"` or re-read into a typed local.

Web tsconfig disables both (Next.js incompatibility). Don't carry those assumptions back to CLI/shared.

### Platform

Node.js ≥20.11.0, POSIX only. `packages/cli/package.json` declares `"os": ["!win32"]`. Windows users must use WSL2.

---

## Architecture invariants

Full architecture in `docs/ARCHITECTURE.md`. What follows are the rules that break replay determinism, security, or structured cancellation if violated.

### Key constants

Don't inline magic values. From `@sygil/shared` or scheduler modules:

- `STALL_EXIT_CODE = -2` — stall sentinel
- `CHECKPOINT_DEBOUNCE_MS = 100`
- `DEFAULT_QUEUE_HIGH_WATER_MARK = 1000` — NDJSON event queue backpressure
- `GATE_SCRIPT_TIMEOUT_MS = 30_000`
- `KILL_GRACE_PERIOD_MS = 2_000` — cursor adapter kill grace

### Adapters — per-adapter gotchas

Each implements `AgentAdapter` from `@sygil/shared`. Registry and auth in `docs/SETUP.md`. Non-obvious:

- **`cursor`** — always pass `--trust --force` in headless mode. Without `--force` any MCP trust prompt hangs the node.
- **`gemini-cli`** — upstream switched `--allowed-tools` → `--policy` in v0.30.0. No resume flag; loop-backs fall back to cold spawn. Tools allowlist is ignored (warns on non-empty).
- **`local-oai`** — models <3B often drop `tool_calls` mid-stream. Known-good: Llama 3.2 8B+, Qwen2.5 7B+, Mistral Nemo.
- **`@anthropic-ai/claude-agent-sdk`** — optional peer dep. Dynamic import with `.catch(() => null)`, annotated `// @ts-ignore -- optional peer dep`.

**NDJSON event mapper** (`adapters/ndjson-event-mapper.ts`) — `cursor-cli`, `codex-cli`, `gemini-cli` share `dispatchEventLine(line, mapping, internal)`. Declare `EventMapping` at module scope as pure data; dispatcher stays pure bytes → dispatch.

**Shared adapter helpers** — the four stream-json CLI adapters (`claude-cli`, `codex-cli`, `cursor-cli`, `gemini-cli`) also share `adapters/constants.ts` (stall/getResult timings), `adapters/ndjson-line-decoder.ts` (UTF-8-safe chunk→line decoder), and `adapters/session.ts` (`makeAgentSession()` outer envelope). New CLI adapters should reuse these before rolling their own.

**Circuit breaker** — opt-in per adapter type via `PoolConfig.circuitBreaker`. Defaults: 5 failures in 30 s → open for 60 s. `rate_limit` failures ignored (backpressure, not outage). Open acquires throw `CircuitOpenError`, classified by `provider-router.ts` as `retryable:circuit_open` so failover kicks in. Transitions broadcast as `circuit_breaker` WsServerEvent; NOT recorded in NDJSON — the driving failures are.

### Replay determinism

Violating any of these breaks NDJSON replay:

- **Retry jitter is deterministic** — hash of `runId/nodeId/attemptNum` mod `RETRY_JITTER_CAP_MS` (500 ms), **not** `Math.random()`.
- **Model tier resolution is load-time** — if `modelTier` is set and `.sygil/config.json > tiers.<tier>` maps it, the concrete model replaces `model` before the scheduler starts. No runtime learning, no auto-escalation.
- **Shared context writes flow through `context_set` AgentEvent** — never direct state pokes. `NodeConfig.writesContext` allowlists keys; unlisted writes are dropped + emit `error`.
- **Old checkpoints lack `sharedContext`** — a one-line defensive backfill in `scheduler/index.ts > resume()` handles them. Do not remove.

### Monitor and metrics ordering

- `WsMonitorServer.emit()` calls `prometheusMetrics?.observe(event)` **before** the `!this.wss` early-return. Do not reorder — metrics must fire even when no WS clients are connected.
- `MetricsAggregator` subscribes to the `WsServerEvent` stream **before** fanout so aggregates match what clients see.
- `AdapterPool.waitStats()` records a 0 ms sample on uncontended acquires so the aggregate reflects real pressure, not just contended cases.
- `gen_ai.agent.name` is intentionally **not** a metric label (unbounded cardinality — span attribute only).

### Gates

Six types: `exit_code`, `file_exists`, `regex`, `script`, `human_review`, `spec_compliance`. AND logic within a gate. Full semantics in `docs/ARCHITECTURE.md`.

- **One `GateEvaluator` per `executeGraph()` call** — `regexCache` reuse depends on it.
- `evaluate()` accepts `signal?: AbortSignal` — pass the node's abort signal so pending `human_review` cancels on workflow cancel.
- `evaluateScript` and `HookRunner.run` both build their child env via `utils/safe-env.ts > buildSafeEnv(extra)` and both check paths via `gates/index.ts > isContainedIn`. Do not reinline either — the shared helper is the security contract.

### Lifecycle hooks

Project scripts in `.sygil/config.json > hooks: { preNode?, postNode?, preGate?, postGate? }`. Implementation: `packages/cli/src/hooks/hook-runner.ts`.

| Hook | Aborts node on non-zero? |
|---|---|
| `preNode` | **Yes** |
| `postNode`, `preGate`, `postGate` | No |

- Security mirrors `gates/index.ts > evaluateScript` — do not bypass `validateHookPath`. Path containment uses the exported `isContainedIn` from `gates/index.ts`; env whitelist lives in `utils/safe-env.ts`.
- Parent env is **not** leaked; only the whitelist in `utils/safe-env.ts > ALLOWED_ENV_KEYS` (`PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR`, `TMP`, `TEMP`) plus fresh `SYGIL_*` vars per hook. Parent `SYGIL_*` vars are not forwarded.
- Every hook emits a `hook_result` AgentEvent → replay sees the same hook sequence.

---

## Security invariants

### Parameter interpolation

`interpolateWorkflow()` (`utils/workflow.ts`) JSON-escapes values via `JSON.stringify(value).slice(1, -1)` and **re-validates** the result against `WorkflowGraphSchema`. Never bypass either — without escaping, a crafted parameter can inject arbitrary JSON structure (adapter, model, prompt overrides).

Literal `{{` / `}}` double: `{{{{foo}}}}` → `{{foo}}`. Implemented as a 3-pass transform with Unicode sentinels; interpolator stays string-literal-only.

### Gate path containment

All path-based gate conditions (`file_exists`, `regex`, `script`, `spec_compliance`) enforce `isContainedIn(resolved, outputDir)`. Prevents absolute probes (`/etc/passwd`), traversal (`../../etc/shadow`), and boolean-oracle exfiltration via regex gates. Scripts additionally allow `templates/gates/`; specs additionally allow `templates/specs/`. **If you add a new path-based gate type, you must add the containment check.**

### WebSocket auth

`WsMonitorServer` generates a per-run `authToken` (UUID). Control events (`pause`, `resume_workflow`, `cancel`, `human_review_approve`, `human_review_reject`) are **silently dropped** for unauthenticated clients. Read-only events (`subscribe`, `unsubscribe`) work without auth. Clients connect with `?token=<uuid>`.

### Structured cancellation

`AbortTree` creates a root `AbortController` per workflow; each node gets a child signal via `AbortSignal.any([root, child])`. `cancel()` propagates to gate `execFileAsync`, worktree git ops, adapter streaming loops, and human-review wait promises.

---

## Web package invariants

- **React Flow edge type:** `"sygil"` (not `"default"`). Drag MIME: `"application/sygil-node-type"`.
- **`monitor/page.tsx`** must stay wrapped in `<Suspense>` — `useSearchParams()` requires it for Next.js static rendering.
- **No mock data in monitor.** `ExecutionMonitor` shows "No workflow connected" when `wsUrl === null`. Do not re-introduce `MOCK_WORKFLOW` / `MOCK_TIMELINE_ENTRIES` / `MOCK_WS_EVENTS`.
- **`WsServerEvent.timestamp`** — `WsMonitorServer.emit()` injects `new Date().toISOString()`; `EventStream` renders it directly. Do not substitute `BASE_TIME + OFFSET`.
- **Editor Zod validation** — `WorkflowEditor.tsx` calls `safeParse()` before export; `useWorkflowEditor.ts` calls it on import. Both paths must stay validated.
- **Contrast floor** — `text-dim` (#71717a, ~4.5:1) is the minimum for informational text. No `text-subtle` / `text-muted`.
- **Touch targets** — interactive elements use `min-h-[44px]`.
- After any `@sygil/shared` type change or package rename: `rm -rf packages/web/.next`.

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `process.chdir() not supported in workers` | Vitest defaulting to worker threads | `pool: "forks"` in `packages/cli/vitest.config.ts` — already set |
| `Cannot find module '@sygil/shared'` | Stale `.next` cache | `rm -rf packages/web/.next` |
| `Object is possibly undefined` on `arr[i]` | `noUncheckedIndexedAccess: true` | Add `!` or `?.` |
| `Type 'X \| undefined' not assignable to 'X'` | `exactOptionalPropertyTypes: true` | Conditional spread |
| Monitor page crashes on static export | `useSearchParams()` without `<Suspense>` | Wrap in `<Suspense>` |
| Rate-limit loop runs forever | Rate-limit retries bypass `maxRetries` by design | Set provider fallback or lower concurrency |
| Node hangs despite `timeoutMs` | Agent trickles output, never stalls | Add `idleTimeoutMs` |
| WebSocket control events silently ignored | Client not authenticated | Connect with `?token=<authToken>` |
| `interpolateWorkflow` throws after valid params | Injected JSON structure fails re-validation | Working as intended |
| `Module '"@sygil/shared"' has no exported member` | Shared not rebuilt after type change | `cd packages/shared && npx tsc` |
