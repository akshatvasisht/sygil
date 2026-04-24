import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, "..", "package.json");

describe("packages/cli/package.json platform guards", () => {
  it("pins engines.node to the Node 20 LTS line (>=20.11)", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf8")) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBeDefined();
    expect(pkg.engines!.node).toMatch(/^>=20\.1[1-9](\.\d+)?$/);
  });

  it("marks win32 as unsupported via the `os` field", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf8")) as {
      os?: string[];
    };
    expect(pkg.os).toBeDefined();
    expect(pkg.os).toContain("!win32");
  });
});
