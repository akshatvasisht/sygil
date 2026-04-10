/**
 * Resolves the WebSocket URL for the monitor page.
 *
 * Three cases:
 *   1. Embedded (CLI serves the page at http://localhost:<port>/monitor?workflow=x&token=t):
 *      No ?ws= param. Token is present. Use locationPort (same as WS port).
 *   2. Dev mode (SIGIL_UI_DEV=1, CLI passes ?ws=<port>&workflow=x&token=t):
 *      ?ws= param overrides — connect to the CLI port, not the Next.js dev port.
 *   3. Direct web access (no CLI involved, no ?token=):
 *      Return null → monitor shows "No workflow connected" empty state.
 */
export function resolveMonitorWsUrl(params: {
  wsParam: string | null;
  token: string | null;
  locationPort: string | null;
  locationHostname: string;
}): string | null {
  const { wsParam, token, locationPort, locationHostname } = params;
  // Only auto-connect from locationPort when a token is present (embedded CLI mode).
  const wsPort = wsParam ?? (token ? locationPort : null);
  if (!wsPort) return null;
  return `ws://${locationHostname}:${wsPort}/?token=${encodeURIComponent(token ?? "")}`;
}
