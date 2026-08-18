import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  applyClasspilotScheduleChangeAction,
  archiveClasspilotScheduleChangePair,
  createClasspilotScheduleChange,
  createClasspilotScheduleChangePair,
  getClasspilotScheduleChangeById,
  getClasspilotScheduleChangeEligibility,
  getClasspilotScheduleChangeNotificationContext,
  getClasspilotScheduleChangesToday,
  getClasspilotScheduleChangeSettings,
  listClasspilotScheduleChangePairs,
  listClasspilotScheduleChanges,
  updateClasspilotScheduleChangeSettings,
  type ClasspilotScheduleChangeAction,
  type ClasspilotScheduleChangeActor,
} from "../../services/storage.js";
import {
  broadcastClasspilotScheduleChangeUpdate,
  emitClasspilotScheduleChangeMetric,
  sendClasspilotScheduleChangeEmails,
} from "../../services/classpilotScheduleChanges.js";
import { isValidInstructionalCalendarDate } from "../../services/storage.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;
const staffRoles = requireRole("admin", "school_admin", "teacher", "office_staff");
const adminRoles = requireRole("admin", "school_admin");
const ROLE_VALUES = new Set(["admin", "school_admin", "teacher", "office_staff"]);
const ACTION_VALUES = new Set<ClasspilotScheduleChangeAction>([
  "accept",
  "decline",
  "approve",
  "deny",
  "withdraw",
  "cancel",
]);
const SCOPE_VALUES = new Set(["needs_action", "upcoming", "history", "all"]);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function routeError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function actor(req: any, res: any): ClasspilotScheduleChangeActor {
  const membershipRole = String(res.locals.membershipRole || "");
  const role = ROLE_VALUES.has(membershipRole)
    ? membershipRole
    : req.authUser?.isSuperAdmin
      ? "admin"
      : "";
  if (!req.authUser?.id || !ROLE_VALUES.has(role)) {
    throw routeError("SCHEDULE_CHANGE_STAFF_CONTEXT_REQUIRED", "Staff context required.", 403);
  }
  return {
    userId: req.authUser.id,
    userEmail: req.authUser.email,
    role: role as ClasspilotScheduleChangeActor["role"],
  };
}

function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw routeError(
      "INVALID_SCHEDULE_CHANGE_REVISION",
      "expectedRevision must be a non-negative integer."
    );
  }
  return Number(value);
}

function requiredString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw routeError(
      `INVALID_${field.toUpperCase()}`,
      `${field} is required and must be at most ${max} characters.`
    );
  }
  return value.trim();
}

function assertOnlyKeys(body: unknown, keys: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw routeError("INVALID_SCHEDULE_CHANGE_BODY", "A JSON object is required.");
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw routeError(
      "UNKNOWN_SCHEDULE_CHANGE_FIELD",
      `Unknown field: ${unknown[0]}`
    );
  }
  return record;
}

function recordFailure(error: unknown, action: string, role: string): void {
  const code = String((error as { code?: string })?.code || "");
  if (code.includes("REVISION")) {
    emitClasspilotScheduleChangeMetric("ScheduleChangeRevisionConflict", {
      Action: action,
      Role: role,
    });
  } else if (code.includes("CUTOFF") || code.includes("ALREADY_STARTED")) {
    emitClasspilotScheduleChangeMetric("ScheduleChangeCutoffDenied", {
      Action: action,
      Role: role,
    });
  } else if (code.includes("CONFLICT") || code.includes("RESERVED")) {
    emitClasspilotScheduleChangeMetric("ScheduleChangeConflict", {
      Action: action,
      Role: role,
    });
  }
}

async function announceChange(options: {
  schoolId: string;
  changeId: string;
  status: string;
  scheduledDate: string;
  revision: number;
}): Promise<void> {
  void broadcastClasspilotScheduleChangeUpdate(options).catch((error) => {
    console.warn("[ClassPilot schedule changes] Realtime update failed:", (error as Error).message);
  });
  let notification: Awaited<ReturnType<typeof getClasspilotScheduleChangeNotificationContext>>;
  try {
    notification = await getClasspilotScheduleChangeNotificationContext({
      schoolId: options.schoolId,
      changeId: options.changeId,
    });
  } catch (error) {
    console.warn("[ClassPilot schedule changes] Notification lookup failed:", (error as Error).message);
    return;
  }
  if (notification) sendClasspilotScheduleChangeEmails(notification);
}

