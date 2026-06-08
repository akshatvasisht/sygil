import fs from "node:fs/promises";
import path from "node:path";

// ── Structured output validation (Contract v3) ─────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates structured output against a JSON Schema-like object.
 * Uses a lightweight structural check — not a full JSON Schema validator.
 */
export function validateStructuredOutput(
  schema: Record<string, unknown>,
  value: unknown
): ValidationResult {
  if (value === null || value === undefined) {
    return { valid: false, errors: ["Output is null or undefined — expected structured output"] };
  }

  const errors: string[] = [];
  const properties = (schema["properties"] as Record<string, { type?: string; required?: boolean }>) ?? {};
  const required = (schema["required"] as string[]) ?? [];

  if (typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["Output is not an object"] };
  }

  const output = value as Record<string, unknown>;

  for (const field of required) {
    if (!(field in output)) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (!(field in output)) continue;
    const fieldValue = output[field];
    const expectedType = fieldSchema.type;
    if (expectedType) {
      const actualType = Array.isArray(fieldValue) ? "array" : typeof fieldValue;
      if (actualType !== expectedType) {
        errors.push(`Field "${field}": expected ${expectedType}, got ${actualType}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Input mapping resolution (Contract v2) ────────────────────────────────

/**
 * Resolves input mapping from a predecessor node's output directory.
 * Each mapping entry: { "contextVarName": "path/to/file.json#fieldName" }
 * Supports: plain file path (reads whole file as string), or path#field (reads JSON and extracts field).
 */
export interface InputMappingResult {
  resolved: Record<string, string>;
  errors: string[];
}

/**
 * Resolves each entry in `mapping` against `predecessorOutputDir` and returns the
 * extracted string values alongside any accumulated errors.
 *
 * Source syntax per entry value:
 * - `"path/to/file.txt"` — reads the whole file as a UTF-8 string.
 * - `"path/to/file.json#field.nested"` — reads the file as JSON and extracts the
 *   dot-separated field path; missing or non-string values are coerced via `String()`.
 *
 * Errors are accumulated (not thrown): a failed entry contributes an error message and
 * sets the resolved value to `""` so callers always receive a complete `resolved` map.
 */
export async function resolveInputMapping(
  mapping: Record<string, string>,
  predecessorOutputDir: string
): Promise<InputMappingResult> {
  const resolved: Record<string, string> = {};
  const errors: string[] = [];

  for (const [varName, source] of Object.entries(mapping)) {
    const [filePath, fieldPath] = source.split("#");
    if (!filePath) continue;

    const fullPath = path.resolve(predecessorOutputDir, filePath);

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch {
      errors.push(`Failed to resolve '${varName}': file not found at ${fullPath}`);
      resolved[varName] = "";
      continue;
    }

    if (fieldPath) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(content) as Record<string, unknown>;
      } catch {
        errors.push(`Failed to resolve '${varName}': invalid JSON in ${fullPath}`);
        resolved[varName] = "";
        continue;
      }

      const fieldValue = fieldPath.split(".").reduce<unknown>((obj, key) => {
        return (obj && typeof obj === "object") ? (obj as Record<string, unknown>)[key] : undefined;
      }, json);

      if (fieldValue !== undefined) {
        resolved[varName] = String(fieldValue);
      } else {
        errors.push(`Failed to resolve '${varName}': field '${fieldPath}' not found in ${fullPath}`);
        resolved[varName] = "";
      }
    } else {
      resolved[varName] = content;
    }
  }

  return { resolved, errors };
}
