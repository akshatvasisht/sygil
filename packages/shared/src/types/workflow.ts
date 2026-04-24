import { z } from "zod";

export type AdapterType = "claude-sdk" | "claude-cli" | "codex" | "cursor" | "echo" | "gemini-cli" | "local-oai";
export type SandboxMode = "read-only" | "workspace-write" | "full-access";

/**
 * Static model tiers. Authored on a node via `modelTier`, resolved
 * to a concrete model ID at workflow-load time from the project-level
 * `tiers` mapping in `.sygil/config.json`. Always deterministic — no runtime
 * learning, no automatic escalation.
 */
export type ModelTier = "cheap" | "smart";

export interface WorkflowGraph {
  version: string;
  name: string;
  description?: string;
  nodes: Record<string, NodeConfig>;
  edges: EdgeConfig[];
  parameters?: Record<string, ParameterConfig>;
}

// Sentinel exit code used by the scheduler when a node stalls (stdout closes without process exit).
export const STALL_EXIT_CODE = -2;

/**
 * A single provider entry for multi-provider failover.
 * Lower `priority` runs first. Ties break by declaration order.
 * If `model` is omitted, the node's top-level `model` is used.
 */
export interface ProviderConfig {
  adapter: AdapterType;
  model?: string;
  priority: number;
}

/**
 * Classes of transient errors a RetryPolicy can opt into.
 * Must match the classification strings produced by
 * `adapters/provider-router.ts > classifyError` — see the Zod enum below.
 */
export type RetryableErrorClass = "transport" | "rate_limit" | "server_5xx";

/**
 * Per-node retry policy. Wraps each provider attempt with an
 * exponential-backoff retry loop for whitelisted transient errors. When
 * retries are exhausted, control returns to the provider-failover loop,
 * which may try the next provider.
 *
 * Backoff formula: `min(initialDelayMs * backoffMultiplier^(attempt-1), maxDelayMs)`
 * plus a deterministic jitter of up to ~500ms derived from
 * `hash(runId + nodeId + attempt)` so replay produces the same delay schedule.
 *
 * `retryableErrors` is an explicit opt-in whitelist. Omitted/empty defaults to
 * all three classes. `maxAttempts` counts total attempts (not retries) — a
 * value of 1 disables retries entirely.
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  retryableErrors?: RetryableErrorClass[];
}

export interface NodeConfig {
  adapter: AdapterType;
  model: string;
  role: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  outputDir?: string;
  expectedOutputs?: string[];
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Kill the node if no AgentEvent is received for this many ms. Complements timeoutMs (wall-clock). */
  idleTimeoutMs?: number;
  sandbox?: SandboxMode;
  /**
   * Provider-failover list. When present, the scheduler tries each
   * provider in priority order (lowest first) on whitelisted transient errors
   * (rate_limit, transport, 5xx). `adapter` + `model` still define the primary
   * attempt for backwards compatibility; `providers` takes precedence when set.
   */
  providers?: ProviderConfig[];
  /**
   * Static tier tag. When set and the project config defines a
   * mapping for this tier (`tiers.cheap` / `tiers.smart`), the resolved tier
   * model overrides `model` at workflow-load time so checkpoints see the
   * concrete ID. When no mapping exists, `model` is used verbatim.
   */
  modelTier?: ModelTier;
  /**
   * Typed sharedContext keys this node is allowed to write. A
   * `context_set` event with a key not in this allowlist is rejected by the
   * scheduler and emitted as an error. Omit or empty = node cannot write.
   */
  writesContext?: string[];
  /**
   * Typed sharedContext keys this node wants interpolated into its prompt via
   * `{{ctx.<key>}}` before spawn. Missing keys interpolate as an empty string
   * (deterministic). Omit = no ctx interpolation.
   */
  readsContext?: string[];
  /**
   * Per-node retry policy. Applies to each provider attempt —
   * a retry with `retryPolicy` exhausted still falls through to the next
   * provider in `providers` (if any). Jitter is deterministic from
   * `hash(runId + nodeId + attempt)` so replay is stable. Rate-limit
   * events with adapter-supplied delays still use the dedicated pause
   * path; only `rate_limit` errors WITHOUT an adapter-supplied delay are
   * handled here.
   */
  retryPolicy?: RetryPolicy;
  /**
   * Workflow-scoped sync primitive. Acquired before the adapter pool slot so
   * nodes sharing the same key cannot run concurrently beyond the declared
   * limit. A mutex is a semaphore with limit=1.
   */
  synchronization?:
    | { mutex: string }
    | { semaphore: { key: string; limit: number } };
}

