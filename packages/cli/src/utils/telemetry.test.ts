import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trackEvent } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:https", () => ({
  default: {
    request: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import https from "node:https";
import { readFileSync } from "node:fs";

const mockRequest = https.request as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trackEvent", () => {
  let mockReq: {
    on: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a fresh mock request object each time
    mockReq = {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mockRequest.mockReturnValue(mockReq);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not send when config file is missing (telemetry disabled by default)", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    trackEvent("test_event");

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("does not send when telemetry is explicitly disabled", () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).includes("config.json")) {
        return JSON.stringify({
          version: "1",
          telemetry: { enabled: false },
        });
      }
      // package.json
      return JSON.stringify({ version: "1.0.0" });
    });

    trackEvent("test_event");

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("sends HTTPS POST when telemetry is enabled", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const pathStr = String(path);
      if (pathStr.includes("config.json")) {
        return JSON.stringify({
          version: "1",
          telemetry: { enabled: true },
        });
      }
      // package.json for version
      return JSON.stringify({ version: "2.0.0" });
    });

    trackEvent("workflow_run_started", { nodeCount: 3 });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [url, options] = mockRequest.mock.calls[0]!;
    expect(url).toContain("telemetry.sygil.dev");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("includes event name and version in the payload", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const pathStr = String(path);
      if (pathStr.includes("config.json")) {
        return JSON.stringify({
          version: "1",
          telemetry: { enabled: true },
        });
      }
      return JSON.stringify({ version: "3.5.0" });
    });

    trackEvent("my_event", { custom: "data" });

    const body = JSON.parse(String(mockReq.write.mock.calls[0]![0])) as Record<string, unknown>;
    expect(body["event"]).toBe("my_event");
    expect(body["version"]).toBe("3.5.0");
    expect(body["custom"]).toBe("data");
  });

  it("never throws even if config parsing fails", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("disk error");
    });

    // Should not throw
    expect(() => trackEvent("test_event")).not.toThrow();
  });

  it("registers timeout and error handlers on the request", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).includes("config.json")) {
        return JSON.stringify({
          version: "1",
          telemetry: { enabled: true },
        });
      }
      return JSON.stringify({ version: "1.0.0" });
    });

    trackEvent("test_event");

    const registeredEvents = mockReq.on.mock.calls.map((c) => c[0]!);
    expect(registeredEvents).toContain("timeout");
    expect(registeredEvents).toContain("error");
  });
});
