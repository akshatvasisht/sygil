import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  NodeTimeline,
  type NodeTimelineEntry,
  type HumanReviewTimelineEntry,
} from "./NodeTimeline";

// Mock lucide-react icons
vi.mock("lucide-react", () => {
  const icon = (name: string) => {
    const Comp = (_props: Record<string, unknown>) => <span data-testid={`icon-${name}`} />;
    Comp.displayName = name;
    return Comp;
  };
  return {
    CheckCircle2: icon("check-circle"),
    Circle: icon("circle"),
    XCircle: icon("x-circle"),
    Loader2: icon("loader"),
    ChevronDown: icon("chevron-down"),
    ChevronRight: icon("chevron-right"),
    FileText: icon("file-text"),
    Terminal: icon("terminal"),
    Wrench: icon("wrench"),
    AlertTriangle: icon("alert-triangle"),
    DollarSign: icon("dollar"),
    Clock3: icon("clock"),
    Snowflake: icon("snowflake"),
    Ban: icon("ban"),
    Clock: icon("clock-icon"),
    ArrowRight: icon("arrow-right"),
    Database: icon("database"),
    Webhook: icon("webhook"),
  };
});

function makeEntry(overrides: Partial<NodeTimelineEntry> = {}): NodeTimelineEntry {
  return {
    nodeId: "planner",
    adapter: "claude-sdk",
    status: "completed",
    startedAt: "2025-01-15T10:42:00Z",
    completedAt: "2025-01-15T10:42:04Z",
    durationMs: 4200,
    attempt: 1,
    costUsd: 0.014,
    events: [],
    ...overrides,
  };
}

function makeHumanReviewEntry(
  overrides: Partial<HumanReviewTimelineEntry> = {}
): HumanReviewTimelineEntry {
  return {
    nodeId: "human-review-edge-1",
    adapter: "human-review",
    status: "awaiting",
    startedAt: "2025-01-15T10:42:10Z",
    attempt: 1,
    edgeId: "edge-1",
    prompt: "Approve this output?",
    events: [] as never[],
    ...overrides,
  };
}

