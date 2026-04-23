import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { replayCommand } from "./replay.js";

describe("replayCommand — runId validation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let processExitSpy: MockInstance<any[], never>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: string | number | null | undefined) => {
        throw new Error(`__EXIT__:${_code ?? 0}`);
      }) as never);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("rejects runIds containing path traversal", async () => {
    await expect(replayCommand("../../etc", {})).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid runId"),
    );
  });

  it("rejects runIds with forward slashes", async () => {
    await expect(replayCommand("foo/bar", {})).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid runId"),
    );
  });

  it("rejects empty runId", async () => {
    await expect(replayCommand("", {})).rejects.toThrow("__EXIT__:1");
  });

  it("rejects runId with whitespace", async () => {
    await expect(replayCommand("foo bar", {})).rejects.toThrow("__EXIT__:1");
  });

  it("accepts a UUID-shaped runId but fails later with `Run directory not found`", async () => {
    await expect(
      replayCommand("550e8400-e29b-41d4-a716-446655440000", {}),
    ).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run directory not found"),
    );
  });

  it("rejects --node containing path traversal", async () => {
    await expect(
      replayCommand("valid-run-id", { node: "../../../etc/passwd" }),
    ).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --node"),
    );
  });

  it("rejects --node containing forward slashes", async () => {
    await expect(
      replayCommand("valid-run-id", { node: "foo/bar" }),
    ).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --node"),
    );
  });

  it("rejects --node containing a leading dot", async () => {
    await expect(
      replayCommand("valid-run-id", { node: "..nodeId" }),
    ).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --node"),
    );
  });

  it("rejects empty --node", async () => {
    await expect(
      replayCommand("valid-run-id", { node: "" }),
    ).rejects.toThrow("__EXIT__:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --node"),
    );
  });
});
