import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../../../cli/dist/index.js");

export interface SygilRun {
  process: ChildProcess;
  wsPort: number;
  authToken: string;
  stdout: string;
  waitForExit(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill(): void;
}

/**
 * Start `sygil run <workflowPath>` as a child process.
 * Resolves once the WebSocket monitor URL is printed to stdout.
 *
 * The CLI prints:
 *   WebSocket monitor running on ws://localhost:<port>/?token=<uuid>
 *
 * Rejects if the monitor URL is not seen within `timeout` ms (default 10 000).
 */
export async function startSygilRun(
  workflowPath: string,
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    args?: string[];
    timeout?: number;
  }
): Promise<SygilRun> {
  const timeout = options?.timeout ?? 10_000;
  const extraArgs = options?.args ?? [];

  const child = spawn(
    process.execPath, // node
    [CLI_PATH, "run", workflowPath, ...extraArgs],
    {
      cwd: options?.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...options?.env,
      },
      // Pipe all stdio so we can capture stdout/stderr
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdoutBuffer = "";
  let stderrBuffer = "";

  // Accumulate stdout as it arrives
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");

  child.stdout!.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
  });

  child.stderr!.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  // WS URL pattern: ws://localhost:<port>/?token=<uuid>
  const WS_URL_RE = /ws:\/\/localhost:(\d+)\/\?token=([a-f0-9-]+)/;

  // Resolve as soon as the monitor URL appears in stdout
  const startPromise = new Promise<{ wsPort: number; authToken: string }>(
    (resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(
            `sygil run did not print a WebSocket monitor URL within ${timeout}ms.\n` +
              `stdout so far:\n${stdoutBuffer}\n` +
              `stderr so far:\n${stderrBuffer}`
          )
        );
      }, timeout);

      // Check each stdout chunk for the monitor URL
      child.stdout!.on("data", (chunk: string) => {
        if (settled) return;
        // Re-check the full buffer in case the URL spans two chunks
        const match = WS_URL_RE.exec(stdoutBuffer);
        if (match) {
          settled = true;
          clearTimeout(timeoutId);
          resolve({
            wsPort: parseInt(match[1]!, 10),
            authToken: match[2]!,
          });
        }
      });

      // Reject early if the process exits before printing the URL
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(
          new Error(
            `sygil run exited (code ${code}) before printing a WebSocket monitor URL.\n` +
              `stdout:\n${stdoutBuffer}\n` +
              `stderr:\n${stderrBuffer}`
          )
        );
      });
    }
  );

  const { wsPort, authToken } = await startPromise;

  function waitForExit(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve) => {
      child.once("exit", (code) => {
        resolve({
          exitCode: code ?? -1,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
        });
      });
    });
  }

  function kill(): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited — ignore
    }
  }

  return {
    process: child,
    wsPort,
    authToken,
    get stdout() {
      return stdoutBuffer;
    },
    waitForExit,
    kill,
  };
}
