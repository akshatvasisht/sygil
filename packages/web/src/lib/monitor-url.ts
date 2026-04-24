/**
 * Resolves the WebSocket URL for the monitor page.
 *
 * Three cases:
 *   1. Embedded (CLI serves the page at http://localhost:<port>/monitor?workflow=x&token=t):
 *      No ?ws= param. Token is present. Use locationPort (same as WS port).
 *   2. Dev mode (SYGIL_UI_DEV=1, CLI passes ?ws=<port>&workflow=x&token=t):
 *      ?ws= param overrides — connect to the CLI port, not the Next.js dev port.
 *   3. Direct web access (no CLI involved, no ?token=):
 *      Return null → monitor shows "No workflow connected" empty state.
 */

const PORT_RE = /^[1-9][0-9]{0,4}$/;

function isValidPort(value: string): boolean {
  if (!PORT_RE.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/**
 * Classifies the ?ws= query param. Used by the monitor page to distinguish
 * "no CLI" from "malformed bookmark" so the UI can surface a targeted error.
 */
export function classifyMonitorWsParam(
  wsParam: string | null,
): "empty" | "valid" | "invalid_port" {
  if (wsParam === null || wsParam === "") return "empty";
  return isValidPort(wsParam) ? "valid" : "invalid_port";
}

export function resolveMonitorWsUrl(params: {
  wsParam: string | null;
  token: string | null;
  locationPort: string | null;
  locationHostname: string;
}): string | null {
  const { wsParam, token, locationPort, locationHostname } = params;
  // Reject an explicitly provided but malformed wsParam outright — do not
  // silently fall back to locationPort. A user-supplied invalid port should
  // surface as an error, not connect to a different port.
  if (wsParam !== null && wsParam !== "" && !isValidPort(wsParam)) return null;
  // Only auto-connect from locationPort when a token is present (embedded CLI mode).
  const wsPort = wsParam !== null && wsParam !== "" ? wsParam : token ? locationPort : null;
  if (!wsPort) return null;
  // locationPort comes from window.location so we trust it, but defensive-validate anyway.
  if (!isValidPort(wsPort)) return null;
  return `ws://${locationHostname}:${wsPort}/?token=${encodeURIComponent(token ?? "")}`;
}
