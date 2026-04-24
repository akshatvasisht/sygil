import type { AdapterType } from "./types/workflow.js";

export type FieldSupport = "enforced" | "partial" | "ignored" | "na";

/**
 * Which NodeConfig fields each adapter honors at runtime. Consumed by:
 *  - sygil run pre-flight: warn when a node uses a field its adapter ignores.
 *  - web editor NodePropertyPanel: grey out / annotate fields not applicable
 *    to the selected adapter.
 *  - docs/ADAPTER_MATRIX.md: hand-authored mirror of this table.
 *
 * Missing keys default to "enforced" for fields every adapter handles uniformly
 * (adapter, model, role, prompt, maxTurns, timeoutMs, idleTimeoutMs).
 */
export const ADAPTER_FIELD_SUPPORT: Record<AdapterType, Partial<Record<string, FieldSupport>>> = {
  "claude-cli": {
    tools: "enforced", disallowedTools: "enforced",
    sandbox: "partial", outputSchema: "partial",
    providers: "enforced", maxBudgetUsd: "enforced",
  },
  "claude-sdk": {
    tools: "enforced", disallowedTools: "enforced",
    sandbox: "na", outputSchema: "enforced",
    providers: "enforced", maxBudgetUsd: "enforced",
  },
  codex: {
    tools: "ignored", disallowedTools: "ignored",
    sandbox: "enforced", outputSchema: "partial",
    maxBudgetUsd: "partial", maxTurns: "ignored",
  },
  cursor: {
    tools: "ignored", disallowedTools: "ignored",
    sandbox: "enforced", outputSchema: "partial",
    maxTurns: "ignored",
  },
  "gemini-cli": {
    tools: "ignored", disallowedTools: "ignored",
    sandbox: "na", outputSchema: "partial",
    maxTurns: "ignored",
  },
  "local-oai": {
    tools: "enforced", disallowedTools: "enforced",
    sandbox: "na", outputSchema: "enforced",
    maxBudgetUsd: "ignored",
  },
  echo: {},
};

export function isFieldSupported(adapter: AdapterType, field: string): FieldSupport {
  return ADAPTER_FIELD_SUPPORT[adapter]?.[field] ?? "enforced";
}
