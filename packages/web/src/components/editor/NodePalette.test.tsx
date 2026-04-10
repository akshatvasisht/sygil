import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodePalette } from "./NodePalette";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Upload: () => <span data-testid="upload-icon" />,
  GripVertical: () => <span data-testid="grip-icon" />,
}));

describe("NodePalette", () => {
  const mockOnLoadWorkflow = vi.fn(() => ({ success: true }));

  it("renders all four palette entries", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Implementer")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("renders adapter badge labels", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    // claude-sdk appears twice (planner + reviewer)
    const sdkBadges = screen.getAllByText("claude-sdk");
    expect(sdkBadges).toHaveLength(2);
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("custom")).toBeInTheDocument();
  });

  it("renders description text for entries", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    expect(screen.getByText("Plans, researches, writes specs")).toBeInTheDocument();
    expect(screen.getByText("Writes and edits code")).toBeInTheDocument();
    expect(screen.getByText("Reviews and validates output")).toBeInTheDocument();
    expect(screen.getByText("Configurable agent")).toBeInTheDocument();
  });

  it("renders Load JSON button", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    expect(screen.getByText("Load JSON")).toBeInTheDocument();
  });

  it("palette entries are draggable", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    const planner = screen.getByText("Planner").closest("[draggable]");
    expect(planner).toBeInTheDocument();
    expect(planner!.getAttribute("draggable")).toBe("true");
  });

  it("sets drag data on drag start", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    const planner = screen.getByText("Planner").closest("[draggable]")!;

    const setData = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsdom Event doesn't expose dataTransfer; cast lets us attach a stub
    const event = new Event("dragstart", { bubbles: true }) as any;
    event.dataTransfer = { setData, effectAllowed: "" };

    fireEvent(planner, event);
    expect(setData).toHaveBeenCalledWith("application/sigil-node-type", "planner");
  });

  it("renders the header text", () => {
    render(<NodePalette onLoadWorkflow={mockOnLoadWorkflow} />);
    expect(screen.getByText("Node palette")).toBeInTheDocument();
  });
});
