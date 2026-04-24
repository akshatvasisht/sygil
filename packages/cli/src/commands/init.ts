import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { AdapterType } from "@sygil/shared";

interface AdapterStatus {
  available: boolean;
  note?: string;
  version?: string;
}

async function checkClaudeSDK(): Promise<AdapterStatus> {
  try {
    // Try to resolve the package — it may not be installed
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- optional peer dep may be absent
    // @ts-ignore -- optional peer dep
    await import("@anthropic-ai/claude-agent-sdk");
    const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"]);
    if (!hasKey) {
      return { available: false, note: "ANTHROPIC_API_KEY not set" };
    }
    // Try to read the installed package version
    let version: string | undefined;
    const searchPaths = [
      join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
      // workspace root
      join(process.cwd(), "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    ];
    for (const p of searchPaths) {
      try {
        const raw = await readFile(p, "utf8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) {
          version = pkg.version;
          break;
        }
      } catch {
        // try next
      }
    }
    return { available: true, ...(version !== undefined ? { version } : {}) };
  } catch {
    return { available: false, note: "package not installed" };
  }
}

function getBinaryVersion(binary: string): string | undefined {
  try {
    const out = execSync(`${binary} --version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function checkBinaryInPath(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function probeLocalOai(): Promise<boolean> {
  const baseUrl =
    process.env["SYGIL_LOCAL_OAI_URL"]?.replace(/\/+$/, "") ?? "http://localhost:11434/v1";
  const apiKey = process.env["SYGIL_LOCAL_OAI_KEY"] ?? "ollama";
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface InitOptions {
  telemetry?: boolean;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log(chalk.bold("\nSigil — adapter detection\n"));

  const claudeCliAvailable = checkBinaryInPath("claude");
  const codexAvailable = checkBinaryInPath("codex");

  const CURSOR_CREDENTIAL_PATHS = [".cursor/credentials.json", ".cursor/auth.json"];
  const cursorAvailable =
    checkBinaryInPath("agent") &&
    (Boolean(process.env["CURSOR_API_KEY"]) ||
      CURSOR_CREDENTIAL_PATHS.some((p) => existsSync(join(homedir(), p))));

  const geminiBinary = checkBinaryInPath("gemini");
  const geminiAuth =
    Boolean(process.env["GEMINI_API_KEY"]) ||
    existsSync(join(homedir(), ".gemini")) ||
    existsSync(join(homedir(), ".config/gemini"));
  const geminiAvailable = geminiBinary && geminiAuth;

  const localOaiAvailable = await probeLocalOai();

  const results: Record<AdapterType, AdapterStatus & { label: string }> = {
    "claude-sdk": {
      ...(await checkClaudeSDK()),
      label: "Claude Agent SDK (@anthropic-ai/claude-agent-sdk)",
    },
    "claude-cli": {
      available: claudeCliAvailable,
      ...(claudeCliAvailable ? { version: getBinaryVersion("claude") } : {}),
      label: "Claude Code CLI (claude)",
    } as AdapterStatus & { label: string },
    codex: {
      available: codexAvailable,
      ...(codexAvailable ? { version: getBinaryVersion("codex") } : {}),
      label: "Codex CLI (codex)",
    } as AdapterStatus & { label: string },
    cursor: {
      available: cursorAvailable,
      ...(cursorAvailable ? { version: getBinaryVersion("agent") } : {}),
      label: "Cursor Agent (agent binary)",
    } as AdapterStatus & { label: string },
    echo: {
      available: true,
      label: "Echo (test-only stub adapter)",
    },
    "gemini-cli": {
      available: geminiAvailable,
      ...(geminiBinary ? { version: getBinaryVersion("gemini") } : {}),
      ...(geminiBinary && !geminiAuth
        ? { note: "gemini binary found but no GEMINI_API_KEY or ~/.gemini" }
        : {}),
      label: "Gemini CLI (gemini)",
    } as AdapterStatus & { label: string },
    "local-oai": {
      available: localOaiAvailable,
      ...(localOaiAvailable
        ? {}
        : { note: "no OpenAI-compatible server at localhost:11434 (set SYGIL_LOCAL_OAI_URL)" }),
      label: "Local OpenAI-compatible (Ollama / llama.cpp / vLLM / LM Studio)",
    } as AdapterStatus & { label: string },
  };

  const availableAdapters: AdapterType[] = [];

  for (const [key, status] of Object.entries(results) as [
    AdapterType,
    (typeof results)[AdapterType],
  ][]) {
    const icon = status.available
      ? chalk.green("✓")
      : chalk.red("✗");
    const name = status.available
      ? chalk.green(status.label)
      : chalk.dim(status.label);
    const versionStr = status.available
      ? status.version
        ? chalk.dim(` — v${status.version.replace(/^v/, "")}`)
        : chalk.dim(" (version unknown)")
      : "";
    const note = status.note ? chalk.yellow(` (${status.note})`) : "";
    console.log(`  ${icon} ${name}${versionStr}${note}`);

    if (status.available) {
      availableAdapters.push(key);
    }
  }

  // Determine default adapter preference order
  const preferenceOrder: AdapterType[] = [
    "claude-sdk",
    "claude-cli",
    "codex",
    "cursor",
    "gemini-cli",
    "local-oai",
  ];
  const defaultAdapter =
    preferenceOrder.find((a) => availableAdapters.includes(a)) ?? null;

  // Read the existing config once — we need it both for carrying forward
  // telemetry and for preserving hand-authored tiers/hooks. A missing
  // file is expected on first run; a present-but-corrupt file is not —
  // surface a warning so users know their tiers/hooks weren't preserved.
  const existing = await readConfig(process.env["SYGIL_CONFIG_DIR"]).catch((err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(
        `Existing .sygil/config.json is unreadable (${err instanceof Error ? err.message : String(err)}); proceeding with fresh defaults. Hand-authored tiers/hooks will NOT be preserved.`,
      );
    }
    return null;
  });

  // Preserve existing telemetry config if no flag was passed
  let telemetryConfig: { enabled: boolean } | undefined;
  if (options.telemetry === true) {
    telemetryConfig = { enabled: true };
  } else if (options.telemetry === false) {
    telemetryConfig = { enabled: false };
  } else {
    // No flag — carry forward whatever is already in config
    telemetryConfig = existing?.telemetry;
  }

  const config = {
    version: "1",
    adapters: Object.fromEntries(
      Object.entries(results).map(([key, val]) => [
        key,
        { available: val.available, note: val.note },
      ])
    ) as Record<AdapterType, { available: boolean; note?: string }>,
    defaultAdapter,
    detectedAt: new Date().toISOString(),
    ...(telemetryConfig !== undefined ? { telemetry: telemetryConfig } : {}),
    ...(existing?.tiers !== undefined ? { tiers: existing.tiers } : {}),
    ...(existing?.hooks !== undefined ? { hooks: existing.hooks } : {}),
  };

  await writeConfig(config, process.env["SYGIL_CONFIG_DIR"]);

  console.log("");

  if (defaultAdapter) {
    console.log(
      `${chalk.bold("Default adapter:")} ${chalk.cyan(defaultAdapter)}`
    );
  } else {
    console.log(
      chalk.yellow(
        "No adapters available. Install claude-cli or codex, or set ANTHROPIC_API_KEY."
      )
    );
  }

  const configDirDisplay = process.env["SYGIL_CONFIG_DIR"] ?? ".sygil";
  console.log(
    `\n${chalk.dim("Config written to")} ${chalk.cyan(`${configDirDisplay}/config.json`)}\n`
  );

  // Next steps hint
  if (availableAdapters.length === 0) {
    console.log(
      chalk.bold.red(
        "No adapters are available. Install at least one (e.g., `npm install -g @anthropic-ai/claude-code` and set ANTHROPIC_API_KEY) before exporting a template."
      )
    );
    console.log("");
  }

  console.log(chalk.dim("Next steps:"));
  console.log(`  ${chalk.cyan("sygil export tdd-feature ./workflow.json")}  ${chalk.dim("# export a bundled template")}`);
  console.log(`  ${chalk.cyan('sygil run ./workflow.json "your task here"')}  ${chalk.dim("# run it")}`);
  console.log("");

  // Print telemetry status message
  if (options.telemetry === true) {
    console.log(
      chalk.green(
        "Telemetry enabled. Anonymous usage metrics will be sent. No code, prompts, or file paths are ever collected."
      )
    );
    console.log(
      chalk.dim('To disable: remove the "telemetry" field from .sygil/config.json')
    );
    console.log("");
  } else if (options.telemetry === false) {
    console.log(chalk.dim("Telemetry disabled."));
    console.log("");
  } else {
    console.log(
      chalk.dim(
        "Telemetry is disabled by default. Run 'sygil init --telemetry' to enable anonymous usage metrics."
      )
    );
    console.log("");
  }
}
