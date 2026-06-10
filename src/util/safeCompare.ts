import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison for secrets (webhook tokens, health tokens,
 * PINs). Plain === short-circuits on the first differing byte, which leaks
 * prefix information through response timing.
 */
export function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
