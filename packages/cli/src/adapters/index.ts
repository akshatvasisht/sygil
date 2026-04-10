import type { AgentAdapter, AdapterType } from "@sigil/shared";
import { ClaudeSDKAdapter } from "./claude-sdk.js";
import { ClaudeCLIAdapter } from "./claude-cli.js";
import { CodexCLIAdapter } from "./codex-cli.js";
import { CursorCLIAdapter } from "./cursor-cli.js";
import { EchoAdapter } from "./echo.js";

export function getAdapter(type: AdapterType): AgentAdapter {
  switch (type) {
    case "claude-sdk":
      return new ClaudeSDKAdapter();
    case "claude-cli":
      return new ClaudeCLIAdapter();
    case "codex":
      return new CodexCLIAdapter();
    case "cursor":
      return new CursorCLIAdapter();
    case "echo":
      return new EchoAdapter();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown adapter type: ${String(_exhaustive)}`);
    }
  }
}
