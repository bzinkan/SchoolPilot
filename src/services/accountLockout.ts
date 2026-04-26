/**
 * Per-account lockout tracking — backed by Postgres.
 *
 * Different from IP rate limiting (authLimiter): this locks a specific
 * email/account after repeated failed attempts regardless of source IP.
 * Mitigates distributed credential stuffing where attackers rotate IPs.
 *
 * Persistence rationale:
 *   - In-memory state was lost on every ECS task restart, letting an attacker
 *     reset their attempt counter just by waiting for a deploy.
 *   - In-memory state didn't share across multiple ECS tasks — when we scale
 *     beyond 1 instance, an attacker could spread attempts across tasks and
 *     never trigger lockout.
 *   - Postgres-backed state survives both restarts and scale-out.
 *
 * Schema (defined in src/index.ts auto-migration):
 *   auth_lockouts (
 *     email_lc TEXT PRIMARY KEY,
 *     failed_attempts INT NOT NULL DEFAULT 0,
 *     first_fail_at TIMESTAMP NOT NULL DEFAULT now(),
 *     locked_until TIMESTAMP,
 *     updated_at TIMESTAMP NOT NULL DEFAULT now()
 *   )
 */
import { pool } from "../db.js";

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

function keyFor(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Returns the unlock time (Date) if the account is currently locked, null otherwise.
 * Cleans up expired locks lazily on read.
 */
export async function isLocked(email: string): Promise<Date | null> {
  const key = keyFor(email);
  const result = await pool.query(
    `SELECT locked_until FROM auth_lockouts WHERE email_lc = $1 LIMIT 1`,
    [key]
  );
  const row = result.rows[0];
  if (!row || !row.locked_until) return null;
  const lockedUntil = new Date(row.locked_until);
  if (lockedUntil.getTime() <= Date.now()) {
    // Expired — clear the record so subsequent calls don't keep paying for the SELECT
    await pool.query(`DELETE FROM auth_lockouts WHERE email_lc = $1`, [key]).catch(() => {});
    return null;
  }
  return lockedUntil;
}

/**
 * Record a failed login attempt. Returns true if this attempt triggered a lockout.
 *
 * Concurrency: the UPSERT below is atomic at the row level. If two processes
 * both increment for the same email at the same time, both increments succeed
 * and the row reflects the higher count — which is the conservative behavior
 * we want (lockout slightly sooner under concurrent attack).
 */
export async function recordFailedAttempt(email: string): Promise<boolean> {
  const key = keyFor(email);
  const now = Date.now();
  const windowStart = new Date(now - ATTEMPT_WINDOW_MS);

  // Atomic upsert: if existing row's first_fail_at is older than the window,
  // reset the counter to 1; otherwise increment.
  const result = await pool.query(
    `INSERT INTO auth_lockouts (email_lc, failed_attempts, first_fail_at, updated_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (email_lc) DO UPDATE SET
       failed_attempts = CASE
         WHEN auth_lockouts.first_fail_at < $2 THEN 1
         ELSE auth_lockouts.failed_attempts + 1
       END,
       first_fail_at = CASE
         WHEN auth_lockouts.first_fail_at < $2 THEN NOW()
         ELSE auth_lockouts.first_fail_at
       END,
       updated_at = NOW()
     RETURNING failed_attempts`,
    [key, windowStart]
  );

  const attempts = result.rows[0]?.failed_attempts ?? 1;
  if (attempts >= MAX_ATTEMPTS) {
    const lockedUntil = new Date(now + LOCKOUT_MS);
    await pool.query(
      `UPDATE auth_lockouts SET locked_until = $1, updated_at = NOW() WHERE email_lc = $2`,
      [lockedUntil, key]
    );
    return true;
  }
  return false;
}

/**
 * Clear lockout state for an account (on successful login).
 */
export async function clearAttempts(email: string): Promise<void> {
  await pool.query(`DELETE FROM auth_lockouts WHERE email_lc = $1`, [keyFor(email)]).catch(() => {});
}

export const LOCKOUT_CONFIG = {
  MAX_ATTEMPTS,
  ATTEMPT_WINDOW_MS,
  LOCKOUT_MS,
};
