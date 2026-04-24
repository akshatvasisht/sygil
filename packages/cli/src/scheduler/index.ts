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
} from "@sygil/shared";
import { validateStructuredOutput, resolveInputMapping, STALL_EXIT_CODE } from "@sygil/shared";
import { GateEvaluator } from "../gates/index.js";
import { LazyWorktreeManager } from "../worktree/lazy-worktree-manager.js";
import { needsIsolation } from "../worktree/isolation-check.js";
import { AbortTree } from "./abort-tree.js";
import { NodeCache, computeContentHash, areGatesDeterministic } from "./node-cache.js";
import { AdapterPool } from "../adapters/adapter-pool.js";
import type { PoolSlot, PoolConfig } from "../adapters/adapter-pool.js";
import { resolveProviders, classifyError } from "../adapters/provider-router.js";
import { computeRetryDelay, isRetryableReason, sleepWithAbort } from "./retry-policy.js";
import type { WsMonitorServer } from "../monitor/websocket.js";
import { deriveTraceContext } from "../monitor/trace-context.js";
import { logger } from "../utils/logger.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { GraphIndex } from "./graph-index.js";
import { computeCriticalPathWeights } from "./critical-path.js";
import { EventRecorder } from "./event-recorder.js";
import { HookRunner, hookResultToEvent } from "../hooks/hook-runner.js";
import type { HookContext, HookType, RunReason } from "../hooks/hook-runner.js";
import type { HooksConfig } from "../utils/config.js";
import { buildEnvironmentSnapshot } from "./environment.js";
import { SyncRegistry } from "./sync-registry.js";
import type { Release } from "./sync-registry.js";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick a single representative type for a GateConfig. Used as a
 * label on `sygil_gate_total`. Most gates have a single condition — that
 * condition's type becomes the label. Gates with multiple conditions are
 * labelled `mixed` to bound label cardinality.
 */
function summarizeGateType(gate: { conditions: Array<{ type: string }> }): string {
  if (gate.conditions.length === 1) return gate.conditions[0]!.type;
  return "mixed";
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
  /**
   * Lifecycle hooks. Scripts invoked at preNode / postNode /
   * preGate / postGate lifecycle points. See `HookRunner`.
   */
  hooks?: HooksConfig;
  /**
   * Prometheus exporter instance. When set, the scheduler installs
   * pool acquire-wait and checkpoint-write listeners so `sygil_adapter_acquire_wait_seconds`
   * and `sygil_checkpoint_write_total` stay populated. Other metrics flow via
   * `WsMonitorServer.setPrometheusMetrics` from the command layer.
   */
  metricsObserver?: MetricsObserver;
}

