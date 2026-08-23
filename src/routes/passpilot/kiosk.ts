import crypto from "node:crypto";
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
import {
  getSchoolById,
  getStudentByIdNumber,
  getStudentById,
  getActivePassForStudent,
  createLegacyPass,
  createCanonicalPass,
  expireOverduePasses,
  getKioskStudentState,
  returnKioskPassForStudent,
  getGradesBySchool,
  updateCanonicalKioskClass,
  updateLegacyKioskClass,
  updateUser,
  getSettingsForSchool,
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
import type { KioskSession, Pass } from "../../schema/passpilot.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";
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
  normalizePasspilotPass,
} from "../../services/passpilotClasses.js";
import {
  authorizePasspilotKiosk,
  issuePasspilotKioskToken,
} from "../../services/passpilotKioskAuth.js";
import {
  getPasspilotKioskClassRecord,
  getPasspilotKioskClassSource,
  recordPasspilotKioskQueryStatements,
  getPasspilotKioskRosterState,
  getPasspilotKioskTeacherIdentity,
  type PasspilotKioskQueryOperation,
} from "../../services/passpilotKioskData.js";
import {
  passpilotKioskClientHealthSchema,
  recordPasspilotKioskClientHealth,
} from "../../services/passpilotKioskHealth.js";
import {
  recordPasspilotKioskCounter,
  recordPasspilotKioskTiming,
} from "../../services/passpilotKioskMetrics.js";
import {
  consumeClasspilotKioskLaunchTicket,
  passpilotKioskLaunchTicketRedemptionSchema,
} from "../../services/classpilotKioskLaunchTicket.js";

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

// Public kiosk requests prefer a short-lived signed token and retain the
// legacy PIN header during the compatibility window. The shared resolver
// reloads current school/license/PIN-hash state on every request, so disabling
// the kiosk, revoking the license, or rotating the PIN invalidates a token on
// the very next request without a normal-poll bcrypt.
async function validateKiosk(
  schoolId: string,
  headers: Record<string, unknown>
) {
  const rawToken = headers["x-kiosk-token"];
  const rawPin = headers["x-kiosk-pin"];
  const result = await authorizePasspilotKiosk({
    schoolId,
    token: typeof rawToken === "string" ? rawToken.trim() : undefined,
    pin: typeof rawPin === "string" ? rawPin : undefined,
  });
  if (!result.ok) {
    return {
      error: result.error,
      status: result.status,
      code: result.code,
      school: null,
      authorization: null,
    };
  }
  return {
    error: null,
    status: 200,
    code: undefined,
    school: result.state.school,
    authorization: result,
  };
}

function respondKioskAuthorizationError(
  res: any,
  result: Awaited<ReturnType<typeof validateKiosk>>
) {
  return res
    .status(result.status)
    .json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
}

