import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SygilConfig } from "./config.js";

const TELEMETRY_ENDPOINT = "https://telemetry.sygil.dev/v1/event";
const TELEMETRY_TIMEOUT_MS = 3000;

export interface TelemetryEvent {
  event: string;
  version: string;
  [key: string]: unknown;
}

/**
 * Fire-and-forget telemetry. Never throws. Never awaited.
 * No-op if telemetry is disabled or config is unavailable.
 * Sends no code content, no file paths, no prompts — only aggregate metrics.
 */
export function trackEvent(name: string, props: Record<string, unknown> = {}): void {
  // Read config synchronously — telemetry must be non-blocking
  const config = readConfigSync();
  if (!config?.telemetry?.enabled) return;

  const payload: TelemetryEvent = {
    event: name,
    version: getPackageVersion(),
    ...props,
  };

  // Fire-and-forget HTTPS POST — 3s timeout, never blocks
  const body = JSON.stringify(payload);
  const req = https.request(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: TELEMETRY_TIMEOUT_MS,
  });

  req.on("timeout", () => req.destroy());
  req.on("error", () => {}); // intentionally swallow all errors
  req.write(body);
  req.end();
}

function readConfigSync(): SygilConfig | null {
  try {
    const configDir =
      process.env["SYGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sygil");
    const configPath = join(configDir, "config.json");
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as SygilConfig;
  } catch {
    return null;
  }
}

function getPackageVersion(): string {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
