"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type XYPosition,
  type ReactFlowInstance,
  MarkerType,
  type EdgeMarkerType,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import {
  WorkflowGraphSchema,
  NodeConfigSchema,
  type NodeConfig,
  type EdgeConfig,
  type WorkflowGraph,
  type AdapterType,
} from "@sygil/shared";
import type { NodeCardData } from "@/components/editor/NodeCard";

// ── Constants ───────────────────────────────────────────────────────────────

const DRAFT_STORAGE_KEY = "sygil-editor-draft";

/** Node dimensions used for dagre layout (w-44 = 176px, h = 64px). */
const TIDY_NODE_WIDTH = 176;
const TIDY_NODE_HEIGHT = 64;

// ── Types ───────────────────────────────────────────────────────────────────

export type NodeArchetype = "planner" | "implementer" | "reviewer" | "custom";

const ARCHETYPE_DEFAULTS: Record<NodeArchetype, Partial<NodeConfig> & { role: string; adapter: AdapterType; model: string; tools: string[] }> = {
  planner: {
    adapter: "claude-sdk",
    model: "claude-opus-4-7",
    tools: ["Read", "Grep", "Glob", "LS"],
    role: "Planner",
    prompt: "",
  },
  implementer: {
    adapter: "codex",
    model: "gpt-4o",
    sandbox: "workspace-write",
    tools: [],
    role: "Implementer",
    prompt: "",
  },
  reviewer: {
    adapter: "claude-sdk",
    model: "claude-sonnet-4-6",
    tools: ["Read", "Grep", "LS"],
    role: "Reviewer",
    prompt: "",
  },
  custom: {
    adapter: "claude-sdk",
    model: "claude-sonnet-4-6",
    tools: [],
    role: "Agent",
    prompt: "",
  },
};

export interface UseWorkflowEditorReturn {
  // React Flow state
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Selection
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectNode: (id: string | null) => void;
  selectEdge: (id: string | null) => void;

  // Node operations
  addNode: (type: NodeArchetype, position: XYPosition) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  updateNode: (id: string, patch: Partial<NodeConfig>) => void;

  // Edge operations
  deleteEdge: (id: string) => void;
  updateEdge: (id: string, patch: Partial<EdgeConfig>) => void;

  // Workflow metadata
  workflowName: string;
  setWorkflowName: (name: string) => void;

  // Import / export
  loadWorkflow: (json: string) => { success: boolean; error?: string };
  exportWorkflow: () => WorkflowGraph;

  // Undo / redo
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;

  // Validation
  validationResult: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };

  // Derived
  nodeCount: number;
  edgeCount: number;
  isDirty: boolean;

  // Layout
  tidyLayout: () => void;

  // React Flow instance wiring (call setReactFlowInstance from onInit or
  // wherever the caller obtains the ReactFlowInstance so tidyLayout can fitView)
  setReactFlowInstance: (instance: ReactFlowInstance | null) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 50;

// Schema-driven allowlist for node-config patches. Any new field added
// to `NodeConfigSchema` in @sygil/shared automatically propagates here, so the
// editor stops silently dropping new fields on updateNode.
const NODE_CONFIG_FIELDS = NodeConfigSchema.keyof().options as readonly (keyof NodeConfig)[];

function sanitizeNodeConfigPatch(patch: Partial<NodeConfig>): Partial<NodeConfig> {
  const out: Record<string, unknown> = {};
  for (const key of NODE_CONFIG_FIELDS) {
    if (key in patch) {
      out[key as string] = (patch as Record<string, unknown>)[key as string];
    }
  }
  return out as Partial<NodeConfig>;
}

function makeNodeCardData(id: string, config: Partial<NodeConfig>): NodeCardData {
  // Store the full NodeConfig on `raw` so round-trips preserve every field,
  // including providers / retryPolicy / modelTier / writesContext / readsContext
  // / expectedOutputs / outputSchema — fields the UI does not yet surface.
  const raw: Partial<NodeConfig> = { ...config };
  return {
    nodeId: id,
    adapter: (config.adapter ?? "claude-sdk") as AdapterType,
    model: config.model ?? "claude-sonnet-4-6",
    role: config.role ?? "Agent",
    tools: config.tools ?? [],
    status: "idle",
    // Display-side mirrors kept in sync with raw for existing renderers
    prompt: config.prompt ?? "",
    outputDir: config.outputDir,
    timeoutMs: config.timeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    maxBudgetUsd: config.maxBudgetUsd,
    maxTurns: config.maxTurns,
    sandbox: config.sandbox,
    disallowedTools: config.disallowedTools,
    raw,
  };
}

