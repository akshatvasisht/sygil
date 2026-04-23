import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventStream } from "./EventStream";
import type { WsServerEvent } from "@sygil/shared";

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
    XCircle: icon("x-circle"),
    Eye: icon("eye"),
    CheckSquare: icon("check-square"),
    Zap: icon("zap"),
    Database: icon("database"),
    Webhook: icon("webhook"),
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

  // Four event variants used to fall to the default `return
  // null` branch — every circuit-breaker transition, metrics tick, shared-
  // context write, and hook result was invisible in the monitor UI.
  describe("event variant coverage", () => {
    it("renders circuit_breaker top-level event", () => {
      const events: WsServerEvent[] = [
        {
          type: "circuit_breaker",
          workflowId: "wf-1",
          adapterType: "claude-sdk",
          state: "open",
          reason: "5 failures in 30s",
        },
      ];
      render(<EventStream events={events} />);
      expect(screen.getByText("circuit_breaker")).toBeInTheDocument();
      expect(screen.getByText("claude-sdk")).toBeInTheDocument();
      expect(screen.getByText(/→ open/)).toBeInTheDocument();
    });

    it("metrics_tick renders nothing (intentional — drives MetricsStrip separately)", () => {
      const events: WsServerEvent[] = [
        {
          type: "metrics_tick",
          workflowId: "wf-1",
          data: {
            adapters: {},
            pool: null,
            gates: { passed: 0, failed: 0 },
            inFlightNodes: 0,
          },
        },
      ];
      render(<EventStream events={events} />);
      expect(screen.queryByText(/metrics_tick/)).not.toBeInTheDocument();
    });

    it("renders context_set inner event with key and truncated value", () => {
      const events: WsServerEvent[] = [
        {
          type: "node_event",
          workflowId: "wf-1",
          nodeId: "planner",
          event: {
            type: "context_set",
            key: "plan_approved",
            value: { approved: true, reviewer: "human" },
          },
        },
      ];
      render(<EventStream events={events} />);
      expect(screen.getByText("context_set")).toBeInTheDocument();
      expect(screen.getByText("plan_approved")).toBeInTheDocument();
      expect(screen.getByText(/"reviewer":"human"/)).toBeInTheDocument();
    });

    it("renders hook_result inner event with exit code and duration", () => {
      const events: WsServerEvent[] = [
        {
          type: "node_event",
          workflowId: "wf-1",
          nodeId: "planner",
          event: {
            type: "hook_result",
            hook: "preNode",
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 42,
          },
        },
      ];
      render(<EventStream events={events} />);
      expect(screen.getByText("hook preNode")).toBeInTheDocument();
      expect(screen.getByText(/exit=0/)).toBeInTheDocument();
      expect(screen.getByText(/42ms/)).toBeInTheDocument();
    });

    // The hook tracks `truncatedCount` when the 2000-event cap is exceeded,
    // but without surfacing it the operator has no way to know the view is
    // not complete. Banner renders only when > 0.
    it("renders truncation banner when truncatedCount > 0", () => {
      render(<EventStream events={[]} truncatedCount={1500} />);
      expect(screen.getByText(/1,500 events truncated/)).toBeInTheDocument();
    });

    it("hides truncation banner when truncatedCount is 0", () => {
      render(<EventStream events={[]} truncatedCount={0} />);
      expect(screen.queryByText(/events truncated/)).not.toBeInTheDocument();
    });

    it("hides truncation banner when truncatedCount is omitted", () => {
      render(<EventStream events={[]} />);
      expect(screen.queryByText(/events truncated/)).not.toBeInTheDocument();
    });

    it("renders hook_result in red on non-zero exit", () => {
      const events: WsServerEvent[] = [
        {
          type: "node_event",
          workflowId: "wf-1",
          nodeId: "planner",
          event: {
            type: "hook_result",
            hook: "postNode",
            exitCode: 1,
            stdout: "",
            stderr: "boom",
            durationMs: 17,
          },
        },
      ];
      render(<EventStream events={events} />);
      const label = screen.getByText("hook postNode");
      expect(label).toHaveClass("text-accent-red");
    });
  });
});
