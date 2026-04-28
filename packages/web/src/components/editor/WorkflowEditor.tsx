"use client";

/**
 * @experimental Visual workflow editor. The supported authoring surface is
 * direct edits to `workflow.json`; this component is a demo-grade visualizer
 * with several advanced NodeConfig fields not yet round-trippable. May change
 * shape, move to a side branch, or be removed in v0.x. See
 * `agentcontext/positioning.md`.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useViewport,
  BackgroundVariant,
  type Edge,
  type Node,
  type EdgeMarkerType,
  MarkerType,
  BaseEdge,
  getBezierPath,
  EdgeLabelRenderer,
  type EdgeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  LayoutGrid,
  GitBranch,
  Undo2,
  Redo2,
  Download,
  Play,
  X,
  Check,
  Workflow,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  AlertTriangle,
} from "lucide-react";

import { NodeCard, type NodeCardData, type NodeExecutionStatus } from "./NodeCard";
import { EdgeGatePanel } from "./EdgeGatePanel";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { NodePalette } from "./NodePalette";
import { RunModal } from "./RunModal";
import { useWorkflowEditor, type NodeArchetype } from "@/hooks/useWorkflowEditor";
import { WorkflowGraphSchema, type EdgeConfig, type NodeConfig, type WorkflowGraph } from "@sygil/shared";

// ── Custom edge ──────────────────────────────────────────────────────────────

interface SygilEdgeData {
  edgeConfig: EdgeConfig;
  isSelected?: boolean;
  [key: string]: unknown;
}

function SygilEdge(props: EdgeProps) {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
    style,
  } = props;
  const edgeData = data as SygilEdgeData | undefined;
  const config = edgeData?.edgeConfig;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isLoopBack = config?.isLoopBack ?? false;
  const hasGate = (config?.gate?.conditions.length ?? 0) > 0;

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeDasharray: isLoopBack ? "6 3" : undefined,
        }}
      />
      <EdgeLabelRenderer>
        {hasGate && (
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            <div className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel border border-accent-amber/30 text-accent-amber/80">
              {config?.gate?.conditions.length === 1
                ? config.gate.conditions[0]?.type
                : `${config?.gate?.conditions.length} conditions`}
            </div>
          </div>
        )}
        {isLoopBack && config?.maxRetries !== undefined && (
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${(labelY ?? 0) + 14}px)`,
              pointerEvents: "none",
            }}
          >
            <div className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel border border-accent-amber/20 text-accent-amber/60">
              ↺ max {config.maxRetries}
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

// ── Node / edge type maps ────────────────────────────────────────────────────

const NODE_TYPES = { nodeCard: NodeCard };
const EDGE_TYPES = { sygil: SygilEdge };

// ── Empty sidebar hint ───────────────────────────────────────────────────────

function EmptySelectionHint({ nodeCount }: { nodeCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
      <div className="w-10 h-10 rounded-xl border border-border bg-surface flex items-center justify-center">
        <GitBranch size={18} className="text-muted" />
      </div>
      <div className="space-y-1.5">
        <div className="font-mono text-xs text-dim">Nothing selected</div>
        <div className="font-mono text-xs text-dim leading-relaxed">
          {nodeCount === 0 ? (
            <>Start by dragging a Planner from the palette.</>
          ) : (
            <>
              Click a node to edit its properties.
              <br />
              Click an edge to configure gate conditions.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Editable workflow name ────────────────────────────────────────────────────

interface EditableNameProps {
  value: string;
  onChange: (v: string) => void;
}

function EditableName({ value, onChange }: EditableNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(value);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed) onChange(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="font-mono text-xs text-bright bg-canvas border border-accent/50 rounded px-2 py-0.5 focus:outline-none w-36"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      aria-label="Click to rename workflow"
      className="font-mono text-xs text-dim hover:text-bright transition-colors duration-200 cursor-text"
      title="Click to rename"
    >
      {value}
    </button>
  );
}

// ── Zoom indicator (must be a child of ReactFlow) ───────────────────────────

function ZoomIndicator() {
  const { zoom } = useViewport();
  return (
    <div className="absolute bottom-3 left-14 z-10 font-mono text-[10px] text-dim bg-panel/80 backdrop-blur-sm border border-border rounded px-2 py-1">
      {Math.round(zoom * 100)}%
    </div>
  );
}

// ── Main editor component ─────────────────────────────────────────────────────

type SidebarMode = "node" | "edge" | "none";

export interface WorkflowEditorProps {
  /** "edit" = full editor (default). "monitor" = read-only with execution overlays. */
  mode?: "edit" | "monitor";
  /** Per-node execution status map — used in monitor mode to render overlays. */
  executionState?: Record<string, NodeExecutionStatus>;
  /** When provided, the editor is initialised with this workflow graph. */
  initialWorkflow?: WorkflowGraph;
}

