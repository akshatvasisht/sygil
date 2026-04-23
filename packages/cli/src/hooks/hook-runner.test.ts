import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookRunner, hookResultToEvent, HOOK_SCRIPT_TIMEOUT_MS } from "./hook-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sygil-hook-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(dir: string, name: string, body: string): Promise<string> {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// HOOK_SCRIPT_TIMEOUT_MS — mirrors gate-script timeout
// ---------------------------------------------------------------------------

describe("HOOK_SCRIPT_TIMEOUT_MS", () => {
  it("is 30 seconds", () => {
    expect(HOOK_SCRIPT_TIMEOUT_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// HookRunner.has
// ---------------------------------------------------------------------------

describe("HookRunner.has", () => {
  it("returns true when hook is configured", () => {
    const runner = new HookRunner({ preNode: "./hooks/pre.sh" }, "/tmp");
    expect(runner.has("preNode")).toBe(true);
    expect(runner.has("postNode")).toBe(false);
    expect(runner.has("preGate")).toBe(false);
    expect(runner.has("postGate")).toBe(false);
  });

  it("returns false when no hooks are configured", () => {
    const runner = new HookRunner({}, "/tmp");
    expect(runner.has("preNode")).toBe(false);
    expect(runner.has("postNode")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HookRunner.run — success path
// ---------------------------------------------------------------------------

describe("HookRunner.run — success", () => {
  it("returns null when hook is not configured", async () => {
    const runner = new HookRunner({}, "/tmp");
    const result = await runner.run("preNode", {
      workflowId: "wf",
      nodeId: "n1",
      outputDir: "/tmp",
    });
    expect(result).toBeNull();
  });

  it("runs a successful hook script and captures stdout", async () => {
    const dir = await makeTempDir();
    await writeExecutable(dir, "ok.sh", "echo hello-hook");
    const runner = new HookRunner({ preNode: "ok.sh" }, dir);

    const result = await runner.run("preNode", {
      workflowId: "wf-1",
      nodeId: "node-a",
      outputDir: dir,
    });

    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.stdout).toContain("hello-hook");
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("injects hook-specific env vars (SYGIL_HOOK_TYPE, SYGIL_NODE_ID, …)", async () => {
    const dir = await makeTempDir();
    await writeExecutable(
      dir,
      "env-dump.sh",
      'echo "type=$SYGIL_HOOK_TYPE node=$SYGIL_NODE_ID wf=$SYGIL_WORKFLOW_ID outDir=$SYGIL_OUTPUT_DIR"',
    );
    const runner = new HookRunner({ postNode: "env-dump.sh" }, dir);

    const result = await runner.run("postNode", {
      workflowId: "wf-42",
      nodeId: "nodeX",
      outputDir: dir,
      exitCode: 0,
      output: "done",
    });

    expect(result!.exitCode).toBe(0);
    expect(result!.stdout).toContain("type=postNode");
    expect(result!.stdout).toContain("node=nodeX");
    expect(result!.stdout).toContain("wf=wf-42");
    expect(result!.stdout).toContain(`outDir=${dir}`);
  });

  it("postNode receives SYGIL_EXIT_CODE and SYGIL_OUTPUT", async () => {
    const dir = await makeTempDir();
    await writeExecutable(
      dir,
      "post.sh",
      'echo "exit=$SYGIL_EXIT_CODE out=$SYGIL_OUTPUT"',
    );
    const runner = new HookRunner({ postNode: "post.sh" }, dir);

    const result = await runner.run("postNode", {
      workflowId: "wf",
      nodeId: "n",
      outputDir: dir,
      exitCode: 7,
      output: "node-output-text",
    });

    expect(result!.stdout).toContain("exit=7");
    expect(result!.stdout).toContain("out=node-output-text");
  });

  it("postGate receives SYGIL_EDGE_ID, SYGIL_GATE_PASSED, SYGIL_GATE_REASON", async () => {
    const dir = await makeTempDir();
    await writeExecutable(
      dir,
      "gate.sh",
      'echo "edge=$SYGIL_EDGE_ID passed=$SYGIL_GATE_PASSED reason=$SYGIL_GATE_REASON"',
    );
    const runner = new HookRunner({ postGate: "gate.sh" }, dir);

    const result = await runner.run("postGate", {
      workflowId: "wf",
      nodeId: "n",
      outputDir: dir,
      edgeId: "edge-7",
      gatePassed: false,
      gateReason: "exit code mismatch",
    });

    expect(result!.stdout).toContain("edge=edge-7");
    expect(result!.stdout).toContain("passed=0");
    expect(result!.stdout).toContain("reason=exit code mismatch");
  });

  it("does NOT forward arbitrary SYGIL_* vars from the parent env", async () => {
    const dir = await makeTempDir();
    await writeExecutable(
      dir,
      "leak-check.sh",
      'echo "secret=${SYGIL_SECRET:-UNSET} custom=${SYGIL_CUSTOM_FLAG:-UNSET}"',
    );
    const runner = new HookRunner({ preNode: "leak-check.sh" }, dir);

    const originalSecret = process.env["SYGIL_SECRET"];
    const originalCustom = process.env["SYGIL_CUSTOM_FLAG"];
    process.env["SYGIL_SECRET"] = "leaked-api-key";
    process.env["SYGIL_CUSTOM_FLAG"] = "leaked-flag";

    try {
      const result = await runner.run("preNode", {
        workflowId: "wf",
        nodeId: "n",
        outputDir: dir,
      });
      expect(result!.exitCode).toBe(0);
      expect(result!.stdout).toContain("secret=UNSET");
      expect(result!.stdout).toContain("custom=UNSET");
    } finally {
      if (originalSecret === undefined) delete process.env["SYGIL_SECRET"];
      else process.env["SYGIL_SECRET"] = originalSecret;
      if (originalCustom === undefined) delete process.env["SYGIL_CUSTOM_FLAG"];
      else process.env["SYGIL_CUSTOM_FLAG"] = originalCustom;
    }
  });
});

// ---------------------------------------------------------------------------
// HookRunner.run — failure semantics
// ---------------------------------------------------------------------------

describe("HookRunner.run — failure", () => {
  it("returns non-zero exit code without throwing", async () => {
    const dir = await makeTempDir();
    await writeExecutable(dir, "fail.sh", "echo oops >&2\nexit 3");
    const runner = new HookRunner({ preNode: "fail.sh" }, dir);

    const result = await runner.run("preNode", {
      workflowId: "wf",
      nodeId: "n",
      outputDir: dir,
    });

    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(3);
    expect(result!.stderr).toContain("oops");
  });

  it("throws on path traversal (path outside workingDir)", async () => {
    const dir = await makeTempDir();
    const runner = new HookRunner({ preNode: "../../etc/passwd" }, dir);
    await expect(
      runner.run("preNode", { workflowId: "wf", nodeId: "n", outputDir: dir }),
    ).rejects.toThrow(/resolves outside the working directory/);
  });

  it("throws on absolute path outside workingDir", async () => {
    const dir = await makeTempDir();
    const runner = new HookRunner({ preNode: "/etc/passwd" }, dir);
    await expect(
      runner.run("preNode", { workflowId: "wf", nodeId: "n", outputDir: dir }),
    ).rejects.toThrow(/resolves outside the working directory/);
  });
});

// ---------------------------------------------------------------------------
// HookRunner.run — abort signal
// ---------------------------------------------------------------------------

describe("HookRunner.run — abort signal", () => {
  it("a pre-aborted signal causes the hook to fail fast", async () => {
    const dir = await makeTempDir();
    // Long-running sleep — would easily exceed the test timeout if not aborted
    await writeExecutable(dir, "slow.sh", "sleep 10");
    const runner = new HookRunner({ preNode: "slow.sh" }, dir);

    const controller = new AbortController();
    controller.abort();

    const result = await runner.run(
      "preNode",
      { workflowId: "wf", nodeId: "n", outputDir: dir },
      controller.signal,
    );
    expect(result).not.toBeNull();
    // Aborted child processes surface as a non-zero exit
    expect(result!.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hookResultToEvent — produces a valid hook_result AgentEvent
// ---------------------------------------------------------------------------

describe("hookResultToEvent", () => {
  it("produces a hook_result AgentEvent carrying all fields", () => {
    const event = hookResultToEvent("preNode", {
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 42,
    });
    expect(event.type).toBe("hook_result");
    if (event.type === "hook_result") {
      expect(event.hook).toBe("preNode");
      expect(event.exitCode).toBe(0);
      expect(event.stdout).toBe("ok\n");
      expect(event.durationMs).toBe(42);
    }
  });
});
