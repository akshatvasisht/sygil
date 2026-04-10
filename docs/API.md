# CLI Reference

## `sigil init`

Checks which adapters are available in the current environment and writes an initial `.sigil/config.json` if one does not exist.

```bash
sigil init
sigil init --telemetry       # Enable anonymous usage telemetry
sigil init --no-telemetry    # Disable anonymous usage telemetry
```

---

## `sigil run <workflow>`

Runs a workflow. `<workflow>` is a path to a `workflow.json` file or the name of a built-in template.

```bash
sigil run tdd-feature.json
sigil run tdd-feature "add OAuth2 login"
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
| `--config <path>` | Path to `.sigil` config directory (default: `./.sigil`). |

When a run starts, the CLI prints a Vite-style URL:

```
  ➜  Monitor: http://localhost:<port>/monitor?workflow=<name>&token=<token>
```

The browser is auto-opened to this URL unless `--no-open` is passed or the
process is running in a non-TTY environment. The monitor UI is served from the
same port as the WebSocket endpoint — there is no separate WS port.

---

## `sigil validate <workflow>`

Validates a `workflow.json` against the Zod schema and checks that all referenced adapter types are known. Also validates `timeoutMs > 0`, `idleTimeoutMs > 0`, and `maxRetries >= 0`.

```bash
sigil validate tdd-feature.json
```

Exits `0` on success, `1` on validation error.

---

## `sigil resume <run-id>`

Resumes a checkpointed run. The run state is read from `.sigil/runs/<run-id>.json`.

```bash
sigil resume 3f8a2c1d-...
```

Already-completed nodes are skipped. The run continues from the first incomplete node. Session history is preserved for adapters that support `resume()` (e.g. `claude-sdk`).

---

## `sigil replay <run-id>`

Replays recorded NDJSON events from a previous workflow run for debugging and review.

```bash
sigil replay r_8x92kf
sigil replay r_8x92kf --node implementer    # Only replay one node
sigil replay r_8x92kf --speed 0             # Instant replay
sigil replay r_8x92kf --speed 2             # 2x speed
```

**Options**

| Flag | Description |
|---|---|
| `-n, --node <nodeId>` | Only replay events from this node. |
| `-s, --speed <multiplier>` | Playback speed. `0` = instant, `1` = real-time (default), `2` = double speed. |

---

## `sigil list`

Lists available adapters and recent workflow runs.

```bash
sigil list
```

---

## `sigil export <template> <output>`

Copies a built-in template to a local file for editing.

```bash
sigil export tdd-feature my-workflow.json
```

---

## `sigil import-template <file>`

Imports a workflow template from a URL or local file path into the user template store at `~/.sigil/templates/`.

```bash
sigil import-template my-workflow.json
sigil import-template https://example.com/workflow.json
```

---

## `sigil registry list`

Lists all templates available in the remote registry.

```bash
sigil registry list
```

---

## `sigil registry search <query>`

Searches the remote registry by name, description, or tag.

```bash
sigil registry search "tdd typescript"
```

---

## `sigil registry install <name>`

Downloads a template from the remote registry to `~/.sigil/templates/<name>.json`.

```bash
sigil registry install tdd-feature
```

---

## Global options

These options apply to all commands:

| Flag | Description |
|---|---|
| `--config <path>` | Path to `.sigil` config directory. Sets `SIGIL_CONFIG_DIR`. |
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
      "model": "claude-opus-4-5",
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
