import crypto from "crypto";

function digestSecret(): string {
  const configured = process.env.CLASSPILOT_EVIDENCE_HMAC_SECRET
    || process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("CLASSPILOT_EVIDENCE_HMAC_SECRET is required in production");
  }
  return configured || "schoolpilot-development-evidence-secret";
}

export function classpilotEvidenceUrlDigest(url: string): string {
  return crypto
    .createHmac("sha256", digestSecret())
    .update(url)
    .digest("hex");
}

export type ClasspilotScreenshotEvidenceAuthority = {
  artifactType: unknown;
  schoolId: unknown;
  deviceId: unknown;
  studentId: unknown;
  studentSessionId: unknown;
  bindingVersion: unknown;
  capturedAt: unknown;
};

function nonEmptyAuthorityId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Screenshot evidence is useful only when the stored artifact independently
 * carries its complete internal authority tuple. This guard mirrors the
 * expand-phase PostgreSQL CHECK while producing a stable fail-closed error
 * before application writes reach the database.
 */
export function assertClasspilotScreenshotEvidenceAuthority(
  value: ClasspilotScreenshotEvidenceAuthority
): void {
  if (value.artifactType !== "screenshot") return;
  if (
    !nonEmptyAuthorityId(value.schoolId)
    || !nonEmptyAuthorityId(value.deviceId)
    || !nonEmptyAuthorityId(value.studentId)
    || !nonEmptyAuthorityId(value.studentSessionId)
    || !nonEmptyAuthorityId(value.bindingVersion)
    || !(value.capturedAt instanceof Date)
    || !Number.isFinite(value.capturedAt.getTime())
  ) {
    throw new Error("CLASSPILOT_EVIDENCE_AUTHORITY_REQUIRED");
  }
}
