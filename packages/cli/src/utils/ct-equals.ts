import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Returns false on length mismatch without
 * comparing bytes (this leaks length, not content). Prevents timing-attack
 * disclosure of per-run auth tokens.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
