import { describe, it, expect } from "vitest";
import type { NodeConfig } from "@sigil/shared";
import { needsIsolation } from "./isolation-check.js";

describe("needsIsolation", () => {
  const BASE_CONFIG: NodeConfig = {
    adapter: "claude-cli",
    model: "claude-sonnet-4-20250514",
    role: "developer",
    prompt: "do something",
  };

  it("returns true when node has file_write tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Read", "file_write"] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns true when node has shell_exec tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["shell_exec"] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns true when node has Edit tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Edit", "Read"] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns true when node has Write tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Write"] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns true when node has Bash tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Bash"] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns false for read-only tools only", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Read", "Grep", "Glob", "WebSearch"] };
    expect(needsIsolation(config)).toBe(false);
  });

  it("defaults to true when tools is undefined", () => {
    const config: NodeConfig = { ...BASE_CONFIG };
    expect(needsIsolation(config)).toBe(true);
  });

  it("defaults to true when tools is empty array", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: [] };
    expect(needsIsolation(config)).toBe(true);
  });

  it("returns true when mixed tools include at least one write tool", () => {
    const config: NodeConfig = { ...BASE_CONFIG, tools: ["Read", "Grep", "Bash", "Glob"] };
    expect(needsIsolation(config)).toBe(true);
  });
});
