# CLI Reference

## `sygil init`

Checks which adapters are available in the current environment and writes an initial `.sygil/config.json` if one does not exist.

```bash
sygil init
sygil init --telemetry       # Enable anonymous usage telemetry
sygil init --no-telemetry    # Disable anonymous usage telemetry
```

---

## `sygil run <workflow>`

Runs a workflow. `<workflow>` is a path to a `workflow.json` file or the name of a built-in template.

```bash
sygil run tdd-feature.json
sygil run tdd-feature "add OAuth2 login"
```

**Options**

| Flag | Description |
|---|---|
| `-p, --param key=value` | Set a workflow parameter. Repeatable. |
| `--dry-run` | Validate and print resolved node configs without executing. |
| `--isolate` | Run each node in an isolated git worktree. Results are merged at fan-in points. |
| `-w, --watch` | Re-run the workflow when the workflow file changes (debounced, max 100 reruns). |
| `--verbose` | Print all agent events to stdout during the run. |
| `--no-open` | Do not automatically open the monitor in a browser. Also suppressed when `!process.stdout.isTTY` (CI). |
| `--no-monitor` | Disable the web monitor entirely (headless/CI mode). |
| `--config <path>` | Path to `.sygil` config directory (default: `./.sygil`). |

When a run starts, the CLI prints a Vite-style URL:

```
  Monitor: http://localhost:<port>/monitor?workflow=<name>&token=<token>
```

The browser is auto-opened to this URL unless `--no-open` is passed or the
process is running in a non-TTY environment. The monitor UI is served from the
same port as the WebSocket endpoint — there is no separate WS port.

---

## `sygil validate <workflow>`

Validates a `workflow.json` against the Zod schema and checks that all referenced adapter types are known. Also validates `timeoutMs > 0`, `idleTimeoutMs > 0`, and `maxRetries >= 0`.

```bash
sygil validate tdd-feature.json
```

Exits `0` on success, `1` on validation error.

---

## `sygil resume <run-id>`

Resumes a checkpointed run. The run state is read from `.sygil/runs/<run-id>.json`.

```bash
sygil resume 3f8a2c1d-...
```

Already-completed nodes are skipped. The run continues from the first incomplete node. Session history is preserved for adapters that support `resume()` (e.g. `claude-sdk`).

---

## `sygil fork <run-id>`

Branches a run from a checkpoint into a new runId. The child starts with a fresh UUID, inherits the parent's `sharedContext` and the first N retained `completedNodes`, and carries `forkedFrom: { runId, checkpointIndex }` so the lineage is recorded.

```bash
sygil fork <parent-run-id>                       # branch at the end of parent's completed nodes
sygil fork <parent-run-id> --at 2                # keep only the first 2 completed nodes
sygil fork <parent-run-id> --param task=altA     # diverge with different params
```

**Options**

| Flag | Description |
|---|---|
| `--at <n>` | Keep the first `n` completed nodes of the parent; re-execute the rest. Clamped to the parent's completed count. Default: keep all. |
| `-p, --param <k=v>` | Parameter overrides. Parent params are NOT inherited — re-specify every required parameter. |

**Semantics**

- `totalCostUsd` resets to 0 on the child. Parent cost is not carried over — sum externally if you need the total.
- Per-node event logs for retained nodes are copied from `<parent>/events/<nodeId>.ndjson` into the child's run dir, so `sygil replay` on the child sees the same prefix history.
- Hooks see `SYGIL_RUN_REASON=fork`.
- Worktree isolation is automatic — the child gets a fresh worktree keyed on its own run-id.

---

## `sygil replay <run-id>`

Replays recorded NDJSON events from a previous workflow run for debugging and review.

```bash
sygil replay r_8x92kf
sygil replay r_8x92kf --node implementer    # Only replay one node
sygil replay r_8x92kf --speed 0             # Instant replay
sygil replay r_8x92kf --speed 2             # 2x speed
```

**Options**

| Flag | Description |
|---|---|
| `-n, --node <nodeId>` | Only replay events from this node. |
| `-s, --speed <multiplier>` | Playback speed. `0` = instant, `1` = real-time (default), `2` = double speed. |

---

## `sygil list`

Lists available adapters and recent workflow runs.

```bash
sygil list
```

---

## `sygil export <template> <output>`

Copies a built-in template to a local file for editing.

```bash
sygil export tdd-feature my-workflow.json
```

---

## `sygil import-template <file>`

Imports a workflow template from a URL or local file path into the user template store at `~/.sygil/templates/`.

```bash
sygil import-template my-workflow.json
sygil import-template https://example.com/workflow.json
```

---

## `sygil registry list`

Lists all templates available in the remote registry.

```bash
sygil registry list
```

---

## `sygil registry search <query>`

Searches the remote registry by name, description, or tag.

```bash
sygil registry search "tdd typescript"
```

---

## `sygil registry install <name>`