/** Minimal interface so the scheduler doesn't depend on the full PrometheusMetrics class. */
export interface MetricsObserver {
  recordAcquireWait(adapterType: string, waitMs: number): void;
  recordCheckpointWrite(): void;
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
 * - State is checkpointed to .sygil/runs/<id>.json after each node
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
  private hookRunner: HookRunner | null = null;
  /** Mutex to serialize concurrent runState mutations from parallel node completions. */
  private completionMutex: Promise<void> = Promise.resolve();
  /** Workflow-scoped sync registry — one instance per executeGraph() call. */
  private syncRegistry: SyncRegistry | null = null;
  /** Tracks the active workflowId so pause/resume can emit the right WsServerEvent. */
  private currentWorkflowId: string | null = null;

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
      sharedContext: {},
    };

    // Populate environment snapshot (best-effort, non-blocking)
    try {
      runState.environment = await buildEnvironmentSnapshot(
        this.workflow,
        this.adapterFactory,
      );
    } catch {
      // Environment snapshot failure must not block the run
    }

    this.state = "running";
    this.currentWorkflowId = workflowId;
    this.retryCounters.clear();
    this.sessionStore.clear();
    this.gateFailureReasons.clear();
    this.actualOutputDirs.clear();
    this.checkpointManager = new CheckpointManager(process.cwd());
    if (options.metricsObserver) {
      this.checkpointManager.setWriteListener(() => options.metricsObserver!.recordCheckpointWrite());
    }
    const runDir = join(process.cwd(), ".sygil", "runs", runId);
    this.eventRecorder = new EventRecorder(runDir);
    const cacheDir = join(process.cwd(), ".sygil", "cache");
    this.nodeCache = new NodeCache(cacheDir);
    this.contentHashes.clear();
    this.monitor.emit({ type: "workflow_start", workflowId, graph: this.workflow });

    const worktreeManager = options.isolate ? new LazyWorktreeManager(runId) : undefined;
    this.adapterPool = options.pool ? new AdapterPool(options.pool) : null;
    this.monitor.setAdapterPool(this.adapterPool);
    if (this.adapterPool && options.metricsObserver) {
      this.adapterPool.setWaitObserver((adapterType, waitMs) => {
        options.metricsObserver!.recordAcquireWait(adapterType, waitMs);
      });
    }
    // Wire circuit-breaker state transitions through to the monitor so UI
    // clients see `circuit_breaker` WsServerEvents in real time.
    if (this.adapterPool) {
      this.adapterPool.setCircuitStateListener((change) => {
        this.monitor.emit({
          type: "circuit_breaker",
          workflowId,
          adapterType: change.adapterType,
          state: change.to,
          ...(change.reason !== undefined ? { reason: change.reason } : {}),
          ...(change.openUntil !== undefined ? { openUntil: change.openUntil } : {}),
        });
      });
    }
    this.hookRunner = options.hooks ? new HookRunner(options.hooks, process.cwd(), "new") : null;

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
      this.currentWorkflowId = null;
      this.checkpointManager.dispose();
      if (this.adapterPool) {
        await this.adapterPool.drain().catch(() => undefined);
      }
      this.monitor.setAdapterPool(null);
      await worktreeManager?.cleanup().catch((e: unknown) => logger.debug(`worktree cleanup failed: ${e}`));
    }
  }

  /**
   * Resume a workflow from persisted state.
   */
  async resume(
    savedState: WorkflowRunState,
    options: { hooks?: HooksConfig; metricsObserver?: MetricsObserver; runReason?: RunReason } = {},
  ): Promise<RunResult> {
    // Use workflowName (not the run UUID) as workflowId so monitor fanout
    // filtering matches the URL slug the web UI subscribes to.
    const workflowId = savedState.workflowName;
    const startedAt = Date.now();

    // Backfill sharedContext for pre-sharedContext-feature checkpoints
    // (pre-existing on-disk state has no `sharedContext` field).
    if (savedState.sharedContext === undefined) {
      savedState.sharedContext = {};
    }

    savedState.status = "running";
    this.state = "running";
    this.currentWorkflowId = workflowId;
    this.retryCounters.clear();
    // Restore retry counters from saved state
    for (const [edgeId, count] of Object.entries(savedState.retryCounters)) {
      this.retryCounters.set(edgeId, count);
    }
    // Do NOT clear sessionStore on resume — loop-back retries after resume
    // need to find previous sessions to continue conversation threads.
    this.checkpointManager = new CheckpointManager(process.cwd());
    if (options.metricsObserver) {
      this.checkpointManager.setWriteListener(() => options.metricsObserver!.recordCheckpointWrite());
    }
    const runDir = join(process.cwd(), ".sygil", "runs", savedState.id);
    this.eventRecorder = new EventRecorder(runDir);
    this.hookRunner = options.hooks ? new HookRunner(options.hooks, process.cwd(), options.runReason ?? "resume") : null;
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
      this.currentWorkflowId = null;
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
    // Broadcast so monitor clients update their status display immediately.
    if (this.currentWorkflowId) {
      this.monitor.emit({ type: "workflow_paused", workflowId: this.currentWorkflowId });
    }
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
    // Broadcast so monitor clients update their status display immediately.
    if (this.currentWorkflowId) {
      this.monitor.emit({ type: "workflow_resumed", workflowId: this.currentWorkflowId });
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

    // Instantiate sync registry for this execution — one per executeGraph() call,
    // same lifecycle as GateEvaluator. Uses critical-path weights to prioritise
    // higher-value waiters when a sync slot is released.
    this.syncRegistry = new SyncRegistry(criticalPathWeights);

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

      // --- Async work outside the mutex ---
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
            this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: false, reason, gateType: "contract" });
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

        // Lifecycle hook: preGate — fires before gate condition
        // evaluation. Observational; gate pass/fail is unaffected.
        await this.runHook(
          "preGate",
          workflowId,
          nodeId,
          { workflowId, nodeId, outputDir: gateOutputDir, edgeId: edge.id },
          nodeSignal,
          false,
        );

        const gateResult = await gateEvaluator.evaluate(edge.gate, result, gateOutputDir, nodeId, edge.id, nodeSignal);

        // Lifecycle hook: postGate — gate verdict available via env vars.
        await this.runHook(
          "postGate",
          workflowId,
          nodeId,
          {
            workflowId,
            nodeId,
            outputDir: gateOutputDir,
            edgeId: edge.id,
            gatePassed: gateResult.passed,
            gateReason: gateResult.reason,
          },
          nodeSignal,
          false,
        );

        this.emit("gate_eval", edge.id, gateResult.passed, gateResult.reason);
        this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: gateResult.passed, reason: gateResult.reason, gateType: summarizeGateType(edge.gate) });

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

          // --- Pure state mutations inside mutex ---
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

        // Lifecycle hook: preGate — forward edges.
        await this.runHook(
          "preGate",
          workflowId,
          nodeId,
          { workflowId, nodeId, outputDir: fwdOutputDir, edgeId: edge.id },
          nodeSignal,
          false,
        );

        const gateResult = await gateEvaluator.evaluate(edge.gate, result, fwdOutputDir, nodeId, edge.id, nodeSignal);

        // Lifecycle hook: postGate — forward edges.
        await this.runHook(
          "postGate",
          workflowId,
          nodeId,
          {
            workflowId,
            nodeId,
            outputDir: fwdOutputDir,
            edgeId: edge.id,
            gatePassed: gateResult.passed,
            gateReason: gateResult.reason,
          },
          nodeSignal,
          false,
        );

        this.emit("gate_eval", edge.id, gateResult.passed, gateResult.reason);
        this.monitor.emit({ type: "gate_eval", workflowId, edgeId: edge.id, passed: gateResult.passed, reason: gateResult.reason, gateType: summarizeGateType(edge.gate) });

        if (!gateResult.passed) {
          forwardGateFailures.push({ edgeId: edge.id, targetNodeId: edge.to, reason: gateResult.reason });
        }
      }

      // --- Pure state mutations inside mutex ---
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

    // Deterministic W3C trace context — stable across retries so span stays
    // coherent for external tracing backends. Threaded into adapter spawn()
    // (env / header) and stamped onto emitted per-node WsServerEvents so UI
    // clients can deep-link to external tracing backends.
    const traceCtx = deriveTraceContext(runState.id, nodeId);
    const { traceId, spanId } = traceCtx;

    // Input mapping (Contract): resolve {{var}} substitutions from predecessor outputs
    nodeConfig = await this.buildNodeInput(nodeId, incomingForwardEdges, nodeConfig, runState, parameters);

    // Lifecycle hook: preNode. Runs once per node execution,
    // before the cache check and provider loop. Non-zero exit fails the
    // node with the hook's stderr as the error message.
    const preNodeOutputDir = nodeConfig.outputDir ?? process.cwd();
    await this.runHook(
      "preNode",
      workflowId,
      nodeId,
      { workflowId, nodeId, outputDir: preNodeOutputDir },
      signal,
      /* abortOnFailure */ true,
    );

    // Check node cache — skip execution if we have a cached result with deterministic gates.
    // Skip cache on loop-back retries: the whole point of a retry is to get a different result.
    const isRetry = [...this.retryCounters.entries()].some(([edgeId, count]) => {
      const edge = this.graphIndex.edgeById.get(edgeId);
      return edge?.isLoopBack && edge.to === nodeId && count > 0;
    });
    let contentHash: string | undefined;
    // Skip cache for nodes that write to sharedContext. The cache
    // stores NodeResult only — it does NOT persist the AgentEvent stream, so a
    // cache hit would bypass the context_set → runState.sharedContext write at
    // the event-processing loop below. Downstream nodes with readsContext
    // would then interpolate against stale/empty ctx values, producing
    // incorrect prompts. Nodes that write context therefore always re-execute.
    const writesCtx = (nodeConfig.writesContext?.length ?? 0) > 0;
    if (this.nodeCache && !isRetry && !writesCtx) {
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
          this.monitor.emit({ type: "node_start", workflowId, nodeId, config: nodeConfig, attempt, traceId, spanId });
          // postNode hook still runs for cache hits — the node's result was
          // "produced" (from cache), so observers see a complete lifecycle.
          await this.runHook(
            "postNode",
            workflowId,
            nodeId,
            {
              workflowId,
              nodeId,
              outputDir: nodeConfig.outputDir ?? process.cwd(),
              exitCode: cached.exitCode,
              output: cached.output,
            },
            signal,
            false,
          );
          this.emit("node_end", nodeId, cached.exitCode === 0);
          // Flag the result so the monitor can render a `cached` status
          // distinct from a fresh completion. The original durationMs /
          // costUsd from the recorded run are preserved.
          const cachedResult = { ...cached, cacheHit: true };
          this.monitor.emit({ type: "node_end", workflowId, nodeId, result: cachedResult, traceId, spanId });
          return cachedResult;
        }
        contentHash = hash;
      }
    }

    // Worktree isolation: create per-node worktree only if the node needs it
    if (worktreeManager && needsIsolation(nodeConfig)) {
      const worktreePath = await worktreeManager.getOrCreate(nodeId, nodeConfig, signal);
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
      traceId,
      spanId,
    });

    // Workflow-scoped synchronization (mutex / semaphore).
    // Acquired BEFORE the adapter pool slot so nodes sharing a key cannot
    // run concurrently beyond the declared limit.
    let syncRelease: Release | undefined;
    let syncKey: string | undefined;
    let syncLimit: number | undefined;
    if (nodeConfig.synchronization) {
      const s = nodeConfig.synchronization;
      syncKey = "mutex" in s ? s.mutex : s.semaphore.key;
      syncLimit = "mutex" in s ? 1 : s.semaphore.limit;
      const syncAcquireEvent: AgentEvent = { type: "sync_acquire", key: syncKey, limit: syncLimit };
      this.emit("node_event", nodeId, syncAcquireEvent);
      this.monitor.emit({ type: "node_event", workflowId, nodeId, event: syncAcquireEvent, traceId, spanId });
      this.eventRecorder?.record(nodeId, syncAcquireEvent);
      syncRelease = await this.syncRegistry!.acquire(syncKey, syncLimit, nodeId, signal);
    }

    // Resolve provider-failover list. Legacy nodes without
    // `providers` produce a single-entry list from the top-level adapter/model.
    const providers = resolveProviders(nodeConfig);
    let lastFailoverError: unknown = null;

    try {
      for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
        const provider = providers[providerIndex]!;
        const hasFallback = providerIndex < providers.length - 1;
        const effectiveConfig: NodeConfig = {
          ...nodeConfig,
          adapter: provider.adapter,
          model: provider.model,
        };

        // On failover iterations, discard any stored session so we spawn fresh
        // on the new adapter. The first iteration preserves any pre-resumed
        // session placed into the store by the checkpoint loader.
        if (providerIndex > 0) {
          this.sessionStore.delete(nodeId);
        }

        // Retry policy: attempt loop bounded by retryPolicy.maxAttempts.
        // Absence of retryPolicy keeps legacy behaviour (one attempt per provider).
        // Retries run against the SAME provider; exhausting them falls through to
        // the failover check below, which may try the next provider.
        const retryPolicy = nodeConfig.retryPolicy;
        const maxAttempts = retryPolicy?.maxAttempts ?? 1;
        let failoverContinue = false;

        for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
          // Fresh session on retries (session state from the failed attempt is
          // no longer useful — particularly for transport errors where the
          // prior session is dead).
          if (attemptNum > 1) {
            this.sessionStore.delete(nodeId);
          }

          let poolSlot: PoolSlot | undefined;
          let session: AgentSession | undefined;
          let clearTimeouts: () => void = () => {};
          // Hoisted so the catch block can call killAdapter on any exception
          // path — previously scoped inside the try, so a throw from within
          // stream() / getResult / monitor.emit leaked the child process.
          let adapter: AgentAdapter | undefined;
          // Kill-once guard, reset whenever `session` is reassigned to a
          // fresh one (rate-limit resume/spawn). Keeps adapter.kill
          // idempotent for mock adapters that don't self-guard on
          // `internal.done` like the real ones.
          let adapterKilled = false;

          const killAdapter = async (): Promise<void> => {
            if (!session || !adapter || adapterKilled) return;
            adapterKilled = true;
            await adapter.kill(session).catch((e: unknown) =>
              logger.warn(`Failed to kill adapter for node "${nodeId}": ${e}`),
            );
          };

          try {
            if (this.adapterPool) {
              poolSlot = await this.adapterPool.acquire(effectiveConfig.adapter);
            }

            adapter = this.adapterFactory(effectiveConfig.adapter);

            session = this.sessionStore.get(nodeId);
            if (!session) {
              session = await adapter.spawn(effectiveConfig, traceCtx);
            }
            this.sessionStore.set(nodeId, session);

            const timeouts = this.setupNodeTimeouts(effectiveConfig, nodeId, killAdapter);
            clearTimeouts = timeouts.clearTimeouts;
            const { onEvent, isStalled, markStalled } = timeouts;

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
                  // With a fallback provider available, escalate to failover
                  // (classifier recognises the `rate_limit:` sentinel).
                  if (hasFallback) {
                    await killAdapter();
                    throw new Error(event.message);
                  }
                  // Clamp to a positive value: a malformed adapter emitting
                  // `rate_limit:-500` would otherwise pass through `|| 60000`
                  // (negative is truthy) into `setTimeout(resolve, -500)` which
                  // Node clamps to 1ms — defeating the rate-limit pause and
                  // producing a tight retry loop. Also covers `rate_limit:0`
                  // (same loop) and `rate_limit:NaN`/empty (already handled by
                  // the `||` default). Upper bound is intentionally uncapped
                  // since providers legitimately return long retry-afters
                  // (e.g. quota-exhausted windows of hours).
                  const parsedRetryMs = parseInt(event.message.slice("rate_limit:".length), 10);
                  const retryAfterMs = Number.isFinite(parsedRetryMs) && parsedRetryMs > 0 ? parsedRetryMs : 60000;
                  const seconds = Math.ceil(retryAfterMs / 1000);
                  logger.info(`Rate limit hit — waiting ${seconds}s before resuming...`);
                  this.monitor.emit({ type: "rate_limit", workflowId, nodeId, retryAfterMs });

                  const prevSession = session;
                  await killAdapter();
                  await sleep(retryAfterMs);

                  // Try resume first so session-based adapters (claude-sdk) preserve conversation history
                  try {
                    session = await adapter.resume(
                      effectiveConfig,
                      prevSession,
                      "Continuing after rate limit pause. Please continue where you left off.",
                      traceCtx,
                    );
                  } catch {
                    // resume failed (e.g. no session ID) — fall back to cold start
                    session = await adapter.spawn(effectiveConfig, traceCtx);
                  }
                  this.sessionStore.set(nodeId, session);
                  // Fresh session — allow killAdapter to run again on the
                  // new child if the catch block later fires.
                  adapterKilled = false;
                  rateLimitRetry = true;
                  break;
                }

                // sharedContext write. Enforce the node's writesContext
                // allowlist BEFORE recording the event — a disallowed write is
                // dropped and a replacement `error` event is recorded instead so
                // replay sees the same (rejected) sequence the original run saw.
                if (event.type === "context_set") {
                  const allowlist = nodeConfig.writesContext ?? [];
                  if (!allowlist.includes(event.key)) {
                    const rejection: AgentEvent = {
                      type: "error",
                      message: `context_set rejected: node "${nodeId}" is not allowed to write key "${event.key}" (not in writesContext)`,
                    };
                    this.emit("node_event", nodeId, rejection);
                    this.monitor.emit({ type: "node_event", workflowId, nodeId, event: rejection, traceId, spanId });
                    this.eventRecorder?.record(nodeId, rejection);
                    logger.warn(`context_set rejected: node "${nodeId}" attempted to write unlisted key "${event.key}"`);
                    continue;
                  }
                  runState.sharedContext[event.key] = event.value;
                  this.checkpointManager?.markDirty(runState);
                }

                this.emit("node_event", nodeId, event);
                this.monitor.emit({ type: "node_event", workflowId, nodeId, event, traceId, spanId });
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
              this.monitor.emit({ type: "node_end", workflowId, nodeId, result: stallResult, traceId, spanId });
              return stallResult;
            }

            const result = await adapter.getResult(session);
            await this.eventRecorder?.flushNode(nodeId);

            // Circuit breaker: a clean result counts as a success
            // for the provider. If we were in half_open, this closes the
            // circuit; if closed, it's a no-op but still exercises the hook
            // so half_open probes elsewhere can't race.
            this.adapterPool?.recordSuccess(effectiveConfig.adapter);

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
                const mergeResult = await worktreeManager.merge(nodeId, currentBranch, signal);
                if (mergeResult.conflicts.length > 0) {
                  const reason = `Merge conflicts in node "${nodeId}": ${mergeResult.conflicts.join(", ")}`;
                  this.monitor.emit({ type: "workflow_error", workflowId, nodeId, message: reason });
                  throw new Error(reason);
                }
              }
            }

            const success = result.exitCode === 0;

            // Lifecycle hook: postNode. Observational — does not
            // alter control flow, but result is captured in the event log.
            await this.runHook(
              "postNode",
              workflowId,
              nodeId,
              {
                workflowId,
                nodeId,
                outputDir: nodeConfig.outputDir ?? process.cwd(),
                exitCode: result.exitCode,
                output: result.output,
              },
              signal,
              false,
            );

            this.emit("node_end", nodeId, success);
            this.monitor.emit({ type: "node_end", workflowId, nodeId, result, traceId, spanId });

            return result;
          } catch (err) {
            clearTimeouts();

            // Tear down the adapter session on ALL exception paths. A throw
            // from inside `for await … of adapter.stream(session)` — or from
            // monitor.emit, eventRecorder.record, getResult, or the worktree
            // merge — leaves the child process running. killAdapter is
            // hoisted and kill-once-guarded, so the cancel / stall /
            // rate-limit-with-fallback paths that already invoked it are
            // no-ops the second time.
            await killAdapter();
            // Flush buffered NDJSON events so the replay log reflects what ran
            // before the error, not just what happened to be flushed on the
            // last debounce. Matches the normal-path flushNode at the success
            // branch above.
            await this.eventRecorder?.flushNode(nodeId).catch(() => undefined);

            // Circuit breaker: signal every failure so the pool
            // can resolve a half_open probe regardless of outcome. The pool
            // itself decides what counts toward the rolling-window threshold:
            // retryable transport/5xx → counted; rate_limit (provider-directed
            // backpressure) and unclassified non-retryable (deterministic bugs)
            // → probe-flag-cleared-only, not counted. Unconditionally calling
            // recordFailure is required because a non-retryable throw during a
            // half_open probe would otherwise leave `halfOpenProbeInFlight=true`
            // forever, pinning the circuit.
            {
              const cbClassified = classifyError(err);
              this.adapterPool?.recordFailure(effectiveConfig.adapter, cbClassified.reason);
            }

            // Retry-in-place on whitelisted retryable errors.
            // Rate-limit is handled by its own bespoke path above — retry
            // policy must not double-handle it (the server already specified
            // the exact wait via retryAfterMs).
            const isRateLimitError =
              err instanceof Error && err.message.startsWith("rate_limit:");
            if (retryPolicy && attemptNum < maxAttempts && !isRateLimitError) {
              const classified = classifyError(err);
              if (
                classified.retryable &&
                isRetryableReason(retryPolicy, classified.reason)
              ) {
                const delayMs = computeRetryDelay(
                  retryPolicy,
                  attemptNum,
                  runState.id,
                  nodeId,
                );
                const reasonStr = classified.reason ?? "unknown";
                const retryEvent: AgentEvent = {
                  type: "retry_scheduled",
                  attempt: attemptNum,
                  nextAttempt: attemptNum + 1,
                  delayMs,
                  reason: reasonStr,
                };
                this.emit("node_event", nodeId, retryEvent);
                this.monitor.emit({
                  type: "node_event",
                  workflowId,
                  nodeId,
                  event: retryEvent,
                  traceId,
                  spanId,
                });
                this.eventRecorder?.record(nodeId, retryEvent);
                logger.info(
                  `Retry scheduled for node "${nodeId}" on ${provider.adapter}: attempt ${attemptNum} → ${attemptNum + 1} in ${delayMs}ms (${reasonStr})`,
                );

                // Release the pool slot while we sleep so the adapter
                // concurrency budget isn't held during backoff.
                if (poolSlot && this.adapterPool) {
                  this.adapterPool.release(poolSlot);
                  poolSlot = undefined;
                }

                await sleepWithAbort(delayMs, signal);
                if ((this.state as string) === "cancelled" || signal?.aborted) {
                  throw new Error("Workflow cancelled");
                }
                continue; // retry same provider
              }
            }

            // Retry exhausted or not applicable — try provider failover.
            if (hasFallback) {
              const classified = classifyError(err);
              if (classified.retryable) {
                lastFailoverError = err;
                const nextProvider = providers[providerIndex + 1]!;
                const reasonStr = classified.reason ?? "unknown";
                const failoverEvent: AgentEvent = {
                  type: "adapter_failover",
                  fromAdapter: provider.adapter,
                  toAdapter: nextProvider.adapter,
                  reason: reasonStr,
                };
                this.emit("node_event", nodeId, failoverEvent);
                this.monitor.emit({ type: "node_event", workflowId, nodeId, event: failoverEvent, traceId, spanId });
                this.eventRecorder?.record(nodeId, failoverEvent);
                logger.info(
                  `Provider failover on node "${nodeId}": ${provider.adapter} → ${nextProvider.adapter} (${reasonStr})`,
                );
                failoverContinue = true;
                break; // exit attempt loop, continue provider loop
              }
            }

            const errorResult: NodeResult = {
              output: err instanceof Error ? err.message : String(err),
              exitCode: 1,
              durationMs: session ? Date.now() - session.startedAt.getTime() : 0,
            };
            this.emit("node_end", nodeId, false);
            this.monitor.emit({ type: "node_end", workflowId, nodeId, result: errorResult, traceId, spanId });
            throw err;
          } finally {
            if (poolSlot && this.adapterPool) {
              this.adapterPool.release(poolSlot);
            }
          }
        }

        if (failoverContinue) continue;
      }

      // All providers exhausted with retryable failures — fail the node.
      const finalErr =
        lastFailoverError instanceof Error
          ? lastFailoverError
          : new Error(String(lastFailoverError ?? "All providers exhausted"));
      const errorResult: NodeResult = {
        output: finalErr.message,
        exitCode: 1,
        durationMs: 0,
      };
      this.emit("node_end", nodeId, false);
      this.monitor.emit({ type: "node_end", workflowId, nodeId, result: errorResult, traceId, spanId });
      throw finalErr;
    } finally {
      // Release the workflow-scoped sync slot if one was acquired.
      if (syncRelease && syncKey !== undefined && syncLimit !== undefined) {
        syncRelease.release();
        const syncReleaseEvent: AgentEvent = { type: "sync_release", key: syncKey, limit: syncLimit };
        this.emit("node_event", nodeId, syncReleaseEvent);
        this.monitor.emit({ type: "node_event", workflowId, nodeId, event: syncReleaseEvent, traceId, spanId });
        this.eventRecorder?.record(nodeId, syncReleaseEvent);
      }

      // Worktree cleanup: remove this node's temporary worktree after execution
      // (runs once per node regardless of failover attempts).
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

    // Pass 3: resolve {{ctx.<key>}} from sharedContext for keys declared in readsContext.
    // Missing keys interpolate as an empty string — deterministic and matches the replay invariant
    // (context_set events are written to the NDJSON log before any downstream node spawns).
    if (nodeConfig.readsContext && nodeConfig.readsContext.length > 0) {
      for (const key of nodeConfig.readsContext) {
        const value = runState.sharedContext[key];
        let serialized: string;
        if (value === undefined) {
          serialized = "";
        } else if (typeof value === "string") {
          serialized = value;
        } else {
          serialized = JSON.stringify(value);
        }
        allVars[`ctx.${key}`] = serialized;
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

  /**
   * Run a lifecycle hook and record the outcome to the event log.
   *
   * No-ops when no hook runner is configured or the specific hook is absent.
   * Always emits + records a `hook_result` AgentEvent when a hook runs so
   * that NDJSON replay observes the same sequence as the live run.
   *
   * When `abortOnFailure` is true (only used for preNode) a non-zero exit
   * throws an Error — mirroring "same semantics as a failed gate" from the
   * proposed shape.
   */
  private async runHook(
    type: HookType,
    workflowId: string,
    nodeId: string,
    context: HookContext,
    signal: AbortSignal | undefined,
    abortOnFailure: boolean,
  ): Promise<void> {
    if (!this.hookRunner || !this.hookRunner.has(type)) return;

    const result = await this.hookRunner.run(type, context, signal);
    if (result === null) return;

    const event = hookResultToEvent(type, result, this.hookRunner.getRunReason());
    this.emit("node_event", nodeId, event);
    this.monitor.emit({ type: "node_event", workflowId, nodeId, event });
    this.eventRecorder?.record(nodeId, event);

    if (result.exitCode !== 0 && abortOnFailure) {
      const stderrSnippet = result.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(
        `${type} hook failed (exit ${result.exitCode})${stderrSnippet ? `: ${stderrSnippet}` : ""}`,
      );
    }
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