/** Default stroke color for forward edges — uses the border-bright design token. */
const EDGE_COLOR_FORWARD = "var(--border-bright)";

/** Stroke color for loop-back (retry) edges — uses the warning/accent-amber design token. */
const EDGE_COLOR_LOOPBACK = "var(--warning)";

const EDGE_DEFAULTS: Partial<Edge> = {
  type: "sygil",
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 14,
    height: 14,
    color: EDGE_COLOR_FORWARD,
  } as EdgeMarkerType,
  style: {
    stroke: EDGE_COLOR_FORWARD,
    strokeWidth: 1.5,
  },
};

function workflowToFlow(graph: WorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodeEntries = Object.entries(graph.nodes);
  const nodes: Node[] = nodeEntries.map(([id, config], index) => ({
    id,
    type: "nodeCard",
    position: { x: index * 280 + 60, y: 200 },
    data: makeNodeCardData(id, config) as unknown as Record<string, unknown>,
  }));

  const edges: Edge[] = graph.edges.map((ec) => ({
    ...EDGE_DEFAULTS,
    id: ec.id,
    source: ec.from,
    target: ec.to,
    ...(ec.isLoopBack
      ? {
          style: { stroke: EDGE_COLOR_LOOPBACK, strokeWidth: 1.5 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: EDGE_COLOR_LOOPBACK,
            width: 12,
            height: 12,
          } as EdgeMarkerType,
        }
      : {}),
    data: { edgeConfig: ec } as unknown as Record<string, unknown>,
  }));

  return { nodes, edges };
}

