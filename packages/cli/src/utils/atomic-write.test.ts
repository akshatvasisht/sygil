import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.js";

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sygil-atomic-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes data to the target path", async () => {
    const target = join(testDir, "out.json");
    await writeFileAtomic(target, '{"hello":"world"}');
    expect(await readFile(target, "utf8")).toBe('{"hello":"world"}');
  });

  it("leaves no .tmp orphan after successful write", async () => {
    const target = join(testDir, "out.json");
    await writeFileAtomic(target, "data");
    const entries = await readdir(testDir);
    expect(entries).toEqual(["out.json"]);
  });

  it("preserves the previous file when the rename target already exists", async () => {
    const target = join(testDir, "out.json");
    await writeFile(target, "version-1", "utf8");
    await writeFileAtomic(target, "version-2");
    expect(await readFile(target, "utf8")).toBe("version-2");
    const entries = await readdir(testDir);
    expect(entries).toEqual(["out.json"]);
  });

  it("throws and leaves no orphan tmp file when the parent directory does not exist", async () => {
    const target = join(testDir, "missing", "out.json");
    await expect(writeFileAtomic(target, "data")).rejects.toThrow();
    // Parent didn't exist → no tmp file was created in `testDir` either.
    const entries = await readdir(testDir);
    expect(entries).toEqual([]);
  });

  it("each call uses a unique tmp name so concurrent writers to different targets don't collide", async () => {
    const a = join(testDir, "a.json");
    const b = join(testDir, "b.json");
    await Promise.all([writeFileAtomic(a, "A"), writeFileAtomic(b, "B")]);
    expect(await readFile(a, "utf8")).toBe("A");
    expect(await readFile(b, "utf8")).toBe("B");
    const entries = (await readdir(testDir)).sort();
    expect(entries).toEqual(["a.json", "b.json"]);
  });
});
