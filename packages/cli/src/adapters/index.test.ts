import { describe, it, expect } from "vitest";
import { getAdapter } from "./index.js";
import { ClaudeSDKAdapter } from "./claude-sdk.js";
import { ClaudeCLIAdapter } from "./claude-cli.js";
import { CodexCLIAdapter } from "./codex-cli.js";
import { CursorCLIAdapter } from "./cursor-cli.js";

describe("getAdapter", () => {
  it("returns a ClaudeSDKAdapter for 'claude-sdk'", () => {
    const adapter = getAdapter("claude-sdk");
    expect(adapter).toBeInstanceOf(ClaudeSDKAdapter);
    expect(adapter.name).toBe("claude-sdk");
  });

  it("returns a ClaudeCLIAdapter for 'claude-cli'", () => {
    const adapter = getAdapter("claude-cli");
    expect(adapter).toBeInstanceOf(ClaudeCLIAdapter);
    expect(adapter.name).toBe("claude-cli");
  });

  it("returns a CodexCLIAdapter for 'codex'", () => {
    const adapter = getAdapter("codex");
    expect(adapter).toBeInstanceOf(CodexCLIAdapter);
    expect(adapter.name).toBe("codex");
  });

  it("returns a CursorCLIAdapter for 'cursor'", () => {
    const adapter = getAdapter("cursor");
    expect(adapter).toBeInstanceOf(CursorCLIAdapter);
    expect(adapter.name).toBe("cursor-cli");
  });

  it("throws for an unknown adapter type", () => {
    // Force a bad type through to test the exhaustive switch default
    expect(() => getAdapter("unknown" as never)).toThrow(/unknown adapter type/i);
  });
});
