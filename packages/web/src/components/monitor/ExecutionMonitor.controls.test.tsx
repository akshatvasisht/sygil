/**
 * Component-level tests for ExecutionMonitor's control toolbar.
 *
 * These tests verify:
 * - Pause is enabled when status=running; disabled when status=paused
 * - Resume is enabled when status=paused; disabled when status=running
 * - Cancel is enabled when status=running or paused
 * - Clicking Pause calls sendControl({ type: "pause", workflowId })
 * - All buttons are disabled when authToken is absent (read-only mode)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExecutionMonitor } from "./ExecutionMonitor";
import type { WorkflowRunState } from "@sygil/shared";

// ── Mock lucide-react ─────────────────────────────────────────────────────────

vi.mock("lucide-react", async () => {
  const { buildLucideIconMocks } = await import("../__mocks__/lucide-react");
  return buildLucideIconMocks([
    ["Wifi", "wifi"],
    ["WifiOff", "wifi-off"],
    ["DollarSign", "dollar"],
    ["Clock", "clock"],
    ["Layers", "layers"],
    ["Pause", "pause"],
    ["Play", "play"],
    ["X", "x"],
    ["Loader2", "loader"],
    ["Download", "download"],
    ["ChevronDown", "chevron-down"],
    ["ChevronUp", "chevron-up"],
    ["Clock3", "clock3"],
    ["CheckCircle", "check-circle"],
    ["XCircle", "x-circle"],
    ["Terminal", "terminal"],
  ]);
});

// ── Mock WorkflowEditor (heavy ReactFlow dep) ─────────────────────────────────

vi.mock("@/components/editor/WorkflowEditor", () => ({
  WorkflowEditor: () => <div data-testid="workflow-editor" />,
}));

// ── Mock MetricsStrip ─────────────────────────────────────────────────────────

vi.mock("./MetricsStrip", () => ({
  MetricsStrip: () => null,
}));

// ── Mock NodeTimeline ─────────────────────────────────────────────────────────

vi.mock("./NodeTimeline", () => ({
  NodeTimeline: () => <div data-testid="node-timeline" />,
}));

// ── Mock useWorkflowMonitor ───────────────────────────────────────────────────

const mockSendControl = vi.fn();
const mockReconnect = vi.fn();

let mockWorkflowState: WorkflowRunState | null = null;
let mockStatus = "mock" as "connecting" | "connected" | "disconnected" | "mock";

vi.mock("@/hooks/useWorkflowMonitor", () => ({
  useWorkflowMonitor: () => ({
    status: mockStatus,
    workflowState: mockWorkflowState,
    events: [],
    truncatedCount: 0,
    circuitBreakers: {},
    error: null,
    reconnectAttempt: 0,
    sendControl: mockSendControl,
    reconnect: mockReconnect,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRunState(status: WorkflowRunState["status"]): WorkflowRunState {
  return {
    id: "run-test-1",
    workflowName: "test-workflow",
    workflowPath: "",
    status,
    startedAt: new Date().toISOString(),
    completedNodes: [],
    nodeResults: {},
    totalCostUsd: 0,
    retryCounters: {},
    sharedContext: {},
  };
}

const WORKFLOW_ID = "test-workflow";
const AUTH_TOKEN = "test-auth-token";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ExecutionMonitor — control toolbar", () => {
  beforeEach(() => {
    mockSendControl.mockClear();
    mockReconnect.mockClear();
    mockStatus = "connected";
  });

  describe("status=running", () => {
    beforeEach(() => {
      mockWorkflowState = makeRunState("running");
    });

    it("Pause button is enabled", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const pauseBtn = screen.getByRole("button", { name: /pause workflow/i });
      expect(pauseBtn).not.toBeDisabled();
    });

    it("Resume button is disabled", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const resumeBtn = screen.getByRole("button", { name: /resume paused/i });
      expect(resumeBtn).toBeDisabled();
    });

    it("Cancel button is enabled", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const cancelBtn = screen.getByRole("button", { name: /cancel workflow/i });
      expect(cancelBtn).not.toBeDisabled();
    });

    it("clicking Pause calls sendControl({ type: 'pause', workflowId })", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const pauseBtn = screen.getByRole("button", { name: /pause workflow/i });
      fireEvent.click(pauseBtn);
      expect(mockSendControl).toHaveBeenCalledWith({
        type: "pause",
        workflowId: WORKFLOW_ID,
      });
    });
  });

  describe("status=paused", () => {
    beforeEach(() => {
      mockWorkflowState = makeRunState("paused");
    });

    it("Pause button is disabled", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const pauseBtn = screen.getByRole("button", { name: /pause workflow/i });
      expect(pauseBtn).toBeDisabled();
    });

    it("Resume button is enabled", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const resumeBtn = screen.getByRole("button", { name: /resume paused/i });
      expect(resumeBtn).not.toBeDisabled();
    });

    it("clicking Resume calls sendControl({ type: 'resume_workflow', workflowId })", () => {
      render(
        <ExecutionMonitor
          wsUrl={`ws://localhost:9000/?token=${AUTH_TOKEN}`}
          workflowId={WORKFLOW_ID}
          authToken={AUTH_TOKEN}
        />
      );
      const resumeBtn = screen.getByRole("button", { name: /resume paused/i });
      fireEvent.click(resumeBtn);
      expect(mockSendControl).toHaveBeenCalledWith({
        type: "resume_workflow",
        workflowId: WORKFLOW_ID,
      });
    });
  });

  describe("no authToken (read-only mode)", () => {
    beforeEach(() => {
      mockWorkflowState = makeRunState("running");
    });

    it("all control buttons are disabled when no authToken", () => {
      render(
        <ExecutionMonitor
          wsUrl="ws://localhost:9000/"
          workflowId={WORKFLOW_ID}
        />
      );
      // When unauthenticated, all control buttons have aria-label pointing to the read-only tooltip
      const allReadOnly = screen.getAllByRole("button", { name: /read-only.*enable controls/i });
      expect(allReadOnly.length).toBeGreaterThanOrEqual(2); // at least Pause and Cancel
      for (const btn of allReadOnly) {
        expect(btn).toBeDisabled();
      }
    });

    it("sendControl is not called when buttons are clicked without auth", () => {
      render(
        <ExecutionMonitor
          wsUrl="ws://localhost:9000/"
          workflowId={WORKFLOW_ID}
        />
      );
      const allReadOnly = screen.getAllByRole("button", { name: /read-only.*enable controls/i });
      for (const btn of allReadOnly) {
        fireEvent.click(btn);
      }
      expect(mockSendControl).not.toHaveBeenCalled();
    });
  });
});
