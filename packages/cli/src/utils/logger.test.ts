import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { logger, setVerbose, isVerbose } from "./logger.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logger", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleLogSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleWarnSpy: MockInstance<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy return types vary per target
  let consoleErrorSpy: MockInstance<any[], any>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Reset verbose mode to off before each test
    setVerbose(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(false);
  });

  describe("setVerbose / isVerbose", () => {
    it("defaults to false", () => {
      expect(isVerbose()).toBe(false);
    });

    it("returns true after setVerbose(true)", () => {
      setVerbose(true);
      expect(isVerbose()).toBe(true);
    });

    it("returns false after setVerbose(false)", () => {
      setVerbose(true);
      setVerbose(false);
      expect(isVerbose()).toBe(false);
    });
  });

  describe("info", () => {
    it("writes to stdout via console.log", () => {
      logger.info("hello info");
      expect(consoleLogSpy).toHaveBeenCalledWith("hello info");
    });
  });

  describe("success", () => {
    it("writes to stdout with green color", () => {
      logger.success("great success");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const msg = String(consoleLogSpy.mock.calls[0]![0]);
      expect(msg).toContain("great success");
    });
  });

  describe("warn", () => {
    it("writes to stderr via console.warn", () => {
      logger.warn("heads up");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const msg = String(consoleWarnSpy.mock.calls[0]![0]);
      expect(msg).toContain("heads up");
    });
  });

  describe("error", () => {
    it("writes to stderr via console.error", () => {
      logger.error("something broke");
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const msg = String(consoleErrorSpy.mock.calls[0]![0]);
      expect(msg).toContain("something broke");
    });
  });

  describe("debug", () => {
    it("does not output when verbose is false", () => {
      setVerbose(false);
      logger.debug("hidden message");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("outputs when verbose is true", () => {
      setVerbose(true);
      logger.debug("visible message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const msg = String(consoleLogSpy.mock.calls[0]![0]);
      expect(msg).toContain("[debug]");
      expect(msg).toContain("visible message");
    });
  });

  describe("verbose", () => {
    it("does not output when verbose is false", () => {
      setVerbose(false);
      logger.verbose("hidden verbose");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("outputs when verbose is true", () => {
      setVerbose(true);
      logger.verbose("visible verbose");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const msg = String(consoleLogSpy.mock.calls[0]![0]);
      expect(msg).toContain("visible verbose");
    });
  });
});