Downloads a template from the remote registry to `~/.sygil/templates/<name>.json`.

```bash
sygil registry install tdd-feature
```

---

## Global options

These options apply to all commands:

| Flag | Description |
|---|---|
| `--config <path>` | Path to `.sygil` config directory. Sets `SYGIL_CONFIG_DIR`. |
| `-v, --verbose` | Verbose output. |
| `--version` | Print version and exit. |
| `-h, --help` | Print help and exit. |

---

## `workflow.json` schema

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full type reference. Minimal example:

```json
{
  "version": "1.0",
  "name": "my-workflow",
  "nodes": {
    "planner": {
      "adapter": "claude-sdk",
      "model": "claude-opus-4-7",
      "role": "You are a senior software architect.",
      "prompt": "Plan the implementation for: {{task}}",
      "tools": ["Read", "Grep", "Glob"],
      "outputDir": "./output/planner"
    },
    "implementer": {
      "adapter": "codex",
      "model": "o3",
      "role": "You are an expert software engineer.",
      "prompt": "Implement the plan in the output directory.",
      "sandbox": "workspace-write",
      "outputDir": "./output/implementer"
    }
  },
  "edges": [
    {
      "id": "plan-to-impl",
      "from": "planner",
      "to": "implementer",
      "gate": {
        "conditions": [
          { "type": "file_exists", "path": "plan.md" }
        ]
      }
    }
  ],
  "parameters": {
    "task": {
      "type": "string",
      "description": "The task to implement",
      "required": true
    }
  }
}
```

### Node fields

| Field | Type | Required | Description |
|---|---|---|---|
| `adapter` | `"claude-sdk" \| "codex" \| "claude-cli" \| "cursor" \| "echo"` | Yes | Agent runtime |
| `model` | `string` | Yes | Model identifier passed to the adapter |
| `role` | `string` | Yes | System prompt for the agent |
| `prompt` | `string` | Yes | Task prompt. Supports `{{param}}` substitution. |
| `tools` | `string[]` | No | Allowed tool names |
| `disallowedTools` | `string[]` | No | Explicitly blocked tool names |
| `outputDir` | `string` | No | Working directory for the agent |
| `expectedOutputs` | `string[]` | No | Files the node is expected to produce (checked on completion) |
| `outputSchema` | `object` | No | JSON Schema for structured output validation |
| `timeoutMs` | `number` | No | Wall-clock deadline — kill the agent after this many ms |
| `idleTimeoutMs` | `number` | No | Kill the agent if no `AgentEvent` arrives for this many ms |
| `maxBudgetUsd` | `number` | No | Spend limit in USD (claude-sdk only) |
| `maxTurns` | `number` | No | Maximum conversation turns |
| `sandbox` | `"read-only" \| "workspace-write" \| "full-access"` | No | Sandbox level (codex only) |

### Edge fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique edge identifier |
| `from` | `string` | Yes | Source node ID |
| `to` | `string` | Yes | Target node ID |
| `gate` | `GateConfig` | No | Conditions that must pass for the edge to fire |
| `contract` | `ContractConfig` | No | Schema validation and input mapping |
| `isLoopBack` | `boolean` | No | Mark as a retry cycle back-edge |
| `maxRetries` | `number` | No | Required on back-edges. Max retry attempts. |

### Contract fields

| Field | Type | Description |
|---|---|---|
| `outputSchema` | `object` | JSON schema the preceding node's structured output must conform to |
| `inputMapping` | `Record<string, string>` | Map fields from preceding node output into next node context |

### Parameter fields

| Field | Type | Description |
|---|---|---|
| `type` | `"string" \| "number" \| "boolean"` | Parameter value type |
| `description` | `string` | Human-readable description |
| `required` | `boolean` | Whether the parameter must be provided at runtime |
| `default` | `unknown` | Default value if not provided |

### Gate condition types

| Type | Required fields | Passes when |
|---|---|---|
| `exit_code` | `value: number` | Node exit code equals `value` |
| `file_exists` | `path: string` | File exists at `outputDir/<path>` |
| `regex` | `filePath: string`, `pattern: string` | File content matches the regular expression |
| `script` | `path: string` | Script at `outputDir/<path>` exits with code 0 |
| `human_review` | `prompt?: string` | A human approves via CLI prompt or WebSocket |

### Loop-back edges

Set `isLoopBack: true` and `maxRetries: <n>` on an edge to create a retry cycle. When the gate on a loop-back edge fails, the target node is re-queued. The adapter's `resume()` method is called instead of `spawn()`, so session-capable adapters (e.g. `claude-sdk`) continue the same conversation thread.

```json
{
  "id": "review-to-impl",
  "from": "reviewer",
  "to": "implementer",
  "isLoopBack": true,
  "maxRetries": 3,
  "gate": {
    "conditions": [
      { "type": "script", "path": "gates/check-approved.sh" }
    ]
  }
}
```
