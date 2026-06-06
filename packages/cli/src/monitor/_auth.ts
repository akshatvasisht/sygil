import type { IncomingMessage } from "node:http";
import { constantTimeEquals } from "../utils/ct-equals.js";

/**
 * Shared HTTP auth check for the monitor's HTTP surfaces (the WebSocket
 * server's POST /run handler and the Prometheus /metrics endpoint).
 *
 * A request is authorized when it carries the per-run token via EITHER:
 *   - `?token=<token>` query parameter, OR
 *   - `Authorization: Bearer <token>` header.
 *
 * The bearer header is parsed leniently (case-insensitive scheme, one-or-more
 * spaces, surrounding whitespace trimmed) — a safe superset of the stricter
 * `startsWith("Bearer ")` variant that previously lived in websocket.ts.
 * Token comparison is constant-time to avoid leaking the token via timing.
 */
export function checkHttpAuth(req: IncomingMessage, token: string): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken !== null && constantTimeEquals(queryToken, token)) return true;

  const header = req.headers.authorization;
  if (typeof header === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && constantTimeEquals(m[1]!, token)) return true;
  }

  return false;
}
