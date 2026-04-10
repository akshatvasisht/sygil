import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Node, Edge } from "@xyflow/react";

// ---------------------------------------------------------------------------
// Mock @xyflow/react
// useNodesState / useEdgesState are backed by real React.useState so that
// setNodes/setEdges calls (including updater-function form) actually mutate
// state and trigger re-renders under renderHook.
// ---------------------------------------------------------------------------

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    useNodesState: (initial: Node[] = []) => {
      const [nodes, setNodes] = React.useState<Node[]>(initial);
      return [nodes, setNodes, () => {}] as const;
    },
    useEdgesState: (initial: Edge[] = []) => {
      const [edges, setEdges] = React.useState<Edge[]>(initial);
      return [edges, setEdges, () => {}] as const;
    },
    addEdge: (edge: object, edges: object[]) => [...edges, edge],
    MarkerType: { ArrowClosed: "arrow-closed" },
  };
});

import { useWorkflowEditor } from "./useWorkflowEditor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WorkflowGraph JSON string */
function makeWorkflowJson(name = "test-wf") {
  return JSON.stringify({
    version: "1.0",
    name,
    nodes: {
      "node-a": {
        adapter: "claude-sdk",
        model: "claude-opus-4-5",
        role: "Planner",
        prompt: "plan it",
        tools: ["Read"],
      },
      "node-b": {
        adapter: "codex",
        model: "gpt-4o",
        role: "Implementer",
        prompt: "implement it",
        tools: [],
      },
    },
    edges: [
      { id: "a-to-b", from: "node-a", to: "node-b" },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWorkflowEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe("initial state", () => {
    it("starts with empty nodes and edges", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      expect(result.current.nodes).toHaveLength(0);
      expect(result.current.edges).toHaveLength(0);
    });

    it("starts with canUndo=false and canRedo=false", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });

    it("starts with isDirty=false", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      expect(result.current.isDirty).toBe(false);
    });

    it("exposes nodeCount and edgeCount", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      expect(result.current.nodeCount).toBe(0);
      expect(result.current.edgeCount).toBe(0);
    });
  });

  // ── addNode ───────────────────────────────────────────────────────────────

  describe("addNode()", () => {
    it("adds a node with the correct archetype defaults", () => {
      const { result } = renderHook(() => useWorkflowEditor());

      act(() => result.current.addNode("planner", { x: 100, y: 200 }));

      expect(result.current.nodes).toHaveLength(1);
      const node = result.current.nodes[0]!;
      expect(node.type).toBe("nodeCard");
      expect(node.position).toEqual({ x: 100, y: 200 });
      // planner archetype defaults
      const data = node.data as Record<string, unknown>;
      expect(data["adapter"]).toBe("claude-sdk");
      expect(data["role"]).toBe("Planner");
    });

    it("increments nodeCount", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      expect(result.current.nodeCount).toBe(1);
    });

    it("sets isDirty=true", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      expect(result.current.isDirty).toBe(true);
    });

    it("enables undo after adding a node", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("reviewer", { x: 0, y: 0 }));
      expect(result.current.canUndo).toBe(true);
    });

    it("generates unique IDs for each node", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => {
        result.current.addNode("custom", { x: 0, y: 0 });
        result.current.addNode("custom", { x: 100, y: 0 });
      });
      const ids = result.current.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  // ── deleteNode ────────────────────────────────────────────────────────────

  describe("deleteNode()", () => {
    it("removes the node from the list", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      const id = result.current.nodes[0]!.id;
      act(() => result.current.deleteNode(id));
      expect(result.current.nodes).toHaveLength(0);
    });

    it("removes edges connected to the deleted node", () => {
      const { result } = renderHook(() => useWorkflowEditor());

      // Add two nodes
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      act(() => result.current.addNode("implementer", { x: 200, y: 0 }));
      const [a, b] = result.current.nodes;

      // Connect them
      act(() =>
        result.current.onConnect({ source: a!.id, target: b!.id, sourceHandle: null, targetHandle: null })
      );
      expect(result.current.edges).toHaveLength(1);

      // Delete one node — edge should be removed
      act(() => result.current.deleteNode(a!.id));
      expect(result.current.edges).toHaveLength(0);
    });

    it("clears selectedNodeId when the selected node is deleted", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      const id = result.current.nodes[0]!.id;
      act(() => result.current.selectNode(id));
      expect(result.current.selectedNodeId).toBe(id);
      act(() => result.current.deleteNode(id));
      expect(result.current.selectedNodeId).toBeNull();
    });
  });

  // ── updateNode ────────────────────────────────────────────────────────────

  describe("updateNode()", () => {
    it("patches the node's role", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      const id = result.current.nodes[0]!.id;

      act(() => result.current.updateNode(id, { role: "Senior Reviewer" }));

      const data = result.current.nodes[0]!.data as Record<string, unknown>;
      expect(data["role"]).toBe("Senior Reviewer");
    });

    it("patches the model without affecting other fields", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      const id = result.current.nodes[0]!.id;
      const originalRole = (result.current.nodes[0]!.data as Record<string, unknown>)["role"];

      act(() => result.current.updateNode(id, { model: "claude-sonnet-4-5" }));

      const data = result.current.nodes[0]!.data as Record<string, unknown>;
      expect(data["model"]).toBe("claude-sonnet-4-5");
      expect(data["role"]).toBe(originalRole); // unchanged
    });
  });

  // ── onConnect / deleteEdge / updateEdge ───────────────────────────────────

  describe("edge operations", () => {
    it("onConnect creates a new edge", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      act(() => result.current.addNode("implementer", { x: 200, y: 0 }));
      const [a, b] = result.current.nodes;

      act(() =>
        result.current.onConnect({ source: a!.id, target: b!.id, sourceHandle: null, targetHandle: null })
      );

      expect(result.current.edges).toHaveLength(1);
      expect(result.current.edges[0]!.source).toBe(a!.id);
      expect(result.current.edges[0]!.target).toBe(b!.id);
    });

    it("onConnect auto-selects the new edge", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      act(() => result.current.addNode("implementer", { x: 200, y: 0 }));
      const [a, b] = result.current.nodes;

      act(() =>
        result.current.onConnect({ source: a!.id, target: b!.id, sourceHandle: null, targetHandle: null })
      );

      expect(result.current.selectedEdgeId).toBe(result.current.edges[0]!.id);
    });

    it("deleteEdge removes the edge", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      act(() => result.current.addNode("implementer", { x: 200, y: 0 }));
      const [a, b] = result.current.nodes;
      act(() =>
        result.current.onConnect({ source: a!.id, target: b!.id, sourceHandle: null, targetHandle: null })
      );
      const edgeId = result.current.edges[0]!.id;

      act(() => result.current.deleteEdge(edgeId));

      expect(result.current.edges).toHaveLength(0);
    });

    it("updateEdge sets isLoopBack styling (amber stroke)", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("planner", { x: 0, y: 0 }));
      act(() => result.current.addNode("implementer", { x: 200, y: 0 }));
      const [a, b] = result.current.nodes;
      act(() =>
        result.current.onConnect({ source: a!.id, target: b!.id, sourceHandle: null, targetHandle: null })
      );
      const edgeId = result.current.edges[0]!.id;

      act(() => result.current.updateEdge(edgeId, { isLoopBack: true, maxRetries: 3 }));

      const edge = result.current.edges[0]!;
      expect((edge.style as Record<string, unknown>)?.["stroke"]).toBe("var(--warning)");
      const stored = (edge.data as Record<string, unknown>)?.["edgeConfig"] as Record<string, unknown>;
      expect(stored?.["isLoopBack"]).toBe(true);
      expect(stored?.["maxRetries"]).toBe(3);
    });
  });

  // ── loadWorkflow / exportWorkflow ─────────────────────────────────────────

  describe("loadWorkflow()", () => {
    it("returns error for invalid JSON", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      const { success, error } = result.current.loadWorkflow("not json");
      expect(success).toBe(false);
      expect(error).toMatch(/invalid json/i);
    });

    it("returns error when 'nodes' field is missing", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      const { success, error } = result.current.loadWorkflow(
        JSON.stringify({ name: "wf", edges: [] })
      );
      expect(success).toBe(false);
      expect(error).toBeTruthy();
    });

    it("populates nodes and edges from a valid workflow", () => {
      const { result } = renderHook(() => useWorkflowEditor());

      let loadResult!: { success: boolean; error?: string };
      act(() => {
        loadResult = result.current.loadWorkflow(makeWorkflowJson());
      });

      expect(loadResult.success).toBe(true);
      expect(result.current.nodes).toHaveLength(2);
      expect(result.current.edges).toHaveLength(1);
    });

    it("sets workflowName from the loaded graph", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => { result.current.loadWorkflow(makeWorkflowJson("my-special-wf")); });
      expect(result.current.workflowName).toBe("my-special-wf");
    });

    it("sets isDirty=false after load", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => { result.current.loadWorkflow(makeWorkflowJson()); });
      expect(result.current.isDirty).toBe(false);
    });
  });

  describe("exportWorkflow()", () => {
    it("exports a valid WorkflowGraph shape after load", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => { result.current.loadWorkflow(makeWorkflowJson("export-test")); });

      const graph = result.current.exportWorkflow();

      expect(graph.version).toBe("1.0");
      expect(graph.name).toBe("export-test");
      expect(Object.keys(graph.nodes)).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.id).toBe("a-to-b");
    });

    it("round-trips node adapter and role", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => { result.current.loadWorkflow(makeWorkflowJson()); });

      const graph = result.current.exportWorkflow();
      expect(graph.nodes["node-a"]?.adapter).toBe("claude-sdk");
      expect(graph.nodes["node-a"]?.role).toBe("Planner");
      expect(graph.nodes["node-b"]?.adapter).toBe("codex");
    });
  });

  // ── Undo / redo ───────────────────────────────────────────────────────────

  describe("undo / redo", () => {
    it("undo after addNode returns to empty state", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      expect(result.current.nodes).toHaveLength(1);

      act(() => result.current.undo());

      expect(result.current.nodes).toHaveLength(0);
    });

    it("redo after undo restores the node", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      act(() => result.current.undo());
      expect(result.current.canRedo).toBe(true);

      act(() => result.current.redo());

      expect(result.current.nodes).toHaveLength(1);
    });

    it("canUndo=false at the beginning of history", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      act(() => result.current.undo());
      expect(result.current.canUndo).toBe(false);
    });

    it("canRedo=false after a new action following undo", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.addNode("custom", { x: 0, y: 0 }));
      act(() => result.current.undo());
      act(() => result.current.addNode("planner", { x: 10, y: 10 }));
      expect(result.current.canRedo).toBe(false);
    });
  });

  // ── Selection ─────────────────────────────────────────────────────────────

  describe("selection", () => {
    it("selectNode sets selectedNodeId and clears selectedEdgeId", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.selectNode("node-1"));
      expect(result.current.selectedNodeId).toBe("node-1");
      expect(result.current.selectedEdgeId).toBeNull();
    });

    it("selectEdge sets selectedEdgeId and clears selectedNodeId", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.selectNode("node-1"));
      act(() => result.current.selectEdge("edge-1"));
      expect(result.current.selectedEdgeId).toBe("edge-1");
      expect(result.current.selectedNodeId).toBeNull();
    });
  });

  // ── setWorkflowName ───────────────────────────────────────────────────────

  describe("setWorkflowName()", () => {
    it("updates workflowName and marks dirty", () => {
      const { result } = renderHook(() => useWorkflowEditor());
      act(() => result.current.setWorkflowName("new-name"));
      expect(result.current.workflowName).toBe("new-name");
      expect(result.current.isDirty).toBe(true);
    });
  });
});