async function committedChangeResponse(options: {
  schoolId: string;
  change: {
    id: string;
    pairId: string;
    scheduledDate: string;
    status: string;
    revision: number;
  };
  actor: ClasspilotScheduleChangeActor;
}): Promise<unknown> {
  try {
    const hydrated = await getClasspilotScheduleChangeById({
      schoolId: options.schoolId,
      changeId: options.change.id,
      actor: options.actor,
    });
    if (hydrated) return hydrated;
  } catch (error) {
    console.warn(
      "[ClassPilot schedule changes] Committed response hydration failed:",
      (error as Error).message
    );
  }
  // The transaction is already committed. Return an ID-only recovery shape so
  // clients can refetch without retrying the mutation and creating ambiguity.
  return {
    id: options.change.id,
    pairId: options.change.pairId,
    scheduledDate: options.change.scheduledDate,
    status: options.change.status,
    revision: options.change.revision,
    committed: true,
    refreshRequired: true,
  };
}

// GET /api/classpilot/schedule-changes/settings
router.get("/settings", ...auth, staffRoles, async (req, res, next) => {
  try {
    const current = await getClasspilotScheduleChangeSettings(res.locals.schoolId!);
    if (!current) {
      throw routeError(
        "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
        "Schedule-change settings are unavailable.",
        500
      );
    }
    res.setHeader("Cache-Control", "no-store");
    return res.json(current);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/classpilot/schedule-changes/settings
router.patch("/settings", ...auth, adminRoles, async (req, res, next) => {
  const routeActor = actor(req, res);
  try {
    const body = assertOnlyKeys(req.body, [
      "expectedRevision",
      "teacherRequestsEnabled",
      "adminApprovalRequired",
      "sameDayCutoff",
    ]);
    const revision = expectedRevision(body.expectedRevision);
    if (
      body.teacherRequestsEnabled !== undefined &&
      typeof body.teacherRequestsEnabled !== "boolean"
    ) {
      throw routeError("INVALID_TEACHER_REQUEST_POLICY", "teacherRequestsEnabled must be boolean.");
    }
    if (
      body.adminApprovalRequired !== undefined &&
      typeof body.adminApprovalRequired !== "boolean"
    ) {
      throw routeError("INVALID_ADMIN_APPROVAL_POLICY", "adminApprovalRequired must be boolean.");
    }
    if (
      body.sameDayCutoff !== undefined &&
      (typeof body.sameDayCutoff !== "string" || !TIME_PATTERN.test(body.sameDayCutoff))
    ) {
      throw routeError("INVALID_SCHEDULE_CHANGE_CUTOFF", "sameDayCutoff must use HH:MM format.");
    }
    const result = await updateClasspilotScheduleChangeSettings({
      schoolId: res.locals.schoolId!,
      expectedRevision: revision,
      patch: {
        teacherRequestsEnabled: body.teacherRequestsEnabled as boolean | undefined,
        adminApprovalRequired: body.adminApprovalRequired as boolean | undefined,
        sameDayCutoff: body.sameDayCutoff as string | undefined,
      },
      actor: routeActor,
    });
    if (result.status === "conflict") {
      emitClasspilotScheduleChangeMetric("ScheduleChangeRevisionConflict", {
        Action: "settings_update",
        Role: routeActor.role,
      });
      return res.status(409).json({
        error: "Schedule-change settings changed in another session.",
        code: "SCHEDULE_CHANGE_REVISION_CONFLICT",
        current: result.current,
      });
    }
    emitClasspilotScheduleChangeMetric("ScheduleChangeMutation", {
      Action: "settings_update",
      Outcome: "saved",
      Role: routeActor.role,
    });
    void broadcastClasspilotScheduleChangeUpdate({ schoolId: res.locals.schoolId! }).catch(() => undefined);
    return res.json(result.current);
  } catch (error) {
    recordFailure(error, "settings_update", routeActor.role);
    next(error);
  }
});

// GET /api/classpilot/schedule-changes/pairs
router.get("/pairs", ...auth, staffRoles, async (req, res, next) => {
  try {
    const routeActor = actor(req, res);
    const includeArchived =
      (routeActor.role === "admin" || routeActor.role === "school_admin") &&
      req.query.includeArchived === "true";
    const pairs = await listClasspilotScheduleChangePairs({
      schoolId: res.locals.schoolId!,
      actor: routeActor,
      includeArchived,
    });
    return res.json({
      pairs,
      capabilities: {
        canManage: routeActor.role === "admin" || routeActor.role === "school_admin",
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/classpilot/schedule-changes/pairs
router.post("/pairs", ...auth, adminRoles, async (req, res, next) => {
  const routeActor = actor(req, res);
  try {
    const body = assertOnlyKeys(req.body, ["firstGroupId", "secondGroupId"]);
    const saved = await createClasspilotScheduleChangePair({
      schoolId: res.locals.schoolId!,
      firstGroupId: requiredString(body.firstGroupId, "firstGroupId", 100),
      secondGroupId: requiredString(body.secondGroupId, "secondGroupId", 100),
      actor: routeActor,
    });
    const pairs = await listClasspilotScheduleChangePairs({
      schoolId: res.locals.schoolId!,
      actor: routeActor,
      includeArchived: true,
    });
    const current = pairs.find((pair) => pair.id === saved.id);
    emitClasspilotScheduleChangeMetric("ScheduleChangeMutation", {
      Action: "pair_enable",
      Outcome: "saved",
      Role: routeActor.role,
    });
    void broadcastClasspilotScheduleChangeUpdate({ schoolId: res.locals.schoolId! }).catch(() => undefined);
    return res.status(201).json(current);
  } catch (error) {
    recordFailure(error, "pair_enable", routeActor.role);
    next(error);
  }
});

// DELETE /api/classpilot/schedule-changes/pairs/:id
router.delete("/pairs/:id", ...auth, adminRoles, async (req, res, next) => {
  const routeActor = actor(req, res);
  try {
    const body = assertOnlyKeys(req.body, ["expectedRevision"]);
    const result = await archiveClasspilotScheduleChangePair({
      schoolId: res.locals.schoolId!,
      pairId: String(req.params.id || ""),
      expectedRevision: expectedRevision(body.expectedRevision),
      actor: routeActor,
    });
    if (result.status === "not_found") {
      throw routeError("SCHEDULE_CHANGE_PAIR_NOT_FOUND", "Eligible class pair not found.", 404);
    }
    const pairs = await listClasspilotScheduleChangePairs({
      schoolId: res.locals.schoolId!,
      actor: routeActor,
      includeArchived: true,
    });
    const current = pairs.find((pair) => pair.id === result.pair.id);
    if (result.status === "conflict") {
      return res.status(409).json({
        error: "This eligible class pair changed in another session.",
        code: "SCHEDULE_CHANGE_REVISION_CONFLICT",
        current,
      });
    }
    emitClasspilotScheduleChangeMetric("ScheduleChangeMutation", {
      Action: "pair_archive",
      Outcome: "saved",
      Role: routeActor.role,
    });
    void broadcastClasspilotScheduleChangeUpdate({ schoolId: res.locals.schoolId! }).catch(() => undefined);
    return res.json(current);
  } catch (error) {
    recordFailure(error, "pair_archive", routeActor.role);
    next(error);
  }
});

// GET /api/classpilot/schedule-changes/eligibility?date=YYYY-MM-DD
router.get("/eligibility", ...auth, staffRoles, async (req, res, next) => {
  try {
    const scheduledDate = String(req.query.date || "");
    if (!isValidInstructionalCalendarDate(scheduledDate)) {
      throw routeError("INVALID_SCHEDULE_CHANGE_DATE", "date must use YYYY-MM-DD format.");
    }
    return res.json(
      await getClasspilotScheduleChangeEligibility({
        schoolId: res.locals.schoolId!,
        scheduledDate,
        actor: actor(req, res),
      })
    );
  } catch (error) {
    next(error);
  }
});

// GET /api/classpilot/schedule-changes/today
router.get("/today", ...auth, staffRoles, async (req, res, next) => {
  try {
    return res.json(
      await getClasspilotScheduleChangesToday({
        schoolId: res.locals.schoolId!,
        actor: actor(req, res),
      })
    );
  } catch (error) {
    next(error);
  }
});

// GET /api/classpilot/schedule-changes?scope=...
router.get("/", ...auth, staffRoles, async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "upcoming");
    if (!SCOPE_VALUES.has(scope)) {
      throw routeError("INVALID_SCHEDULE_CHANGE_SCOPE", "Invalid schedule-change scope.");
    }
    return res.json(
      await listClasspilotScheduleChanges({
        schoolId: res.locals.schoolId!,
        actor: actor(req, res),
        scope: scope as "needs_action" | "upcoming" | "history" | "all",
      })
    );
  } catch (error) {
    next(error);
  }
});

// POST /api/classpilot/schedule-changes
router.post("/", ...auth, requireRole("admin", "school_admin", "teacher"), async (req, res, next) => {
  const routeActor = actor(req, res);
  try {
    const body = assertOnlyKeys(req.body, ["pairId", "scheduledDate", "reason", "directApprove"]);
    if (body.directApprove !== undefined && typeof body.directApprove !== "boolean") {
      throw routeError("INVALID_DIRECT_APPROVAL", "directApprove must be boolean.");
    }
    const saved = await createClasspilotScheduleChange({
      schoolId: res.locals.schoolId!,
      pairId: requiredString(body.pairId, "pairId", 100),
      scheduledDate: requiredString(body.scheduledDate, "scheduledDate", 10),
      reason: requiredString(body.reason, "reason", 500),
      directApprove: body.directApprove as boolean | undefined,
      actor: routeActor,
    });
    const current = await committedChangeResponse({
      schoolId: res.locals.schoolId!,
      change: saved,
      actor: routeActor,
    });
    emitClasspilotScheduleChangeMetric("ScheduleChangeMutation", {
      Action: "create",
      Outcome: "saved",
      Status: saved.status,
      Role: routeActor.role,
    });
    await announceChange({
      schoolId: res.locals.schoolId!,
      changeId: saved.id,
      status: saved.status,
      scheduledDate: saved.scheduledDate,
      revision: saved.revision,
    });
    return res.status(201).json(current);
  } catch (error) {
    recordFailure(error, "create", routeActor.role);
    next(error);
  }
});

// POST /api/classpilot/schedule-changes/:id/actions
router.post("/:id/actions", ...auth, requireRole("admin", "school_admin", "teacher"), async (req, res, next) => {
  const routeActor = actor(req, res);
  try {
    const body = assertOnlyKeys(req.body, ["action", "expectedRevision", "reason"]);
    if (typeof body.action !== "string" || !ACTION_VALUES.has(body.action as ClasspilotScheduleChangeAction)) {
      throw routeError("INVALID_SCHEDULE_CHANGE_ACTION", "Invalid schedule-change action.");
    }
    const changeId = String(req.params.id || "");
    const visible = await getClasspilotScheduleChangeById({
      schoolId: res.locals.schoolId!,
      changeId,
      actor: routeActor,
    });
    if (!visible) {
      throw routeError("SCHEDULE_CHANGE_NOT_FOUND", "Schedule change not found.", 404);
    }
    const result = await applyClasspilotScheduleChangeAction({
      schoolId: res.locals.schoolId!,
      changeId,
      action: body.action as ClasspilotScheduleChangeAction,
      expectedRevision: expectedRevision(body.expectedRevision),
      reason: typeof body.reason === "string" ? body.reason : undefined,
      actor: routeActor,
    });
    const current = await committedChangeResponse({
      schoolId: res.locals.schoolId!,
      change: result.change,
      actor: routeActor,
    });
    if (result.status === "revision_conflict") {
      emitClasspilotScheduleChangeMetric("ScheduleChangeRevisionConflict", {
        Action: body.action,
        Role: routeActor.role,
      });
      return res.status(409).json({
        error: "This schedule change was updated in another session.",
        code: "SCHEDULE_CHANGE_REVISION_CONFLICT",
        current,
      });
    }
    await announceChange({
      schoolId: res.locals.schoolId!,
      changeId,
      status: result.change.status,
      scheduledDate: result.change.scheduledDate,
      revision: result.change.revision,
    });
    if (result.status === "superseded" || result.status === "expired") {
      emitClasspilotScheduleChangeMetric("ScheduleChangeConflict", {
        Action: body.action,
        Outcome: result.status,
        Role: routeActor.role,
      });
      return res.status(409).json({
        error: result.status === "expired"
          ? "The approval window has closed. Create a new request for another date."
          : "The class configuration changed. Create a new request.",
        code: result.status === "expired"
          ? "SCHEDULE_CHANGE_EXPIRED"
          : "SCHEDULE_CHANGE_SUPERSEDED",
        current,
      });
    }
    emitClasspilotScheduleChangeMetric("ScheduleChangeMutation", {
      Action: body.action,
      Outcome: "saved",
      Status: result.change.status,
      Role: routeActor.role,
    });
    return res.json(current);
  } catch (error) {
    recordFailure(error, "action", routeActor.role);
    next(error);
  }
});

export default router;
