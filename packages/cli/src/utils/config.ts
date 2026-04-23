import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterType, ModelTier } from "@sygil/shared";
import { writeFileAtomic } from "./atomic-write.js";
import { logger } from "./logger.js";

const CONFIG_DIR = ".sygil";
const CONFIG_FILE = "config.json";

/**
 * Lifecycle hook paths. Each value is a path to an executable
 * script relative to the project working directory. Hooks run out-of-band
 * at the listed scheduler lifecycle points; see `packages/cli/src/hooks/hook-runner.ts`.
 */
export interface HooksConfig {
  preNode?: string;
  postNode?: string;
  preGate?: string;
  postGate?: string;
}

export interface SygilConfig {
  version: string;
  adapters: Record<AdapterType, { available: boolean; note?: string }>;
  defaultAdapter: AdapterType | null;
  detectedAt: string;
  telemetry?: { enabled: boolean };
  /**
   * Static model-tier mapping. Each key is a `ModelTier` name;
   * the value is the concrete model ID that substitutes for a node's
   * `model` field at workflow-load time when `modelTier` is set. Absent
   * keys cause the original `model` value to be used verbatim.
   */
  tiers?: Partial<Record<ModelTier, string>>;
  /**
   * Lifecycle hook script paths. Omitted / undefined entries
   * are no-ops. See `HooksConfig` for the 4 supported hook points.
   */
  hooks?: HooksConfig;
}

function resolveConfigDir(configDir?: string): string {
  if (configDir) return configDir;
  // Allow environment variable override
  if (process.env["SYGIL_CONFIG_DIR"]) return process.env["SYGIL_CONFIG_DIR"];
  return join(process.cwd(), CONFIG_DIR);
}

function configPath(configDir?: string): string {
  return join(resolveConfigDir(configDir), CONFIG_FILE);
}

/** Reads and parses sygil.config.json from the given directory (or default .sygil/). */
export async function readConfig(configDir?: string): Promise<SygilConfig> {
  const raw = await readFile(configPath(configDir), "utf8");
  return JSON.parse(raw) as SygilConfig;
}

/** Writes a SygilConfig to sygil.config.json, creating the directory if needed. */
export async function writeConfig(config: SygilConfig, configDir?: string): Promise<void> {
  const dir = resolveConfigDir(configDir);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(configPath(configDir), JSON.stringify(config, null, 2));
}

/**
 * Like readConfig but returns null instead of throwing when the file is absent.
 *
 * ENOENT (file does not exist) is silently treated as "no config" since that's
 * the valid uninitialized-project state. Any OTHER failure — malformed JSON,
 * EACCES, EISDIR, etc. — is surfaced as a `logger.warn` before falling back to
 * null. Silent swallowing of parse errors was a UX bug: users would edit
 * `.sygil/config.json`, break the JSON, watch their `tiers`/`hooks` stop taking
 * effect, and have nothing to diagnose against.
 */
export async function readConfigSafe(configDir?: string): Promise<SygilConfig | null> {
  try {
    return await readConfig(configDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    const path = configPath(configDir);
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not load ${path}: ${reason}. Falling back to defaults.`);
    return null;
  }
}
