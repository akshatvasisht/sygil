import { describe, it, expect } from "vitest";
import { constantTimeEquals } from "./ct-equals.js";

describe("constantTimeEquals", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEquals("abc123", "abc123")).toBe(true);
  });

  it("returns false when one character differs", () => {
    expect(constantTimeEquals("abc123", "abc124")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("abcd", "abc")).toBe(false);
  });

  it("returns true for two empty strings and false when one is non-empty", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("", "x")).toBe(false);
    expect(constantTimeEquals("x", "")).toBe(false);
  });

  it("handles a realistic UUID pair", () => {
    const token = "550e8400-e29b-41d4-a716-446655440000";
    expect(constantTimeEquals(token, token)).toBe(true);
    expect(constantTimeEquals(token, token.slice(0, -1) + "1")).toBe(false);
  });

  it("handles unicode without throwing and compares byte-equivalent", () => {
    expect(constantTimeEquals("café", "café")).toBe(true);
    // é is 2 bytes in utf-8, so "cafe" (4 chars, 4 bytes) has a different byte length than "café" (4 chars, 5 bytes)
    expect(constantTimeEquals("cafe", "café")).toBe(false);
  });
});
