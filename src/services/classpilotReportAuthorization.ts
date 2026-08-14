import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ClasspilotReportAuthorizationMarker = {
  version: 1;
  salt: string;
  digests: string[];
};

const REPORT_STAFF_DIGEST_NAMESPACE = "classpilot-report-staff-v1";

function staffDigest(options: {
  schoolId: string;
  teachingSessionId: string;
  staffId: string;
  salt: string;
}): string {
  return createHash("sha256")
    // School/session/staff identifiers are UUID-shaped and cannot contain the
    // separator. Keep this byte contract identical to the PostgreSQL trigger
    // that protects mixed-version inserts during the backend-first rollout.
    .update([
      REPORT_STAFF_DIGEST_NAMESPACE,
      options.salt,
      options.schoolId,
      options.teachingSessionId,
      options.staffId,
    ].join("|"))
    .digest("base64url");
}

export function createClasspilotReportAuthorizationMarker(options: {
  schoolId: string;
  teachingSessionId: string;
  staffIds: readonly string[];
  salt?: string;
}): ClasspilotReportAuthorizationMarker {
  const salt = options.salt || randomBytes(24).toString("base64url");
  const digests = [...new Set(options.staffIds.map(String).map((value) => value.trim()).filter(Boolean))]
    .map((staffId) => staffDigest({ ...options, staffId, salt }))
    .sort();
  return { version: 1, salt, digests };
}

export function parseClasspilotReportAuthorizationMarker(
  value: unknown
): ClasspilotReportAuthorizationMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (marker.version !== 1 || typeof marker.salt !== "string" || !Array.isArray(marker.digests)) {
    return null;
  }
  if (marker.salt.length < 16 || marker.salt.length > 128) return null;
  const digests = marker.digests.filter(
    (digest): digest is string => typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(digest)
  );
  if (digests.length !== marker.digests.length) return null;
  return { version: 1, salt: marker.salt, digests };
}

export function isClasspilotReportAuthorizedStaff(options: {
  marker: unknown;
  schoolId: string;
  teachingSessionId: string;
  staffId: string;
}): boolean {
  const marker = parseClasspilotReportAuthorizationMarker(options.marker);
  if (!marker) return false;
  const candidate = Buffer.from(staffDigest({
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    staffId: options.staffId,
    salt: marker.salt,
  }), "utf8");
  return marker.digests.some((digest) => {
    const stored = Buffer.from(digest, "utf8");
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  });
}
