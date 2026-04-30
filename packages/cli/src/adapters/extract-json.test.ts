import { describe, it, expect } from "vitest";
import { extractJsonFromOutput } from "./extract-json.js";

describe("extractJsonFromOutput", () => {
  it("returns undefined for text with no braces", () => {
    expect(extractJsonFromOutput("just plain text")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(extractJsonFromOutput("")).toBeUndefined();
  });

  it("extracts a single JSON object", () => {
    expect(extractJsonFromOutput('{"status":"ok"}')).toEqual({ status: "ok" });
  });

  it("extracts the JSON object when surrounded by prose", () => {
    expect(extractJsonFromOutput('Some preamble {"status":"ok"} trailing text')).toEqual({
      status: "ok",
    });
  });

  it("extracts JSON inside a markdown code fence", () => {
    const md = "Here is the result:\n```json\n{\"final\":true,\"value\":42}\n```\n";
    expect(extractJsonFromOutput(md)).toEqual({ final: true, value: 42 });
  });

  it("returns the LAST valid JSON when multiple are present", () => {
    // Cycle 20: this is the bug case the prior greedy regex collapsed into
    // one unparseable span, returning undefined.
    const text = '{"step":"progress","pct":50} ... {"step":"done","result":"X"}';
    expect(extractJsonFromOutput(text)).toEqual({ step: "done", result: "X" });
  });

  it("handles nested JSON objects correctly via brace counting", () => {
    expect(extractJsonFromOutput('{"outer":{"inner":1}}')).toEqual({ outer: { inner: 1 } });
  });

  it("handles JSON with strings containing braces (no false positives)", () => {
    expect(extractJsonFromOutput('{"msg":"a } b { c"}')).toEqual({ msg: "a } b { c" });
  });

  it("handles JSON with escaped quotes inside strings", () => {
    expect(extractJsonFromOutput('{"q":"she said \\"hi\\""}')).toEqual({
      q: 'she said "hi"',
    });
  });

  it("returns undefined when braces are unbalanced", () => {
    expect(extractJsonFromOutput("{ unclosed")).toBeUndefined();
  });

  it("ignores invalid JSON-shaped spans and returns the next valid one", () => {
    const text = '{not valid} then {"valid":true}';
    expect(extractJsonFromOutput(text)).toEqual({ valid: true });
  });

  it("returns the last valid JSON even when a later span is malformed", () => {
    const text = '{"first":1} then {malformed';
    expect(extractJsonFromOutput(text)).toEqual({ first: 1 });
  });
});