export function WorkflowEditor({
  mode = "edit",
  executionState,
  initialWorkflow,
}: WorkflowEditorProps = {}) {
  const isMonitor = mode === "monitor";
  const editor = useWorkflowEditor();
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("none");
  const [showRunModal, setShowRunModal] = useState(false);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: "node" | "edge" | "canvas"; nodeId?: string; edgeId?: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [edgeEditMode, setEdgeEditMode] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Load initialWorkflow once on mount (or when the graph reference changes)
  const loadedGraphRef = useRef<WorkflowGraph | null>(null);
  useEffect(() => {
    if (initialWorkflow && initialWorkflow !== loadedGraphRef.current) {
      loadedGraphRef.current = initialWorkflow;
      editor.loadWorkflow(JSON.stringify(initialWorkflow));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- editor callbacks are stable; only re-run when the graph reference changes
  }, [initialWorkflow]);

  // ── Keyboard shortcuts (undo/redo) ─────────────────────────────────────
  useEffect(() => {
    if (isMonitor) return;
    function handleKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Skip when focus is inside a contenteditable region — native
      // browser shortcuts (undo, duplicate-line, etc.) must win.
      if (el?.isContentEditable) return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        editor.redo();
      } else if (e.key === "d" && mod) {
        // Ctrl+D on a focused button hijacks the native bookmark shortcut
        // without doing anything useful — the canvas isn't the target.
        if (tag === "BUTTON") return;
        e.preventDefault();
        if (editor.selectedNodeId) {
          editor.duplicateNode(editor.selectedNodeId);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMonitor, editor]);

  // ── Close context menu on any click ─────────────────────────────────────
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // ── Close shortcuts popover on outside click ───────────────────────────
  useEffect(() => {
    if (!showShortcuts) return;
    const close = () => setShowShortcuts(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showShortcuts]);

  // ── Close validation popover on outside click ─────────────────────────
  useEffect(() => {
    if (!showValidation) return;
    const close = () => setShowValidation(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showValidation]);

  // ── Auto-focus first context menu item ────────────────────────────────
  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const firstItem = contextMenuRef.current.querySelector<HTMLElement>("[role='menuitem']");
    firstItem?.focus();
  }, [contextMenu]);

  // ── Auto-dismiss export error after 5s ────────────────────────────────
  useEffect(() => {
    if (!exportError) return;
    const timer = setTimeout(() => setExportError(null), 5000);
    return () => clearTimeout(timer);
  }, [exportError]);

  // ── Derived data ────────────────────────────────────────────────────────

  const selectedNodeConfig = useMemo((): NodeCardData | null => {
    if (!editor.selectedNodeId) return null;
    const node = editor.nodes.find((n) => n.id === editor.selectedNodeId);
    return node ? (node.data as NodeCardData) : null;
  }, [editor.nodes, editor.selectedNodeId]);

  const selectedEdgeConfig = useMemo((): EdgeConfig | null => {
    if (!editor.selectedEdgeId) return null;
    const edge = editor.edges.find((e) => e.id === editor.selectedEdgeId);
    if (!edge) return null;
    const stored = (edge.data as { edgeConfig?: EdgeConfig } | undefined)?.edgeConfig;
    return (
      stored ?? {
        id: edge.id,
        from: edge.source,
        to: edge.target,
      }
    );
  }, [editor.edges, editor.selectedEdgeId]);

  const selectedEdgeLabel = useMemo(() => {
    if (!selectedEdgeConfig) return undefined;
    return `${selectedEdgeConfig.from} → ${selectedEdgeConfig.to}`;
  }, [selectedEdgeConfig]);

  // Merge executionState into node data for monitor mode
  const nodesWithStatus = useMemo(() => {
    if (!executionState) return editor.nodes;
    return editor.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        executionState: executionState[node.id],
      },
    }));
  }, [editor.nodes, executionState]);

  // Highlight selected edge (edit mode) or gate_eval results (monitor mode)
  const displayEdges = useMemo(
    () =>
      editor.edges.map((e) => {
        if (e.id !== editor.selectedEdgeId) return e;
        const isLoop =
          (e.data as { edgeConfig?: EdgeConfig } | undefined)?.edgeConfig
            ?.isLoopBack ?? false;
        return {
          ...e,
          style: {
            ...e.style,
            stroke: isLoop ? "var(--warning)" : "var(--accent)",
            strokeWidth: 2.5,
          },
        };
      }),
    [editor.edges, editor.selectedEdgeId]
  );

  // ── Callbacks ───────────────────────────────────────────────────────────

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const archetype = event.dataTransfer.getData(
        "application/sygil-node-type"
      ) as NodeArchetype;
      if (!archetype) return;
      if (!rfInstance) return;
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      editor.addNode(archetype, position);
    },
    [editor, rfInstance]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      editor.selectNode(node.id);
      setSidebarMode("node");
      setRightCollapsed(false);
      setContextMenu(null);
    },
    [editor]
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      editor.selectEdge(edge.id);
      setSidebarMode("edge");
      setRightCollapsed(false);
    },
    [editor]
  );

  const handlePaneClick = useCallback(() => {
    editor.selectNode(null);
    editor.selectEdge(null);
    setSidebarMode("none");
    setContextMenu(null);
  }, [editor]);

  // After a new connection is made, switch to edge sidebar
  const handleConnect = useCallback(
    (params: Parameters<typeof editor.onConnect>[0]) => {
      editor.onConnect(params);
      setSidebarMode("edge");
      setRightCollapsed(false);
    },
    [editor]
  );

  // Export JSON — validate against schema before download
  function handleExport() {
    const workflow = editor.exportWorkflow();
    const validation = WorkflowGraphSchema.safeParse(workflow);
    if (!validation.success) {
      const issues = validation.error.issues.map(i => `• ${i.path.join(".")}: ${i.message}`).join("\n");
      setExportError(issues);
      return;
    }
    const blob = new Blob([JSON.stringify(validation.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${editor.workflowName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full">
      {/* Left palette — hidden in monitor mode */}
      {!isMonitor && (
        <>
          {!leftCollapsed && (
            <NodePalette
              onLoadWorkflow={(json) => {
                if (editor.isDirty && !window.confirm("You have unsaved changes. Loading a new workflow will replace your current work. Continue?")) {
                  return { success: false };
                }
                return editor.loadWorkflow(json);
              }}
              onAddNode={(archetype) => {
                const center = rfInstance
                  ? rfInstance.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
                  : { x: 200, y: 200 };
                const offset = editor.nodeCount * 40;
                editor.addNode(archetype, { x: center.x + offset, y: center.y + offset });
              }}
            />
          )}
          <button
            onClick={() => setLeftCollapsed(c => !c)}
            className="shrink-0 w-11 min-w-[44px] flex items-center justify-center border-r border-border bg-panel hover:bg-surface text-dim hover:text-bright transition-colors duration-200"
            aria-label={leftCollapsed ? "Show node palette" : "Hide node palette"}
          >
            {leftCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </button>
        </>
      )}

      {/* Canvas area */}
      <div className="flex-1 relative overflow-hidden">
        {/* Toolbar */}
        <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between gap-2 pointer-events-none">
          {/* Left: workflow name + stats */}
          <div className="pointer-events-auto flex items-center gap-2">
            <div className="flex items-center gap-2 bg-panel border border-border rounded-lg px-3 py-2">
              <LayoutGrid size={12} className="text-dim shrink-0" />
              {isMonitor ? (
                <span className="font-mono text-xs text-dim">{editor.workflowName}</span>
              ) : (
                <EditableName
                  value={editor.workflowName}
                  onChange={editor.setWorkflowName}
                />
              )}
              <span className="font-mono text-[10px] text-dim border-l border-border pl-2.5 ml-0.5 whitespace-nowrap">
                {editor.nodeCount} node{editor.nodeCount !== 1 ? "s" : ""} · {editor.edgeCount} edge{editor.edgeCount !== 1 ? "s" : ""}
              </span>
              {!isMonitor && editor.isDirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-accent-amber shrink-0"
                  title="Unsaved changes"
                />
              )}
              {!isMonitor && editor.nodeCount > 0 && (
                editor.validationResult.success ? (
                  <span title="Workflow is valid"><Check size={11} className="text-accent-green shrink-0" /></span>
                ) : (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowValidation(v => !v); }}
                      className="flex items-center gap-1 text-accent-amber"
                      title={`${editor.validationResult.error?.issues.length ?? 0} validation issue(s)`}
                    >
                      <AlertTriangle size={11} className="shrink-0" />
                      <span className="font-mono text-[10px]">{editor.validationResult.error?.issues.length ?? 0}</span>
                    </button>
                    {showValidation && editor.validationResult.error && (
                      <div className="absolute top-full mt-2 left-0 z-50 bg-panel border border-border rounded-lg shadow-2xl p-3 min-w-[280px] max-w-[400px] max-h-[200px] overflow-y-auto"
                           onClick={(e) => e.stopPropagation()}>
                        <div className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">Validation issues</div>
                        <div className="space-y-1.5">
                          {editor.validationResult.error.issues.map((issue, i) => (
                            <div key={i} className="font-mono text-[11px] text-dim">
                              <span className="text-accent-amber">{issue.path.join(".")}</span>
                              {" — "}
                              <span className="text-body">{issue.message}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          </div>

          {/* Right: undo/redo + export + run — hidden in monitor mode */}
          {!isMonitor && (
            <div className="pointer-events-auto flex items-center gap-1.5" role="toolbar" aria-label="Editor toolbar">
              {/* Tidy Up */}
              <button
                type="button"
                onClick={editor.tidyLayout}
                aria-label="Auto-layout workflow nodes"
                title="Auto-layout workflow nodes"
                className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg bg-panel border border-border text-dim hover:text-bright hover:border-border-bright font-mono text-xs transition-colors duration-200"
              >
                <LayoutGrid size={12} />
                Tidy Up
              </button>

              {/* Undo */}
              <button
                type="button"
                onClick={editor.undo}
                disabled={!editor.canUndo}
                aria-label="Undo (Ctrl+Z)"
                title="Undo (Ctrl+Z)"
                className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-panel border border-border text-dim hover:text-bright hover:border-border-bright transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Undo2 size={13} />
              </button>

              {/* Redo */}
              <button
                type="button"
                onClick={editor.redo}
                disabled={!editor.canRedo}
                aria-label="Redo (Ctrl+Shift+Z)"
                title="Redo (Ctrl+Shift+Z)"
                className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-panel border border-border text-dim hover:text-bright hover:border-border-bright transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Redo2 size={13} />
              </button>

              {/* Keyboard shortcuts */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowShortcuts(s => !s); }}
                  aria-label="Keyboard shortcuts"
                  title="Keyboard shortcuts"
                  className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-panel border border-border text-dim hover:text-bright hover:border-border-bright transition-colors duration-200"
                >
                  <Keyboard size={13} />
                </button>
                {showShortcuts && (
                  <div
                    role="dialog"
                    aria-labelledby="shortcuts-popover-heading"
                    className="absolute top-full right-0 mt-2 w-64 bg-panel border border-border rounded-lg shadow-2xl p-4 z-50"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setShowShortcuts(false); } }}
                  >
                    <div id="shortcuts-popover-heading" className="font-mono text-xs text-bright font-medium mb-3">Keyboard shortcuts</div>
                    <div className="space-y-2 font-mono text-[11px]">
                      {[
                        ["Delete / Backspace", "Delete selected"],
                        ["Ctrl+Z", "Undo"],
                        ["Ctrl+Shift+Z", "Redo"],
                        ["Ctrl+D", "Duplicate node"],
                        ["Ctrl+A", "Select all"],
                      ].map(([key, desc]) => (
                        <div key={key} className="flex items-center justify-between gap-3">
                          <span className="text-dim">{desc}</span>
                          <kbd className="text-[10px] text-dim bg-canvas border border-border px-1.5 py-0.5 rounded">{key}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Export */}
              <button
                type="button"
                onClick={handleExport}
                aria-label="Export workflow JSON"
                title="Export workflow JSON"
                className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg bg-panel border border-border text-dim hover:text-bright hover:border-border-bright font-mono text-xs transition-colors duration-200"
              >
                <Download size={12} />
                Export
              </button>

              {/* Run */}
              <button
                type="button"
                onClick={() => setShowRunModal(true)}
                aria-label="Run workflow"
                className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg bg-accent hover:bg-accent-hover text-white font-mono text-xs transition-colors duration-200"
              >
                <Play size={12} fill="currentColor" />
                Run
              </button>
            </div>
          )}
        </div>

        {/* Export validation error toast */}
        {exportError && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-panel border border-accent-red/30 rounded-lg px-4 py-3 max-w-md shadow-2xl">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-accent-red shrink-0 mt-0.5" />
              <div>
                <div className="font-mono text-xs text-bright font-medium mb-1">Export validation failed</div>
                <pre className="font-mono text-[10px] text-dim whitespace-pre-wrap">{exportError}</pre>
              </div>
              <button onClick={() => setExportError(null)} className="p-1 text-dim hover:text-bright" aria-label="Dismiss">
                <X size={11} />
              </button>
            </div>
          </div>
        )}

        {/* Edge legend */}
        {editor.edgeCount > 0 && (
          <div className="absolute bottom-28 left-3 z-10 flex items-center gap-4 bg-panel/80 backdrop-blur-sm border border-border rounded-lg px-4 py-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-px bg-border-bright" />
              <span className="font-mono text-[10px] text-dim">forward</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-px border-t border-dashed border-accent-amber/60" />
              <span className="font-mono text-[10px] text-dim">loop-back</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded bg-accent-amber/20 border border-accent-amber/40" />
              <span className="font-mono text-[10px] text-dim">gate</span>
            </div>
          </div>
        )}

        {/* Empty canvas state */}
        {nodesWithStatus.length === 0 && (
          <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 rounded-xl border border-border bg-surface flex items-center justify-center">
                <Workflow size={22} className="text-muted" />
              </div>
              <div className="space-y-1.5">
                <div className="font-mono text-sm text-bright font-medium">Start building your workflow</div>
                <div className="font-mono text-xs text-dim leading-relaxed">
                  Drag a node from the palette, or load an existing workflow.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* React Flow */}
        <ReactFlow
          nodes={nodesWithStatus}
          edges={displayEdges}
          onNodesChange={isMonitor ? undefined : editor.onNodesChange}
          onEdgesChange={isMonitor ? undefined : editor.onEdgesChange}
          onConnect={isMonitor ? undefined : handleConnect}
          onNodeClick={isMonitor ? undefined : handleNodeClick}
          onEdgeClick={isMonitor ? undefined : handleEdgeClick}
          onPaneClick={isMonitor ? undefined : handlePaneClick}
          onDrop={isMonitor ? undefined : onDrop}
          onDragOver={isMonitor ? undefined : onDragOver}
          onNodesDelete={isMonitor ? undefined : (nodes) => { nodes.forEach((n) => editor.deleteNode(n.id)); setSidebarMode("none"); }}
          onEdgesDelete={isMonitor ? undefined : (edges) => { edges.forEach((e) => editor.deleteEdge(e.id)); setSidebarMode("none"); }}
          onNodeContextMenu={isMonitor ? undefined : (e, node) => { e.preventDefault(); const menuWidth = 160; const menuHeight = 140; const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8); const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8); setContextMenu({ x, y, type: "node", nodeId: node.id }); }}
          onPaneContextMenu={isMonitor ? undefined : (e) => { e.preventDefault(); const menuWidth = 160; const menuHeight = 50; const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8); const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8); setContextMenu({ x, y, type: "canvas" }); }}
          onEdgeContextMenu={isMonitor ? undefined : (e, edge) => { e.preventDefault(); const menuWidth = 160; const menuHeight = 50; const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8); const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8); setContextMenu({ x, y, type: "edge", edgeId: edge.id }); }}
          isValidConnection={(connection) => {
            // Self-loops are valid: the scheduler handles `source === target`
            // correctly, and the Ralph template depends on it.
            return !editor.edges.some(
              e => e.source === connection.source && e.target === connection.target
            );
          }}
          onInit={(instance) => { setRfInstance(instance); editor.setReactFlowInstance(instance); }}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesDraggable={!isMonitor}
          nodesConnectable={!isMonitor}
          elementsSelectable={!isMonitor}
          deleteKeyCode={isMonitor ? null : "Delete"}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          panOnScroll
          zoomOnScroll
          minZoom={0.3}
          maxZoom={2}
          style={{ background: "transparent" }}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: "sygil",
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 14,
              height: 14,
              color: "var(--border-bright)",
            } as EdgeMarkerType,
            style: {
              stroke: "var(--border-bright)",
              strokeWidth: 1.5,
            },
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgba(39, 39, 42, 0.5)"
          />
          <Controls
            showFitView
            showZoom
            showInteractive={false}
            position="bottom-left"
          />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={() => "var(--border-bright)"}
            maskColor="rgba(9, 9, 11, 0.85)"
          />
          <ZoomIndicator />
        </ReactFlow>

        {/* Context menu */}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            role="menu"
            className="fixed z-50 bg-panel border border-border rounded-lg shadow-2xl py-1 min-w-[160px]"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setContextMenu(null); return; }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = contextMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
                if (!items || items.length === 0) return;
                const current = document.activeElement as HTMLElement;
                const idx = Array.from(items).indexOf(current);
                const next = e.key === "ArrowDown"
                  ? items[(idx + 1) % items.length]
                  : items[(idx - 1 + items.length) % items.length];
                next?.focus();
              }
            }}
          >
            {contextMenu.type === "node" && contextMenu.nodeId && (
              <>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full px-3 py-2 text-left font-mono text-xs text-dim hover:text-bright hover:bg-surface transition-colors duration-150"
                  onClick={() => { editor.duplicateNode(contextMenu.nodeId!); setContextMenu(null); }}
                >
                  Duplicate
                </button>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full px-3 py-2 text-left font-mono text-xs text-dim hover:text-bright hover:bg-surface transition-colors duration-150"
                  onClick={() => { navigator.clipboard.writeText(contextMenu.nodeId!); setContextMenu(null); }}
                >
                  Copy ID
                </button>
                <div className="border-t border-border my-1" />
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full px-3 py-2 text-left font-mono text-xs text-accent-red hover:bg-accent-red/10 transition-colors duration-150"
                  onClick={() => { editor.deleteNode(contextMenu.nodeId!); setContextMenu(null); setSidebarMode("none"); }}
                >
                  Delete
                </button>
              </>
            )}
            {contextMenu.type === "edge" && contextMenu.edgeId && (
              <button
                role="menuitem"
                tabIndex={-1}
                className="w-full px-3 py-2 text-left font-mono text-xs text-accent-red hover:bg-accent-red/10 transition-colors duration-150"
                onClick={() => { editor.deleteEdge(contextMenu.edgeId!); setContextMenu(null); setSidebarMode("none"); }}
              >
                Delete edge
              </button>
            )}
            {contextMenu.type === "canvas" && (
              <>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="w-full px-3 py-2 text-left font-mono text-xs text-dim hover:text-bright hover:bg-surface transition-colors duration-150"
                  onClick={() => { rfInstance?.fitView({ padding: 0.3 }); setContextMenu(null); }}
                >
                  Fit view
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right sidebar — hidden in monitor mode */}
      {!isMonitor && (
        <>
          <button
            onClick={() => setRightCollapsed(c => !c)}
            className="shrink-0 w-11 min-w-[44px] flex items-center justify-center border-l border-border bg-panel hover:bg-surface text-dim hover:text-bright transition-colors duration-200"
            aria-label={rightCollapsed ? "Show properties panel" : "Hide properties panel"}
          >
            {rightCollapsed ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
          </button>
          {!rightCollapsed && (
            <div className="w-80 shrink-0 border-l border-border bg-panel flex flex-col overflow-hidden card-glow">
              {sidebarMode === "node" && editor.selectedNodeId && selectedNodeConfig && (
                <div key={`node-${editor.selectedNodeId}`} className="flex flex-col h-full animate-fade-switch">
                  <NodePropertyPanel
                    nodeId={editor.selectedNodeId}
                    config={selectedNodeConfig}
                    onUpdate={(patch: Partial<NodeConfig>) =>
                      editor.updateNode(editor.selectedNodeId!, patch)
                    }
                    onDelete={() => {
                      editor.deleteNode(editor.selectedNodeId!);
                      setSidebarMode("none");
                    }}
                    onDuplicate={() => {
                      editor.duplicateNode(editor.selectedNodeId!);
                    }}
                  />
                </div>
              )}
              {sidebarMode === "edge" && editor.selectedEdgeId && selectedEdgeConfig && (
                <div key={`edge-${editor.selectedEdgeId}`} className="flex flex-col h-full animate-fade-switch">
                  <EdgeGatePanel
                    edge={selectedEdgeConfig}
                    edgeLabel={selectedEdgeLabel}
                    onUpdate={(patch) => editor.updateEdge(editor.selectedEdgeId!, patch)}
                    onDelete={() => {
                      editor.deleteEdge(editor.selectedEdgeId!);
                      setSidebarMode("none");
                    }}
                    editMode={edgeEditMode}
                    onEditModeChange={setEdgeEditMode}
                    onClose={() => {
                      editor.selectEdge(null);
                      setSidebarMode("none");
                    }}
                  />
                </div>
              )}
              {(sidebarMode === "none" ||
                (sidebarMode === "node" && !editor.selectedNodeId) ||
                (sidebarMode === "edge" && !editor.selectedEdgeId)) && (
                <div key="empty" className="flex flex-col h-full animate-fade-switch">
                  <EmptySelectionHint nodeCount={editor.nodeCount} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Run modal */}
      {showRunModal && (
        <RunModal
          workflow={editor.exportWorkflow()}
          onClose={() => setShowRunModal(false)}
        />
      )}
    </div>
  );
}
