import { z, type ZodType } from "zod";

/**
 * Thin wrapper around Zod v4's native `z.toJSONSchema` that preserves Sygil's
 * historical call-site API (`zodToJsonSchema(schema, { $id, title })`).
 *
 * Targets draft-2020-12 (Zod v4 default). The previous hand-rolled converter
 * emitted draft-07; the checked-in `docs/workflow.schema.json` is regenerated
 * via `sygil schema` and the CI drift check keeps it in sync.
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
  return {
    ...generated,
    ...(options.$id !== undefined ? { $id: options.$id } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
  };
}
