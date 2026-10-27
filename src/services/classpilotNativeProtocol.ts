import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const NATIVE_LIMITS = Object.freeze({ enrollmentMs: 600_000, sessionMs: 300_000,
  absoluteSessionMs: 8 * 3_600_000, leaseMs: 45_000, renewSeconds: 15, captureSeconds: 30,
  uploadAgeMs: 5_000, maxBytes: 262_144, maxWidth: 1280, maxHeight: 720, maxTargets: 50 });
export class ClasspilotNativeError extends Error {
  constructor(public code: string, public status = 403, message = "Native desktop access is unavailable") { super(message); }
}
export function nativeVisibilityEnabled(schoolId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLASSPILOT_NATIVE_VISIBILITY_MODE !== "on") return false;
  const raw = env.CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS;
  if (!raw || raw.length > 20_000) return false;
  const values = raw.split(",").map(value => value.trim());
  if (values.length > 500 || values.some(value => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))) return false;
  return values.includes(schoolId);
}
export function requireNativeEnabled(schoolId: string): void {
  if (!nativeVisibilityEnabled(schoolId)) throw new ClasspilotNativeError("NATIVE_NOT_ENABLED", 404);
}
export type NativeCredentialKind = "enroll" | "install" | "session";
export type NativeCredential = { kind: NativeCredentialKind; schoolId: string; id: string; tokenHash: string };
export function nativeSecretHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function createNativeCredential(kind: NativeCredentialKind, schoolId: string, id = randomUUID()) {
  const value = `cpn1.${kind}.${Buffer.from(schoolId).toString("base64url")}.${id}.${randomBytes(32).toString("base64url")}`;
  return { id, credential: value, tokenHash: nativeSecretHash(value) };
}
export function parseNativeCredential(value: unknown, kind: NativeCredentialKind): NativeCredential {
  if (typeof value !== "string" || value.length > 600) throw new ClasspilotNativeError("NATIVE_CREDENTIAL_INVALID", 401);
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "cpn1" || parts[1] !== kind
    || !/^[A-Za-z0-9_-]{1,267}$/.test(parts[2]!) || !z.string().uuid().safeParse(parts[3]).success
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[4]!)) throw new ClasspilotNativeError("NATIVE_CREDENTIAL_INVALID", 401);
  const schoolId = Buffer.from(parts[2]!, "base64url").toString("utf8");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(schoolId)
    || Buffer.from(schoolId).toString("base64url") !== parts[2]) throw new ClasspilotNativeError("NATIVE_CREDENTIAL_INVALID", 401);
  return { kind, schoolId, id: parts[3]!, tokenHash: nativeSecretHash(value) };
}
export function nativeHashMatches(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
const id = z.string().trim().min(1).max(200);
export const nativeContextSchema = z.object({ teachingSessionId: id.optional(), supervisionContextId: id.optional() })
  .strict().refine(value => Boolean(value.teachingSessionId) !== Boolean(value.supervisionContextId), "Exactly one classroom context is required");
export type NativeContext = z.infer<typeof nativeContextSchema>;
export const nativeTargetSchema = z.object({ studentId: id, sourceRef: z.string().uuid(), bindingRevision: z.number().int().positive() }).strict();
export type NativeTarget = z.infer<typeof nativeTargetSchema>;
export const nativeLeaseSchema = z.object({ teachingSessionId: id.optional(), supervisionContextId: id.optional(),
  targets: z.array(nativeTargetSchema).min(1).max(NATIVE_LIMITS.maxTargets) }).strict()
  .refine(value => Boolean(value.teachingSessionId) !== Boolean(value.supervisionContextId), "Exactly one classroom context is required")
  .refine(value => new Set(value.targets.map(target => target.studentId)).size === value.targets.length, "Duplicate students");
export const nativeTileSchema = z.object({ teachingSessionId: id.optional(), supervisionContextId: id.optional(),
  studentIds: z.array(id).min(1).max(NATIVE_LIMITS.maxTargets), viewerInstanceId: z.string().uuid().optional(),
  selectedSources: z.array(nativeTargetSchema).max(NATIVE_LIMITS.maxTargets).optional() }).strict()
  .refine(value => Boolean(value.teachingSessionId) !== Boolean(value.supervisionContextId), "Exactly one classroom context is required")
  .refine(value => new Set(value.studentIds).size === value.studentIds.length, "Duplicate students")
  .refine(value => !value.selectedSources?.length || Boolean(value.viewerInstanceId), "Selected sources require a viewer")
  .refine(value => (value.selectedSources ?? []).every(target => value.studentIds.includes(target.studentId)), "Selected source outside scope");
export const nativeApplicationSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.!+ -]+$/),
  displayName: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f\\/:]+$/),
  observedAt: z.string().datetime({ offset: true }),
}).strict();
export type NativeApplication = z.infer<typeof nativeApplicationSchema>;
export const nativeObservationSchema = z.object({ grantId: z.string().uuid(), sourceGeneration: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), capturedAt: z.string().datetime({ offset: true }),
  foregroundApplication: nativeApplicationSchema.nullable() }).strict();
export type NativeObservationMetadata = z.infer<typeof nativeObservationSchema>;
export function nativeCaptureTimestampValid(capturedAt: string, issuedAt: number, expiresAt: number, now = Date.now()): boolean {
  const captured = Date.parse(capturedAt);
  return Number.isFinite(captured) && captured >= issuedAt && captured < expiresAt && now < expiresAt
    && captured <= now + 1_000 && now - captured <= NATIVE_LIMITS.uploadAgeMs;
}
