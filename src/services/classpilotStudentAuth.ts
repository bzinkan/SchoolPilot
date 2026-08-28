import type { Request, Response } from "express";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import db from "../db.js";
import type { Student } from "../schema/students.js";
import { students } from "../schema/students.js";
import {
  devices,
  studentSessions,
  type StudentSession,
} from "../schema/classpilot.js";
import {
  createDevice,
  endStudentSessionExact,
  getDeviceById,
  getSettingsForSchool,
  startStudentSessionWithReplacements,
  type StudentSessionIssuanceAuthKind,
} from "./storage.js";
import {
  createStudentToken,
  type StudentTokenPayload,
} from "./deviceJwt.js";
import {
  assertClasspilotManualSharedSessionIssuanceEnabled,
  createStudentSessionRecovery,
  currentStudentSessionAuthorityPredicate,
  hashStudentSessionRecoveryToken,
  normalizeStudentSessionRecoveryToken,
} from "./classpilotStudentSessionAuthority.js";

export const CLASSPILOT_ENROLLMENT_KEY_HEADER = "x-classpilot-enrollment-key";
export const CLASSPILOT_MANUAL_AUTH_TTL_SECONDS = 300;
const MAX_IN_FLIGHT_ACTIVE_STUDENT_SESSION_LOOKUPS = 5_000;

export type ActiveStudentTokenSessionLookupResult = {
  session: StudentSession;
  studentSchoolId: string;
  deviceSchoolId: string;
  studentEmail: string | null;
};

export type ActiveStudentTokenSession = StudentSession & {
  studentEmail: string | null;
};

export type ActiveStudentTokenSessionLookup = (
  payload: StudentTokenPayload
) => Promise<ActiveStudentTokenSessionLookupResult | undefined>;

type ActiveStudentTokenSessionResolverOptions = {
  maxInFlight?: number;
};

const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_NODE_OPERATIONAL_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

function safeOperationalErrorCode(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      (POSTGRES_SQLSTATE.test(code) || SAFE_NODE_OPERATIONAL_ERROR_CODES.has(code))
    ) {
      return code;
    }
  }
  return undefined;
}

export function studentAuthenticationServiceError(error: unknown): Error {
  const safe = new Error("Student authentication service unavailable") as NodeJS.ErrnoException & {
    expose?: boolean;
    status?: number;
  };
  safe.name = "StudentAuthenticationServiceError";
  safe.code = safeOperationalErrorCode(error);
  safe.expose = true;
  safe.status = 503;
  return safe;
}

export function setClassPilotNoStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
}

export function enrollmentKeyFromRequest(
  req: Request,
  options: { allowBody?: boolean } = {}
): string | undefined {
  const headerValue = req.get(CLASSPILOT_ENROLLMENT_KEY_HEADER);
  if (headerValue) return headerValue;
  if (options.allowBody && typeof req.body?.enrollmentKey === "string") {
    return req.body.enrollmentKey;
  }
  return undefined;
}

function enrollmentKeyMatches(expected: string | null | undefined, providedRaw: unknown): boolean {
  const expectedBuffer = Buffer.from(expected || "");
  const provided = Buffer.from(String(providedRaw || ""));
  return (
    expectedBuffer.length > 0 &&
    provided.length === expectedBuffer.length &&
    crypto.timingSafeEqual(provided, expectedBuffer)
  );
}

export function validateEnrollmentKeyForSettings(
  settings: Awaited<ReturnType<typeof getSettingsForSchool>>,
  provided: unknown,
  options: { requireConfiguredKey?: boolean } = {}
): { ok: true } | { ok: false; status: number; error: string } {
  const hasConfiguredKey = !!settings?.enrollmentKey;
  if (options.requireConfiguredKey && !hasConfiguredKey) {
    return { ok: false, status: 403, error: "Shared sign-in is not configured for this school" };
  }
  if (settings?.enrollmentKeyRequired || options.requireConfiguredKey || hasConfiguredKey) {
    if (!enrollmentKeyMatches(settings?.enrollmentKey, provided)) {
      return { ok: false, status: 401, error: "Invalid or missing enrollment key" };
    }
  }
  return { ok: true };
}