function flowToWorkflow(
  name: string,
  nodes: Node[],
  edges: Edge[]
): WorkflowGraph {
  const workflowNodes: Record<string, NodeConfig> = {};
  for (const n of nodes) {
    const d = n.data as NodeCardData;
    // `raw` holds the full NodeConfig preserved through round-trips.
    // Display mirrors overlay raw so recent edits win, but raw supplies
    // advanced fields (providers, retryPolicy, modelTier, writesContext,
    // readsContext, expectedOutputs, outputSchema) that the panel does not
    // yet render.
    const raw = (d.raw as Partial<NodeConfig> | undefined) ?? {};
    workflowNodes[n.id] = {
      ...raw,
      adapter: d.adapter,
      model: d.model,
      role: d.role,
      prompt: (d.prompt as string | undefined) ?? "",
      tools: d.tools,
      disallowedTools: d.disallowedTools as string[] | undefined,
      outputDir: d.outputDir as string | undefined,
      timeoutMs: d.timeoutMs as number | undefined,
      idleTimeoutMs: d.idleTimeoutMs as number | undefined,
      maxBudgetUsd: d.maxBudgetUsd as number | undefined,
      maxTurns: d.maxTurns as number | undefined,
      sandbox: d.sandbox as "read-only" | "workspace-write" | "full-access" | undefined,
    } as NodeConfig;
  }

  const workflowEdges: EdgeConfig[] = edges.map((e) => {
    const stored = (e.data as { edgeConfig?: EdgeConfig } | undefined)?.edgeConfig;
    if (stored) return stored;
    return { id: e.id, from: e.source, to: e.target };
  });

  return {
    version: "1.0",
    name,
    nodes: workflowNodes,
    edges: workflowEdges,
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface HistoryEntry {
  nodes: Node[];
  edges: Edge[];
}

function genNodeId(archetype: NodeArchetype): string {
  return `${archetype}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function genEdgeId(source: string, target: string): string {
  return `${source}-to-${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function loadDraft(): { nodes: Node[]; edges: Edge[]; workflowName: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { nodes?: unknown; edges?: unknown; workflowName?: unknown };
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || typeof parsed.workflowName !== "string") {
      return null;
    }
    return { nodes: parsed.nodes as Node[], edges: parsed.edges as Edge[], workflowName: parsed.workflowName };
  } catch {
    return null;
  }
}

export function useWorkflowEditor(): UseWorkflowEditorReturn {
  // Restore from localStorage before any other state initialization
  const draft = useRef(loadDraft());

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(draft.current?.nodes ?? []);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(draft.current?.edges ?? []);

  const [workflowName, setWorkflowNameState] = useState(draft.current?.workflowName ?? "my-workflow");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Keep refs in sync with the latest nodes/edges on every render (not in a
  // useEffect — that would be one render late). Callbacks that run inside
  // setNodes/setEdges updaters read from these refs so they always see the
  // current value instead of a stale closure capture.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Ref to the ReactFlowInstance — set by the caller via setReactFlowInstance
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);

  const setReactFlowInstance = useCallback((instance: ReactFlowInstance | null) => {
    reactFlowInstanceRef.current = instance;
  }, []);

  // History stored in a ref to avoid re-renders on every push
  const historyRef = useRef<HistoryEntry[]>([{ nodes: [], edges: [] }]);
  const historyIndexRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0); // just to trigger re-renders

  // ── History helpers ──────────────────────────────────────────────────────

  const pushHistory = useCallback(
    (newNodes: Node[], newEdges: Edge[]) => {
      const history = historyRef.current;
      const idx = historyIndexRef.current;
      // Truncate forward history
      const trimmed = history.slice(0, idx + 1);
      trimmed.push({ nodes: newNodes, edges: newEdges });
      if (trimmed.length > HISTORY_LIMIT) trimmed.shift();
      historyRef.current = trimmed;
      historyIndexRef.current = trimmed.length - 1;
      setHistoryVersion((v) => v + 1);
      setIsDirty(true);
    },
    []
  );

  // ── Selection ────────────────────────────────────────────────────────────

  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }, []);

  const selectEdge = useCallback((id: string | null) => {
    setSelectedEdgeId(id);
    setSelectedNodeId(null);
  }, []);

  // ── Node operations ──────────────────────────────────────────────────────

  const addNode = useCallback(
    (type: NodeArchetype, position: XYPosition) => {
      const id = genNodeId(type);
      const defaults = ARCHETYPE_DEFAULTS[type];
      const newNode: Node = {
        id,
        type: "nodeCard",
        position,
        data: makeNodeCardData(id, defaults) as unknown as Record<string, unknown>,
      };
      setNodes((nds) => {
        const next = [...nds, newNode];
        pushHistory(next, edgesRef.current);
        return next;
      });
    },
    [pushHistory, setNodes]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => {
        const next = nds.filter((n) => n.id !== id);
        setEdges((eds) => {
          const nextEdges = eds.filter((e) => e.source !== id && e.target !== id);
          pushHistory(next, nextEdges);
          return nextEdges;
        });
        return next;
      });
      setSelectedNodeId((s) => (s === id ? null : s));
    },
    [pushHistory, setEdges, setNodes]
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const source = nodes.find((n) => n.id === id);
      if (!source) return;
      const sourceData = source.data as NodeCardData;
      const newId = `${id}-copy-${Math.random().toString(36).slice(2, 6)}`;
      // Clone from `raw` — the schema-complete NodeConfig — so advanced fields
      // (providers, retryPolicy, modelTier, writesContext, readsContext,
      // expectedOutputs, outputSchema) survive the duplicate. Enumerating
      // display-mirror fields here is the same class of drop bug the export
      // path fixes; structuredClone breaks array/object aliasing.
      const sourceRaw = (sourceData.raw ?? {}) as Partial<NodeConfig>;
      const clonedData = makeNodeCardData(
        newId,
        structuredClone(sourceRaw),
      );
      const newNode: Node = {
        id: newId,
        type: "nodeCard",
        position: { x: source.position.x + 60, y: source.position.y + 60 },
        data: clonedData as unknown as Record<string, unknown>,
      };
      setNodes((nds) => {
        const next = [...nds, newNode];
        pushHistory(next, edgesRef.current);
        return next;
      });
      setSelectedNodeId(newId);
      setSelectedEdgeId(null);
    },
    [nodes, pushHistory, setNodes]
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<NodeConfig>) => {
      // Sanitize the incoming patch against the schema-derived allowlist so
      // any new NodeConfig field (providers, retryPolicy, modelTier,
      // writesContext, readsContext, expectedOutputs, outputSchema, ...)
      // propagates automatically without hand-editing this action.
      const sanitized = sanitizeNodeConfigPatch(patch);
      setNodes((nds) => {
        const next = nds.map((n) => {
          if (n.id !== id) return n;
          const prev = n.data as NodeCardData;
          const prevRaw = (prev.raw as Partial<NodeConfig> | undefined) ?? {};
          const nextRaw: Partial<NodeConfig> = { ...prevRaw, ...sanitized };
          const merged: NodeCardData = {
            ...prev,
            adapter: sanitized.adapter !== undefined ? sanitized.adapter : prev.adapter,
            model: sanitized.model !== undefined ? sanitized.model : prev.model,
            role: sanitized.role !== undefined ? sanitized.role : prev.role,
            tools: sanitized.tools !== undefined ? sanitized.tools : prev.tools,
            prompt: sanitized.prompt !== undefined ? sanitized.prompt : (prev.prompt as string | undefined) ?? "",
            outputDir: sanitized.outputDir !== undefined ? sanitized.outputDir : (prev.outputDir as string | undefined),
            timeoutMs: sanitized.timeoutMs !== undefined ? sanitized.timeoutMs : (prev.timeoutMs as number | undefined),
            idleTimeoutMs: sanitized.idleTimeoutMs !== undefined ? sanitized.idleTimeoutMs : (prev.idleTimeoutMs as number | undefined),
            maxBudgetUsd: sanitized.maxBudgetUsd !== undefined ? sanitized.maxBudgetUsd : (prev.maxBudgetUsd as number | undefined),
            maxTurns: sanitized.maxTurns !== undefined ? sanitized.maxTurns : (prev.maxTurns as number | undefined),
            sandbox: sanitized.sandbox !== undefined ? sanitized.sandbox : (prev.sandbox as "read-only" | "workspace-write" | "full-access" | undefined),
            disallowedTools: sanitized.disallowedTools !== undefined ? sanitized.disallowedTools : (prev.disallowedTools as string[] | undefined),
            raw: nextRaw,
          };
          return { ...n, data: merged as unknown as Record<string, unknown> };
        });
        pushHistory(next, edgesRef.current);
        return next;
      });
    },
    [pushHistory, setNodes]
  );

  // ── Edge operations ──────────────────────────────────────────────────────

  const onConnect: OnConnect = useCallback(
    (params) => {
      const newEdgeId = genEdgeId(params.source ?? "src", params.target ?? "tgt");
      // A self-loop only executes under a loop-back gate — a forward self-edge
      // has no scheduler meaning — so set `isLoopBack: true` up front.
      const isSelfLoop = params.source !== null && params.source === params.target;
      const newEdge: Edge = {
        ...EDGE_DEFAULTS,
        ...params,
        id: newEdgeId,
        data: {
          edgeConfig: {
            id: newEdgeId,
            from: params.source ?? "",
            to: params.target ?? "",
            ...(isSelfLoop ? { isLoopBack: true } : {}),
          },
        } as unknown as Record<string, unknown>,
      };
      setEdges((eds) => {
        const next = addEdge(newEdge, eds);
        pushHistory(nodesRef.current, next);
        return next;
      });
      // Auto-select the new edge
      setSelectedEdgeId(newEdgeId);
      setSelectedNodeId(null);
    },
    [pushHistory, setEdges]
  );

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((eds) => {
        const next = eds.filter((e) => e.id !== id);
        pushHistory(nodesRef.current, next);
        return next;
      });
      setSelectedEdgeId((s) => (s === id ? null : s));
    },
    [pushHistory, setEdges]
  );

  const updateEdge = useCallback(
    (id: string, patch: Partial<EdgeConfig>) => {
      setEdges((eds) => {
        const next = eds.map((e) => {
          if (e.id !== id) return e;
          const prev = (e.data as { edgeConfig?: EdgeConfig } | undefined)?.edgeConfig ?? {
            id: e.id,
            from: e.source,
            to: e.target,
          };
          const merged: EdgeConfig = { ...prev, ...patch };
          const isLoopBack = merged.isLoopBack ?? false;
          return {
            ...e,
            ...(isLoopBack
              ? {
                  style: { stroke: EDGE_COLOR_LOOPBACK, strokeWidth: 1.5 },
                  markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: EDGE_COLOR_LOOPBACK,
                    width: 12,
                    height: 12,
                  } as EdgeMarkerType,
                }
              : {
                  style: { stroke: EDGE_COLOR_FORWARD, strokeWidth: 1.5 },
                  markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 14,
                    height: 14,
                    color: EDGE_COLOR_FORWARD,
                  } as EdgeMarkerType,
                }),
            data: { edgeConfig: merged } as unknown as Record<string, unknown>,
          };
        });
        pushHistory(nodesRef.current, next);
        return next;
      });
    },
    [pushHistory, setEdges]
  );

  // ── Workflow name ────────────────────────────────────────────────────────

  const setWorkflowName = useCallback((name: string) => {
    setWorkflowNameState(name);
    setIsDirty(true);
  }, []);

  // ── Import / export ──────────────────────────────────────────────────────

  const loadWorkflow = useCallback(
    (json: string): { success: boolean; error?: string } => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { success: false, error: "Invalid JSON" };
      }

      // Validate against schema
      const result = WorkflowGraphSchema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.slice(0, 5).map(i => `• ${i.path.join(".")}: ${i.message}`).join("\n");
        const suffix = result.error.issues.length > 5 ? `\n...and ${result.error.issues.length - 5} more issues` : "";
        return { success: false, error: `Invalid workflow JSON:\n\n${issues}${suffix}` };
      }

      const graph = result.data;
      const { nodes: newNodes, edges: newEdges } = workflowToFlow(graph);
      setNodes(newNodes);
      setEdges(newEdges);
      setWorkflowNameState(graph.name);
      pushHistory(newNodes, newEdges);
      setIsDirty(false);
      return { success: true };
    },
    [pushHistory, setEdges, setNodes]
  );

  const exportWorkflow = useCallback((): WorkflowGraph => {
    return flowToWorkflow(workflowName, nodes, edges);
  }, [edges, nodes, workflowName]);

  // ── Undo / redo ──────────────────────────────────────────────────────────

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx <= 0) return;
    const newIdx = idx - 1;
    historyIndexRef.current = newIdx;
    const entry = historyRef.current[newIdx];
    if (entry) {
      setNodes(entry.nodes);
      setEdges(entry.edges);
    }
    setHistoryVersion((v) => v + 1);
  }, [setEdges, setNodes]);

  const redo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx >= historyRef.current.length - 1) return;
    const newIdx = idx + 1;
    historyIndexRef.current = newIdx;
    const entry = historyRef.current[newIdx];
    if (entry) {
      setNodes(entry.nodes);
      setEdges(entry.edges);
    }
    setHistoryVersion((v) => v + 1);
  }, [setEdges, setNodes]);

  // historyVersion used purely to keep canUndo/canRedo reactive
  const _hv = historyVersion;
  void _hv;

  const canUndo = historyIndexRef.current > 0;
  const canRedo = historyIndexRef.current < historyRef.current.length - 1;

  const [validationResult, setValidationResult] = useState<{ success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }>({ success: true });

  useEffect(() => {
    const timer = setTimeout(() => {
      const workflow = flowToWorkflow(workflowName, nodes, edges);
      const result = WorkflowGraphSchema.safeParse(workflow);
      if (result.success) {
        setValidationResult({ success: true });
      } else {
        setValidationResult({
          success: false,
          error: { issues: result.error.issues.map(i => ({ path: i.path, message: i.message })) },
        });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [nodes, edges, workflowName]);

  // ── localStorage auto-save (debounced ~5s) ──────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem(
          DRAFT_STORAGE_KEY,
          JSON.stringify({ nodes, edges, workflowName })
        );
      } catch {
        // Quota exceeded or private browsing — silently ignore
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [nodes, edges, workflowName]);

  // ── Tidy layout (dagre LR) ───────────────────────────────────────────────

  const tidyLayout = useCallback(() => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });

    for (const node of nodesRef.current) {
      g.setNode(node.id, { width: TIDY_NODE_WIDTH, height: TIDY_NODE_HEIGHT });
    }
    for (const edge of edgesRef.current) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    setNodes((nds) =>
      nds.map((node) => {
        const pos = g.node(node.id);
        if (!pos) return node;
        return {
          ...node,
          position: {
            x: pos.x - TIDY_NODE_WIDTH / 2,
            y: pos.y - TIDY_NODE_HEIGHT / 2,
          },
        };
      })
    );

    // fitView after React re-renders new positions
    requestAnimationFrame(() => {
      reactFlowInstanceRef.current?.fitView({ padding: 0.3 });
    });
  }, [setNodes]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,

    selectedNodeId,
    selectedEdgeId,
    selectNode,
    selectEdge,

    addNode,
    deleteNode,
    duplicateNode,
    updateNode,

    deleteEdge,
    updateEdge,

    workflowName,
    setWorkflowName,

    loadWorkflow,
    exportWorkflow,

    undo,
    redo,
    canUndo,
    canRedo,

    validationResult,

    nodeCount: nodes.length,
    edgeCount: edges.length,
    isDirty,

    tidyLayout,
    setReactFlowInstance,
  };
}
