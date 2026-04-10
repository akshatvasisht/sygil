import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventStream } from "./EventStream";
import type { WsServerEvent } from "@sigil/shared";

// Mock lucide-react icons to simple spans
vi.mock("lucide-react", () => {
  const icon = (name: string) => {
    const Comp = (_props: Record<string, unknown>) => <span data-testid={`icon-${name}`} />;
    Comp.displayName = name;
    return Comp;
  };
  return {
    Wrench: icon("wrench"),
    FileText: icon("file-text"),
    Terminal: icon("terminal"),
    Type: icon("type"),
    DollarSign: icon("dollar"),
    AlertTriangle: icon("alert-triangle"),
    AlertCircle: icon("alert-circle"),
    GitBranch: icon("git-branch"),
    Play: icon("play"),
    CheckCircle2: icon("check-circle"),
  };
});

describe("EventStream", () => {
  it("renders 'Event log' header", () => {
    render(<EventStream events={[]} />);
    expect(screen.getByText("Event log")).toBeInTheDocument();
  });

  it("renders filter buttons", () => {
    render(<EventStream events={[]} />);
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Shell")).toBeInTheDocument();
  });

  it("renders workflow_start event", () => {
    const events: WsServerEvent[] = [
      {
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "test", nodes: {}, edges: [] },
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("workflow_start")).toBeInTheDocument();
    expect(screen.getByText("wf-1")).toBeInTheDocument();
  });

  it("renders node_start event", () => {
    const events: WsServerEvent[] = [
      {
        type: "node_start",
        workflowId: "wf-1",
        nodeId: "planner",
        config: {
          adapter: "claude-sdk",
          model: "claude-opus-4-5",
          role: "Planner",
          prompt: "",
        },
        attempt: 1,
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("node_start")).toBeInTheDocument();
    expect(screen.getByText("planner")).toBeInTheDocument();
  });

  it("renders node_end event with duration", () => {
    const events: WsServerEvent[] = [
      {
        type: "node_end",
        workflowId: "wf-1",
        nodeId: "planner",
        result: { output: "done", exitCode: 0, durationMs: 2500, costUsd: 0.012 },
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("node_end")).toBeInTheDocument();
    expect(screen.getByText("2.5s")).toBeInTheDocument();
    expect(screen.getByText("$0.012")).toBeInTheDocument();
  });

  it("renders tool_call node_event", () => {
    const events: WsServerEvent[] = [
      {
        type: "node_event",
        workflowId: "wf-1",
        nodeId: "planner",
        event: { type: "tool_call", tool: "Read", input: { path: "file.ts" } },
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("renders gate_eval event with passed status", () => {
    const events: WsServerEvent[] = [
      {
        type: "gate_eval",
        workflowId: "wf-1",
        edgeId: "edge-1",
        passed: true,
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("gate_eval")).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
  });

  it("renders gate_eval event with failed status", () => {
    const events: WsServerEvent[] = [
      {
        type: "gate_eval",
        workflowId: "wf-1",
        edgeId: "edge-1",
        passed: false,
        reason: "exit code mismatch",
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("(exit code mismatch)")).toBeInTheDocument();
  });

  it("renders workflow_end event", () => {
    const events: WsServerEvent[] = [
      {
        type: "workflow_end",
        workflowId: "wf-1",
        success: true,
        durationMs: 5000,
        totalCostUsd: 0.055,
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("workflow_end")).toBeInTheDocument();
    expect(screen.getByText("5.0s total")).toBeInTheDocument();
    expect(screen.getByText("$0.055 total")).toBeInTheDocument();
  });

  it("renders loop_back event", () => {
    const events: WsServerEvent[] = [
      {
        type: "loop_back",
        workflowId: "wf-1",
        edgeId: "edge-loop",
        attempt: 2,
        maxRetries: 3,
      },
    ];
    render(<EventStream events={events} />);
    expect(screen.getByText("loop_back")).toBeInTheDocument();
    expect(screen.getByText("attempt 2/3")).toBeInTheDocument();
  });

  it("filters to system events only", () => {
    const events: WsServerEvent[] = [
      {
        type: "workflow_start",
        workflowId: "wf-1",
        graph: { version: "1", name: "test", nodes: {}, edges: [] },
      },
      {
        type: "node_event",
        workflowId: "wf-1",
        nodeId: "planner",
        event: { type: "tool_call", tool: "Read", input: {} },
      },
    ];
    render(<EventStream events={events} />);

    // Click "System" filter
    fireEvent.click(screen.getByText("System"));

    // workflow_start is a system event
    expect(screen.getByText("workflow_start")).toBeInTheDocument();
    // tool_call should be filtered out
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
  });

  it("renders empty state with no events", () => {
    render(<EventStream events={[]} />);
    // With no events, none of the event-specific content should render
    expect(screen.queryByText(/tool_call/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/text_delta/i)).not.toBeInTheDocument();
  });
});
