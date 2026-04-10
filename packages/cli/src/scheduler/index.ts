import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import type {
  WorkflowGraph,
  EdgeConfig,
  NodeConfig,
  NodeResult,
  WorkflowRunState,
  AgentAdapter,
  AdapterType,
  AgentEvent,
  AgentSession,
} from "@sigil/shared";
import { validateStructuredOutput, resolveInputMapping, STALL_EXIT_CODE } from "@sigil/shared";
import { GateEvaluator } from "../gates/index.js";
import { LazyWorktreeManager } from "../worktree/lazy-worktree-manager.js";
import { needsIsolation } from "../worktree/isolation-check.js";
import { AbortTree } from "./abort-tree.js";
import { NodeCache, computeContentHash, areGatesDeterministic } from "./node-cache.js";
import { AdapterPool } from "../adapters/adapter-pool.js";
import type { PoolSlot, PoolConfig } from "../adapters/adapter-pool.js";
import type { WsMonitorServer } from "../monitor/websocket.js";
import { logger } from "../utils/logger.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { GraphIndex } from "./graph-index.js";
import { computeCriticalPathWeights } from "./critical-path.js";
import { EventRecorder } from "./event-recorder.js";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AdapterFactory = (type: AdapterType) => AgentAdapter;

interface RunResult {
  runId: string;
  success: boolean;
  durationMs: number;
  totalCostUsd?: number;
  error?: string;
}

export interface RunOptions {
  isolate?: boolean;
  pool?: PoolConfig;
}

type SchedulerState = "idle" | "running" | "paused" | "cancelled";

// ---------------------------------------------------------------------------
// Graph topology helpers
// ---------------------------------------------------------------------------

/**
 * Build a map: nodeId -> list of edge IDs whose `to` is that node (forward edges only).
 * Uses GraphIndex for O(1) edge lookups.
 */
function buildIncomingForwardEdgeIds(graphIndex: GraphIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const nodeId of graphIndex.nodeIds) {
    const incoming = graphIndex.edgesByTo.get(nodeId) ?? [];
    const forwardEdgeIds = incoming
      .filter((e) => !e.isLoopBack)
      .map((e) => e.id);
    map.set(nodeId, forwardEdgeIds);
  }
  return map;
}

/**
 * WorkflowScheduler — executes a WorkflowGraph using a topological ready-queue.
 *
 * Graph execution rules:
 * - Start nodes: nodes with no incoming forward edges
 * - Parallel execution: all ready nodes run concurrently
 * - After each node, evaluate outgoing edge gates
 * - Loop-back edges: on gate failure, re-queue the target node (up to maxRetries)
 * - Forward edges: on gate failure, mark target as failed
 * - State is checkpointed to .sigil/runs/<id>.json after each node
 */