export async function ensureClassPilotDeviceForSchool(options: {
  deviceId: string;
  deviceName?: string | null;
  schoolId: string;
  classId?: string | null;
}) {
  let device = await getDeviceById(options.deviceId);
  if (!device) {
    device = await createDevice({
      deviceId: options.deviceId,
      deviceName: options.deviceName || null,
      schoolId: options.schoolId,
      classId: options.classId || options.schoolId,
    });
  }
  return device;
}

export async function issueStudentDeviceSessionToken(options: {
  schoolId: string;
  deviceId: string;
  deviceName?: string | null;
  classId?: string | null;
  student: Student;
  authKind: StudentSessionIssuanceAuthKind;
  reclaimRecoveryToken?: string | null;
}, dependencies: {
  signStudentToken?: typeof createStudentToken;
} = {}) {
  if (options.authKind === "manual_shared") {
    // Check before device creation or any durable mutation. Storage repeats
    // this guard so direct callers cannot bypass the Phase-A dark posture.
    assertClasspilotManualSharedSessionIssuanceEnabled();
  }
  if (options.student.schoolId !== options.schoolId || options.student.status !== "active") {
    throw Object.assign(new Error("Student is not enrolled"), {
      status: 403,
      code: "STUDENT_INACTIVE",
      expose: true,
    });
  }
  const recovery = options.authKind === "manual_shared"
    ? createStudentSessionRecovery()
    : null;
  const reclaimRecoveryToken = normalizeStudentSessionRecoveryToken(
    options.reclaimRecoveryToken
  );
  const sessionId = crypto.randomUUID();
  // Sign against a validated preallocated ID before device/session writes.
  // If signing fails, no transaction has replaced or created authority and no
  // recovery capability has been persisted.
  const studentToken = (dependencies.signStudentToken ?? createStudentToken)({
    studentId: options.student.id,
    deviceId: options.deviceId,
    schoolId: options.schoolId,
    sessionId,
    studentEmail: options.student.email || undefined,
  });
  const device = await ensureClassPilotDeviceForSchool({
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    schoolId: options.schoolId,
    classId: options.classId,
  });
  const {
    session,
    replacedSessions,
    crossStudentHandoff,
  } = await startStudentSessionWithReplacements(
    options.schoolId,
    options.student.id,
    options.deviceId,
    {
      authKind: options.authKind,
      sessionId,
      sessionRecoveryTokenHash: recovery?.tokenHash ?? null,
      reclaimRecoveryTokenHash: reclaimRecoveryToken
        ? hashStudentSessionRecoveryToken(reclaimRecoveryToken)
        : null,
    }
  );

  return {
    device,
    session,
    replacedSessions,
    crossStudentHandoff,
    studentToken,
    sessionRecoveryToken: recovery?.token ?? null,
  };
}

/**
 * Complete response shaping after a credential-bearing session transaction.
 * If any later awaited step fails, end only the exact row just issued so a raw
 * recovery capability that never reached the extension cannot strand the
 * student. Cleanup and publication are deliberately best-effort and never
 * replace the original failure.
 */
export async function finalizeStudentDeviceSessionIssuance<T>(options: {
  schoolId: string;
  issuedSession: StudentSession;
  finalize: () => Promise<T>;
  onCompensated?: (endedSession: StudentSession) => Promise<void> | void;
}): Promise<T> {
  try {
    return await options.finalize();
  } catch (error) {
    const endedSession = await endStudentSessionExact({
      schoolId: options.schoolId,
      studentId: options.issuedSession.studentId,
      deviceId: options.issuedSession.deviceId,
      studentSessionId: options.issuedSession.id,
    }).catch(() => undefined);
    if (endedSession && options.onCompensated) {
      await Promise.resolve(options.onCompensated(endedSession)).catch(() => undefined);
    }
    throw error;
  }
}

