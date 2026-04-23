import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAYOUT_PATH = resolve(__dirname, "layout.tsx");

describe("app/layout.tsx metadata exports", () => {
  it("declares a Next 14 `viewport` export with dark colorScheme and themeColor", async () => {
    const src = await readFile(LAYOUT_PATH, "utf8");
    expect(src).toMatch(/export const viewport\s*:\s*Viewport\s*=/);
    expect(src).toMatch(/colorScheme:\s*"dark"/);
    expect(src).toMatch(/prefers-color-scheme:\s*dark/);
    expect(src).toMatch(/prefers-color-scheme:\s*light/);
    expect(src).toMatch(/width:\s*"device-width"/);
    expect(src).toMatch(/initialScale:\s*1/);
  });

  it("declares a `metadataBase` on the metadata export", async () => {
    const src = await readFile(LAYOUT_PATH, "utf8");
    expect(src).toMatch(/metadataBase:\s*new URL\(/);
  });

  it("imports the Viewport type from next", async () => {
    const src = await readFile(LAYOUT_PATH, "utf8");
    expect(src).toMatch(/import type \{[^}]*\bViewport\b[^}]*\} from "next"/);
  });
});