describe("NodeTimeline", () => {
  it("renders the 'Node timeline' header", () => {
    render(
      <NodeTimeline entries={[]} selectedNodeId={null} onSelectNode={vi.fn()} />
    );
    expect(screen.getByText("Node timeline")).toBeInTheDocument();
  });

  it("renders node entries with their IDs", () => {
    const entries = [
      makeEntry({ nodeId: "planner" }),
      makeEntry({ nodeId: "implementer", adapter: "codex" }),
    ];
    render(
      <NodeTimeline entries={entries} selectedNodeId={null} onSelectNode={vi.fn()} />
    );
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("implementer")).toBeInTheDocument();
  });

  it("shows adapter name", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ adapter: "codex" })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("shows formatted duration", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ durationMs: 4200 })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("4.2s")).toBeInTheDocument();
  });

  it("shows duration in ms for short tasks", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ durationMs: 500 })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("500ms")).toBeInTheDocument();
  });

  it("shows cost", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ costUsd: 0.014 })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("$0.014")).toBeInTheDocument();
  });

  it("shows attempt badge for retry attempts > 1", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ attempt: 2 })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("attempt 2")).toBeInTheDocument();
  });

  it("does not show attempt badge for attempt 1", () => {
    render(
      <NodeTimeline
        entries={[makeEntry({ attempt: 1 })]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  it("renders human review entry", () => {
    render(
      <NodeTimeline
        entries={[makeHumanReviewEntry()]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    );
    expect(screen.getByText("Awaiting human review")).toBeInTheDocument();
    expect(screen.getByText("Approve this output?")).toBeInTheDocument();
  });

  it("calls onSelectNode when clicking a node row", () => {
    const onSelectNode = vi.fn();
    render(
      <NodeTimeline
        entries={[makeEntry({ nodeId: "planner" })]}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />
    );

    fireEvent.click(screen.getByText("planner"));
    expect(onSelectNode).toHaveBeenCalledWith("planner");
  });

  it("deselects node when clicking the selected node", () => {
    const onSelectNode = vi.fn();
    render(
      <NodeTimeline
        entries={[makeEntry({ nodeId: "planner" })]}
        selectedNodeId="planner"
        onSelectNode={onSelectNode}
      />
    );

    fireEvent.click(screen.getByText("planner"));
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });

  it("renders gate passed connector between nodes", () => {
    const entries = [
      makeEntry({ nodeId: "planner", status: "completed" }),
      makeEntry({ nodeId: "implementer", status: "running" }),
    ];
    render(
      <NodeTimeline entries={entries} selectedNodeId={null} onSelectNode={vi.fn()} />
    );
    expect(screen.getByText(/gate: passed/)).toBeInTheDocument();
  });

  it("shows events when a node is expanded", () => {
    const entries = [
      makeEntry({
        nodeId: "my-node",
        events: [
          { type: "tool_call", tool: "Edit", input: { path: "foo.ts" } },
          { type: "shell_exec", command: "npm test", exitCode: 0 },
        ],
      }),
    ];
    render(
      <NodeTimeline entries={entries} selectedNodeId={null} onSelectNode={vi.fn()} />
    );

    // Click to expand (my-node is not in default expanded set)
    fireEvent.click(screen.getByText("my-node"));

    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  // Per-node expanded detail used to drop five AgentEvent
  // variants silently. Operators expanding a node row didn't see retries,
  // failovers, stalls, shared-context writes, or hook results even though
  // those events were already in the entry's `events` array.
  describe("EventBadge variant coverage", () => {
    it("renders stall, adapter_failover, retry_scheduled, context_set, hook_result badges", () => {
      const entries = [
        makeEntry({
          nodeId: "all-events",
          events: [
            { type: "stall", reason: "no output for 30s" },
            {
              type: "adapter_failover",
              fromAdapter: "claude-sdk",
              toAdapter: "claude-cli",
              reason: "transport",
            },
            {
              type: "retry_scheduled",
              attempt: 1,
              nextAttempt: 2,
              delayMs: 5000,
              reason: "server_5xx",
            },
            { type: "context_set", key: "review_passed", value: true },
            {
              type: "hook_result",
              hook: "preNode",
              exitCode: 0,
              stdout: "",
              stderr: "",
              durationMs: 12,
            },
          ],
        }),
      ];
      render(
        <NodeTimeline entries={entries} selectedNodeId={null} onSelectNode={vi.fn()} />
      );
      fireEvent.click(screen.getByText("all-events"));

      expect(screen.getByText(/stalled: no output for 30s/)).toBeInTheDocument();
      expect(screen.getByText(/claude-sdk → claude-cli/)).toBeInTheDocument();
      expect(screen.getByText(/retry 2 in 5000ms/)).toBeInTheDocument();
      expect(screen.getByText("review_passed")).toBeInTheDocument();
      expect(screen.getByText("hook preNode")).toBeInTheDocument();
    });
  });

  // Status union now includes `cached` and `cancelled` so
  // cache hits and aborted runs are visually distinct from genuine completion
  // or adapter failure.
  describe("status union coverage", () => {
    it("renders a cached node with distinct styling", () => {
      render(
        <NodeTimeline
          entries={[makeEntry({ nodeId: "memoed", status: "cached" })]}
          selectedNodeId={null}
          onSelectNode={vi.fn()}
        />
      );
      const label = screen.getByText("memoed");
      expect(label).toHaveClass("text-accent-cyan");
      expect(screen.getByTestId("icon-snowflake")).toBeInTheDocument();
    });

    it("renders a cancelled node with distinct styling", () => {
      render(
        <NodeTimeline
          entries={[makeEntry({ nodeId: "aborted", status: "cancelled" })]}
          selectedNodeId={null}
          onSelectNode={vi.fn()}
        />
      );
      const label = screen.getByText("aborted");
      expect(label).toHaveClass("line-through");
      expect(screen.getByTestId("icon-ban")).toBeInTheDocument();
    });
  });
});
