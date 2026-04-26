/**
 * One-time authorization code exchange for OAuth callbacks.
 *
 * Replaces the previous flow which redirected with `?token=<JWT>` in the URL.
 * That pattern leaked the JWT to:
 *   - Browser history (anyone with device access could grab it)
 *   - HTTP Referer headers sent to third parties on subsequent navigation
 *   - Server access logs (CloudFront, ALB, third-party analytics)
 *   - Native app deep-link logs on Android/iOS (visible to other apps with package
 *     visibility on some configurations)
 *
 * New flow:
 *   1. After successful OAuth, server creates a short-lived random code (60s TTL),
 *      stores the JWT in memory keyed by code.
 *   2. Server redirects with `?code=<one_time_code>` instead.
 *   3. Client POSTs the code to /auth/exchange-code, gets JWT in response BODY.
 *   4. Code is invalidated immediately on first use; expires after 60s if unused.
 *
 * Why in-memory now: single ECS task currently. When scaling to multi-instance,
 * move to Redis with the same SETEX-style key TTL. The interface here is
 * intentionally Redis-shaped to make that swap trivial.
 */
import crypto from "crypto";

interface CodeRecord {
  token: string;
  expiresAt: number;
}

const CODE_TTL_MS = 60 * 1000; // 60 seconds — long enough for a network round-trip, short enough to limit damage if logged
const codeStore = new Map<string, CodeRecord>();

// Periodic cleanup of expired codes
setInterval(() => {
  const now = Date.now();
  for (const [code, record] of codeStore) {
    if (record.expiresAt < now) codeStore.delete(code);
  }
}, 30 * 1000);

/**
 * Stash a JWT under a fresh one-time code. Returns the code (URL-safe random).
 */
export function issueAuthCode(token: string): string {
  const code = crypto.randomBytes(32).toString("base64url");
  codeStore.set(code, { token, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/**
 * Exchange a code for the stored JWT. Code is invalidated on first use.
 * Returns null if the code is unknown, expired, or already used.
 */
export function consumeAuthCode(code: string): string | null {
  const record = codeStore.get(code);
  if (!record) return null;
  codeStore.delete(code); // single-use
  if (record.expiresAt < Date.now()) return null;
  return record.token;
}
