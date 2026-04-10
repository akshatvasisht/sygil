import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterType } from "@sigil/shared";

const CONFIG_DIR = ".sigil";
const CONFIG_FILE = "config.json";

export interface SigilConfig {
  version: string;
  adapters: Record<AdapterType, { available: boolean; note?: string }>;
  defaultAdapter: AdapterType | null;
  detectedAt: string;
  telemetry?: { enabled: boolean };
}

function resolveConfigDir(configDir?: string): string {
  if (configDir) return configDir;
  // Allow environment variable override
  if (process.env["SIGIL_CONFIG_DIR"]) return process.env["SIGIL_CONFIG_DIR"];
  return join(process.cwd(), CONFIG_DIR);
}

function configPath(configDir?: string): string {
  return join(resolveConfigDir(configDir), CONFIG_FILE);
}

/** Reads and parses sigil.config.json from the given directory (or default .sigil/). */
export async function readConfig(configDir?: string): Promise<SigilConfig> {
  const raw = await readFile(configPath(configDir), "utf8");
  return JSON.parse(raw) as SigilConfig;
}

/** Writes a SigilConfig to sigil.config.json, creating the directory if needed. */
export async function writeConfig(config: SigilConfig, configDir?: string): Promise<void> {
  const dir = resolveConfigDir(configDir);
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(configDir), JSON.stringify(config, null, 2), "utf8");
}

/** Like readConfig but returns null instead of throwing when the file is absent or invalid. */
export async function readConfigSafe(configDir?: string): Promise<SigilConfig | null> {
  try {
    return await readConfig(configDir);
  } catch {
    return null;
  }
}
