export type ClasspilotAuthenticatedBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Protocol v2 acknowledgements do not carry an authority envelope, so absence
 * remains compatible. Once any explicit binding field is present, every
 * supplied field must match the cryptographically authenticated connection.
 * The database transaction remains the final frozen-target authority check.
 */
export function classpilotAckEnvelopeMatchesBinding(
  value: unknown,
  authenticated: ClasspilotAuthenticatedBinding
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const ack = value as Record<string, unknown>;
  const nestedObject = (key: "exactBinding" | "authority") => {
    if (!(key in ack) || ack[key] === undefined) return null;
    const candidate = ack[key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false as const;
    }
    return candidate as Record<string, unknown>;
  };
  const exact = nestedObject("exactBinding");
  const authority = nestedObject("authority");
  if (exact === false || authority === false) return false;

  const supplied = {
    schoolId: [ack.schoolId, exact?.schoolId, authority?.schoolId],
    deviceId: [ack.deviceId, exact?.deviceId, authority?.deviceId],
    studentId: [ack.studentId, exact?.studentId, authority?.studentId],
    studentSessionId: [
      ack.studentSessionId,
      exact?.studentSessionId,
      authority?.studentSessionId,
    ],
  };
  for (const key of Object.keys(supplied) as Array<keyof typeof supplied>) {
    for (const candidate of supplied[key]) {
      if (candidate === undefined) continue;
      const normalized = optionalString(candidate);
      if (!normalized || normalized !== authenticated[key]) return false;
    }
  }
  return true;
}
