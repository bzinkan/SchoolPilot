import type { Request } from "express";

export interface WebSessionIdentity {
  userId: string;
  email: string;
  role: string;
  schoolId: string | null;
  schoolSessionVersion?: number | null;
  authVersion?: number | null;
}

/**
 * Start a fresh authenticated browser session.
 *
 * Regeneration prevents session fixation and, importantly, removes stale idle
 * metadata before a user signs in again. Callers still explicitly save the
 * session before returning their response.
 */
export async function establishWebSession(
  req: Request,
  identity: WebSessionIdentity
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });

  req.session.userId = identity.userId;
  req.session.email = identity.email;
  req.session.role = identity.role;
  req.session.schoolId = identity.schoolId;
  req.session.schoolSessionVersion = identity.schoolSessionVersion ?? 1;
  req.session.authVersion = identity.authVersion ?? 1;
  req.session.lastActivityAt = Date.now();
}
