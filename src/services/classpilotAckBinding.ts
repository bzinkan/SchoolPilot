export type ClasspilotAuthenticatedBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ackObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function suppliedControlRevisions(ack: Record<string, unknown>): unknown[] {
  const exact = ackObject(ack.exactBinding);
  const authority = ackObject(ack.authority);
  return [
    ack.studentControlRevision,
    ack.controlRevision,
    exact?.controlRevision,
    authority?.controlRevision,
  ].filter((value) => value !== undefined);
}

/** Return one strictly encoded, internally consistent ACK control revision.
 * String coercion is deliberately forbidden: exact-tab V2 persistence treats
 * absence as a binding failure, while legacy targets simply ignore absence. */
export function classpilotAckControlRevision(value: unknown): number | undefined {
  const ack = ackObject(value);
  if (!ack) return undefined;
  const revisions = suppliedControlRevisions(ack);
  if (
    revisions.length === 0
    || revisions.some((revision) =>
      typeof revision !== "number"
      || !Number.isSafeInteger(revision)
      || revision < 0
    )
  ) {
    return undefined;
  }
  const [revision] = revisions as number[];
  return revisions.every((candidate) => candidate === revision)
    ? revision
    : undefined;
}

/** Strictly parse the SSO projection fence actually applied by the client. */
export function classpilotAckAppliedAuthPolicyRevision(
  value: unknown
): number | undefined {
  const ack = ackObject(value);
  const revision = ack?.appliedAuthPolicyRevision;
  return typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : undefined;
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

  const revisions = suppliedControlRevisions(ack);
  if (revisions.length > 0 && classpilotAckControlRevision(ack) === undefined) {
    return false;
  }

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
