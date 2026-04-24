import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodePropertyPanel } from "./NodePropertyPanel";
import type { NodeCardData } from "./NodeCard";

// Silence react "unused" lint
void React;

function makeData(overrides: Partial<NodeCardData> = {}): NodeCardData {
  return {
    nodeId: "planner",
    adapter: "claude-sdk",
    model: "claude-opus-4-7",
    role: "Planner",
    tools: [],
    status: "idle",
    ...overrides,
  };
}

function renderPanel(overrides: Partial<NodeCardData> = {}) {
  const onUpdate = vi.fn();
  const onDelete = vi.fn();
  const data = makeData(overrides);
  render(
    <NodePropertyPanel
      nodeId="planner"
      config={data}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />
  );
  return { onUpdate, onDelete, data };
}

describe("NodePropertyPanel", () => {
  it("renders the identity section and Raw JSON pane", () => {
    renderPanel();
    expect(screen.getByLabelText("Raw node JSON")).toBeInTheDocument();
  });

  it("Raw JSON reflects the current config live", () => {
    renderPanel({ modelTier: "smart" });
    const pane = screen.getByLabelText("Raw node JSON");
    expect(pane.textContent).toContain('"modelTier": "smart"');
  });

  it("omits executionState from the Raw JSON view", () => {
    renderPanel({ executionState: { status: "running", attempt: 1 } });
    const pane = screen.getByLabelText("Raw node JSON");
    expect(pane.textContent).not.toContain("executionState");
  });

  it("modelTier dropdown round-trips through onUpdate", () => {
    const { onUpdate } = renderPanel();
    const select = screen.getByLabelText(/model tier/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "cheap" } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ modelTier: "cheap" }));
  });

  it("clearing modelTier passes undefined through onUpdate", () => {
    const { onUpdate } = renderPanel({ modelTier: "smart" });
    const select = screen.getByLabelText(/model tier/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ modelTier: undefined }));
  });

  it("writesContext comma-separated input splits on blur", () => {
    const { onUpdate } = renderPanel();
    const input = screen.getByLabelText(/context keys this node writes/i) as HTMLInputElement;
    fireEvent.blur(input, { target: { value: "spec, plan,summary" } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ writesContext: ["spec", "plan", "summary"] }));
  });

  it("readsContext empty value clears the field", () => {
    const { onUpdate } = renderPanel({ readsContext: ["spec"] });
    const input = screen.getByLabelText(/context keys this node reads/i) as HTMLInputElement;
    fireEvent.blur(input, { target: { value: "" } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ readsContext: undefined }));
  });

  it("shows 'N/A for this adapter' on tools when adapter is gemini-cli", () => {
    renderPanel({ adapter: "gemini-cli" });
    // Field support annotation appears wherever a field is ignored/na for the adapter.
    // gemini-cli reports tools as "ignored" in ADAPTER_FIELD_SUPPORT.
    const notes = screen.queryAllByText(/n\/a for this adapter/i);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("does not show the N/A note for claude-sdk (tools enforced)", () => {
    renderPanel({ adapter: "claude-sdk" });
    // claude-sdk enforces most fields; should be zero N/A annotations.
    const notes = screen.queryAllByText(/n\/a for this adapter/i);
    expect(notes.length).toBe(0);
  });
});
