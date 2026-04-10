import { z } from "zod";

export type AdapterType = "claude-sdk" | "claude-cli" | "codex" | "cursor" | "echo";
export type SandboxMode = "read-only" | "workspace-write" | "full-access";

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
  | { type: "human_review"; prompt?: string };

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
]);

export const GateConfigSchema = z.object({
  conditions: z.array(GateConditionSchema).min(1),
});

export const ContractConfigSchema = z.object({
  outputSchema: z.record(z.unknown()).optional(),
  inputMapping: z.record(z.string()).optional(),
});

export const NodeConfigSchema = z.object({
  adapter: z.enum(["claude-sdk", "claude-cli", "codex", "cursor", "echo"]),
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
