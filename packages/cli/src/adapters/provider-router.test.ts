import { describe, it, expect } from "vitest";
import type { NodeConfig } from "@sygil/shared";
import { resolveProviders, classifyError } from "./provider-router.js";

describe("resolveProviders", () => {
  const base: NodeConfig = {
    adapter: "claude-sdk",
    model: "claude-opus-4-7",
    role: "planner",
    prompt: "x",
  };

  it("returns a single legacy entry when providers is absent", () => {
    const out = resolveProviders(base);
    expect(out).toEqual([{ adapter: "claude-sdk", model: "claude-opus-4-7" }]);
  });

  it("returns a single legacy entry when providers is explicitly empty", () => {
    const out = resolveProviders({ ...base, providers: [] });
    expect(out).toEqual([{ adapter: "claude-sdk", model: "claude-opus-4-7" }]);
  });

  it("sorts providers by ascending priority", () => {
    const out = resolveProviders({
      ...base,
      providers: [
        { adapter: "claude-cli", model: "claude-haiku-4-5", priority: 10 },
        { adapter: "claude-sdk", priority: 0 },
        { adapter: "local-oai", model: "llama3.2", priority: 5 },
      ],
    });
    expect(out.map((p) => p.adapter)).toEqual(["claude-sdk", "local-oai", "claude-cli"]);
  });

  it("breaks priority ties by declaration order (stable)", () => {
    const out = resolveProviders({
      ...base,
      providers: [
        { adapter: "gemini-cli", priority: 0 },
        { adapter: "claude-sdk", priority: 0 },
        { adapter: "local-oai", priority: 0 },
      ],
    });
    expect(out.map((p) => p.adapter)).toEqual(["gemini-cli", "claude-sdk", "local-oai"]);
  });

  it("inherits the node-level model when provider.model is omitted", () => {
    const out = resolveProviders({
      ...base,
      model: "inherited-model",
      providers: [{ adapter: "claude-sdk", priority: 0 }],
    });
    expect(out[0]!.model).toBe("inherited-model");
  });

  it("per-provider model overrides the node-level model", () => {
    const out = resolveProviders({
      ...base,
      model: "ignored",
      providers: [{ adapter: "local-oai", model: "qwen2.5", priority: 0 }],
    });
    expect(out[0]!.model).toBe("qwen2.5");
  });
});

describe("classifyError", () => {
  it("classifies the rate_limit:<ms> sentinel as retryable", () => {
    const c = classifyError("rate_limit:60000");
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("rate_limit");
  });

  it("classifies a plain 429 message as retryable", () => {
    const c = classifyError("HTTP 429 Too Many Requests");
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("rate_limit");
  });

  it.each([
    ["ECONNREFUSED at 127.0.0.1:11434"],
    ["getaddrinfo ENOTFOUND api.anthropic.com"],
    ["connect ETIMEDOUT"],
    ["socket hang up"],
    ["fetch failed"],
  ])("classifies transport error %p as retryable:transport", (msg) => {
    const c = classifyError(msg);
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("transport");
  });

  it.each([
    ["HTTP 500 Internal Server Error"],
    ["HTTP 502 Bad Gateway"],
    ["HTTP 503 Service Unavailable"],
    ["HTTP 504 Gateway Timeout"],
    ["status: 500"],
  ])("classifies 5xx %p as retryable:server_5xx", (msg) => {
    const c = classifyError(msg);
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("server_5xx");
  });

  it("does NOT classify a 4xx (non-429) error as retryable", () => {
    expect(classifyError("HTTP 400 Bad Request").retryable).toBe(false);
    expect(classifyError("HTTP 401 Unauthorized").retryable).toBe(false);
    expect(classifyError("HTTP 403 Forbidden").retryable).toBe(false);
    expect(classifyError("HTTP 404 Not Found").retryable).toBe(false);
  });

  it("does NOT classify a stall as retryable (likely reproducible)", () => {
    expect(classifyError("Node stalled").retryable).toBe(false);
    expect(classifyError("stall: no output for 30s").retryable).toBe(false);
  });

  it("does NOT classify an arbitrary application error as retryable", () => {
    expect(classifyError("Invalid output schema").retryable).toBe(false);
    expect(classifyError("Gate failed: file_exists foo.txt").retryable).toBe(false);
  });

  it("handles an Error object whose code property carries ECONNREFUSED", () => {
    const err = Object.assign(new Error("request failed"), { code: "ECONNREFUSED" });
    const c = classifyError(err);
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("transport");
  });

  it("tolerates null / undefined / non-stringable values", () => {
    expect(classifyError(null).retryable).toBe(false);
    expect(classifyError(undefined).retryable).toBe(false);
    expect(classifyError({ weird: "object" }).retryable).toBe(false);
  });

  // CircuitOpenError surfaces as a retryable:circuit_open
  // rejection so provider failover picks the next adapter.
  it("classifies a CircuitOpenError (by name) as retryable:circuit_open", () => {
    const err = new Error("Circuit open for adapter \"claude-cli\" until 2026-04-20T00:00:00.000Z");
    err.name = "CircuitOpenError";
    const c = classifyError(err);
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("circuit_open");
  });

  it("classifies a bare 'Circuit open' message string as retryable:circuit_open", () => {
    const c = classifyError("Circuit open for adapter \"codex\" until 2026-04-20T00:00:00.000Z");
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe("circuit_open");
  });
});