async function runWithKioskTenantContext<T>(
  schoolId: string,
  fn: () => Promise<T>
): Promise<T> {
  recordPasspilotKioskCounter("tenantCheckouts");
  return runWithTenantContext({ schoolId }, fn);
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

// Same-device continuity proof (X-Kiosk-Device-Prev): when a page adopts the
// managed device id over a previously minted random one, it presents the
// replaced id once so a live session stamped with the old id can migrate.
function getKioskPrevDeviceId(req: { headers: Record<string, unknown> }): string | null {
  const value = req.headers["x-kiosk-device-prev"];
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
  schoolId: string,
  operation?: PasspilotKioskQueryOperation
): Promise<{ session: KioskSession; kioskName: string | null } | null | undefined> {
  const sessionId = getKioskSessionId(req);
  if (!sessionId) return undefined;
  if (operation) recordPasspilotKioskQueryStatements(operation);
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
    ? await kioskSessionTeacherIdentity(schoolId, session.teacherId, operation)
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
async function kioskSessionTeacherIdentity(
  schoolId: string,
  teacherId: string,
  operation?: PasspilotKioskQueryOperation
) {
  return getPasspilotKioskTeacherIdentity(schoolId, teacherId, operation);
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

function kioskSnapshotPass(pass: Pass) {
  return {
    id: pass.id,
    studentId: pass.studentId,
    destination: pass.destination,
    customDestination: pass.customDestination,
    status: pass.status,
    issuedAt: pass.issuedAt,
    duration: pass.duration,
    expiresAt: pass.expiresAt,
    returnedAt: pass.returnedAt,
    issuedVia: pass.issuedVia,
    notes: pass.notes,
  };
}

function kioskSnapshotEtag(payload: unknown): { etag: string; revision: string } {
  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("base64url");
  return { revision, etag: `"${revision}"` };
}

// POST /api/passpilot/kiosk/auth - Exchange a configured PIN for a short-lived
// polling token. The PIN remains supported directly on all public endpoints
// during the compatibility period.
router.post("/auth", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }
    const rawPin = req.headers["x-kiosk-pin"];
    const authorization = await authorizePasspilotKiosk({
      schoolId,
      pin: typeof rawPin === "string" ? rawPin : undefined,
    });
    if (!authorization.ok) {
      return res.status(authorization.status).json({
        error: authorization.error,
        ...(authorization.code ? { code: authorization.code } : {}),
      });
    }
    const issued = issuePasspilotKioskToken(authorization.state);
    return res.json({
      token: issued.token,
      expiresInSeconds: issued.expiresInSeconds,
      expiresAt: issued.expiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/launch-ticket/redeem - Exchange a one-use
// ClassPilot handoff for an opaque, school-scoped kiosk device id. Redemption
// is continuity only: current PIN/token authorization is required first and
// the returned id is never accepted as a kiosk credential.
router.post("/launch-ticket/redeem", kioskLimiter, async (req, res, next) => {
  try {
    const parsed = passpilotKioskLaunchTicketRedemptionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid kiosk launch ticket",
        code: "PASSPILOT_KIOSK_LAUNCH_TICKET_INVALID",
      });
    }
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }
    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }

    return await runWithKioskTenantContext(schoolId, async () => {
      const continuity = await consumeClasspilotKioskLaunchTicket({
        ticket: parsed.data.ticket,
        schoolId,
      });
      if (!continuity) {
        return res.status(404).json({
          error: "Kiosk launch ticket is invalid or expired",
          code: "PASSPILOT_KIOSK_LAUNCH_TICKET_INVALID",
        });
      }
      return res.json({
        continuityOnly: true,
        deviceId: continuity.deviceId,
      });
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/snapshot?classId= - One bounded, revisioned read
// for the kiosk controller. It replaces separate config + roster polling but
// does not remove either legacy route.
router.get("/snapshot", kioskLimiter, async (req, res, next) => {
  const startedAt = performance.now();
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }
    const classId = typeof req.query.classId === "string"
      ? req.query.classId.trim()
      : "";
    if (!classId) {
      return res.status(400).json({ error: "classId required" });
    }

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    return await runWithKioskTenantContext(schoolId, async () => {
      const resolved = await requireActiveKioskSession(
        req,
        res,
        schoolId,
        "snapshot"
      );
      if (resolved === null) return;
      const kioskSession: KioskSession | null = resolved?.session ?? null;
      const source = await getPasspilotKioskClassSource(schoolId, "snapshot");
      if (
        source === "classpilot_groups" &&
        !requireKioskClassCapability(req, res)
      ) {
        return;
      }
      if (kioskSession?.classSource && kioskSession.classSource !== source) {
        await forceReleaseKioskSession(schoolId, kioskSession.id);
        return respondKioskSessionExpired(res);
      }

      const configuredClassId = kioskSession
        ? kioskSessionClassId(kioskSession)
        : source === "classpilot_groups"
          ? school.kioskClasspilotGroupId
          : school.kioskGradeId;
      if (kioskSession && !configuredClassId) {
        return res.status(409).json({
          error: "A class must be sent to this kiosk before a snapshot can be loaded.",
          code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
        });
      }
      if (configuredClassId && configuredClassId !== classId) {
        return res.status(409).json({
          error: "The selected class does not match the configured kiosk class.",
          code: "PASSPILOT_KIOSK_CLASS_CHANGED",
        });
      }
      if (source === "classpilot_groups" && !configuredClassId) {
        return res.status(409).json({
          error:
            "An administrator must select a kiosk class before a snapshot can be loaded.",
          code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
        });
      }

      const classRecord = await getPasspilotKioskClassRecord(
        schoolId,
        source,
        classId,
        "snapshot"
      );
      if (!classRecord) {
        return res.status(409).json({
          error:
            "The configured kiosk class is no longer active. Ask an administrator to select an active class.",
          code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
          source,
          kioskStyle: school.kioskStyle,
        });
      }
      if (kioskSession) {
        recordPasspilotKioskQueryStatements("snapshot");
        await touchKioskSessionLastSeen(schoolId, kioskSession.id);
      }

      const { students: studentRows, activePasses } =
        await getPasspilotKioskRosterState(
          schoolId,
          source,
          classId,
          "snapshot"
        );
      const legacyIdentity = !resolved && school.kioskActivatedByUserId
        ? await kioskSessionTeacherIdentity(
            schoolId,
            school.kioskActivatedByUserId,
            "snapshot"
          )
        : null;
      const kioskName = resolved?.kioskName ?? legacyIdentity?.kioskName ?? null;
      const session = kioskSession
        ? {
            id: kioskSession.id,
            status: kioskSession.status,
            source: kioskSession.classSource,
            classId,
            gradeId: source === "legacy_grades" ? classId : null,
            className: classRecord.name,
            kioskName,
            revision: kioskSession.revision,
          }
        : null;
      const config = {
        source,
        classId,
        gradeId: source === "legacy_grades" ? classId : null,
        className: classRecord.name,
        kioskName,
        kioskEnabled: school.kioskEnabled,
        kioskRequiresApproval: school.kioskRequiresApproval,
        defaultPassDuration: school.defaultPassDuration,
        kioskStyle: school.kioskStyle,
      };
      const roster = studentRows.map((student) => ({
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        classId,
        gradeId: source === "legacy_grades" ? classId : null,
        studentIdNumber: student.studentIdNumber || null,
        status: student.status,
      }));
      const passRows = activePasses.map(kioskSnapshotPass);
      const revisionBase = {
        config,
        session,
        roster,
        passes: passRows,
        revisions: {
          config: school.passpilotSettingsRevision,
          session: kioskSession?.revision ?? null,
        },
      };
      const { etag, revision } = kioskSnapshotEtag(revisionBase);
      res.setHeader("ETag", etag);
      if (req.headers["if-none-match"] === etag) {
        recordPasspilotKioskCounter("snapshotNotModified");
        return res.status(304).end();
      }
      return res.json({
        ...revisionBase,
        revisions: { ...revisionBase.revisions, snapshot: revision },
      });
    });
  } catch (err) {
    next(err);
  } finally {
    recordPasspilotKioskTiming("snapshotMs", performance.now() - startedAt);
  }
});

// POST /api/passpilot/kiosk/client-health - Bounded transition telemetry. A
// client reports only after three consecutive failures and once on recovery;
// duplicate event types are suppressed for five minutes per exact kiosk scope.
router.post("/client-health", kioskLimiter, async (req, res, next) => {
  try {
    const parsed = passpilotKioskClientHealthSchema.safeParse(req.body);
    if (!parsed.success) {
      recordPasspilotKioskCounter("clientHealthRejected");
      return res.status(400).json({
        error: "Invalid kiosk health event",
        code: "PASSPILOT_KIOSK_HEALTH_INVALID",
      });
    }
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }
    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }

    return await runWithKioskTenantContext(schoolId, async () => {
      const resolved = await requireActiveKioskSession(req, res, schoolId);
      if (resolved === null) return;
      const result = await recordPasspilotKioskClientHealth({
        schoolId,
        kioskScopeId: resolved?.session.id ?? getKioskDeviceId(req),
        health: parsed.data,
      });
      if (!result.accepted) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
      }
      return res.status(202).json({ accepted: result.accepted });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/session - Create or resume a kiosk device session.
// Public (PIN-gated). Idempotent: a live presented session is returned as-is,
// so PIN re-entry or a page reload never rotates the claim code.
router.post("/session", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }
    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    await runWithKioskTenantContext(schoolId, async () => {
      const deviceId = getKioskDeviceId(req);
      const presentedId = getKioskSessionId(req);
      if (presentedId) {
        const existing = await getLiveKioskSessionById(schoolId, presentedId);
        if (existing) {
          if (deviceId) {
            // Stamp the device on the session; an active session (the
            // /sessions/self handoff) also writes the durable binding here.
            await adoptKioskSessionDevice(
              schoolId,
              existing.id,
              deviceId,
              getKioskPrevDeviceId(req)
            );
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
    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    await runWithKioskTenantContext(schoolId, async () => {
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }

    const parsed = kioskLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Student ID number required" });
    }

    await runWithKioskTenantContext(schoolId, async () => {
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    const parsed = kioskCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    await runWithKioskTenantContext(schoolId, async () => {
    // Resolve the optional teacher-bound session before reading or mutating
    // any other tenant state. The resolved identity is reused throughout the
    // request and is never reloaded after side effects begin.
    const resolved = await requireActiveKioskSession(req, res, schoolId);
    if (resolved === null) return;
    const kioskSession: KioskSession | null = resolved?.session ?? null;

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

    // Kiosk label + pass attribution.
    let kioskName: string | null = null;
    let attributedTeacherId: string | null = null;
    if (resolved && kioskSession) {
      kioskName = resolved.kioskName;
      attributedTeacherId = kioskSession.teacherId;
    } else if (school.kioskActivatedByUserId) {
      const activatingIdentity = await kioskSessionTeacherIdentity(
        schoolId,
        school.kioskActivatedByUserId
      );
      if (activatingIdentity) {
        kioskName = activatingIdentity.kioskName;
        attributedTeacherId = school.kioskActivatedByUserId;
      }
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }

    await runWithKioskTenantContext(schoolId, async () => {
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    const inventory = await runWithKioskTenantContext(schoolId, async () => {
      const resolved = await requireActiveKioskSession(req, res, schoolId);
      if (resolved === null) return null;
      return getPasspilotClasses(schoolId, { userId: "kiosk", manager: true });
    });
    if (!inventory) return;
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    const startedAt = performance.now();
    try {
      return await runWithKioskTenantContext(schoolId, async () => {
        const resolved = await requireActiveKioskSession(
          req,
          res,
          schoolId,
          "students"
        );
        if (resolved === null) return;
        const kioskSession: KioskSession | null = resolved?.session ?? null;
        const source = await getPasspilotKioskClassSource(schoolId, "students");
        if (
          source === "classpilot_groups" &&
          !requireKioskClassCapability(req, res)
        ) {
          return;
        }
        if (kioskSession?.classSource && kioskSession.classSource !== source) {
          // Class-model cutover mid-session: invalidate rather than remap silently.
          await forceReleaseKioskSession(schoolId, kioskSession.id);
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
            error:
              "An administrator must select a kiosk class before students can be loaded.",
            code: "PASSPILOT_KIOSK_CLASS_REQUIRED",
          });
        }

        const classRecord = await getPasspilotKioskClassRecord(
          schoolId,
          source,
          classId,
          "students"
        );
        if (!classRecord) {
          return res.status(409).json({
            error:
              "The configured kiosk class is no longer active. Ask an administrator to select an active class.",
            code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
            source,
          });
        }

        const { students: studentsList, activePasses } =
          await getPasspilotKioskRosterState(
            schoolId,
            source,
            classId,
            "students"
          );
        const passMap = new Map(activePasses.map((pass) => [pass.studentId, pass]));
        const result = studentsList.map((student) => ({
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          classId,
          gradeId: source === "legacy_grades" ? classId : null,
          studentIdNumber: student.studentIdNumber || null,
          status: student.status,
          activePass: passMap.get(student.id) || null,
        }));

        return res.json({ source, classId, students: result });
      });
    } finally {
      recordPasspilotKioskTiming("studentsMs", performance.now() - startedAt);
    }
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

    const kioskAuthorization = await validateKiosk(schoolId, req.headers);
    if (!kioskAuthorization.school) {
      return respondKioskAuthorizationError(res, kioskAuthorization);
    }
    const { school } = kioskAuthorization;

    const startedAt = performance.now();
    try {
      return await runWithKioskTenantContext(schoolId, async () => {
        const sessionId = getKioskSessionId(req);
        if (sessionId) {
          // Per-device session branch: config comes from the session, not the
          // school-global slot. Every lookup shares this one tenant checkout.
          recordPasspilotKioskQueryStatements("config");
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
          recordPasspilotKioskQueryStatements("config");
          await touchKioskSessionLastSeen(schoolId, session.id);
          const identity = session.teacherId
            ? await kioskSessionTeacherIdentity(
                schoolId,
                session.teacherId,
                "config"
              )
            : null;
          if (!identity) {
            // Teacher is no longer active staff — never leave an ownerless kiosk.
            await forceReleaseKioskSession(schoolId, session.id);
            return respondKioskSessionExpired(res);
          }
          const classSource = await getPasspilotKioskClassSource(
            schoolId,
            "config"
          );
          if (session.classSource && session.classSource !== classSource) {
            // Class-model cutover mid-session: invalidate, teacher re-claims.
            await forceReleaseKioskSession(schoolId, session.id);
            return respondKioskSessionExpired(res);
          }
          if (
            classSource === "classpilot_groups" &&
            !requireKioskClassCapability(req, res)
          ) {
            return;
          }
          const classId = kioskSessionClassId(session);
          const classRecord = classId
            ? await getPasspilotKioskClassRecord(
                schoolId,
                classSource,
                classId,
                "config"
              )
            : null;
          if (classId && !classRecord) {
            // kioskStyle rides the 409 too: a kiosk parked on this error still
            // polls config and must observe an admin style flip.
            return res.status(409).json({
              error:
                "The configured kiosk class is no longer active. Ask your teacher to send a new class to this kiosk.",
              code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
              source: classSource,
              session: { id: session.id, status: session.status },
              kioskStyle: school.kioskStyle,
            });
          }
          return res.json({
            session: { id: session.id, status: session.status },
            source: session.classSource,
            classId,
            gradeId: session.classSource === "legacy_grades" ? classId : null,
            className: classRecord?.name ?? null,
            kioskName: identity.kioskName,
            kioskEnabled: school.kioskEnabled,
            kioskRequiresApproval: school.kioskRequiresApproval,
            defaultPassDuration: school.defaultPassDuration,
            kioskStyle: school.kioskStyle,
          });
        }

        const classSource = await getPasspilotKioskClassSource(
          schoolId,
          "config"
        );
        if (
          classSource === "classpilot_groups" &&
          !requireKioskClassCapability(req, res)
        ) {
          return;
        }
        const classId =
          classSource === "classpilot_groups"
            ? school.kioskClasspilotGroupId || null
            : school.kioskGradeId || null;
        const classRecord = classId
          ? await getPasspilotKioskClassRecord(
              schoolId,
              classSource,
              classId,
              "config"
            )
          : null;
        if (classId && !classRecord) {
          return res.status(409).json({
            error:
              "The configured kiosk class is no longer active. Ask an administrator to select an active class.",
            code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
            source: classSource,
            kioskStyle: school.kioskStyle,
          });
        }
        const identity = school.kioskActivatedByUserId
          ? await kioskSessionTeacherIdentity(
              schoolId,
              school.kioskActivatedByUserId,
              "config"
            )
          : null;
        return res.json({
          source: classSource,
          classId,
          gradeId: classSource === "legacy_grades" ? classId : null,
          className: classRecord?.name ?? null,
          kioskName: identity?.kioskName ?? null,
          kioskEnabled: school.kioskEnabled,
          kioskRequiresApproval: school.kioskRequiresApproval,
          defaultPassDuration: school.defaultPassDuration,
          kioskStyle: school.kioskStyle,
        });
      });
    } finally {
      recordPasspilotKioskTiming("configMs", performance.now() - startedAt);
    }
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
// to the requesting teacher. classId is optional: without it the kiosk shows
// the teacher's name and waits for Send to Kiosk (same contract as
// /sessions/self); with it (the My Class entry point) the class shows
// immediately.
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
      let target: KioskClassTarget | null = null;
      if (parsed.data.classId) {
        target = await resolveKioskClassTarget(req, res, schoolId, parsed.data.classId);
        if (!target) return;
        if (!(await canAccessPasspilotClass(req.authUser!, schoolId, parsed.data.classId, role))) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
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
