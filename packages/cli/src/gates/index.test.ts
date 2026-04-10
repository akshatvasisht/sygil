import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GateEvaluator } from "./index.js";
import type { NodeResult } from "@sigil/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const evaluator = new GateEvaluator();

const defaultResult: NodeResult = {
  output: "test output",
  exitCode: 0,
  durationMs: 100,
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sigil-gate-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Clean up temp dirs in reverse order (deepest first)
  for (const dir of tempDirs.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// exit_code condition
// ---------------------------------------------------------------------------

describe("GateEvaluator", () => {
  describe("exit_code condition", () => {
    it("passes when exit code matches", async () => {
      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: 0 },
        "/tmp"
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/matches expected/);
    });

    it("fails when exit code does not match", async () => {
      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: 1 },
        "/tmp"
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/does not match expected/);
    });
  });

  // ---------------------------------------------------------------------------
  // file_exists condition
  // ---------------------------------------------------------------------------

  describe("file_exists condition", () => {
    it("passes when file exists", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "output.txt");
      await writeFile(filePath, "content", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: filePath }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/file exists/);
    });

    it("fails when file does not exist", async () => {
      const dir = await makeTempDir();

      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: join(dir, "missing.txt") }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/file not found/);
    });

    it("resolves relative paths against outputDir", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, "relative.txt"), "content", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: "relative.txt" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // regex condition
  // ---------------------------------------------------------------------------

  describe("regex condition", () => {
    it("passes when file content matches pattern", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "review.txt");
      await writeFile(filePath, "Everything looks good\nLGTM\n", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath, pattern: "LGTM" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/matched/);
    });

    it("fails when file content does not match pattern", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "review.txt");
      await writeFile(filePath, "Some content without the keyword\n", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath, pattern: "NEEDS_TESTS" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/did not match/);
    });

    it("fails when file does not exist", async () => {
      const dir = await makeTempDir();
      const missingFile = join(dir, "no-such-file.txt");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath: missingFile, pattern: "anything" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/cannot (read|stat) file/);
    });

    it("resolves relative file paths against outputDir", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, "output.md"), "# Result\nSUCCESS\n", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath: "output.md", pattern: "SUCCESS" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // script condition
  // ---------------------------------------------------------------------------

  describe("script condition", () => {
    it("passes when script exits 0", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "check.sh");
      await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(scriptPath, 0o755);

      const result = await evaluator.evaluate(
        { conditions: [{ type: "script", path: scriptPath }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/exited with code 0/);
    });

    it("fails when script exits non-zero", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "check-fail.sh");
      await writeFile(scriptPath, "#!/bin/sh\nexit 1\n", "utf8");
      await chmod(scriptPath, 0o755);

      const result = await evaluator.evaluate(
        { conditions: [{ type: "script", path: scriptPath }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/failed/);
    });

    it("passes SIGIL_EXIT_CODE env var to script", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "check-env.sh");
      // Script passes only if SIGIL_EXIT_CODE is 0
      await writeFile(
        scriptPath,
        '#!/bin/sh\n[ "$SIGIL_EXIT_CODE" = "0" ] && exit 0 || exit 1\n',
        "utf8"
      );
      await chmod(scriptPath, 0o755);

      const passResult = await evaluator.evaluate(
        { conditions: [{ type: "script", path: scriptPath }] },
        { ...defaultResult, exitCode: 0 },
        dir
      );
      expect(passResult.passed).toBe(true);

      const failResult = await evaluator.evaluate(
        { conditions: [{ type: "script", path: scriptPath }] },
        { ...defaultResult, exitCode: 1 },
        dir
      );
      expect(failResult.passed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // AND logic (all conditions must pass)
  // ---------------------------------------------------------------------------

  describe("AND logic", () => {
    it("passes only when all conditions pass", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, "exists.txt"), "content", "utf8");

      const result = await evaluator.evaluate(
        {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "file_exists", path: join(dir, "exists.txt") },
          ],
        },
        { ...defaultResult, exitCode: 0 },
        dir
      );
      expect(result.passed).toBe(true);
    });

    it("fails when any condition fails", async () => {
      const dir = await makeTempDir();
      // file_exists will fail because file doesn't exist
      const result = await evaluator.evaluate(
        {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "file_exists", path: join(dir, "missing.txt") },
          ],
        },
        { ...defaultResult, exitCode: 0 },
        dir
      );
      expect(result.passed).toBe(false);
    });

    it("returns the failing condition reason", async () => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        {
          conditions: [
            { type: "exit_code", value: 0 },
            { type: "file_exists", path: join(dir, "not-here.txt") },
          ],
        },
        { ...defaultResult, exitCode: 0 },
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/file not found/);
    });

    it("short-circuits on first failing condition", async () => {
      // exit_code fails first, so file_exists is never evaluated
      const result = await evaluator.evaluate(
        {
          conditions: [
            { type: "exit_code", value: 0 },
            // This would also fail, but exit_code fails first
            { type: "file_exists", path: "/tmp/hypothetical-missing-file.txt" },
          ],
        },
        { ...defaultResult, exitCode: 1 },
        "/tmp"
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exit code/);
    });

    it("returns a passing reason when gate passes", async () => {
      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: 0 },
        "/tmp"
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Path traversal prevention (Vuln 2 fix)
  // ---------------------------------------------------------------------------

  describe("file_exists — path traversal prevention", () => {
    it("rejects absolute path outside outputDir", async () => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: "/etc/passwd" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/resolves outside the output directory/);
    });

    it("rejects relative traversal path outside outputDir", async () => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: "../../etc/passwd" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/resolves outside the output directory/);
    });

    it("allows path inside outputDir", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, "report.txt"), "data", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path: "report.txt" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/file exists/);
    });
  });

  describe("regex — path traversal prevention", () => {
    it("rejects absolute path outside outputDir", async () => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath: "/etc/passwd", pattern: "root" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/resolves outside the output directory/);
    });

    it("rejects relative traversal path outside outputDir", async () => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath: "../../etc/passwd", pattern: "root" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/resolves outside the output directory/);
    });

    it("allows path inside outputDir", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, "output.log"), "SUCCESS: all tests passed", "utf8");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath: "output.log", pattern: "SUCCESS" }] },
        defaultResult,
        dir
      );
      expect(result.passed).toBe(true);
      expect(result.reason).toMatch(/matched/);
    });
  });

  // ---------------------------------------------------------------------------
  // AbortSignal support
  // ---------------------------------------------------------------------------

  describe("AbortSignal support", () => {
    it("checks signal.aborted before evaluating each condition", async () => {
      const controller = new AbortController();
      controller.abort("cancelled");

      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: 0 },
        "/tmp",
        undefined,
        undefined,
        controller.signal
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/abort/i);
    });

    it("passes signal to script gate execution", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "slow-script.sh");
      // Script that sleeps — should be killed by abort signal
      await writeFile(scriptPath, "#!/bin/sh\nsleep 30\nexit 0\n", "utf8");
      await chmod(scriptPath, 0o755);

      const controller = new AbortController();

      // Abort after a short delay
      const abortTimer = setTimeout(() => controller.abort("cancelled"), 100);

      const result = await evaluator.evaluate(
        { conditions: [{ type: "script", path: scriptPath }] },
        defaultResult,
        dir,
        undefined,
        undefined,
        controller.signal
      );

      clearTimeout(abortTimer);

      // The script should have been killed or the evaluation should have
      // returned early due to the abort signal
      expect(result.passed).toBe(false);
    });

    it("does not abort when signal is not aborted", async () => {
      const controller = new AbortController();

      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: 0 },
        "/tmp",
        undefined,
        undefined,
        controller.signal
      );

      expect(result.passed).toBe(true);
    });
  });
});
