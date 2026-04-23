import { describe, it, expect } from "vitest";
import { resolveMonitorWsUrl, classifyMonitorWsParam } from "./monitor-url.js";

const HOST = "localhost";
const PORT = "4321";
const TOKEN = "test-token-abc";

describe("resolveMonitorWsUrl", () => {
  describe("embedded mode (CLI serves the page, no ?ws= param)", () => {
    it("connects to window.location.port when token is present", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: TOKEN,
        locationPort: PORT,
        locationHostname: HOST,
      });
      expect(url).toBe(`ws://${HOST}:${PORT}/?token=${TOKEN}`);
    });

    it("returns null when token is absent (direct web access)", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: null,
        locationPort: PORT,
        locationHostname: HOST,
      });
      expect(url).toBeNull();
    });

    it("returns null when both token and locationPort are absent", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: null,
        locationPort: null,
        locationHostname: HOST,
      });
      expect(url).toBeNull();
    });
  });

  describe("dev mode (SYGIL_UI_DEV=1, ?ws=<port> provided)", () => {
    it("uses ?ws= param port, overriding locationPort", () => {
      const url = resolveMonitorWsUrl({
        wsParam: "9999",
        token: TOKEN,
        locationPort: "3000", // Next.js dev server port — should be ignored
        locationHostname: HOST,
      });
      expect(url).toBe(`ws://${HOST}:9999/?token=${TOKEN}`);
    });

    it("uses ?ws= param even when token is absent", () => {
      // ?ws= explicitly provided — honour it regardless of token
      const url = resolveMonitorWsUrl({
        wsParam: "9999",
        token: null,
        locationPort: "3000",
        locationHostname: HOST,
      });
      expect(url).toBe(`ws://${HOST}:9999/?token=`);
    });
  });

  describe("URL encoding", () => {
    it("URL-encodes the token in the query string", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: "tok/en=val&ue",
        locationPort: PORT,
        locationHostname: HOST,
      });
      expect(url).toBe(`ws://${HOST}:${PORT}/?token=tok%2Fen%3Dval%26ue`);
    });

    it("handles empty-string token", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: "",
        locationPort: PORT,
        locationHostname: HOST,
      });
      // Empty token is falsy — treated as no token → null
      expect(url).toBeNull();
    });
  });

  describe("wsParam validation", () => {
    it.each([
      ["abc"],
      ["4891/path"],
      ["-1"],
      ["0"],
      ["65536"],
      ["99999"],
      [" 4321"],
      ["4321 "],
      ["4321a"],
    ])("returns null when wsParam is invalid: %s", (bad) => {
      const url = resolveMonitorWsUrl({
        wsParam: bad,
        token: TOKEN,
        locationPort: PORT,
        locationHostname: HOST,
      });
      expect(url).toBeNull();
    });

    it.each([["1"], ["80"], ["4321"], ["65535"]])(
      "accepts valid port %s",
      (good) => {
        const url = resolveMonitorWsUrl({
          wsParam: good,
          token: TOKEN,
          locationPort: null,
          locationHostname: HOST,
        });
        expect(url).toBe(`ws://${HOST}:${good}/?token=${TOKEN}`);
      },
    );

    it("classifyMonitorWsParam returns 'empty' for null and empty string", () => {
      expect(classifyMonitorWsParam(null)).toBe("empty");
      expect(classifyMonitorWsParam("")).toBe("empty");
    });

    it("classifyMonitorWsParam returns 'valid' for a port in range", () => {
      expect(classifyMonitorWsParam("4321")).toBe("valid");
    });

    it("classifyMonitorWsParam returns 'invalid_port' for garbage", () => {
      expect(classifyMonitorWsParam("abc")).toBe("invalid_port");
      expect(classifyMonitorWsParam("65536")).toBe("invalid_port");
      expect(classifyMonitorWsParam("-1")).toBe("invalid_port");
      expect(classifyMonitorWsParam("4891/path")).toBe("invalid_port");
    });
  });

  describe("SSR / server-side rendering (locationPort is null)", () => {
    it("returns null on server when no ?ws= param", () => {
      const url = resolveMonitorWsUrl({
        wsParam: null,
        token: TOKEN,
        locationPort: null, // window not available on server
        locationHostname: HOST,
      });
      expect(url).toBeNull();
    });

    it("uses ?ws= param on server when provided", () => {
      const url = resolveMonitorWsUrl({
        wsParam: "4321",
        token: TOKEN,
        locationPort: null,
        locationHostname: HOST,
      });
      expect(url).toBe(`ws://${HOST}:4321/?token=${TOKEN}`);
    });
  });
});
