/**
 * Tests for the WorkflowEditor Run modal — POST /run wiring.
 *
 * Verifies:
 * - modal renders parameter inputs from workflow.parameters
 * - clicking Run POSTs to /run with workflow + parameters
 * - on 200, navigates to /monitor?run=<runId>&token=<authToken>
 * - on error, shows error message instead of navigating
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// We test RunModal directly since it's an inner component; import it by
// re-rendering the module export. RunModal is not exported, so we'll use
// a mini integration approach by testing via a wrapper that mirrors RunModal's
// props interface.

// Actually: we'll test via stub that mocks fetch + useRouter and renders
// an isolated instance of the modal. Since RunModal is not exported, we need
// to open the WorkflowEditor and trigger it.
//
// Simpler approach: test the modal behavior through a direct re-export stub.
// Since RunModal is unexported, we'll mock the WorkflowEditor entirely and
// just test the modal in isolation via a small helper wrapper.

// We need RunModal – since it's not exported, we'll extract the logic into
// a separate test that simulates its behavior.
// The cleanest way without modifying the source: test via WorkflowEditor
// with all its heavy deps mocked.

// ── Mock heavy deps ──────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const Noop = () => null;
  const Comp = ({ children }: { children?: React.ReactNode }) => <div data-testid="reactflow">{children}</div>;
  return {
    ...actual,
    ReactFlow: Comp,
    Background: Noop,
    Controls: Noop,
    MiniMap: Noop,
    useViewport: () => ({ zoom: 1, x: 0, y: 0 }),
    BaseEdge: Noop,
    getBezierPath: () => ["", 0, 0],
    EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@xyflow/react/dist/style.css", () => ({}));

vi.mock("lucide-react", async () => {
  const { buildLucideIconMocks } = await import("../__mocks__/lucide-react");
  return buildLucideIconMocks([
    ["LayoutGrid", "layout-grid"],
    ["GitBranch", "git-branch"],
    ["Undo2", "undo2"],
    ["Redo2", "redo2"],
    ["Download", "download"],
    ["Play", "play"],
    ["X", "x"],
    ["Terminal", "terminal"],
    ["Copy", "copy"],
    ["Check", "check"],
    ["Workflow", "workflow"],
    ["ChevronLeft", "chevron-left"],
    ["ChevronRight", "chevron-right"],
    ["Keyboard", "keyboard"],
    ["AlertTriangle", "alert-triangle"],
  ]);
});

vi.mock("./NodeCard", () => ({
  NodeCard: () => <div data-testid="node-card" />,
}));

vi.mock("./EdgeGatePanel", () => ({
  EdgeGatePanel: () => <div data-testid="edge-gate-panel" />,
}));

vi.mock("./NodePropertyPanel", () => ({
  NodePropertyPanel: () => <div data-testid="node-property-panel" />,
}));

vi.mock("./NodePalette", () => ({
  NodePalette: () => <div data-testid="node-palette" />,
}));

// ── Mock state ───────────────────────────────────────────────────────────────

const mockRouterPush = vi.fn();

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ──────────────────────────────────────────────────────────────────

import { WorkflowEditor } from "./WorkflowEditor";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WorkflowEditor Run modal", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockFetch.mockClear();
  });

  it("opens when Run button is clicked (edit mode)", async () => {
    render(<WorkflowEditor mode="edit" />);

    const runBtn = screen.getByRole("button", { name: /run workflow/i });
    fireEvent.click(runBtn);

    // Modal header should appear
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows 'no parameters' message for a workflow without parameters", async () => {
    render(<WorkflowEditor mode="edit" />);

    const runBtn = screen.getByRole("button", { name: /run workflow/i });
    fireEvent.click(runBtn);

    expect(screen.getByText(/no parameters/i)).toBeInTheDocument();
  });

  it("POSTs to /run and navigates on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runId: "run-abc123", authToken: "tok-xyz" }),
    });

    render(<WorkflowEditor mode="edit" />);

    // Open modal — toolbar Run button has aria-label "Run workflow"
    const toolbarRunBtn = screen.getByRole("button", { name: /^run workflow$/i });
    fireEvent.click(toolbarRunBtn);

    // Submit the modal form — look for button inside the dialog
    const dialog = screen.getByRole("dialog");
    const submitBtn = dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    fireEvent.click(submitBtn!);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/run",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
        })
      );
    });

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith(
        expect.stringContaining("run-abc123")
      );
    });
    expect(mockRouterPush).toHaveBeenCalledWith(expect.stringContaining("tok-xyz"));
  });

  it("shows error message on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "sygil not in PATH" }),
    });

    render(<WorkflowEditor mode="edit" />);

    const toolbarRunBtn = screen.getByRole("button", { name: /^run workflow$/i });
    fireEvent.click(toolbarRunBtn);

    const dialog = screen.getByRole("dialog");
    const submitBtn = dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(submitBtn!);

    await waitFor(() => {
      expect(screen.getByText(/sygil not in PATH/)).toBeInTheDocument();
    });

    // Should NOT navigate
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
