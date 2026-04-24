import { z, type ZodType } from "zod";

/**
 * Thin wrapper around Zod v4's native `z.toJSONSchema` that preserves Sygil's
 * historical call-site API (`zodToJsonSchema(schema, { $id, title })`).
 *
 * Targets draft-2020-12 (Zod v4 default). The previous hand-rolled converter
 * emitted draft-07; the checked-in `docs/workflow.schema.json` is regenerated
 * via `sygil schema` and the CI drift check keeps it in sync.
 *
 * Field categories authored via `.meta({ category: "..." })` on Zod schemas
 * are rewritten to the JSON-Schema-conventional `x-category` key during the
 * walk below so downstream consumers (editor grouping, ADAPTER_MATRIX docs)
 * can rely on a stable extension prefix.
 */

export type JsonSchema = Record<string, unknown>;

export interface ConvertOptions {
  /** Top-level `$id` URI. */
  $id?: string;
  /** Optional title. */
  title?: string;
}

export function zodToJsonSchema(
  schema: ZodType,
  options: ConvertOptions = {},
): JsonSchema {
  const generated = z.toJSONSchema(schema) as JsonSchema;
  renameCategoryKey(generated);
  return {
    ...generated,
    ...(options.$id !== undefined ? { $id: options.$id } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
  };
}

/**
 * Walk the emitted JSON Schema and rename `category` to `x-category` at every
 * level. Zod v4 copies `.meta()` keys verbatim into the output, so a top-level
 * `category: "core"` emerges as a plain field; the `x-` prefix follows the
 * JSON Schema extension convention and avoids collisions with future spec keys.
 */
function renameCategoryKey(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) renameCategoryKey(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj["category"] === "string" && obj["x-category"] === undefined) {
    obj["x-category"] = obj["category"];
    delete obj["category"];
  }
  for (const value of Object.values(obj)) renameCategoryKey(value);
}
