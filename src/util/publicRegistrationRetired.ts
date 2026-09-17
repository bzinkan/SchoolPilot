import type { Response } from "express";

export const PUBLIC_REGISTRATION_RETIRED = "PUBLIC_REGISTRATION_RETIRED" as const;

/**
 * Terminal response for the retired public registration route. The body is
 * independent of the request so account or school existence cannot be
 * inferred by probing it.
 */
export function sendPublicRegistrationRetired(res: Response) {
  return res.status(410).json({ code: PUBLIC_REGISTRATION_RETIRED });
}

// Shape only, not validity: the value is recorded for the system audit log and
// never echoed back, and a probe that sends an odd-looking address is exactly
// the kind of hit worth keeping. One "@", no whitespace, bounded length.
const AUDIT_EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * The email a retired-route hit is recorded under, for the system audit log
 * only. Anything without an email-like shape is recorded as unknown.
 */
export function retiredRegistrationAuditEmail(body: unknown): string | undefined {
  const raw =
    body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
  if (typeof raw !== "string") return undefined;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && AUDIT_EMAIL_SHAPE.test(email) ? email : undefined;
}