export interface EdgeConfig {
  id: string;
  from: string;
  to: string;
  gate?: GateConfig;
  contract?: ContractConfig;
  /**
   * Back-edges (loop-backs) create cycles in the workflow graph.
   * maxRetries is required on all back-edges — unbounded cycles are invalid.
   */
  isLoopBack?: boolean;
  maxRetries?: number;
}

export interface GateConfig {
  conditions: GateCondition[];
}

export type GateCondition =
  | { type: "exit_code"; value: number }
  | { type: "file_exists"; path: string }
  | { type: "regex"; filePath: string; pattern: string }
  | { type: "script"; path: string }
  | { type: "human_review"; prompt?: string }
  | { type: "spec_compliance"; specPath: string; mode: "exact" | "superset" };

export interface ContractConfig {
  /** v3: JSON schema the preceding node's output must conform to */
  outputSchema?: Record<string, unknown>;
  /** v2: map fields from preceding node output into next node context */
  inputMapping?: Record<string, string>;
}

export interface ParameterConfig {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
  default?: unknown;
}

// ---------------------------------------------------------------------------
// Zod schemas — mirror the TypeScript types above with extra runtime validation
// ---------------------------------------------------------------------------

export const GateConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exit_code"),
    value: z.number().int().describe("Expected exit code — gate passes when the node's exit code matches."),
  }).describe("Pass when the upstream node's exit code equals the expected value."),
  z.object({
    type: z.literal("file_exists"),
    path: z.string().min(1).describe("Path relative to the node's outputDir; absolute paths and traversal are rejected."),
  }).describe("Pass when a file exists at the given path within the node's outputDir."),
  z.object({
    type: z.literal("regex"),
    filePath: z.string().min(1).describe("Path (outputDir-relative) to a file whose contents are tested against the pattern."),
    pattern: z.string().min(1).describe("JavaScript-flavoured regex compiled with default flags."),
  }).describe("Pass when a regex matches anywhere in the target file's contents."),
  z.object({
    type: z.literal("script"),
    path: z.string().min(1).describe("Executable gate script; must resolve inside outputDir or templates/gates/."),
  }).describe("Pass when the gate script exits with code 0; receives SYGIL_EXIT_CODE/OUTPUT_DIR/OUTPUT in env."),
  z.object({
    type: z.literal("human_review"),
    prompt: z.string().optional().describe("Reviewer-facing question; defaults to a generic approve/reject prompt."),
  }).describe("Pause the workflow until a human approves or rejects via CLI or monitor."),
  z.object({
    type: z.literal("spec_compliance"),
    specPath: z.string().min(1).describe("Path to the spec markdown; must resolve inside outputDir or templates/specs/."),
    mode: z.enum(["exact", "superset"]).describe("exact = output must match spec verbatim; superset = spec must be covered by output."),
  }).describe("Pass when the upstream node's output conforms to the named spec."),
]);

export const GateConfigSchema = z.object({
  conditions: z.array(GateConditionSchema).min(1).describe("AND-joined conditions; every condition must pass for the gate to pass."),
});

export const ContractConfigSchema = z.object({
  outputSchema: z.record(z.string(), z.unknown()).optional()
    .describe("JSON Schema the upstream node's output must satisfy before traversing this edge."),
  inputMapping: z.record(z.string(), z.string()).optional()
    .describe("Legacy field → field mapping from upstream output into downstream context."),
});

export const ProviderConfigSchema = z.object({
  adapter: z.enum(["claude-sdk", "claude-cli", "codex", "cursor", "echo", "gemini-cli", "local-oai"])
    .describe("Adapter type to use for this provider attempt."),
  model: z.string().min(1).optional()
    .describe("Model ID for this provider; falls back to the node's top-level model when omitted."),
  priority: z.number().int()
    .describe("Lower numbers run first; ties break by declaration order."),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1)
    .describe("Total attempts including the first; 1 disables retries."),
  initialDelayMs: z.number().int().min(0)
    .describe("Delay before the second attempt; subsequent delays multiply by backoffMultiplier."),
  backoffMultiplier: z.number().min(1)
    .describe("Multiplier applied between attempts; 1 = constant delay, 2 = classic exponential."),
  maxDelayMs: z.number().int().min(0)
    .describe("Upper bound on computed delay; must be >= initialDelayMs."),
  retryableErrors: z.array(z.enum(["transport", "rate_limit", "server_5xx"])).min(1).optional()
    .describe("Opt-in whitelist of transient error classes; omitted = all three classes retry."),
}).superRefine((policy, ctx) => {
  if (policy.maxDelayMs < policy.initialDelayMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `retryPolicy.maxDelayMs (${policy.maxDelayMs}) must be >= initialDelayMs (${policy.initialDelayMs})`,
    });
  }
});

