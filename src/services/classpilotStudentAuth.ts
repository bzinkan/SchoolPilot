import type { Request, Response } from "express";
import crypto from "crypto";
import type { Student } from "../schema/students.js";
import {
  createDevice,
  getActiveSessionByDevice,
  getActiveSessionById,
  getActiveSessionByStudent,
  getDeviceById,
  getSettingsForSchool,
  linkStudentDevice,
  startStudentSession,
} from "./storage.js";
import {
  createStudentToken,
  type StudentTokenPayload,
} from "./deviceJwt.js";

export const CLASSPILOT_ENROLLMENT_KEY_HEADER = "x-classpilot-enrollment-key";
export const CLASSPILOT_MANUAL_AUTH_TTL_SECONDS = 300;

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
}) {
  const device = await ensureClassPilotDeviceForSchool({
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    schoolId: options.schoolId,
    classId: options.classId,
  });
  const previousStudentSession = await getActiveSessionByStudent(options.student.id);
  const previousDeviceSession = await getActiveSessionByDevice(options.deviceId);

  await linkStudentDevice({ studentId: options.student.id, deviceId: options.deviceId });
  const session = await startStudentSession(options.student.id, options.deviceId);

  const studentToken = createStudentToken({
    studentId: options.student.id,
    deviceId: options.deviceId,
    schoolId: options.schoolId,
    sessionId: session.id,
    studentEmail: options.student.email || undefined,
  });

  return {
    device,
    session,
    previousStudentSession,
    previousDeviceSession,
    studentToken,
  };
}

export async function verifyActiveStudentTokenSession(
  payload: StudentTokenPayload
): Promise<boolean> {
  if (!payload.sessionId) return false;
  const session = await getActiveSessionById(payload.sessionId);
  if (!session) return false;
  const device = await getDeviceById(payload.deviceId);
  if (!device || device.schoolId !== payload.schoolId) return false;
  return (
    session.studentId === payload.studentId &&
    session.deviceId === payload.deviceId
  );
}
