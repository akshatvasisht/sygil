import { describe, it, expect } from "vitest";
import {
  validateTools,
  validateWorkflowTools,
  ADAPTER_TOOL_CATALOG,
} from "./tool-validator.js";
import type { NodeConfig } from "../types/workflow.js";

function node(over: Partial<NodeConfig>): NodeConfig {
  return {
    adapter: "claude-cli",
    model: "claude-opus-4-7",
    role: "worker",
    prompt: "hello",
    ...over,
  };
}

describe("validateTools", () => {
  it("returns null for nodes without tools", () => {
    expect(validateTools("n", node({}))).toBeNull();
  });

  it("returns null for empty tools list", () => {
    expect(validateTools("n", node({ tools: [] }))).toBeNull();
  });

  it("accepts catalog-listed claude-cli tools silently", () => {
    const result = validateTools("n", node({ tools: ["Read", "Write", "Bash"] }));
    expect(result).toBeNull();
  });

  it("flags unknown tools on claude-cli", () => {
    const result = validateTools(
      "n",
      node({ tools: ["Read", "UnknownThing"] })
    );
    expect(result).not.toBeNull();
    expect(result!.unknownTools).toEqual(["UnknownThing"]);
    expect(result!.message).toContain("claude-cli");
    expect(result!.message).toContain("UnknownThing");
  });

  it("passes through MCP-prefixed tools unchallenged", () => {
    const result = validateTools(
      "n",
      node({ tools: ["Read", "mcp__playwright__screenshot"] })
    );
    expect(result).toBeNull();
  });

  it("returns null for wildcard adapters (local-oai, echo)", () => {
    const local = validateTools(
      "n",
      node({ adapter: "local-oai", tools: ["anything", "whatever"] })
    );
    expect(local).toBeNull();

    const echo = validateTools(
      "n",
      node({ adapter: "echo", tools: ["Write"] })
    );
    expect(echo).toBeNull();
  });

  it("catalog advertises gemini-cli's lowercase tool names", () => {
    const catalog = ADAPTER_TOOL_CATALOG["gemini-cli"]!;
    expect(catalog.has("read_file")).toBe(true);
    expect(catalog.has("write_file")).toBe(true);
    // Should NOT match claude-cli's PascalCase names for gemini.
    const result = validateTools(
      "n",
      node({ adapter: "gemini-cli", tools: ["Read"] })
    );
    expect(result).not.toBeNull();
    expect(result!.unknownTools).toEqual(["Read"]);
  });
});

describe("validateWorkflowTools", () => {
  it("emits one warning per node with unknown tools", () => {
    const warnings = validateWorkflowTools({
      a: node({ tools: ["Read"] }),
      b: node({ adapter: "gemini-cli", tools: ["Typo1"] }),
      c: node({ adapter: "codex", tools: ["NotATool"] }),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.nodeId).sort()).toEqual(["b", "c"]);
  });

  it("returns empty array when all nodes are clean", () => {
    const warnings = validateWorkflowTools({
      a: node({ tools: ["Read", "Bash"] }),
      b: node({ adapter: "local-oai", tools: ["anything"] }),
    });
    expect(warnings).toEqual([]);
  });
});