export const NodeConfigSchema = z.object({
  adapter: z.enum(["claude-sdk", "claude-cli", "codex", "cursor", "echo", "gemini-cli", "local-oai"])
    .describe("Agent adapter to spawn; controls how the prompt is executed and which CLI/SDK is used.")
    .meta({ category: "core" }),
  model: z.string().min(1)
    .describe("Model ID passed to the adapter; resolved from modelTier before scheduler start when a tier mapping exists.")
    .meta({ category: "core" }),
  role: z.string().min(1)
    .describe("Free-form label shown in the monitor and logs; no behavioral effect.")
    .meta({ category: "core" }),
  prompt: z.string().min(1)
    .describe("Prompt text; supports {{parameters.X}}, {{nodes.X.output}}, and {{ctx.X}} interpolation.")
    .meta({ category: "core" }),
  tools: z.array(z.string()).optional()
    .describe("Allowlist of tool names the agent may call; adapter support varies — see ADAPTER_MATRIX.")
    .meta({ category: "contract" }),
  disallowedTools: z.array(z.string()).optional()
    .describe("Blocklist of tool names the agent must not call; adapter support mirrors tools.")
    .meta({ category: "contract" }),
  outputDir: z.string().optional()
    .describe("Working directory for file-based gate checks; defaults to the run's working directory.")
    .meta({ category: "contract" }),
  expectedOutputs: z.array(z.string()).optional()
    .describe("Paths (outputDir-relative) expected to exist after the node completes; surfaced to gates and monitors.")
    .meta({ category: "contract" }),
  outputSchema: z.record(z.string(), z.unknown()).optional()
    .describe("JSON Schema the node's structured output must conform to; adapters that support strict mode enforce it provider-side.")
    .meta({ category: "contract" }),
  maxTurns: z.number().int().positive().optional()
    .describe("Upper bound on agent turns; adapter support varies — several CLIs ignore this field.")
    .meta({ category: "limits" }),
  maxBudgetUsd: z.number().positive().optional()
    .describe("Cost ceiling in USD; node fails with a budget error when exceeded (adapters that report cost).")
    .meta({ category: "limits" }),
  timeoutMs: z.number().int().positive().optional()
    .describe("Wall-clock timeout; node is cancelled via SIGTERM→SIGKILL when exceeded.")
    .meta({ category: "limits" }),
  idleTimeoutMs: z.number().int().positive().optional()
    .describe("Idle timeout; node is cancelled when no AgentEvent is received for this long.")
    .meta({ category: "limits" }),
  sandbox: z.enum(["read-only", "workspace-write", "full-access"]).optional()
    .describe("Filesystem permission boundary for sandbox-aware adapters (codex, cursor).")
    .meta({ category: "contract" }),
  providers: z.array(ProviderConfigSchema).min(1).optional()
    .describe("Failover list; scheduler tries providers in priority order on transient errors and takes precedence over top-level adapter.")
    .meta({ category: "resilience" }),
  modelTier: z.enum(["cheap", "smart"]).optional()
    .describe("Symbolic tier resolved at workflow-load time via .sygil/config.json > tiers; overrides model with the mapped value.")
    .meta({ category: "resilience" }),
  writesContext: z.array(z.string().min(1)).optional()
    .describe("Allowlist of sharedContext keys this node may write via context_set events; unlisted writes are dropped.")
    .meta({ category: "context" }),
  readsContext: z.array(z.string().min(1)).optional()
    .describe("sharedContext keys interpolated into the prompt via {{ctx.<key>}}; missing keys resolve to empty string.")
    .meta({ category: "context" }),
  retryPolicy: RetryPolicySchema.optional()
    .describe("Per-provider retry loop for transient errors; deterministic jitter preserves replay.")
    .meta({ category: "resilience" }),
  synchronization: z.union([
    z.object({ mutex: z.string().min(1) }),
    z.object({ semaphore: z.object({ key: z.string().min(1), limit: z.number().int().min(1) }) }),
  ]).optional()
    .describe("Workflow-scoped sync primitive: mutex (1 concurrent) or semaphore (N concurrent) keyed by arbitrary string. Acquired before the adapter pool slot.")
    .meta({ category: "resilience" }),
});

