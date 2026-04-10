import { describe, it, expect } from "vitest";
import { SigilErrorCode } from "./errors.js";
import type { SigilError } from "./errors.js";

describe("SigilErrorCode", () => {
  it("all error codes are unique strings", () => {
    const values = Object.values(SigilErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe("string");
    }
  });

  it("error code values match their keys", () => {
    for (const [key, value] of Object.entries(SigilErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it("SigilError interface accepts valid error objects", () => {
    const err: SigilError = {
      code: SigilErrorCode.NODE_TIMEOUT,
      message: "Node exceeded timeout",
      nodeId: "planner",
    };
    expect(err.code).toBe("NODE_TIMEOUT");
    expect(err.message).toBe("Node exceeded timeout");
    expect(err.nodeId).toBe("planner");
    expect(err.edgeId).toBeUndefined();
  });

  it("SigilError accepts all optional fields", () => {
    const err: SigilError = {
      code: SigilErrorCode.GATE_SCRIPT_FAILED,
      message: "Script exited with code 1",
      nodeId: "reviewer",
      edgeId: "review-edge",
      details: { exitCode: 1, scriptPath: "./check.sh" },
    };
    expect(err.details?.exitCode).toBe(1);
  });

  it("covers all expected error categories", () => {
    // Gate errors
    expect(SigilErrorCode.GATE_TIMEOUT).toBeDefined();
    expect(SigilErrorCode.GATE_SCRIPT_FAILED).toBeDefined();
    expect(SigilErrorCode.GATE_CONDITION_FAILED).toBeDefined();
    expect(SigilErrorCode.GATE_PATH_TRAVERSAL).toBeDefined();

    // Node errors
    expect(SigilErrorCode.NODE_TIMEOUT).toBeDefined();
    expect(SigilErrorCode.NODE_IDLE_TIMEOUT).toBeDefined();
    expect(SigilErrorCode.NODE_STALLED).toBeDefined();
    expect(SigilErrorCode.NODE_CRASHED).toBeDefined();

    // Adapter errors
    expect(SigilErrorCode.ADAPTER_UNAVAILABLE).toBeDefined();
    expect(SigilErrorCode.ADAPTER_SPAWN_FAILED).toBeDefined();
    expect(SigilErrorCode.ADAPTER_RATE_LIMITED).toBeDefined();

    // Workflow errors
    expect(SigilErrorCode.WORKFLOW_CANCELLED).toBeDefined();
    expect(SigilErrorCode.WORKFLOW_VALIDATION_FAILED).toBeDefined();
    expect(SigilErrorCode.WORKFLOW_NODE_FAILED).toBeDefined();

    // Checkpoint errors
    expect(SigilErrorCode.CHECKPOINT_WRITE_FAILED).toBeDefined();
    expect(SigilErrorCode.CHECKPOINT_LOAD_FAILED).toBeDefined();
  });
});
