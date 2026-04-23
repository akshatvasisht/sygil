import { describe, it, expect } from "vitest";
import { SygilErrorCode } from "./errors.js";
import type { SygilError } from "./errors.js";

describe("SygilErrorCode", () => {
  it("all error codes are unique strings", () => {
    const values = Object.values(SygilErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe("string");
    }
  });

  it("error code values match their keys", () => {
    for (const [key, value] of Object.entries(SygilErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it("SygilError interface accepts valid error objects", () => {
    const err: SygilError = {
      code: SygilErrorCode.NODE_TIMEOUT,
      message: "Node exceeded timeout",
      nodeId: "planner",
    };
    expect(err.code).toBe("NODE_TIMEOUT");
    expect(err.message).toBe("Node exceeded timeout");
    expect(err.nodeId).toBe("planner");
    expect(err.edgeId).toBeUndefined();
  });

  it("SygilError accepts all optional fields", () => {
    const err: SygilError = {
      code: SygilErrorCode.GATE_SCRIPT_FAILED,
      message: "Script exited with code 1",
      nodeId: "reviewer",
      edgeId: "review-edge",
      details: { exitCode: 1, scriptPath: "./check.sh" },
    };
    expect(err.details?.exitCode).toBe(1);
  });

  it("covers all expected error categories", () => {
    // Gate errors
    expect(SygilErrorCode.GATE_TIMEOUT).toBeDefined();
    expect(SygilErrorCode.GATE_SCRIPT_FAILED).toBeDefined();
    expect(SygilErrorCode.GATE_CONDITION_FAILED).toBeDefined();
    expect(SygilErrorCode.GATE_PATH_TRAVERSAL).toBeDefined();

    // Node errors
    expect(SygilErrorCode.NODE_TIMEOUT).toBeDefined();
    expect(SygilErrorCode.NODE_IDLE_TIMEOUT).toBeDefined();
    expect(SygilErrorCode.NODE_STALLED).toBeDefined();
    expect(SygilErrorCode.NODE_CRASHED).toBeDefined();

    // Adapter errors
    expect(SygilErrorCode.ADAPTER_UNAVAILABLE).toBeDefined();
    expect(SygilErrorCode.ADAPTER_SPAWN_FAILED).toBeDefined();
    expect(SygilErrorCode.ADAPTER_RATE_LIMITED).toBeDefined();

    // Workflow errors
    expect(SygilErrorCode.WORKFLOW_CANCELLED).toBeDefined();
    expect(SygilErrorCode.WORKFLOW_VALIDATION_FAILED).toBeDefined();
    expect(SygilErrorCode.WORKFLOW_NODE_FAILED).toBeDefined();

    // Checkpoint errors
    expect(SygilErrorCode.CHECKPOINT_WRITE_FAILED).toBeDefined();
    expect(SygilErrorCode.CHECKPOINT_LOAD_FAILED).toBeDefined();
  });
});