export const EdgeConfigSchema = z.object({
  id: z.string().min(1)
    .describe("Unique edge identifier; used for gate attribution in the monitor and logs.")
    .meta({ category: "core" }),
  from: z.string().min(1)
    .describe("Source node ID; must match a key in workflow.nodes.")
    .meta({ category: "core" }),
  to: z.string().min(1)
    .describe("Destination node ID; must match a key in workflow.nodes.")
    .meta({ category: "core" }),
  gate: GateConfigSchema.optional()
    .describe("Conditions evaluated after the source node completes; failure blocks traversal.")
    .meta({ category: "core" }),
  contract: ContractConfigSchema.optional()
    .describe("Output contract enforced on the source node's structured output before traversal.")
    .meta({ category: "core" }),
  isLoopBack: z.boolean().optional()
    .describe("True for back-edges that create loops; requires maxRetries.")
    .meta({ category: "resilience" }),
  maxRetries: z.number().int().positive().optional()
    .describe("Upper bound on loop-back traversals for this edge; required when isLoopBack is true.")
    .meta({ category: "resilience" }),
}).superRefine((edge, ctx) => {
  if (edge.isLoopBack && edge.maxRetries === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Loop-back edge "${edge.id}" must define maxRetries`,
    });
  }
});

export const ParameterConfigSchema = z.object({
  type: z.enum(["string", "number", "boolean"])
    .describe("Parameter primitive type; governs how CLI flags are parsed."),
  description: z.string().optional()
    .describe("Human-readable description shown in help text and the editor's Run modal."),
  required: z.boolean().optional()
    .describe("When true, the parameter must be provided at run time; no default is consulted."),
  default: z.unknown().optional()
    .describe("Value used when the parameter is omitted at run time; type must match the declared type."),
});

export interface NodeExecutionStatus {
  status: "idle" | "running" | "completed" | "failed";
  attempt: number;
  durationMs?: number;
  costUsd?: number;
}

export const WorkflowGraphSchema = z.object({
  version: z.string()
    .describe("Workflow schema version string; authored templates currently use \"1.0\"."),
  name: z.string().min(1)
    .describe("Human-readable workflow name; shown in the monitor title and CLI logs."),
  description: z.string().optional()
    .describe("Optional longer description surfaced in share bundles and the editor."),
  nodes: z.record(z.string(), NodeConfigSchema)
    .refine(nodes => Object.keys(nodes).length > 0, "Workflow must have at least one node")
    .describe("Node definitions keyed by stable node ID; order is irrelevant to execution."),
  edges: z.array(EdgeConfigSchema)
    .describe("Directed edges between nodes; gates and contracts are attached here, not on nodes."),
  parameters: z.record(z.string(), ParameterConfigSchema).optional()
    .describe("Run-time parameters surfaced as CLI flags and editor form fields."),
}).superRefine((graph, ctx) => {
  const nodeIds = new Set(Object.keys(graph.nodes));
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate edge ID: "${edge.id}"` });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Edge "${edge.id}" references unknown node "${edge.from}"` });
    }
    if (!nodeIds.has(edge.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Edge "${edge.id}" references unknown node "${edge.to}"` });
    }
  }

  // Validate {{nodes.<id>...}} references in prompts have forward-edge reachability
  // Build forward adjacency list (excluding loop-back edges)
  const forwardAdj = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    forwardAdj.set(id, new Set());
  }
  for (const edge of graph.edges) {
    if (edge.isLoopBack) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    forwardAdj.get(edge.from)!.add(edge.to);
  }

  // BFS reachability check: can `from` reach `to` via forward edges?
  function isReachable(from: string, to: string): boolean {
    if (from === to) return true;
    const visited = new Set<string>();
    const queue = [from];
    visited.add(from);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = forwardAdj.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (neighbor === to) return true;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return false;
  }

  const refPattern = /\{\{nodes\.([\w]+)\./g;
  for (const [currentNodeId, nodeConfig] of Object.entries(graph.nodes)) {
    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(nodeConfig.prompt)) !== null) {
      const referencedNodeId = match[1]!;
      if (!nodeIds.has(referencedNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Node "${currentNodeId}" references unknown node "${referencedNodeId}" in prompt via {{nodes.${referencedNodeId}...}}`,
        });
      } else if (!isReachable(referencedNodeId, currentNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Node "${currentNodeId}" references node "${referencedNodeId}" in prompt, but there is no forward-edge path from "${referencedNodeId}" to "${currentNodeId}"`,
        });
      }
    }
    // Reset lastIndex since we reuse the pattern across iterations
    refPattern.lastIndex = 0;
  }
});