async function lookupActiveStudentTokenSession(
  payload: StudentTokenPayload
): Promise<ActiveStudentTokenSessionLookupResult | undefined> {
  const [match] = await db
    .select({
      session: studentSessions,
      studentSchoolId: students.schoolId,
      deviceSchoolId: devices.schoolId,
      studentEmail: students.email,
    })
    .from(studentSessions)
    .innerJoin(
      students,
      and(
        eq(students.id, studentSessions.studentId),
        eq(students.schoolId, payload.schoolId),
        eq(students.status, "active")
      )
    )
    .innerJoin(
      devices,
      and(
        eq(devices.deviceId, studentSessions.deviceId),
        eq(devices.schoolId, payload.schoolId)
      )
    )
    .where(
      and(
        eq(studentSessions.id, payload.sessionId),
        eq(studentSessions.studentId, payload.studentId),
        eq(studentSessions.deviceId, payload.deviceId),
        currentStudentSessionAuthorityPredicate()
      )
    )
    .limit(1);

  return match;
}

function activeStudentTokenSessionKey(payload: StudentTokenPayload): string {
  return JSON.stringify([
    payload.schoolId,
    payload.studentId,
    payload.deviceId,
    payload.sessionId,
  ]);
}

function isCompleteStudentTokenPayload(payload: StudentTokenPayload): boolean {
  return [
    payload.schoolId,
    payload.studentId,
    payload.deviceId,
    payload.sessionId,
  ].every((value) => typeof value === "string" && value.length > 0);
}

function exactActiveStudentTokenSession(
  payload: StudentTokenPayload,
  match: ActiveStudentTokenSessionLookupResult | undefined
): ActiveStudentTokenSession | undefined {
  if (
    !match ||
    match.studentSchoolId !== payload.schoolId ||
    match.deviceSchoolId !== payload.schoolId ||
    match.session.id !== payload.sessionId ||
    match.session.studentId !== payload.studentId ||
    match.session.deviceId !== payload.deviceId ||
    match.session.isActive !== true
  ) {
    return undefined;
  }
  return { ...match.session, studentEmail: match.studentEmail };
}

export function createActiveStudentTokenSessionResolver(
  lookup: ActiveStudentTokenSessionLookup,
  options: ActiveStudentTokenSessionResolverOptions = {}
): (payload: StudentTokenPayload) => Promise<ActiveStudentTokenSession | undefined> {
  const maxInFlight =
    options.maxInFlight ?? MAX_IN_FLIGHT_ACTIVE_STUDENT_SESSION_LOOKUPS;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
    throw new RangeError("maxInFlight must be a positive safe integer");
  }

  const inFlight = new Map<string, Promise<ActiveStudentTokenSession | undefined>>();

  return (payload: StudentTokenPayload): Promise<ActiveStudentTokenSession | undefined> => {
    if (!isCompleteStudentTokenPayload(payload)) {
      return Promise.resolve(undefined);
    }

    const key = activeStudentTokenSessionKey(payload);
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending = Promise.resolve()
      .then(() => lookup(payload))
      .then((match) => exactActiveStudentTokenSession(payload, match));

    // Keep the coalescer strictly bounded. Once full, additional distinct
    // sessions still verify normally but are not retained in the map.
    if (inFlight.size >= maxInFlight) {
      return pending;
    }

    inFlight.set(key, pending);
    const removeSettled = () => {
      if (inFlight.get(key) === pending) {
        inFlight.delete(key);
      }
    };
    void pending.then(removeSettled, removeSettled);
    return pending;
  };
}

const activeStudentTokenSessionResolver =
  createActiveStudentTokenSessionResolver(lookupActiveStudentTokenSession);

/**
 * Resolve the exact active session represented by a signed student token.
 * Callers must bind the token's school tenant context before invoking this.
 */
export function resolveActiveStudentTokenSession(
  payload: StudentTokenPayload
): Promise<ActiveStudentTokenSession | undefined> {
  return activeStudentTokenSessionResolver(payload);
}

/** Compatibility wrapper for existing truthy/falsey HTTP and WebSocket gates. */
export async function verifyActiveStudentTokenSession(
  payload: StudentTokenPayload
): Promise<boolean> {
  return Boolean(await resolveActiveStudentTokenSession(payload));
}
