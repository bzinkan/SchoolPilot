/**
 * Per-account lockout tracking.
 *
 * Different from IP rate limiting (authLimiter): this locks a specific
 * email/account after repeated failed attempts regardless of source IP.
 * Mitigates distributed credential stuffing where attackers rotate IPs.
 *
 * In-memory for now (single ECS task). For multi-instance deployment,
 * move to Redis with the same key structure.
 */

interface LockState {
  failedAttempts: number;
  firstFailAt: number;
  lockedUntil: number | null;
}

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const lockMap = new Map<string, LockState>();

// Cleanup stale entries
setInterval(() => {
  const now = Date.now();
  for (const [email, state] of lockMap.entries()) {
    // Remove entries where both the attempt window and lockout have fully expired
    const windowExpired = now - state.firstFailAt > ATTEMPT_WINDOW_MS;
    const lockExpired = !state.lockedUntil || now > state.lockedUntil;
    if (windowExpired && lockExpired) {
      lockMap.delete(email);
    }
  }
}, CLEANUP_INTERVAL_MS);

function keyFor(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Check if an account is currently locked.
 * Returns the unlock time (ms since epoch) if locked, null otherwise.
 */
export function isLocked(email: string): number | null {
  const state = lockMap.get(keyFor(email));
  if (!state || !state.lockedUntil) return null;
  if (Date.now() > state.lockedUntil) {
    // Lock expired — clean up
    lockMap.delete(keyFor(email));
    return null;
  }
  return state.lockedUntil;
}

/**
 * Record a failed login attempt.
 * Triggers lockout when MAX_ATTEMPTS is hit within ATTEMPT_WINDOW_MS.
 * Returns true if this attempt triggered a lockout.
 */
export function recordFailedAttempt(email: string): boolean {
  const key = keyFor(email);
  const now = Date.now();
  const existing = lockMap.get(key);

  // Fresh window or no prior record
  if (!existing || now - existing.firstFailAt > ATTEMPT_WINDOW_MS) {
    lockMap.set(key, { failedAttempts: 1, firstFailAt: now, lockedUntil: null });
    return false;
  }

  existing.failedAttempts++;
  if (existing.failedAttempts >= MAX_ATTEMPTS) {
    existing.lockedUntil = now + LOCKOUT_MS;
    return true;
  }
  return false;
}

/**
 * Clear lockout state for an account (on successful login).
 */
export function clearAttempts(email: string): void {
  lockMap.delete(keyFor(email));
}

export const LOCKOUT_CONFIG = {
  MAX_ATTEMPTS,
  ATTEMPT_WINDOW_MS,
  LOCKOUT_MS,
};