export class WorkflowScheduler extends EventEmitter {
  private state: SchedulerState = "idle";
  private pausePromise: Promise<void> | null = null;
  private pauseResolve: (() => void) | null = null;
  private retryCounters = new Map<string, number>();
  private sessionStore = new Map<string, AgentSession>();
  private checkpointManager: CheckpointManager | null = null;
  private abortTree: AbortTree | null = null;
  private eventRecorder: EventRecorder | null = null;
  private gateFailureReasons = new Map<string, string>();
  private graphIndex: GraphIndex;
  private actualOutputDirs: Map<string, string> = new Map();
  private nodeCache: NodeCache | null = null;
  private contentHashes = new Map<string, string>();
  private adapterPool: AdapterPool | null = null;
  /** Mutex to serialize concurrent runState mutations from parallel node completions. */
  private completionMutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly workflow: WorkflowGraph,
    private readonly adapterFactory: AdapterFactory,
    private readonly monitor: WsMonitorServer,
    private readonly workflowFilePath?: string
  ) {
    super();
    this.graphIndex = new GraphIndex(workflow);
  }

  /**
   * Run the workflow from the beginning.
   */
  async run(
    workflowId: string,
    parameters: Record<string, string> = {},
    options: RunOptions = {}
  ): Promise<RunResult> {
    const runId = randomUUID();
    const startedAt = Date.now();

    const runState: WorkflowRunState = {
      id: runId,
      workflowName: this.workflow.name,
      workflowPath: this.workflowFilePath ?? "",
      status: "running",
      startedAt: new Date().toISOString(),
      completedNodes: [],
      nodeResults: {},
      totalCostUsd: 0,
      retryCounters: {},
    };

    this.state = "running";
    this.retryCounters.clear();
    this.sessionStore.clear();
    this.gateFailureReasons.clear();
    this.actualOutputDirs.clear();
    this.checkpointManager = new CheckpointManager(process.cwd());
    const runDir = join(process.cwd(), ".sigil", "runs", runId);
    this.eventRecorder = new EventRecorder(runDir);
    const cacheDir = join(process.cwd(), ".sigil", "cache");
    this.nodeCache = new NodeCache(cacheDir);
    this.contentHashes.clear();
    this.monitor.emit({ type: "workflow_start", workflowId, graph: this.workflow });

    const worktreeManager = options.isolate ? new LazyWorktreeManager(runId) : undefined;
    this.adapterPool = options.pool ? new AdapterPool(options.pool) : null;

    try {
      await this.executeGraph(workflowId, runState, parameters, false, worktreeManager);
      runState.status = "completed";
      runState.completedAt = new Date().toISOString();
      await this.eventRecorder.flushAll();
      this.checkpointManager.markDirty(runState);
      await this.checkpointManager.flush();

      const durationMs = Date.now() - startedAt;
      this.monitor.emit({
        type: "workflow_end",
        workflowId,
        success: true,
        durationMs,
        totalCostUsd: runState.totalCostUsd,
      });

      const totalCostUsd = runState.totalCostUsd > 0 ? runState.totalCostUsd : undefined;
      return {
        runId,
        success: true,
        durationMs,
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runState.status = "failed";
      runState.completedAt = new Date().toISOString();
      await this.eventRecorder?.flushAll().catch((e: unknown) => logger.warn(`Event recorder flush failed: ${e}`));
      this.checkpointManager.markDirty(runState);
      await this.checkpointManager.flush().catch((e: unknown) => logger.warn(`Checkpoint flush failed — resume may find stale state: ${e}`));

      const durationMs = Date.now() - startedAt;
      const errorEvent: { type: "workflow_error"; workflowId: string; message: string; nodeId?: string } = {
        type: "workflow_error",
        workflowId,
        message,
      };
      if (runState.currentNodeId !== undefined) {
        errorEvent.nodeId = runState.currentNodeId;
      }
      this.monitor.emit(errorEvent);
      this.monitor.emit({
        type: "workflow_end",
        workflowId,
        success: false,
        durationMs,
        totalCostUsd: runState.totalCostUsd,
      });

      return {
        runId,
        success: false,
        durationMs,
        error: message,
      };
    } finally {
      this.state = "idle";
      this.checkpointManager.dispose();
      if (this.adapterPool) {
        await this.adapterPool.drain().catch(() => undefined);
      }
      await worktreeManager?.cleanup().catch((e: unknown) => logger.debug(`worktree cleanup failed: ${e}`));
    }
  }

  /**
   * Resume a workflow from persisted state.
   */
  async resume(savedState: WorkflowRunState): Promise<RunResult> {
    const workflowId = savedState.id;
    const startedAt = Date.now();

    savedState.status = "running";
    this.state = "running";
    this.retryCounters.clear();
    // Restore retry counters from saved state
    for (const [edgeId, count] of Object.entries(savedState.retryCounters)) {
      this.retryCounters.set(edgeId, count);
    }
    // Do NOT clear sessionStore on resume — loop-back retries after resume
    // need to find previous sessions to continue conversation threads.
    this.checkpointManager = new CheckpointManager(process.cwd());
    const runDir = join(process.cwd(), ".sigil", "runs", savedState.id);
    this.eventRecorder = new EventRecorder(runDir);
    this.monitor.emit({ type: "workflow_start", workflowId, graph: this.workflow });

    try {
      await this.executeGraph(workflowId, savedState, {}, true, undefined);
      savedState.status = "completed";
      savedState.completedAt = new Date().toISOString();
      await this.eventRecorder.flushAll();
      this.checkpointManager.markDirty(savedState);
      await this.checkpointManager.flush();

      const durationMs = Date.now() - startedAt;
      this.monitor.emit({
        type: "workflow_end",
        workflowId,
        success: true,
        durationMs,
        totalCostUsd: savedState.totalCostUsd,
      });

      const totalCostUsd = savedState.totalCostUsd > 0 ? savedState.totalCostUsd : undefined;
      return {
        runId: savedState.id,
        success: true,
        durationMs,
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      savedState.status = "failed";
      savedState.completedAt = new Date().toISOString();
      await this.eventRecorder?.flushAll().catch((e: unknown) => logger.warn(`Event recorder flush failed: ${e}`));
      this.checkpointManager.markDirty(savedState);
      await this.checkpointManager.flush().catch((e: unknown) => logger.warn(`Checkpoint flush failed — resume may find stale state: ${e}`));

      const durationMs = Date.now() - startedAt;
      this.monitor.emit({ type: "workflow_error", workflowId, message });
      this.monitor.emit({
        type: "workflow_end",
        workflowId,
        success: false,
        durationMs,
      });

      return {
        runId: savedState.id,
        success: false,
        durationMs,
        error: message,
      };
    } finally {
      this.state = "idle";
      this.checkpointManager.dispose();
    }
  }

  /** Pause the currently executing workflow (takes effect between nodes). */
  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.pausePromise = new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  /** Resume a paused workflow. */
  resumeExecution(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
      this.pausePromise = null;
    }
  }

  /** Cancel the workflow. */
  cancel(): void {
    this.state = "cancelled";
    this.abortTree?.abortAll("Workflow cancelled");
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
      this.pausePromise = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private graph execution logic — completion-driven dispatch with
  // critical-path priority scheduling
  // ---------------------------------------------------------------------------

  private async executeGraph(
    workflowId: string,
    runState: WorkflowRunState,
    parameters: Record<string, string>,
    isResume = false,
    worktreeManager?: LazyWorktreeManager
  ): Promise<void> {
    const incomingForwardEdges = buildIncomingForwardEdgeIds(this.graphIndex);

    const completed = new Set<string>(isResume ? runState.completedNodes : []);
    const failed = new Set<string>();
    const running = new Set<string>();

    const totalNodes = this.graphIndex.nodeIds.length;

    // Pre-compute critical-path weights for priority scheduling
    const criticalPathWeights = computeCriticalPathWeights(this.graphIndex);

    // Structured concurrency: create an abort tree for this execution
    const abortTree = new AbortTree();
    this.abortTree = abortTree;

    // Wake signal: resolves when any node finishes, replacing the 100ms polling loop.
    let wakeResolve: (() => void) | null = null;
    const wake = (): void => {
      const r = wakeResolve;
      wakeResolve = null;
      r?.();
    };

    while (completed.size + failed.size < totalNodes) {
      if (this.state === "cancelled") {
        throw new Error("Workflow cancelled");
      }

      // Wait if paused
      if (this.state === "paused" && this.pausePromise) {
        runState.status = "paused";
        this.checkpointManager?.markDirty(runState);
        await this.checkpointManager?.flush();
        await this.pausePromise;
        runState.status = "running";
      }

      // Re-read state — may have been cancelled while awaiting pause
      if ((this.state as string) === "cancelled") {
        throw new Error("Workflow cancelled");
      }

      // Find nodes that are ready: all forward-edge predecessors completed, not running/done/failed
      const ready = this.findReadyNodes(completed, running, failed, incomingForwardEdges);

      if (ready.length === 0) {
        if (running.size === 0) {
          // Check for unrecoverable situation: nodes exist but none are ready or running
          const remaining = this.graphIndex.nodeIds.filter(
            (id) => !completed.has(id) && !failed.has(id)
          );
          if (remaining.length > 0) {
            // Some nodes failed — propagate failure
            break;
          }
          break; // all done
        }
        // Event-driven wait: no polling — wake() is called by each node on completion
        await new Promise<void>((resolve) => {
          wakeResolve = resolve;
        });
        continue;
      }

      // Sort ready nodes by descending critical-path weight for priority scheduling
      ready.sort((a, b) => (criticalPathWeights.get(b) ?? 0) - (criticalPathWeights.get(a) ?? 0));

      // Launch all ready nodes concurrently (fire-and-forget; each calls wake() on finish)
      for (const nodeId of ready) {
        running.add(nodeId);
        runState.currentNodeId = nodeId;
        void this.executeNodeAndHandleResult(
          workflowId, nodeId, runState, parameters,
          incomingForwardEdges,
          completed, failed, running, worktreeManager, abortTree
        ).finally(wake);
      }
    }

    // Clean up abort tree
    abortTree.dispose();
    this.abortTree = null;

    // If any nodes failed, throw with gate failure details
    if (failed.size > 0) {
      const failedList = [...failed].join(", ");
      const gateDetails = [...this.gateFailureReasons.entries()]
        .map(([edgeId, reason]) => `  edge "${edgeId}": ${reason}`)
        .join("\n");
      const message = gateDetails
        ? `Workflow failed: ${failed.size} node(s) failed: ${failedList}\nGate failures:\n${gateDetails}`
        : `Workflow failed: ${failed.size} node(s) failed: ${failedList}`;
      throw new Error(message);
    }
  }

  private async executeNodeAndHandleResult(
    workflowId: string,
    nodeId: string,
    runState: WorkflowRunState,
    parameters: Record<string, string>,
    incomingForwardEdges: Map<string, string[]>,
    completed: Set<string>,
    failed: Set<string>,
    running: Set<string>,
    worktreeManager?: LazyWorktreeManager,
    abortTree?: AbortTree
  ): Promise<void> {
    // Create a child abort signal for this node
    const nodeSignal = abortTree?.createChild(nodeId);

    try {
      const result = await this.executeNode(workflowId, nodeId, runState, parameters, incomingForwardEdges, worktreeManager, nodeSignal);

      // --- Phase 1: Async work outside the mutex ---
      // All async operations (gate eval, contract validation, I/O checks) run here
      // so the mutex only protects synchronous state mutations.

      // Handle stall (synchronous check, no async needed)
      if (result.exitCode === STALL_EXIT_CODE) {
        this.completionMutex = this.completionMutex.then(() => {
          running.delete(nodeId);
          failed.add(nodeId);
          this.emitError(workflowId, nodeId, new Error(`Node ${nodeId} stalled`));
        });
        await this.completionMutex;
        return;
      }

      const nodeConfig = this.workflow.nodes[nodeId];
      const actualOutputDir = nodeConfig?.outputDir ?? process.cwd();

      // Validate expected outputs exist (I/O, outside mutex)
      const expectedOutputs = nodeConfig?.expectedOutputs;
      if (expectedOutputs && expectedOutputs.length > 0) {
        const { existsSync } = await import("node:fs");
        const { join: joinPath } = await import("node:path");
        const missing = expectedOutputs.filter(f => !existsSync(joinPath(actualOutputDir, f)));
        if (missing.length > 0) {
          const msg = `Node "${nodeId}" failed to produce expected outputs: ${missing.join(", ")}`;
          this.monitor.emit({ type: "workflow_error", workflowId, nodeId, message: msg });
          throw new Error(msg);
        }
      }

      // Contract v3 validation (outside mutex)
      const outgoingEdgesForValidation = this.graphIndex.edgesByFrom.get(nodeId) ?? [];
      for (const edge of outgoingEdgesForValidation) {
        if (edge.contract?.outputSchema) {
          const validationResult = validateStructuredOutput(edge.contract.outputSchema, result.structuredOutput);
          if (!validationResult.valid) {
            const reason = `Contract v3 validation failed: ${validationResult.errors.join(", ")}`;
            this.emit("gate_eval", edge.id, false, reason);
            this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: false, reason });
            this.completionMutex = this.completionMutex.then(() => {
              running.delete(nodeId);
              failed.add(nodeId);
              this.emitError(workflowId, nodeId, new Error(`Node "${nodeId}" edge "${edge.id}": ${reason}`));
            });
            await this.completionMutex;
            return;
          }
        }
      }

      // Evaluate outgoing edges — all gate evaluations outside mutex (they're async I/O)
      const outgoing = this.graphIndex.edgesByFrom.get(nodeId) ?? [];
      const gateEvaluator = new GateEvaluator(this.monitor, workflowId);

      // Check loop-back edges first (async gate eval outside mutex)
      for (const edge of outgoing) {
        if (!edge.isLoopBack || !edge.gate) continue;

        const gateOutputDir = this.workflow.nodes[edge.from]?.outputDir ?? process.cwd();
        const gateResult = await gateEvaluator.evaluate(edge.gate, result, gateOutputDir, nodeId, edge.id, nodeSignal);

        this.emit("gate_eval", edge.id, gateResult.passed, gateResult.reason);
        this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: gateResult.passed, reason: gateResult.reason });

        if (!gateResult.passed) {
          const maxRetries = edge.maxRetries ?? 0;

          // Resume call for loop-back (async, outside mutex)
          let resumedSession: AgentSession | null = null;
          const feedbackMessage = `Gate '${edge.id}' failed. Reason: ${gateResult.reason}. Please revise your output and try again.`;
          const loopTargetConfig = this.workflow.nodes[edge.to];
          if (loopTargetConfig) {
            const previousSession = this.sessionStore.get(edge.to);
            if (previousSession) {
              const loopAdapter = this.adapterFactory(loopTargetConfig.adapter);
              try {
                resumedSession = await loopAdapter.resume(loopTargetConfig, previousSession, feedbackMessage);
              } catch {
                // If resume fails, the next executeNode call will spawn fresh
              }
            }
          }

          // --- Phase 2: Pure state mutations inside mutex ---
          this.completionMutex = this.completionMutex.then(() => {
            running.delete(nodeId);

            const retryCount = (this.retryCounters.get(edge.id) ?? 0) + 1;
            if (retryCount > maxRetries) {
              failed.add(nodeId);
              this.gateFailureReasons.set(edge.id, gateResult.reason);
              this.emitError(workflowId, nodeId, new Error(
                `Loop-back edge "${edge.id}": exceeded maxRetries (${maxRetries}) — gate: ${gateResult.reason}`
              ));
              return;
            }

            this.retryCounters.set(edge.id, retryCount);
            runState.retryCounters[edge.id] = retryCount;

            this.emit("loop_back", edge.id, retryCount, maxRetries);
            this.monitor.emit({ type: "loop_back", workflowId, edgeId: edge.id, attempt: retryCount, maxRetries });

            completed.delete(edge.to);
            runState.completedNodes = runState.completedNodes.filter((id) => id !== edge.to);

            if (resumedSession) {
              this.sessionStore.set(edge.to, resumedSession);
            } else if (loopTargetConfig && this.sessionStore.has(edge.to)) {
              this.sessionStore.delete(edge.to);
            }

            if (nodeId !== edge.to) {
              completed.add(nodeId);
            }
            this.checkpointManager?.markDirty(runState);
          });
          await this.completionMutex;
          return;
        }
      }

      // Evaluate forward edges (async gate eval outside mutex)
      const forwardGateFailures: Array<{ edgeId: string; targetNodeId: string; reason: string }> = [];
      for (const edge of outgoing) {
        if (edge.isLoopBack) continue;
        if (!edge.gate) continue;

        const fwdOutputDir = this.workflow.nodes[edge.from]?.outputDir ?? process.cwd();
        const gateResult = await gateEvaluator.evaluate(edge.gate, result, fwdOutputDir, nodeId, edge.id, nodeSignal);

        this.emit("gate_eval", edge.id, gateResult.passed, gateResult.reason);
        this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: gateResult.passed, reason: gateResult.reason });

        if (!gateResult.passed) {
          forwardGateFailures.push({ edgeId: edge.id, targetNodeId: edge.to, reason: gateResult.reason });
        }
      }

      // --- Phase 2: Pure state mutations inside mutex ---
      this.completionMutex = this.completionMutex.then(() => {
        running.delete(nodeId);

        // Store result
        if (!runState.completedNodes.includes(nodeId)) {
          runState.completedNodes.push(nodeId);
        }
        runState.nodeResults[nodeId] = result;
        if (result.costUsd != null) {
          runState.totalCostUsd += result.costUsd;
        }
        this.actualOutputDirs.set(nodeId, actualOutputDir);

        // Apply forward gate failures
        for (const { edgeId, targetNodeId, reason } of forwardGateFailures) {
          failed.add(targetNodeId);
          this.gateFailureReasons.set(edgeId, reason);
          this.emitError(workflowId, targetNodeId, new Error(
            `Gate failed on forward edge "${edgeId}" from "${nodeId}": ${reason}`
          ));
        }

        completed.add(nodeId);
        this.checkpointManager?.markDirty(runState);
      });
      await this.completionMutex;
    } catch (err) {
      // Serialize failure bookkeeping inside mutex too
      this.completionMutex = this.completionMutex.then(() => {
        running.delete(nodeId);
        failed.add(nodeId);
        this.emitError(workflowId, nodeId, err instanceof Error ? err : new Error(String(err)));
      });
      await this.completionMutex;
    } finally {
      // Clean up this node's abort controller — it's no longer needed
      abortTree?.abortChild(nodeId);
    }
  }

  private async executeNode(
    workflowId: string,
    nodeId: string,
    runState: WorkflowRunState,
    parameters: Record<string, string>,
    incomingForwardEdges: Map<string, string[]>,
    worktreeManager?: LazyWorktreeManager,
    signal?: AbortSignal
  ): Promise<NodeResult> {
    if (!this.workflow.nodes[nodeId]) {
      throw new Error(`Node "${nodeId}" not found in workflow`);
    }
    let nodeConfig = { ...this.workflow.nodes[nodeId]! };

    // Validate timeout configuration
    if (nodeConfig.timeoutMs != null && nodeConfig.timeoutMs <= 0) {
      throw new Error(`Node "${nodeId}" has invalid timeoutMs: ${nodeConfig.timeoutMs} (must be positive)`);
    }
    if (nodeConfig.idleTimeoutMs != null && nodeConfig.idleTimeoutMs <= 0) {
      throw new Error(`Node "${nodeId}" has invalid idleTimeoutMs: ${nodeConfig.idleTimeoutMs} (must be positive)`);
    }

    const attempt = (this.retryCounters.get(nodeId) ?? 0) + 1;

    // Input mapping (Contract): resolve {{var}} substitutions from predecessor outputs
    nodeConfig = await this.buildNodeInput(nodeId, incomingForwardEdges, nodeConfig, runState, parameters);

    // Check node cache — skip execution if we have a cached result with deterministic gates.
    // Skip cache on loop-back retries: the whole point of a retry is to get a different result.
    const isRetry = [...this.retryCounters.entries()].some(([edgeId, count]) => {
      const edge = this.graphIndex.edgeById.get(edgeId);
      return edge?.isLoopBack && edge.to === nodeId && count > 0;
    });
    let contentHash: string | undefined;
    if (this.nodeCache && !isRetry) {
      const outgoingEdges = this.graphIndex.edgesByFrom.get(nodeId) ?? [];
      if (areGatesDeterministic(outgoingEdges)) {
        const upstreamHashes: Record<string, string> = {};
        for (const edgeId of (incomingForwardEdges.get(nodeId) ?? [])) {
          const edge = this.graphIndex.edgeById.get(edgeId);
          if (edge) {
            const h = this.contentHashes.get(edge.from);
            if (h) upstreamHashes[edge.from] = h;
          }
        }
        const hashInputs: import("./node-cache.js").HashableNodeInputs = {
          prompt: nodeConfig.prompt,
          adapter: nodeConfig.adapter,
          model: nodeConfig.model,
          ...(nodeConfig.tools !== undefined ? { tools: nodeConfig.tools } : {}),
        };
        const hash = computeContentHash(
          hashInputs,
          {},
          upstreamHashes
        );
        const cached = await this.nodeCache.get(hash);
        if (cached) {
          logger.info(`Cache hit for node "${nodeId}" — skipping execution`);
          this.contentHashes.set(nodeId, hash);
          this.emit("node_start", nodeId);
          this.monitor.emit({ type: "node_start", workflowId, nodeId, config: nodeConfig, attempt });
          this.emit("node_end", nodeId, cached.exitCode === 0);
          this.monitor.emit({ type: "node_end", workflowId, nodeId, result: cached });
          return cached;
        }
        contentHash = hash;
      }
    }

    // Worktree isolation: create per-node worktree only if the node needs it
    if (worktreeManager && needsIsolation(nodeConfig)) {
      const worktreePath = await worktreeManager.getOrCreate(nodeId, nodeConfig);
      nodeConfig = { ...nodeConfig, outputDir: worktreePath };
    }

    // Ensure outputDir exists before spawning the adapter (it's used as cwd)
    if (nodeConfig.outputDir) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(nodeConfig.outputDir, { recursive: true });
    }

    this.emit("node_start", nodeId);
    this.monitor.emit({
      type: "node_start",
      workflowId,
      nodeId,
      config: nodeConfig,
      attempt,
    });

    let poolSlot: PoolSlot | undefined;
    if (this.adapterPool) {
      poolSlot = await this.adapterPool.acquire(nodeConfig.adapter);
    }

    const adapter = this.adapterFactory(nodeConfig.adapter);

    // If we have a pre-resumed session, use it; otherwise spawn fresh
    let session = this.sessionStore.get(nodeId);
    if (!session) {
      session = await adapter.spawn(nodeConfig);
    }
    this.sessionStore.set(nodeId, session);

    const killAdapter = async (): Promise<void> => {
      await adapter.kill(session!).catch((e: unknown) => logger.warn(`Failed to kill adapter for node "${nodeId}": ${e}`));
    };

    // Set up wall-clock and idle timeouts
    const { clearTimeouts, onEvent, isStalled, markStalled } = this.setupNodeTimeouts(nodeConfig, nodeId, killAdapter);

    try {
      // Stream events — re-enter the loop on rate limit (does not count against maxRetries)
      let rateLimitRetry = true;
      while (rateLimitRetry) {
        rateLimitRetry = false;

        for await (const event of adapter.stream(session)) {
          onEvent();

          if (this.state === "cancelled" || signal?.aborted) {
            await killAdapter();
            throw new Error("Workflow cancelled");
          }

          // Rate limit signal: "rate_limit:<retryAfterMs>"
          if (event.type === "error" && event.message.startsWith("rate_limit:")) {
            const retryAfterMs = parseInt(event.message.slice("rate_limit:".length), 10) || 60000;
            const seconds = Math.ceil(retryAfterMs / 1000);
            logger.info(`Rate limit hit — waiting ${seconds}s before resuming...`);
            this.monitor.emit({ type: "rate_limit", workflowId, nodeId, retryAfterMs });

            const prevSession = session;
            await killAdapter();
            await sleep(retryAfterMs);

            // Try resume first so session-based adapters (claude-sdk) preserve conversation history
            try {
              session = await adapter.resume(
                nodeConfig,
                prevSession,
                "Continuing after rate limit pause. Please continue where you left off."
              );
            } catch {
              // resume failed (e.g. no session ID) — fall back to cold start
              session = await adapter.spawn(nodeConfig);
            }
            this.sessionStore.set(nodeId, session);
            rateLimitRetry = true;
            break;
          }

          this.emit("node_event", nodeId, event);
          this.monitor.emit({ type: "node_event", workflowId, nodeId, event });
          this.eventRecorder?.record(nodeId, event);

          // Stall signal from adapter — scheduler decides to kill
          if (event.type === "stall") {
            markStalled();
            await killAdapter();
            break;
          }
        }
      }

      clearTimeouts();

      if (isStalled()) {
        // Return a synthetic stall result
        const stallResult: NodeResult = {
          output: "",
          exitCode: STALL_EXIT_CODE,
          durationMs: Date.now() - session.startedAt.getTime(),
        };
        await this.eventRecorder?.flushNode(nodeId);
        this.emit("node_end", nodeId, false);
        this.monitor.emit({ type: "node_end", workflowId, nodeId, result: stallResult });
        return stallResult;
      }

      const result = await adapter.getResult(session);
      await this.eventRecorder?.flushNode(nodeId);

      // Store result in cache
      if (this.nodeCache && contentHash) {
        this.contentHashes.set(nodeId, contentHash);
        await this.nodeCache.set(contentHash, result).catch((e: unknown) =>
          logger.debug(`Cache write failed for node "${nodeId}": ${e}`)
        );
      }

      // Worktree fan-in: merge this node's worktree into the main branch at fan-in points
      if (worktreeManager) {
        const isFanIn = (incomingForwardEdges.get(nodeId)?.length ?? 0) > 1;
        if (isFanIn) {
          const { stdout: branchStdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "main" }));
          const currentBranch = branchStdout.trim();
          const mergeResult = await worktreeManager.merge(nodeId, currentBranch);
          if (mergeResult.conflicts.length > 0) {
            const reason = `Merge conflicts in node "${nodeId}": ${mergeResult.conflicts.join(", ")}`;
            this.monitor.emit({ type: "workflow_error", workflowId, nodeId, message: reason });
            throw new Error(reason);
          }
        }
      }

      const success = result.exitCode === 0;

      this.emit("node_end", nodeId, success);
      this.monitor.emit({ type: "node_end", workflowId, nodeId, result });

      return result;
    } catch (err) {
      clearTimeouts();
      const errorResult: NodeResult = {
        output: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: Date.now() - session.startedAt.getTime(),
      };
      this.emit("node_end", nodeId, false);
      this.monitor.emit({ type: "node_end", workflowId, nodeId, result: errorResult });
      throw err;
    } finally {
      if (poolSlot && this.adapterPool) {
        this.adapterPool.release(poolSlot);
      }
      // Worktree cleanup: remove this node's temporary worktree after execution
      if (worktreeManager) {
        await worktreeManager.remove(nodeId).catch((e: unknown) => logger.debug(`worktree remove failed for node ${nodeId}: ${e}`));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Extracted helpers
  // ---------------------------------------------------------------------------

  /**
   * Find nodes where all forward-edge predecessors are completed and the
   * node isn't already running, done, or failed.
   */
  private findReadyNodes(
    completed: Set<string>,
    running: Set<string>,
    failed: Set<string>,
    incomingForwardEdges: Map<string, string[]>
  ): string[] {
    return this.graphIndex.nodeIds.filter((nodeId) => {
      if (completed.has(nodeId) || running.has(nodeId) || failed.has(nodeId)) return false;
      const incomingEdgeIds = incomingForwardEdges.get(nodeId) ?? [];
      return incomingEdgeIds.every((edgeId) => {
        const edge = this.graphIndex.edgeById.get(edgeId);
        return edge ? completed.has(edge.from) : true;
      });
    });
  }

  /**
   * Resolve contract inputMapping from predecessor outputs, substituting
   * {{var}} placeholders in the node's prompt.
   *
   * Two-pass resolution:
   * 1. Runtime {{nodes.<id>.output}} and {{nodes.<id>.structuredOutput.<path>}} references
   * 2. File-based inputMapping from edge contracts
   *
   * Final single-pass regex replaces all collected variables in the prompt.
   */
  private async buildNodeInput(
    nodeId: string,
    incomingForwardEdges: Map<string, string[]>,
    nodeConfig: NodeConfig,
    runState: WorkflowRunState,
    parameters: Record<string, string> = {}
  ): Promise<NodeConfig> {
    const allVars: Record<string, string> = {};

    // Pass 1: resolve {{nodes.<id>.output}} and {{nodes.<id>.structuredOutput.<path>}} from runState
    const nodeRefPattern = /\{\{nodes\.([\w-]+)\.(output|structuredOutput(?:\.[\w.]+)?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = nodeRefPattern.exec(nodeConfig.prompt)) !== null) {
      const fullMatch = match[0]!;
      const refNodeId = match[1]!;
      const refPath = match[2]!;

      if (!runState.completedNodes.includes(refNodeId)) {
        throw new Error(
          `Node "${nodeId}" references {{nodes.${refNodeId}.${refPath}}} but node "${refNodeId}" ` +
          `has not completed — this is likely a missing edge in the workflow definition`
        );
      }

      const refResult = runState.nodeResults[refNodeId];
      if (refPath === "output") {
        allVars[`nodes.${refNodeId}.${refPath}`] = refResult?.output ?? "";
      } else if (refPath.startsWith("structuredOutput")) {
        // Traverse dot-separated path into structured output
        const pathParts = refPath.split(".").slice(1); // remove "structuredOutput" prefix
        let value: unknown = refResult?.structuredOutput;
        for (const part of pathParts) {
          if (value != null && typeof value === "object") {
            value = (value as Record<string, unknown>)[part];
          } else {
            value = undefined;
            break;
          }
        }
        allVars[`nodes.${refNodeId}.${refPath}`] = value !== undefined ? String(value) : "";
      }
    }

    // Pass 2: resolve file-based inputMapping from edge contracts
    const incomingEdgeIds = incomingForwardEdges.get(nodeId) ?? [];
    for (const edgeId of incomingEdgeIds) {
      const edge = this.graphIndex.edgeById.get(edgeId);
      if (edge?.contract?.inputMapping) {
        const predecessorOutputDir = this.actualOutputDirs.get(edge.from)
          ?? this.workflow.nodes[edge.from]?.outputDir
          ?? "";
        const { resolved, errors } = await resolveInputMapping(edge.contract.inputMapping, predecessorOutputDir);
        for (const err of errors) {
          logger.warn(`Input mapping warning for edge "${edgeId}": ${err}`);
        }
        for (const [varName, value] of Object.entries(resolved)) {
          allVars[varName] = value;
        }
      }
    }

    // Resolve workflow-level parameters (lowest priority — overridden by node outputs and inputMapping)
    for (const [key, value] of Object.entries(parameters)) {
      if (!(key in allVars)) {
        allVars[key] = value;
      }
    }

    // Single-pass replacement of all {{key}} placeholders
    if (Object.keys(allVars).length === 0) return nodeConfig;

    const prompt = nodeConfig.prompt.replace(/\{\{([\w./-]+)\}\}/g, (wholeMatch, key: string) => {
      if (key in allVars) return allVars[key]!;
      return wholeMatch; // leave unresolved (may be a workflow parameter)
    });

    return { ...nodeConfig, prompt };
  }

  /**
   * Set up wall-clock and idle timeouts for a node execution.
   * Returns helpers to clear timers, update last-event time, check/set stall state.
   */
  private setupNodeTimeouts(
    nodeConfig: NodeConfig,
    _nodeId: string,
    killAdapter: () => Promise<void>
  ): { clearTimeouts: () => void; onEvent: () => void; isStalled: () => boolean; markStalled: () => void } {
    let stallDetected = false;
    let lastEventAt = Date.now();

    const markStalled = (): void => {
      stallDetected = true;
    };

    // Set up wall-clock timeout if configured
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (nodeConfig.timeoutMs != null) {
      timeoutHandle = setTimeout(() => {
        stallDetected = true;
        void killAdapter();
      }, nodeConfig.timeoutMs);
    }

    // Set up idle timeout: kill the node if no event arrives within idleTimeoutMs
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    if (nodeConfig.idleTimeoutMs != null) {
      const idleMs = nodeConfig.idleTimeoutMs;
      idleTimer = setInterval(() => {
        if (Date.now() - lastEventAt >= idleMs) {
          stallDetected = true;
          void killAdapter();
        }
      }, Math.min(idleMs, 1000)); // check at most every 1s
    }

    return {
      clearTimeouts: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (idleTimer !== null) clearInterval(idleTimer);
      },
      onEvent: () => {
        lastEventAt = Date.now();
      },
      isStalled: () => stallDetected,
      markStalled,
    };
  }

  private emitError(workflowId: string, nodeId: string, err: Error): void {
    this.monitor.emit({
      type: "workflow_error",
      workflowId,
      nodeId,
      message: err.message,
    });
  }
}

// Typed event emitter interface
export interface WorkflowScheduler {
  emit(event: "node_start", nodeId: string): boolean;
  emit(event: "node_event", nodeId: string, agentEvent: AgentEvent): boolean;
  emit(event: "node_end", nodeId: string, success: boolean): boolean;
  emit(event: "loop_back", edgeId: string, attempt: number, maxRetries: number): boolean;
  emit(event: "gate_eval", edgeId: string, passed: boolean, reason: string): boolean;
  on(event: "node_start", listener: (nodeId: string) => void): this;
  on(event: "node_event", listener: (nodeId: string, agentEvent: AgentEvent) => void): this;
  on(event: "node_end", listener: (nodeId: string, success: boolean) => void): this;
  on(event: "loop_back", listener: (edgeId: string, attempt: number, maxRetries: number) => void): this;
  on(event: "gate_eval", listener: (edgeId: string, passed: boolean, reason: string) => void): this;
}
