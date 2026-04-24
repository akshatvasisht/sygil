import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname);

const VALID_ANTHROPIC_IDS = new Set([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
]);

const ANTHROPIC_ID_PATTERN = /claude-(?:opus|sonnet|haiku)-\d+-\d+/g;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|d)\.(ts|tsx)$/.test(entry.name)) continue;
    files.push(full);
  }
  return files;
}

describe("Anthropic model IDs in packages/web/src/**", () => {
  it("every hardcoded Anthropic model ID is in the valid allowlist", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const violations: { file: string; id: string }[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(ANTHROPIC_ID_PATTERN)) {
        const id = match[0];
        if (!VALID_ANTHROPIC_IDS.has(id)) {
          violations.push({ file: file.replace(SRC_ROOT, "src"), id });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
