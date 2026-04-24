import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { GateEvaluator } from "./index.js";
import { makeNodeResult, makeTempDir as makeTempDirHelper } from "../scheduler/__test-helpers__.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const evaluator = new GateEvaluator();

const defaultResult = makeNodeResult();

const tempDirs: string[] = [];

const makeTempDir = (): Promise<string> => makeTempDirHelper(tempDirs, "sygil-gate-test-");

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
    it.each([
      { label: "passes when exit code matches", actual: 0, passed: true, reason: /matches expected/ },
      { label: "fails when exit code does not match", actual: 1, passed: false, reason: /does not match expected/ },
    ])("$label", async ({ actual, passed, reason }) => {
      const result = await evaluator.evaluate(
        { conditions: [{ type: "exit_code", value: 0 }] },
        { ...defaultResult, exitCode: actual },
        "/tmp"
      );
      expect(result.passed).toBe(passed);
      expect(result.reason).toMatch(reason);
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

    it("passes SYGIL_EXIT_CODE env var to script", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "check-env.sh");
      // Script passes only if SYGIL_EXIT_CODE is 0
      await writeFile(
        scriptPath,
        '#!/bin/sh\n[ "$SYGIL_EXIT_CODE" = "0" ] && exit 0 || exit 1\n',
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

    it("falls back to the bundled templates dir when the script is not present in the outputDir", async () => {
      // Bundled template gates (e.g. ralph.json → gates/ralph-done.sh,
      // optimize.json → gates/check-budget.sh) are shipped in the CLI tarball
      // but are NOT copied by `sygil export`. The resolver falls back to the
      // bundled `templates/<scriptPath>` so those templates run out-of-the-box
      // without requiring the user to copy gates/ into their working dir.
      const dir = await makeTempDir();
      // Pick a real bundled gate that we know ships with the CLI. Its
      // behavior-under-missing-config is non-zero exit (fails closed), which
      // is fine — we only need to verify the file was found + executed.
      const result = await evaluator.evaluate(
        { conditions: [{ type: "script", path: "gates/check-budget.sh" }] },
        defaultResult,
        dir,
      );
      // Either passes or fails based on the bundled script's own logic — the
      // important signal is that the reason string references the bundled
      // path, proving the fallback resolver found it.
      expect(result.reason).toMatch(/templates\/gates\/check-budget\.sh/);
    });

    it("does NOT forward arbitrary SYGIL_* vars from the parent env", async () => {
      const dir = await makeTempDir();
      const scriptPath = join(dir, "leak-check.sh");
      // Fails if SYGIL_SECRET is leaked from the parent environment.
      await writeFile(
        scriptPath,
        '#!/bin/sh\n[ -z "$SYGIL_SECRET" ] && exit 0 || exit 1\n',
        "utf8",
      );
      await chmod(scriptPath, 0o755);

      const originalSecret = process.env["SYGIL_SECRET"];
      process.env["SYGIL_SECRET"] = "leaked-api-key";

      try {
        const result = await evaluator.evaluate(
          { conditions: [{ type: "script", path: scriptPath }] },
          defaultResult,
          dir,
        );
        expect(result.passed).toBe(true);
      } finally {
        if (originalSecret === undefined) delete process.env["SYGIL_SECRET"];
        else process.env["SYGIL_SECRET"] = originalSecret;
      }
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
    it.each([
      ["absolute", "/etc/passwd"],
      ["relative traversal", "../../etc/passwd"],
    ])("rejects %s path outside outputDir", async (_label, path) => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "file_exists", path }] },
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
    it.each([
      ["absolute", "/etc/passwd"],
      ["relative traversal", "../../etc/passwd"],
    ])("rejects %s path outside outputDir", async (_label, filePath) => {
      const dir = await makeTempDir();
      const result = await evaluator.evaluate(
        { conditions: [{ type: "regex", filePath, pattern: "root" }] },
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

  // ---------------------------------------------------------------------------
  // spec_compliance condition
  // ---------------------------------------------------------------------------

  describe("spec_compliance condition", () => {
    describe("exact mode", () => {
      it("passes when output matches spec line-for-line", async () => {
        const dir = await makeTempDir();
        await writeFile(
          join(dir, "spec.md"),
          "# API\n- endpoint: /health\n- returns: 200\n",
          "utf8"
        );

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "exact" }] },
          { ...defaultResult, output: "# API\n- endpoint: /health\n- returns: 200\n" },
          dir
        );
        expect(result.passed).toBe(true);
        expect(result.reason).toMatch(/exact/);
      });

      it("ignores leading/trailing whitespace and blank lines", async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, "spec.md"), "alpha\nbeta\n", "utf8");

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "exact" }] },
          { ...defaultResult, output: "\n  alpha  \n\nbeta\n\n" },
          dir
        );
        expect(result.passed).toBe(true);
      });

      it("fails when a line is missing", async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, "spec.md"), "alpha\nbeta\ngamma\n", "utf8");

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "exact" }] },
          { ...defaultResult, output: "alpha\nbeta\n" },
          dir
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toMatch(/differs/);
      });

      it("fails when order differs", async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, "spec.md"), "alpha\nbeta\n", "utf8");

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "exact" }] },
          { ...defaultResult, output: "beta\nalpha\n" },
          dir
        );
        expect(result.passed).toBe(false);
      });
    });

    describe("superset mode", () => {
      it("passes when output contains every spec line in any order", async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, "spec.md"), "## endpoints\n- /health\n- /ready\n", "utf8");

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "superset" }] },
          {
            ...defaultResult,
            output: "# API spec\n## endpoints\n- /ready\n- /health\n- /metrics (new)\n",
          },
          dir
        );
        expect(result.passed).toBe(true);
        expect(result.reason).toMatch(/covers/);
      });

      it("fails when a spec line is absent from the output", async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, "spec.md"), "required: A\nrequired: B\nrequired: C\n", "utf8");

        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath: "spec.md", mode: "superset" }] },
          { ...defaultResult, output: "required: A\nrequired: B\n" },
          dir
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toMatch(/missing/);
        expect(result.reason).toMatch(/required: C/);
      });
    });

    describe("path traversal prevention", () => {
      it.each([
        ["absolute", "/etc/passwd", "exact" as const],
        ["relative traversal", "../../etc/passwd", "superset" as const],
      ])("rejects %s path outside outputDir", async (_label, specPath, mode) => {
        const dir = await makeTempDir();
        const result = await evaluator.evaluate(
          { conditions: [{ type: "spec_compliance", specPath, mode }] },
          defaultResult,
          dir
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toMatch(/resolves outside the output directory/);
      });

      it("fails cleanly when spec file is missing", async () => {
        const dir = await makeTempDir();
        const result = await evaluator.evaluate(
          {
            conditions: [
              { type: "spec_compliance", specPath: "no-such-spec.md", mode: "exact" },
            ],
          },
          defaultResult,
          dir
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toMatch(/cannot (stat|read) spec/);
      });
    });
  });
});
