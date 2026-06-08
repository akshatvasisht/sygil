import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Ora } from "ora";
import { isContainedIn } from "../gates/index.js";
import { RUN_ID_RE } from "./run-id.js";
import type { WorkflowRunState, NodeResult } from "@sygil/shared";
import { WorkflowRunStateSchema } from "@sygil/shared";

export async function loadRunState(
  runId: string,
  spinner?: Ora
): Promise<WorkflowRunState> {
  const fail = (msg: string): never => {
    if (spinner) {
      spinner.fail(msg);
    } else {
      console.error(msg);
    }
    process.exit(1);
  };

  // Reject runIds with path-traversal characters before constructing any path.
  // Mirror of resume.ts's guard — without this, a crafted runId can probe paths
  // outside the runs directory and leak file existence via differential errors.
  if (!RUN_ID_RE.test(runId)) {
    fail(`Invalid runId "${runId}": must be alphanumeric/_/-`);
  }

  const configDir =
    process.env["SYGIL_CONFIG_DIR"] ?? join(process.cwd(), ".sygil");
  const runsRoot = join(configDir, "runs");
  const stateFile = join(runsRoot, `${runId}.json`);
  if (!isContainedIn(stateFile, runsRoot)) {
    fail(
      `Invalid runId "${runId}": resolved path escapes the runs directory`
    );
  }

  const raw = await readFile(stateFile, "utf8").catch(() =>
    fail(`Could not load run state from ${stateFile}`)
  );

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    fail(
      `Checkpoint at ${stateFile} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parseResult = WorkflowRunStateSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const issueMsg = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : parseResult.error.message;
    fail(
      `Checkpoint at ${stateFile} is corrupt or from an incompatible version: ${issueMsg}`
    );
  }

  const state = parseResult.data as WorkflowRunState;

  // Merge incremental per-node result files (written by CheckpointManager.markNodeResult)
  // so a crash between a node finishing and the next debounced full-state write still
  // recovers that node. Absent nodes/ dir = nothing to merge (backward compatible with
  // checkpoints that only have the inline main file).
  const nodesDir = join(runsRoot, runId, "nodes");
  try {
    for (const file of await readdir(nodesDir)) {
      if (!file.endsWith(".json")) continue;
      const nodeId = file.slice(0, -5);
      state.nodeResults[nodeId] = JSON.parse(await readFile(join(nodesDir, file), "utf8")) as NodeResult;
    }
  } catch {
    // No per-node directory — all results are inline in the main state file.
  }

  return state;
}
