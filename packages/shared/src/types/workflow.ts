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
  z.object({ type: z.literal("exit_code"), value: z.number().int() }),
  z.object({ type: z.literal("file_exists"), path: z.string().min(1) }),
  z.object({ type: z.literal("regex"), filePath: z.string().min(1), pattern: z.string().min(1) }),
  z.object({ type: z.literal("script"), path: z.string().min(1) }),
  z.object({ type: z.literal("human_review"), prompt: z.string().optional() }),
  z.object({
    type: z.literal("spec_compliance"),
    specPath: z.string().min(1),
    mode: z.enum(["exact", "superset"]),
  }),
]);

export const GateConfigSchema = z.object({
  conditions: z.array(GateConditionSchema).min(1),
});

export const ContractConfigSchema = z.object({
  outputSchema: z.record(z.unknown()).optional(),
  inputMapping: z.record(z.string()).optional(),
});

export const ProviderConfigSchema = z.object({
  adapter: z.enum(["claude-sdk", "claude-cli", "codex", "cursor", "echo", "gemini-cli", "local-oai"]),
  model: z.string().min(1).optional(),
  priority: z.number().int(),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1),
  initialDelayMs: z.number().int().min(0),
  backoffMultiplier: z.number().min(1),
  maxDelayMs: z.number().int().min(0),
  retryableErrors: z.array(z.enum(["transport", "rate_limit", "server_5xx"])).min(1).optional(),
}).superRefine((policy, ctx) => {
  if (policy.maxDelayMs < policy.initialDelayMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `retryPolicy.maxDelayMs (${policy.maxDelayMs}) must be >= initialDelayMs (${policy.initialDelayMs})`,
    });
  }
});

export const NodeConfigSchema = z.object({
  adapter: z.enum(["claude-sdk", "claude-cli", "codex", "cursor", "echo", "gemini-cli", "local-oai"]),
  model: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  outputDir: z.string().optional(),
  expectedOutputs: z.array(z.string()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  sandbox: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
  providers: z.array(ProviderConfigSchema).min(1).optional(),
  modelTier: z.enum(["cheap", "smart"]).optional(),
  writesContext: z.array(z.string().min(1)).optional(),
  readsContext: z.array(z.string().min(1)).optional(),
  retryPolicy: RetryPolicySchema.optional(),
});

export const EdgeConfigSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  gate: GateConfigSchema.optional(),
  contract: ContractConfigSchema.optional(),
  isLoopBack: z.boolean().optional(),
  maxRetries: z.number().int().positive().optional(),
}).superRefine((edge, ctx) => {
  if (edge.isLoopBack && edge.maxRetries === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Loop-back edge "${edge.id}" must define maxRetries`,
    });
  }
});

export const ParameterConfigSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

export interface NodeExecutionStatus {
  status: "idle" | "running" | "completed" | "failed";
  attempt: number;
  durationMs?: number;
  costUsd?: number;
}

export const WorkflowGraphSchema = z.object({
  version: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.record(NodeConfigSchema).refine(nodes => Object.keys(nodes).length > 0, "Workflow must have at least one node"),
  edges: z.array(EdgeConfigSchema),
  parameters: z.record(ParameterConfigSchema).optional(),
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
