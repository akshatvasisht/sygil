import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname);

const CITED_FILES = [
  "app/monitor/page.tsx",
  "app/editor/page.tsx",
  "components/monitor/MetricsStrip.tsx",
  "components/editor/NodePropertyPanel.tsx",
  "components/editor/EdgeGatePanel.tsx",
];

describe("WCAG contrast — `text-subtle` on load-bearing elements", () => {
  it.each(CITED_FILES)(
    "%s contains no text-subtle class on interactive/data text",
    async (rel) => {
      const source = await readFile(resolve(SRC_ROOT, rel), "utf8");
      expect(source).not.toMatch(/text-subtle/);
    },
  );

  it("NodePalette custom archetype badge uses dim tokens, not subtle", async () => {
    const source = await readFile(
      resolve(SRC_ROOT, "components/editor/NodePalette.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/text-subtle border-muted\/30/);
    expect(source).not.toMatch(/dotCls:\s*"bg-subtle"/);
  });
});
