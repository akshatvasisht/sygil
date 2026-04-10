import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeCard, type NodeCardData } from "./NodeCard";

// Mock @xyflow/react Handle component
vi.mock("@xyflow/react", () => ({
  Handle: ({ type, position: _position }: { type: string; position: string }) => (
    <div data-testid={`handle-${type}`} />
  ),
  Position: { Left: "left", Right: "right" },
  memo: (fn: React.FC) => fn,
}));

function makeNodeProps(overrides: Partial<NodeCardData> = {}) {
  const data: NodeCardData = {
    nodeId: "planner-1",
    adapter: "claude-sdk",
    model: "claude-opus-4-5",
    role: "Planner",
    tools: ["Read", "Write"],
    status: "idle",
    ...overrides,
  };
  // NodeCard only uses `data` from NodeProps; other NodeProps fields are not
  // exercised by these unit tests so the cast avoids wiring a full ReactFlow context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only partial props stub
  return { data } as any;
}

describe("NodeCard", () => {
  it("renders node ID text", () => {
    render(<NodeCard {...makeNodeProps()} />);
    expect(screen.getByText("planner-1")).toBeInTheDocument();
  });

  it("renders role text", () => {
    render(<NodeCard {...makeNodeProps({ role: "Senior Reviewer" })} />);
    expect(screen.getByText("Senior Reviewer")).toBeInTheDocument();
  });

  it("renders source and target handles", () => {
    render(<NodeCard {...makeNodeProps()} />);
    expect(screen.getByTestId("handle-source")).toBeInTheDocument();
    expect(screen.getByTestId("handle-target")).toBeInTheDocument();
  });

  it("shows execution metrics when completed with duration", () => {
    render(
      <NodeCard
        {...makeNodeProps({
          executionState: {
            status: "completed",
            durationMs: 2500,
            costUsd: 0.0123,
            attempt: 1,
          },
        })}
      />
    );
    expect(screen.getByText("2.5s")).toBeInTheDocument();
    expect(screen.getByText("$0.0123")).toBeInTheDocument();
  });

  it("shows milliseconds for short durations", () => {
    render(
      <NodeCard
        {...makeNodeProps({
          executionState: {
            status: "completed",
            durationMs: 450,
            attempt: 1,
          },
        })}
      />
    );
    expect(screen.getByText("450ms")).toBeInTheDocument();
  });

  it("does not show metrics when status is running", () => {
    render(
      <NodeCard
        {...makeNodeProps({
          executionState: {
            status: "running",
            durationMs: 1000,
            attempt: 1,
          },
        })}
      />
    );
    // running nodes should not show duration
    expect(screen.queryByText("1.0s")).not.toBeInTheDocument();
  });

  it("shows retry badge when attempt > 1", () => {
    render(
      <NodeCard
        {...makeNodeProps({
          executionState: {
            status: "running",
            attempt: 3,
          },
        })}
      />
    );
    expect(screen.getByText(/attempt 3/)).toBeInTheDocument();
  });

  it("does not show retry badge for attempt 1", () => {
    render(
      <NodeCard
        {...makeNodeProps({
          executionState: {
            status: "running",
            attempt: 1,
          },
        })}
      />
    );
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });
});
