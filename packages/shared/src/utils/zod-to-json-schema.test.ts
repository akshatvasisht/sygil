import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { WorkflowGraphSchema } from "../types/workflow.js";

/**
 * This module is a thin shim over Zod v4's native `z.toJSONSchema`. The
 * pre-v4 hand-rolled converter had exhaustive per-construct tests; the
 * delegation removed the need. These assertions lock in the wrapper
 * contract: end-to-end coverage on the real `WorkflowGraphSchema` plus
 * option pass-through.
 */

describe("zodToJsonSchema", () => {
  it("converts the full WorkflowGraphSchema without throwing", () => {
    const out = zodToJsonSchema(WorkflowGraphSchema);
    expect(out["type"]).toBe("object");
    const properties = out["properties"] as Record<string, unknown>;
    expect(properties).toBeDefined();
    expect(properties["version"]).toBeDefined();
    expect(properties["nodes"]).toBeDefined();
    expect(properties["edges"]).toBeDefined();
    const required = out["required"] as string[];
    expect(required).toContain("version");
    expect(required).toContain("name");
    expect(required).toContain("nodes");
    expect(required).toContain("edges");
  });

  it("passes $id and title through to the output", () => {
    const out = zodToJsonSchema(z.object({ x: z.string() }), {
      $id: "https://example.com/foo.json",
      title: "Foo",
    });
    expect(out["$id"]).toBe("https://example.com/foo.json");
    expect(out["title"]).toBe("Foo");
  });

  it("preserves the $schema uri from the underlying converter", () => {
    const out = zodToJsonSchema(z.object({ x: z.string() }));
    // Zod v4 defaults to draft-2020-12.
    expect(typeof out["$schema"]).toBe("string");
    expect(String(out["$schema"])).toContain("json-schema.org");
  });

  it("produces stable output shape across repeated calls (serialization contract)", () => {
    const a = zodToJsonSchema(WorkflowGraphSchema);
    const b = zodToJsonSchema(WorkflowGraphSchema);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("propagates .describe() text into the output as description", () => {
    const out = zodToJsonSchema(WorkflowGraphSchema);
    const nodeProps = ((out["properties"] as Record<string, unknown>)["nodes"] as Record<string, unknown>);
    const nodeItem = nodeProps["additionalProperties"] as Record<string, unknown>;
    const nodeFieldProps = nodeItem["properties"] as Record<string, Record<string, unknown>>;
    expect(typeof nodeFieldProps["adapter"]!["description"]).toBe("string");
    expect(String(nodeFieldProps["adapter"]!["description"])).toContain("adapter");
  });

  it("rewrites .meta({ category }) to x-category on nested fields", () => {
    const out = zodToJsonSchema(WorkflowGraphSchema);
    const nodeProps = ((out["properties"] as Record<string, unknown>)["nodes"] as Record<string, unknown>);
    const nodeItem = nodeProps["additionalProperties"] as Record<string, unknown>;
    const fieldProps = nodeItem["properties"] as Record<string, Record<string, unknown>>;
    expect(fieldProps["adapter"]!["x-category"]).toBe("core");
    expect(fieldProps["model"]!["x-category"]).toBe("core");
    expect(fieldProps["tools"]!["x-category"]).toBe("contract");
    expect(fieldProps["maxTurns"]!["x-category"]).toBe("limits");
    expect(fieldProps["providers"]!["x-category"]).toBe("resilience");
    expect(fieldProps["writesContext"]!["x-category"]).toBe("context");
    // Raw "category" key is stripped in favor of x-category.
    expect(fieldProps["adapter"]!["category"]).toBeUndefined();
  });
});
