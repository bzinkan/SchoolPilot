import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  kioskLookupSchema,
  kioskCheckoutSchema,
  kioskClaimSchema,
  kioskRetargetSchema,
  kioskSelfSessionSchema,
} from "../../schema/validation.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";

// Count only failed public kiosk requests toward the strict per-IP budget.
// Successful, PIN-authenticated polling must not cause multiple kiosks behind
// the same school NAT to rate-limit one another at idle.
const kioskLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 failed requests per minute per IP
  message: { error: "Too many kiosk requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
import { eq, and } from "drizzle-orm";
import { productLicenses } from "../../schema/core.js";
import db from "../../db.js";
import {
  getSchoolById,
  getStudentByIdNumber,
  getStudentById,
  getStudentsByGrade,
  getActivePassForStudent,
  getActivePassesByGrade,
  getActivePassesByClass,
  createLegacyPass,
  createCanonicalPass,
  expireOverduePasses,
  getKioskStudentState,
  returnKioskPassForStudent,
  getUserById,
  getGradesBySchool,
  updateCanonicalKioskClass,
  updateLegacyKioskClass,
  updateUser,
  getSettingsForSchool,
  getMembershipByUserAndSchool,
  createKioskSession,
  createSelfClaimedKioskSession,
  createResumedKioskSession,
  adoptKioskSessionDevice,
  getLiveKioskDeviceBinding,
  deleteKioskDeviceBinding,
  getLiveKioskSessionById,
  touchKioskSessionLastSeen,
  claimKioskSessionByCode,
  retargetKioskSessionsForTeacher,
  updateKioskSessionClass,
  releaseKioskSession,
  forceReleaseKioskSession,
  getActiveKioskSessionsForTeacher,
  type KioskClassTarget,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import type { KioskSession } from "../../schema/passpilot.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";
import { comparePassword } from "../../util/password.js";
import {
  canAccessGrade,
  canAccessPasspilotClass,
  getCanonicalClassForSchool,
  getPasspilotClassSourceForSchool,
  getRequestPassPilotRole,
  hasPasspilotCanonicalClassCapability,
  isPassPilotManager,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";
import {
  getPasspilotClasses,
  getPasspilotClassRoster,
  normalizePasspilotPass,
} from "../../services/passpilotClasses.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

function requireKioskClassCapability(req: Parameters<typeof hasPasspilotCanonicalClassCapability>[0], res: any) {
  if (hasPasspilotCanonicalClassCapability(req)) return true;
  res.status(426).json({
    error: "This school uses the ClassPilot class model. Refresh or update PassPilot before continuing.",
    code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
    requiredClassModel: "classpilot-groups-v1",
  });
  return false;
}

// Helper: extract schoolId from header or query
function getKioskSchoolId(req: { headers: Record<string, unknown>; query: Record<string, unknown> }): string | null {
  return (
    (req.headers["x-school-id"] as string) ||
    (req.query.school as string) ||
    (req.query.schoolId as string) ||
    null
  );
}

// Helper: validate kiosk is enabled and the kiosk PIN is correct.
// These endpoints are PUBLIC (no auth) and return student data, so a PIN is
// REQUIRED: a school UUID alone (visible in URLs/QR codes) must not unlock
// badge-number → student lookup. Admins set the PIN in Setup → Settings.
async function validateKiosk(schoolId: string, kioskPin?: string) {
  const school = await getSchoolById(schoolId);
  if (!school) return { error: "School not found", status: 400, school: null };
  // Check PassPilot license
  const [license] = await db.select().from(productLicenses).where(and(eq(productLicenses.schoolId, schoolId), eq(productLicenses.product, "PASSPILOT"), eq(productLicenses.status, "active"))).limit(1);
  if (!license) return { error: "PassPilot license required", status: 403, school: null };
  if (school.kioskEnabled === false) return { error: "Kiosk is not enabled", status: 403, school: null };
  if (!school.kioskPinHash) {
    return {
      error: "Kiosk PIN not configured. An administrator must set a kiosk PIN in PassPilot Setup → Settings.",
      status: 403,
      school: null,
    };
  }
  if (!kioskPin || !(await comparePassword(kioskPin, school.kioskPinHash))) {
    return { error: "Invalid kiosk PIN", status: 401, school: null };
  }
  return { error: null, status: 200, school };
}

// ============================================================================
// Per-device kiosk sessions (teacher-bound)
// ============================================================================
// A kiosk presents X-Kiosk-Session on every call. Absent header → the legacy
// school-global code paths below run unchanged (old clients). A dead session
// is 404 PASSPILOT_KIOSK_SESSION_EXPIRED — NEVER 401, which kiosk clients
// reserve for a bad PIN (they clear the stored PIN on 401).

function getKioskSessionId(req: { headers: Record<string, unknown> }): string | null {
  const value = req.headers["x-kiosk-session"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Durable device identity (X-Kiosk-Device): a client-generated UUID that
// keys the passpilot_kiosk_devices binding. Strictly validated and lowercased
// — a malformed header means "no device id" (feature silently off), never an
// error, so a garbled header cannot break a kiosk.
const KIOSK_DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getKioskDeviceId(req: { headers: Record<string, unknown> }): string | null {
  const value = req.headers["x-kiosk-device"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return KIOSK_DEVICE_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function respondKioskSessionExpired(res: any) {
  return res.status(404).json({
    error: "This kiosk session has expired.",
    code: "PASSPILOT_KIOSK_SESSION_EXPIRED",
  });
}

function respondKioskSessionUnclaimed(res: any) {
  return res.status(409).json({
    error: "This kiosk has not been claimed by a teacher yet.",
    code: "PASSPILOT_KIOSK_SESSION_UNCLAIMED",
  });
}

// Minimal class-column shape shared by kiosk sessions and device bindings.
type KioskClassColumns = Pick<
  KioskSession,
  "classSource" | "gradeId" | "classpilotGroupId"
>;

function kioskSessionClassId(session: KioskClassColumns): string | null {
  return session.classSource === "classpilot_groups"
    ? session.classpilotGroupId
    : session.classSource === "legacy_grades"
      ? session.gradeId
      : null;
}

// Resolve + fully validate a presented kiosk session for data-serving
// endpoints: dead → 404 EXPIRED, unclaimed → 409 UNCLAIMED, teacher no longer
// active staff → force-release + 404 (never leave an ownerless kiosk).
// Returns undefined when no session header is present (legacy school-global
// path), null when a response has already been sent, else the session +
// teacher kiosk name.
async function requireActiveKioskSession(
  req: { headers: Record<string, unknown> },
  res: any,
  schoolId: string
): Promise<{ session: KioskSession; kioskName: string | null } | null | undefined> {
  const sessionId = getKioskSessionId(req);
  if (!sessionId) return undefined;
  const session = await getLiveKioskSessionById(schoolId, sessionId);
  if (!session) {
    respondKioskSessionExpired(res);
    return null;
  }
  if (session.status !== "active") {
    respondKioskSessionUnclaimed(res);
    return null;
  }
  const identity = session.teacherId
    ? await kioskSessionTeacherIdentity(schoolId, session.teacherId)
    : null;
  if (!identity) {
    await forceReleaseKioskSession(schoolId, session.id);
    respondKioskSessionExpired(res);
    return null;
  }
  return { session, kioskName: identity.kioskName };
}

// Teacher display name for kiosk headers/pass labels: the per-teacher kiosk
// name when set, falling back to the account display name. Returns null
// membership when the teacher is no longer active staff at the school.
async function kioskSessionTeacherIdentity(schoolId: string, teacherId: string) {
  const membership = await getMembershipByUserAndSchool(teacherId, schoolId);
  if (!membership || membership.status !== "active") return null;
  const user = await getUserById(teacherId);
  return {
    kioskName: (membership as any).kioskName || user?.displayName || null,
  };
}

async function kioskSessionClassName(
  schoolId: string,
  session: KioskClassColumns
): Promise<string | null> {
  const classId = kioskSessionClassId(session);
  if (!classId) return null;
  if (session.classSource === "classpilot_groups") {
    const group = await getCanonicalClassForSchool(classId, schoolId);
    return group?.name ?? null;
  }
  const allGrades = await getGradesBySchool(schoolId);
  return allGrades.find((g) => g.id === classId)?.name ?? null;
}

// Resume offer for the bootstrap response: shown on the waiting screen so a
// remembered device can rejoin its teacher with one tap instead of a claim
// code. Self-healing: a binding whose teacher is no longer active staff is
// deleted on sight (mirrors the force-release-on-null convention). Class
// staleness only degrades the display — the actual class decision is made at
// resume time, the single source of truth.
async function kioskDeviceResumeOffer(
  schoolId: string,
  deviceId: string | null
): Promise<{ kioskName: string | null; className: string | null } | null> {
  if (!deviceId) return null;
  const binding = await getLiveKioskDeviceBinding(schoolId, deviceId);
  if (!binding) return null;
  const identity = await kioskSessionTeacherIdentity(schoolId, binding.teacherId);
  if (!identity) {
    await deleteKioskDeviceBinding(schoolId, deviceId);
    return null;
  }
  let className: string | null = null;
  try {
    className = await kioskSessionClassName(schoolId, binding);
  } catch {
    className = null;
  }
  return { kioskName: identity.kioskName, className };
}

// Session payload for kiosk devices (public, PIN-gated callers).
async function kioskSessionDeviceView(schoolId: string, session: KioskSession) {
  if (session.status !== "active") {
    return {
      id: session.id,
      status: session.status,
      claimCode: session.claimCode,
      source: null,
      classId: null,
      gradeId: null,
      className: null,
      kioskName: null,
    };
  }
  const identity = session.teacherId
    ? await kioskSessionTeacherIdentity(schoolId, session.teacherId)
    : null;
  const classId = kioskSessionClassId(session);
  return {
    id: session.id,
    status: session.status,
    claimCode: null,
    source: session.classSource,
    classId,
    gradeId: session.classSource === "legacy_grades" ? classId : null,
    className: await kioskSessionClassName(schoolId, session),
    kioskName: identity?.kioskName ?? null,
  };
}

// Session payload for the authenticated teacher UI.
async function kioskSessionTeacherView(schoolId: string, session: KioskSession) {
  const classId = kioskSessionClassId(session);
  return {
    id: session.id,
    status: session.status,
    source: session.classSource,
    classId,
    gradeId: session.classSource === "legacy_grades" ? classId : null,
    className: await kioskSessionClassName(schoolId, session),
    claimedAt: session.claimedAt,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
  };
}

async function resolveKioskClassTarget(
  req: Parameters<typeof hasPasspilotCanonicalClassCapability>[0],
  res: any,
  schoolId: string,
  classId: string
): Promise<KioskClassTarget | null> {
  const source = await getPasspilotClassSourceForSchool(schoolId);
  if (source === "classpilot_groups" && !requireKioskClassCapability(req, res)) {
    return null;
  }
  return { source, classId };
}

// POST /api/passpilot/kiosk/session - Create or resume a kiosk device session.
// Public (PIN-gated). Idempotent: a live presented session is returned as-is,
// so PIN re-entry or a page reload never rotates the claim code.
router.post("/session", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }
    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    await runWithTenantContext({ schoolId }, async () => {
      const deviceId = getKioskDeviceId(req);
      const presentedId = getKioskSessionId(req);
      if (presentedId) {
        const existing = await getLiveKioskSessionById(schoolId, presentedId);
        if (existing) {
          if (deviceId) {
            // Stamp the device on the session; an active session (the
            // /sessions/self handoff) also writes the durable binding here.
            await adoptKioskSessionDevice(schoolId, existing.id, deviceId);
          }
          return res.json({
            session: await kioskSessionDeviceView(schoolId, existing),
            kioskStyle: school.kioskStyle,
            resume:
              existing.status === "unclaimed"
                ? await kioskDeviceResumeOffer(schoolId, deviceId)
                : null,
          });
        }
      }
      const session = await createKioskSession(schoolId, deviceId);
      return res.status(201).json({
        session: await kioskSessionDeviceView(schoolId, session),
        kioskStyle: school.kioskStyle,
        resume: await kioskDeviceResumeOffer(schoolId, deviceId),
      });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/session/resume - One-tap resume from a remembered
// device binding. Public (PIN-gated) like /session — it deliberately lives
// under the /session namespace: the authenticated /sessions/* teacher
// endpoints remain CSRF-protected. The PIN is the security boundary (staff
// present); the device id only selects WHICH teacher's kiosk to mint.
router.post("/session/resume", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }
    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    await runWithTenantContext({ schoolId }, async () => {
      const deviceId = getKioskDeviceId(req);
      if (!deviceId) {
        return res.status(404).json({
          error: "This device has no remembered kiosk. Use a claim code instead.",
          code: "PASSPILOT_KIOSK_DEVICE_UNKNOWN",
        });
      }
      // Offer-time teacher check with binding self-healing; the transaction
      // in createResumedKioskSession re-validates under lock.
      const offer = await kioskDeviceResumeOffer(schoolId, deviceId);
      if (!offer) {
        return res.status(404).json({
          error: "This device has no remembered kiosk. Use a claim code instead.",
          code: "PASSPILOT_KIOSK_DEVICE_UNKNOWN",
        });
      }
      const session = await createResumedKioskSession(schoolId, deviceId);
      // Device-initiated mint of a teacher-bound session with no teacher
      // interaction: worth an audit trail even though kiosk routes are
      // otherwise unaudited. Best-effort by design.
      await logAudit({
        schoolId,
        action: "passpilot.kiosk.session_resumed",
        entityType: "passpilot_kiosk_session",
        entityId: session.id,
        changes: { deviceId, teacherId: session.teacherId },
      });
      return res.status(201).json({
        session: await kioskSessionDeviceView(schoolId, session),
        kioskStyle: school.kioskStyle,
      });
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Public kiosk endpoints (no auth required, school ID from header)
// ============================================================================

// POST /api/passpilot/kiosk/lookup - Student lookup by badge ID
router.post("/lookup", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error) return res.status(status).json({ error });

    const parsed = kioskLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Student ID number required" });
    }

    await runWithTenantContext({ schoolId }, async () => {
    const resolved = await requireActiveKioskSession(req, res, schoolId);
    if (resolved === null) return;
    let sessionOverride: { source: "legacy_grades" | "classpilot_groups"; configuredClassId: string } | undefined;
    if (resolved) {
      const sessionClassId = kioskSessionClassId(resolved.session);
      if (!resolved.session.classSource || !sessionClassId) {
        return res.status(409).json({
          error: "A class must be sent to this kiosk before looking up students.",
          code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
        });
      }
      sessionOverride = { source: resolved.session.classSource, configuredClassId: sessionClassId };
    }
    const student = await getStudentByIdNumber(schoolId, parsed.data.studentIdNumber);
    if (!student) {
      return res.json({ error: "Student not found", student: null, activePass: null });
    }

    const kioskState = await getKioskStudentState(
      schoolId,
      student.id,
      hasPasspilotCanonicalClassCapability(req),
      sessionOverride
    );
    if (!kioskState.enrolled) {
      return res.json({ error: "Student not found", student: null, activePass: null });
    }
    if (kioskState.hasActivePassInAnotherClass) {
      return res.status(409).json({
        error: "Student already has an active pass",
        student: null,
        activePass: null,
      });
    }
    const activePass = kioskState.activePass ?? undefined;

    return res.json({
      source: kioskState.source,
      classId: kioskState.configuredClassId,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        classId: kioskState.configuredClassId,
      },
      activePass: activePass ? await normalizePasspilotPass(activePass, schoolId) : null,
    });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/checkout - Self-checkout (create pass from kiosk)
router.post("/checkout", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const parsed = kioskCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    await runWithTenantContext({ schoolId }, async () => {
    const student = await getStudentById(parsed.data.studentId);
    if (!student || student.schoolId !== schoolId || student.status !== "active") {
      return res.status(400).json({ error: "Student not found" });
    }

    // Enforce school hours
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return res.status(403).json({ error: "Passes cannot be issued outside school hours" });
    }

    // Expire lapsed passes first so a stale one doesn't block a new checkout.
    await expireOverduePasses(schoolId);

    // Check for existing active pass
    const activePass = await getActivePassForStudent(student.id, schoolId);
    if (activePass) {
      return res.status(409).json({ error: "Student already has an active pass" });
    }

    const passDuration = school.defaultPassDuration || 5;
    const expiresAt = new Date(Date.now() + passDuration * 60 * 1000);

    // Per-device session (teacher-bound) when the kiosk presents one;
    // otherwise the legacy school-global slot.
    const resolved = await requireActiveKioskSession(req, res, schoolId);
    if (resolved === null) return;
    const kioskSession: KioskSession | null = resolved?.session ?? null;

    // Kiosk label + pass attribution.
    let kioskName: string | null = null;
    let attributedTeacherId: string | null = null;
    if (resolved && kioskSession) {
      kioskName = resolved.kioskName;
      attributedTeacherId = kioskSession.teacherId;
    } else if (school.kioskActivatedByUserId) {
      const activatingUser = await getUserById(school.kioskActivatedByUserId);
      if (activatingUser) {
        kioskName = activatingUser.displayName || null;
      }
      attributedTeacherId = school.kioskActivatedByUserId;
    }

    // Resolve the configured kiosk class.
    let className: string | null = null;
    const classSource = await getPasspilotClassSourceForSchool(schoolId);
    if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const sessionConfiguredClassId = kioskSession ? kioskSessionClassId(kioskSession) : null;
    if (kioskSession && (!kioskSession.classSource || !sessionConfiguredClassId)) {
      return res.status(409).json({
        error: "A class must be sent to this kiosk before checkout.",
        code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
      });
    }
    if (kioskSession && kioskSession.classSource !== classSource) {
      // Class-model cutover mid-session: invalidate rather than remap silently.
      await forceReleaseKioskSession(schoolId, kioskSession.id);
      return respondKioskSessionExpired(res);
    }
    const selectedClassId = kioskSession
      ? sessionConfiguredClassId
      : classSource === "classpilot_groups"
        ? school.kioskClasspilotGroupId
        : (parsed.data.classId || school.kioskGradeId);
    if (classSource === "classpilot_groups") {
      if (!selectedClassId) {
        return res.status(400).json({ error: "A kiosk class must be selected before checkout" });
      }
      if (parsed.data.classId && parsed.data.classId !== selectedClassId) {
        return res.status(400).json({ error: "Checkout class does not match the configured kiosk class" });
      }
      const group = await getCanonicalClassForSchool(selectedClassId, schoolId);
      if (!group) return res.status(400).json({ error: "Kiosk class is not active" });
      className = group.name;
    } else if (selectedClassId) {
      const expectedLegacyClassId = kioskSession ? selectedClassId : school.kioskGradeId;
      if (
        (kioskSession && parsed.data.classId && parsed.data.classId !== selectedClassId) ||
        (!kioskSession && school.kioskGradeId && selectedClassId !== expectedLegacyClassId)
      ) {
        return res.status(400).json({
          error: "Checkout class does not match the configured kiosk class",
          code: "PASSPILOT_KIOSK_CLASS_CHANGED",
        });
      }
      const allGrades = await getGradesBySchool(schoolId);
      const grade = allGrades.find((g) => g.id === selectedClassId);
      if (!grade) return res.status(400).json({ error: "Kiosk class was not found" });
      className = grade.name;
    }

    // Combine: "7th Science" or just "Science" or just "7th" or null
    const kioskLabel = [className, kioskName].filter(Boolean).join(" ");

    let pass;
    try {
      const commonPass = {
          schoolId,
          studentId: student.id,
          teacherId: attributedTeacherId,
          destination: parsed.data.destination,
          customDestination:
            parsed.data.destination === "custom"
              ? (parsed.data.customDestination || null)
              : null,
          status: "active" as const,
          duration: passDuration,
          expiresAt,
          issuedVia: "kiosk" as const,
          notes: kioskLabel || null,
        };
      pass = classSource === "classpilot_groups"
        ? await createCanonicalPass(
            { ...commonPass, classId: selectedClassId! },
            { kiosk: true, kioskSessionId: kioskSession?.id ?? null }
          )
        : await createLegacyPass(
            { ...commonPass, gradeId: selectedClassId || null },
            kioskSession
              ? { kiosk: true, kioskSessionId: kioskSession.id }
              : {
                  kiosk: true,
                  expectedKioskClassId: school.kioskGradeId || null,
                }
          );
    } catch (err: any) {
      // Drizzle may wrap the pg error (DrizzleQueryError with .cause).
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        return res.status(409).json({ error: "Student already has an active pass" });
      }
      throw err;
    }

    return res.status(201).json({ pass: await normalizePasspilotPass(pass, schoolId) });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/checkin - Return pass from kiosk
router.post("/checkin", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }

    await runWithTenantContext({ schoolId }, async () => {
    const resolved = await requireActiveKioskSession(req, res, schoolId);
    if (resolved === null) return;
    let sessionOverride: { source: "legacy_grades" | "classpilot_groups"; configuredClassId: string } | undefined;
    if (resolved) {
      const sessionClassId = kioskSessionClassId(resolved.session);
      if (!resolved.session.classSource || !sessionClassId) {
        return res.status(409).json({
          error: "A class must be sent to this kiosk before returning passes.",
          code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
        });
      }
      sessionOverride = { source: resolved.session.classSource, configuredClassId: sessionClassId };
    }
    const pass = await returnKioskPassForStudent(
      schoolId,
      studentId,
      hasPasspilotCanonicalClassCapability(req),
      sessionOverride
    );
    if (!pass) {
      return res.status(400).json({ error: "No active pass found" });
    }
    return res.json({ pass: await normalizePasspilotPass(pass, schoolId) });
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/grades - List grades for kiosk
router.get("/grades", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const inventory = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClasses(schoolId, { userId: "kiosk", manager: true })
    );
    if (inventory.source === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const configuredClassId = inventory.source === "classpilot_groups"
      ? school.kioskClasspilotGroupId
      : school.kioskGradeId;
    const classes = configuredClassId
      ? inventory.classes.filter((entry) => entry.classId === configuredClassId)
      : inventory.classes;
    return res.json({ source: inventory.source, classes, grades: classes });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/students - List students for a grade with active pass status
router.get("/students", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const classId = (req.query.classId || req.query.gradeId) as string;
    if (!classId) {
      return res.status(400).json({ error: "classId required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const resolved = await runWithTenantContext({ schoolId }, () =>
      requireActiveKioskSession(req, res, schoolId)
    );
    if (resolved === null) return;
    const kioskSession: KioskSession | null = resolved?.session ?? null;
    const source = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClassSourceForSchool(schoolId)
    );
    if (source === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    if (kioskSession?.classSource && kioskSession.classSource !== source) {
      // Class-model cutover mid-session: invalidate rather than remap silently.
      const sessionToRelease = kioskSession;
      await runWithTenantContext({ schoolId }, () =>
        forceReleaseKioskSession(schoolId, sessionToRelease.id)
      );
      return respondKioskSessionExpired(res);
    }
    const configuredClassId = kioskSession
      ? kioskSessionClassId(kioskSession)
      : source === "classpilot_groups"
        ? school.kioskClasspilotGroupId
        : school.kioskGradeId;
    if (kioskSession && !configuredClassId) {
      return res.status(409).json({
        error: "A class must be sent to this kiosk before students can be loaded.",
        code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
      });
    }
    if (configuredClassId && classId !== configuredClassId) {
      return res.status(409).json({
        error: "The selected class does not match the configured kiosk class.",
        code: "PASSPILOT_KIOSK_CLASS_CHANGED",
      });
    }
    if (source === "classpilot_groups" && !configuredClassId) {
      return res.status(409).json({
        error: "An administrator must select a kiosk class before students can be loaded.",
        code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
      });
    }

    const rosterState = await runWithTenantContext({ schoolId }, async () => {
      if (source === "classpilot_groups") {
        const roster = await getPasspilotClassRoster(schoolId, classId, { userId: "kiosk", manager: true });
        if (!roster) return null;
        return {
          studentsList: roster.students,
          activePasses: await getActivePassesByClass(schoolId, classId),
        };
      }
      return {
        studentsList: await getStudentsByGrade(schoolId, classId),
        activePasses: await getActivePassesByGrade(schoolId, classId),
      };
    });
    if (!rosterState) {
      return res.status(409).json({
        error: "The configured kiosk class is no longer active. Ask an administrator to select an active ClassPilot class.",
        code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
        source: "classpilot_groups",
      });
    }
    const { studentsList, activePasses } = rosterState;

    const passMap = new Map(activePasses.map((p) => [p.studentId, p]));

    const result = studentsList.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      classId,
      gradeId: source === "legacy_grades" ? classId : null,
      studentIdNumber: s.studentIdNumber || null,
      status: s.status,
      activePass: passMap.get(s.id) || null,
    }));

    return res.json({ source, classId, students: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/config - Get kiosk configuration
router.get("/config", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const sessionId = getKioskSessionId(req);
    if (sessionId) {
      // Per-device session branch: config comes from the session, not the
      // school-global slot. Returns className directly so session-mode kiosks
      // never need the /grades endpoint.
      return await runWithTenantContext({ schoolId }, async () => {
        const session = await getLiveKioskSessionById(schoolId, sessionId);
        if (!session) return respondKioskSessionExpired(res);
        if (session.status !== "active") {
          return res.json({
            session: await kioskSessionDeviceView(schoolId, session),
            source: null,
            classId: null,
            gradeId: null,
            className: null,
            kioskName: null,
            kioskEnabled: school.kioskEnabled,
            kioskRequiresApproval: school.kioskRequiresApproval,
            defaultPassDuration: school.defaultPassDuration,
            kioskStyle: school.kioskStyle,
          });
        }
        await touchKioskSessionLastSeen(schoolId, session.id);
        const identity = session.teacherId
          ? await kioskSessionTeacherIdentity(schoolId, session.teacherId)
          : null;
        if (!identity) {
          // Teacher is no longer active staff — never leave an ownerless kiosk.
          await forceReleaseKioskSession(schoolId, session.id);
          return respondKioskSessionExpired(res);
        }
        const classSource = await getPasspilotClassSourceForSchool(schoolId);
        if (session.classSource && session.classSource !== classSource) {
          // Class-model cutover mid-session: invalidate, teacher re-claims.
          await forceReleaseKioskSession(schoolId, session.id);
          return respondKioskSessionExpired(res);
        }
        if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
        const classId = kioskSessionClassId(session);
        if (session.classSource === "classpilot_groups" && classId) {
          const roster = await getPasspilotClassRoster(schoolId, classId, {
            userId: "kiosk",
            manager: true,
          });
          if (!roster) {
            // kioskStyle rides the 409 too: a kiosk parked on this error still
            // polls config and must observe an admin style flip.
            return res.status(409).json({
              error:
                "The configured kiosk class is no longer active. Ask your teacher to send a new class to this kiosk.",
              code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
              source: "classpilot_groups",
              session: { id: session.id, status: session.status },
              kioskStyle: school.kioskStyle,
            });
          }
        }
        const view = await kioskSessionDeviceView(schoolId, session);
        return res.json({
          session: { id: session.id, status: session.status },
          source: view.source,
          classId: view.classId,
          gradeId: view.gradeId,
          className: view.className,
          kioskName: view.kioskName,
          kioskEnabled: school.kioskEnabled,
          kioskRequiresApproval: school.kioskRequiresApproval,
          defaultPassDuration: school.defaultPassDuration,
          kioskStyle: school.kioskStyle,
        });
      });
    }

    let kioskName: string | null = null;
    if (school.kioskActivatedByUserId) {
      const user = await getUserById(school.kioskActivatedByUserId);
      if (user) kioskName = user.displayName || null;
    }

    const classSource = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClassSourceForSchool(schoolId)
    );
    if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const classId = classSource === "classpilot_groups"
      ? school.kioskClasspilotGroupId || null
      : school.kioskGradeId || null;
    if (classSource === "classpilot_groups" && classId) {
      const roster = await runWithTenantContext({ schoolId }, () =>
        getPasspilotClassRoster(schoolId, classId, { userId: "kiosk", manager: true })
      );
      if (!roster) {
        return res.status(409).json({
          error: "The configured kiosk class is no longer active. Ask an administrator to select an active ClassPilot class.",
          code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
          source: "classpilot_groups",
          kioskStyle: school.kioskStyle,
        });
      }
    }
    return res.json({
      source: classSource,
      classId,
      gradeId: classSource === "legacy_grades" ? classId : null,
      kioskName,
      kioskEnabled: school.kioskEnabled,
      kioskRequiresApproval: school.kioskRequiresApproval,
      defaultPassDuration: school.defaultPassDuration,
      kioskStyle: school.kioskStyle,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Authenticated kiosk configuration
// ============================================================================

// PUT /api/passpilot/kiosk/config - Configure kiosk (requires auth)
router.put(
  "/config",
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
  async (req, res, next) => {
    try {
      const { gradeId, classId, kioskName } = req.body;
      const schoolId = res.locals.schoolId!;
      const role = await getRequestPassPilotRole(req, res);

      // Update school kiosk settings
      const classSource = await getPasspilotClassSourceForSchool(schoolId);
      if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
      const selectedClassId = classId !== undefined ? classId : gradeId;
      if (selectedClassId !== undefined) {
        if (selectedClassId && !(await canAccessPasspilotClass(req.authUser!, schoolId, selectedClassId, role))) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
        if (classSource === "classpilot_groups") {
          await updateCanonicalKioskClass(
            schoolId,
            selectedClassId || null,
            req.authUser!.id,
            isPassPilotManager(role)
          );
        } else {
          await updateLegacyKioskClass(
            schoolId,
            selectedClassId || null,
            req.authUser!.id,
            isPassPilotManager(role)
          );
        }
      }

      // Update user kiosk name (stored in displayName for now, or membership kioskName)
      if (kioskName !== undefined) {
        await updateUser(req.authUser!.id, { displayName: kioskName });
      }

      const school = await getSchoolById(schoolId);
      return res.json({
        ok: true,
        source: classSource,
        classId: classSource === "classpilot_groups"
          ? school?.kioskClasspilotGroupId || null
          : school?.kioskGradeId || null,
        gradeId: classSource === "legacy_grades" ? school?.kioskGradeId || null : null,
        kioskName: kioskName || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Authenticated teacher endpoints for per-device kiosk sessions
// ============================================================================
// Same middleware chain as PUT /config. These ride the web client's CSRF
// token — they are intentionally NOT in the CSRF exempt list.

// Failed claim attempts count against a strict per-IP budget (same shape as
// kioskLimiter): with a 1M code space and an authenticated caller required,
// brute force is impractical.
const kioskClaimLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: "Too many kiosk claim attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

const kioskSessionTeacherAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

// POST /api/passpilot/kiosk/sessions/claim - Bind an unclaimed kiosk (by code)
// to the requesting teacher and a class they may run.
router.post(
  "/sessions/claim",
  kioskClaimLimiter,
  ...kioskSessionTeacherAuth,
  async (req, res, next) => {
    try {
      const schoolId = res.locals.schoolId!;
      const parsed = kioskClaimSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const role = await getRequestPassPilotRole(req, res);
      const target = await resolveKioskClassTarget(req, res, schoolId, parsed.data.classId);
      if (!target) return;
      if (!(await canAccessPasspilotClass(req.authUser!, schoolId, parsed.data.classId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const session = await claimKioskSessionByCode(schoolId, parsed.data.claimCode, target, {
        actorUserId: req.authUser!.id,
        manager: isPassPilotManager(role),
      });
      return res.json({ session: await kioskSessionTeacherView(schoolId, session) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/passpilot/kiosk/sessions/self - Auto-claimed session for kiosks
// launched from the teacher's own logged-in app (no code step). classId is
// optional: a classless active session waits for the first Send to Kiosk.
router.post("/sessions/self", ...kioskSessionTeacherAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const parsed = kioskSelfSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }
    const role = await getRequestPassPilotRole(req, res);
    let target: KioskClassTarget | null = null;
    if (parsed.data.classId) {
      target = await resolveKioskClassTarget(req, res, schoolId, parsed.data.classId);
      if (!target) return;
      if (!(await canAccessPasspilotClass(req.authUser!, schoolId, parsed.data.classId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
    }
    const session = await createSelfClaimedKioskSession(schoolId, target, {
      actorUserId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    return res.status(201).json({ session: await kioskSessionTeacherView(schoolId, session) });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/sessions/mine - The requesting teacher's live kiosks.
router.get("/sessions/mine", ...kioskSessionTeacherAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const sessions = await getActiveKioskSessionsForTeacher(schoolId, req.authUser!.id);
    return res.json({
      sessions: await Promise.all(
        sessions.map((session) => kioskSessionTeacherView(schoolId, session))
      ),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/sessions/retarget - Point ALL of the requesting
// teacher's kiosks at a class ("Send to Kiosk").
router.post("/sessions/retarget", ...kioskSessionTeacherAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const parsed = kioskRetargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }
    const role = await getRequestPassPilotRole(req, res);
    const target = await resolveKioskClassTarget(req, res, schoolId, parsed.data.classId);
    if (!target) return;
    if (!(await canAccessPasspilotClass(req.authUser!, schoolId, parsed.data.classId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const sessions = await retargetKioskSessionsForTeacher(schoolId, req.authUser!.id, target, {
      actorUserId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    return res.json({
      updated: sessions.length,
      sessions: await Promise.all(
        sessions.map((session) => kioskSessionTeacherView(schoolId, session))
      ),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/passpilot/kiosk/sessions/:id - Retarget a single kiosk.
router.put("/sessions/:id", ...kioskSessionTeacherAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const parsed = kioskRetargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }
    const role = await getRequestPassPilotRole(req, res);
    const target = await resolveKioskClassTarget(req, res, schoolId, parsed.data.classId);
    if (!target) return;
    if (!(await canAccessPasspilotClass(req.authUser!, schoolId, parsed.data.classId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const session = await updateKioskSessionClass(schoolId, param(req, "id"), target, {
      actorUserId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    if (!session) {
      return res.status(404).json({ error: "Kiosk session not found" });
    }
    return res.json({ session: await kioskSessionTeacherView(schoolId, session) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/passpilot/kiosk/sessions/:id - Release a kiosk (owner or manager).
router.delete("/sessions/:id", ...kioskSessionTeacherAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const session = await releaseKioskSession(schoolId, param(req, "id"), {
      actorUserId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    if (!session) {
      return res.status(404).json({ error: "Kiosk session not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
