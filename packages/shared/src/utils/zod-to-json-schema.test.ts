import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { WorkflowGraphSchema } from "../types/workflow.js";

describe("zodToJsonSchema", () => {
  it("converts primitives with checks", () => {
    expect(zodToJsonSchema(z.string().min(1))).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(zodToJsonSchema(z.number().int().positive())).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
    });
    expect(zodToJsonSchema(z.boolean())).toMatchObject({ type: "boolean" });
  });

  it("converts literals and enums", () => {
    expect(zodToJsonSchema(z.literal("x"))).toMatchObject({ const: "x" });
    expect(zodToJsonSchema(z.enum(["a", "b"]))).toMatchObject({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("marks required vs optional fields in objects", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });
    const out = zodToJsonSchema(schema);
    expect(out["type"]).toBe("object");
    expect(out["required"]).toEqual(["name"]);
    expect((out["properties"] as Record<string, unknown>)["age"]).toMatchObject({
      type: "number",
    });
  });

  it("converts arrays with min", () => {
    const out = zodToJsonSchema(z.array(z.string()).min(2));
    expect(out).toMatchObject({
      type: "array",
      items: { type: "string" },
      minItems: 2,
    });
  });

  it("converts records via additionalProperties", () => {
    const out = zodToJsonSchema(z.record(z.number()));
    expect(out).toMatchObject({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  it("converts discriminated unions to anyOf", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), x: z.number() }),
      z.object({ type: z.literal("b"), y: z.string() }),
    ]);
    const out = zodToJsonSchema(schema);
    const anyOf = out["anyOf"] as Array<Record<string, unknown>>;
    expect(anyOf).toHaveLength(2);
    expect((anyOf[0]!["properties"] as Record<string, unknown>)["type"]).toMatchObject({
      const: "a",
    });
  });

  it("unwraps ZodEffects (refine / superRefine)", () => {
    const schema = z
      .object({ n: z.number() })
      .superRefine((v, ctx) => {
        if (v.n < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "neg" });
      });
    const out = zodToJsonSchema(schema);
    expect(out["type"]).toBe("object");
    expect((out["properties"] as Record<string, unknown>)["n"]).toMatchObject({ type: "number" });
  });

  it("emits draft-07 $schema by default", () => {
    const out = zodToJsonSchema(z.object({ x: z.string() }));
    expect(out["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("converts the full WorkflowGraphSchema without throwing", () => {
    const out = zodToJsonSchema(WorkflowGraphSchema, {
      $id: "https://example.com/workflow.schema.json",
      title: "Sygil Workflow",
    });
    expect(out["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(out["$id"]).toContain("workflow.schema.json");
    expect(out["type"]).toBe("object");
    const required = out["required"] as string[];
    expect(required).toContain("version");
    expect(required).toContain("name");
    expect(required).toContain("nodes");
    expect(required).toContain("edges");
  });
});
