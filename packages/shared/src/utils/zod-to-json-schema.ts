import { z } from "zod";

/**
 * Minimal Zod → JSON-Schema (draft-07) converter sufficient for
 * `WorkflowGraphSchema`. Handles the narrow set of Zod constructs we use:
 * objects, strings, numbers, booleans, arrays, records, enums, literals,
 * discriminated unions, optionals, unknown, and the superRefine/refine
 * wrapper (ZodEffects). Not a general-purpose tool — write tests if you
 * extend it.
 */

export type JsonSchema = Record<string, unknown>;

interface ZodDef {
  typeName: string;
  [key: string]: unknown;
}

function getDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

export interface ConvertOptions {
  /** Top-level $schema URI (default: draft-07). */
  $schema?: string;
  /** Top-level $id. */
  $id?: string;
  /** Optional title. */
  title?: string;
}

export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  options: ConvertOptions = {}
): JsonSchema {
  const root: JsonSchema = {
    $schema: options.$schema ?? "http://json-schema.org/draft-07/schema#",
    ...(options.$id !== undefined ? { $id: options.$id } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...convert(schema),
  };
  return root;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = getDef(schema);

  switch (def.typeName) {
    case "ZodString":
      return convertString(def);
    case "ZodNumber":
      return convertNumber(def);
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral":
      return { const: def["value"] };
    case "ZodEnum":
      return { type: "string", enum: def["values"] as string[] };
    case "ZodNativeEnum": {
      const values = Object.values(def["values"] as Record<string, string | number>);
      return { enum: values };
    }
    case "ZodArray":
      return convertArray(def);
    case "ZodObject":
      return convertObject(schema);
    case "ZodRecord":
      return convertRecord(def);
    case "ZodDiscriminatedUnion":
      return convertDiscriminatedUnion(def);
    case "ZodUnion":
      return convertUnion(def);
    case "ZodOptional":
      return convert(def["innerType"] as z.ZodTypeAny);
    case "ZodNullable": {
      const inner = convert(def["innerType"] as z.ZodTypeAny);
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodDefault":
      return {
        ...convert(def["innerType"] as z.ZodTypeAny),
        default: def["defaultValue"] instanceof Function
          ? (def["defaultValue"] as () => unknown)()
          : def["defaultValue"],
      };
    case "ZodEffects":
      // Unwrap refine / superRefine / transform — JSON Schema can't express custom predicates.
      return convert(def["schema"] as z.ZodTypeAny);
    case "ZodUnknown":
    case "ZodAny":
      return {};
    case "ZodNull":
      return { type: "null" };
    default:
      return {};
  }
}

function convertString(def: ZodDef): JsonSchema {
  const out: JsonSchema = { type: "string" };
  const checks = def["checks"] as Array<{ kind: string; value?: unknown }> | undefined;
  if (!checks) return out;
  for (const check of checks) {
    if (check.kind === "min") out["minLength"] = check.value;
    else if (check.kind === "max") out["maxLength"] = check.value;
    else if (check.kind === "regex") out["pattern"] = String(check.value);
    else if (check.kind === "url") out["format"] = "uri";
    else if (check.kind === "email") out["format"] = "email";
    else if (check.kind === "uuid") out["format"] = "uuid";
  }
  return out;
}

function convertNumber(def: ZodDef): JsonSchema {
  const out: JsonSchema = { type: "number" };
  const checks = def["checks"] as Array<{ kind: string; value?: unknown; inclusive?: boolean }> | undefined;
  if (!checks) return out;
  for (const check of checks) {
    if (check.kind === "int") out["type"] = "integer";
    else if (check.kind === "min") {
      if (check.inclusive === false) out["exclusiveMinimum"] = check.value;
      else out["minimum"] = check.value;
    } else if (check.kind === "max") {
      if (check.inclusive === false) out["exclusiveMaximum"] = check.value;
      else out["maximum"] = check.value;
    }
  }
  return out;
}

function convertArray(def: ZodDef): JsonSchema {
  const out: JsonSchema = {
    type: "array",
    items: convert(def["type"] as z.ZodTypeAny),
  };
  const minLength = def["minLength"] as { value: number } | null | undefined;
  const maxLength = def["maxLength"] as { value: number } | null | undefined;
  if (minLength) out["minItems"] = minLength.value;
  if (maxLength) out["maxItems"] = maxLength.value;
  return out;
}

function convertObject(schema: z.ZodTypeAny): JsonSchema {
  const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    properties[key] = convert(fieldSchema);
    if (!isOptionalLike(fieldSchema)) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out["required"] = required;
  return out;
}

function isOptionalLike(schema: z.ZodTypeAny): boolean {
  const def = getDef(schema);
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") return true;
  if (def.typeName === "ZodEffects") return isOptionalLike(def["schema"] as z.ZodTypeAny);
  return false;
}

function convertRecord(def: ZodDef): JsonSchema {
  const valueType = def["valueType"] as z.ZodTypeAny;
  return { type: "object", additionalProperties: convert(valueType) };
}

function convertDiscriminatedUnion(def: ZodDef): JsonSchema {
  const options = def["options"] as z.ZodTypeAny[];
  return { anyOf: options.map(convert) };
}

function convertUnion(def: ZodDef): JsonSchema {
  const options = def["options"] as z.ZodTypeAny[];
  return { anyOf: options.map(convert) };
}
