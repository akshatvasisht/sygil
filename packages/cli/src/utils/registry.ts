import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

export interface RegistryEntry {
  name: string;
  description: string;
  url: string;           // raw URL to download the template JSON
  tags: string[];
  author: string;
  stars?: number;
  adapterRequirements: string[]; // e.g. ["claude-sdk", "codex"]
}

export interface RegistryIndex {
  version: "1";
  updatedAt: string; // ISO8601
  templates: RegistryEntry[];
}

export const REGISTRY_INDEX_URL = "https://raw.githubusercontent.com/sygil-dev/registry/main/index.json";
export const USER_TEMPLATES_DIR = () => join(homedir(), ".sygil", "templates");

/**
 * Whitelist URL schemes for any remote template source. Rejects `file://`,
 * `ftp://`, `gopher://`, `data:`, and other Node-fetch-unsupported schemes
 * with a clear error rather than letting fetch throw a generic one. Also
 * surfaced to `import-template`'s URL fetch path for parity.
 */
export function validateTemplateUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Template URL must use http or https protocol");
  }
}

export async function fetchRegistryIndex(url = REGISTRY_INDEX_URL): Promise<RegistryIndex> {
  validateTemplateUrl(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
    return await res.json() as RegistryIndex;
  } catch (err) {
    // Re-throw with the contacted URL so connectivity failures (firewall,
    // proxy, DNS) are diagnosable. The bare fetch error never names the host.
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach template registry at ${url}: ${cause}`);
  }
}

export function searchTemplates(index: RegistryIndex, query: string): RegistryEntry[] {
  const q = query.toLowerCase();
  return index.templates.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.tags.some(tag => tag.toLowerCase().includes(q))
  );
}

export async function installTemplate(
  entry: RegistryEntry,
  destDir: string,
  prefetchedBody?: string,
): Promise<string> {
  validateTemplateUrl(entry.url);
  // The registry `install` command fetches and structurally validates the
  // template body before calling this helper. When it passes that body in via
  // `prefetchedBody` we reuse it, avoiding a second network round-trip. If it's
  // omitted (e.g. a direct caller), fetch the JSON with a 10s timeout.
  let json: string;
  if (prefetchedBody !== undefined) {
    json = prefetchedBody;
  } else {
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Failed to download template: ${res.status}`);
    json = await res.text();
  }

  // Sanitize entry.name — strip directory components to prevent path traversal
  // (a compromised registry could set name to "../../.bashrc" to escape destDir)
  const safeName = entry.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safeName.length === 0) {
    throw new Error(`Invalid template name: "${entry.name}"`);
  }

  // Write to destDir/<safeName>.json and verify containment
  await fs.mkdir(destDir, { recursive: true });
  const destPath = join(destDir, `${safeName}.json`);
  const resolvedDest = resolve(destPath);
  const resolvedBase = resolve(destDir) + sep;
  if (!resolvedDest.startsWith(resolvedBase)) {
    throw new Error(`Template name "${entry.name}" resolves outside the templates directory`);
  }
  await fs.writeFile(destPath, json, "utf-8");
  return destPath;
}

export async function listUserTemplates(dir: string): Promise<{ name: string; path: string }[]> {
  try {
    const files = await fs.readdir(dir);
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f.replace(".json", ""), path: join(dir, f) }));
  } catch {
    return [];
  }
}
