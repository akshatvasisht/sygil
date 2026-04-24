import { describe, it, expect } from "vitest";
import { isFieldSupported, ADAPTER_FIELD_SUPPORT } from "./adapter-parity.js";
import type { AdapterType } from "./types/workflow.js";

describe("adapter-parity", () => {
  it("isFieldSupported returns 'ignored' for gemini-cli + tools", () => {
    expect(isFieldSupported("gemini-cli", "tools")).toBe("ignored");
  });

  it("isFieldSupported returns 'enforced' for unknown adapter + unknown field (default)", () => {
    // Cast to AdapterType to simulate a future adapter not yet in the union
    expect(isFieldSupported("echo" as AdapterType, "someUnknownField")).toBe("enforced");
  });

  it("every AdapterType in the enum has an entry in ADAPTER_FIELD_SUPPORT", () => {
    const allAdapterTypes: AdapterType[] = [
      "claude-cli",
      "claude-sdk",
      "codex",
      "cursor",
      "gemini-cli",
      "local-oai",
      "echo",
    ];
    for (const adapter of allAdapterTypes) {
      expect(ADAPTER_FIELD_SUPPORT).toHaveProperty(adapter);
    }
  });
});
