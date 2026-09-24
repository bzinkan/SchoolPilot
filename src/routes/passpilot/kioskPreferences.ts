import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import db from "../../db.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole, getRequestPassPilotRole, getPasspilotClassSourceForSchool } from "../../services/passpilotAccess.js";
import { getKioskPreferences, saveKioskPreferences, kioskTeacher, kioskClasses, resolveKioskAssignment, lockKioskSchool, assertKioskScheduleEditor } from "../../services/passpilotKioskAssignments.js";
import { kioskModeSchema, kioskScheduleSchema, kioskError } from "../../services/passpilotKioskSchedule.js";
import { schoolMemberships, users } from "../../schema/core.js";
import { passpilotKioskSessions, type KioskSession } from "../../schema/passpilot.js";
import { logAudit } from "../../services/audit.js";
import { resolveClasspilotEntitlement } from "../../services/classpilotEntitlement.js";

const router = Router();
router.use(authenticate, requireSchoolContext, requireActiveSchool, requireProductLicense("PASSPILOT"),
  requirePassPilotRole("teacher", "admin", "school_admin"));
const updateSchema = z.object({ mode: kioskModeSchema, schedule: kioskScheduleSchema, expectedRevision: z.number().int().min(0) }).strict();

router.get("/teachers", async (req, res, next) => {
  try {
    const role = await getRequestPassPilotRole(req, res);
    const admin = ["admin", "school_admin", "super_admin"].includes(role!);
    const teachers = await db.selectDistinct({ id: users.id, name: users.displayName, firstName: users.firstName, lastName: users.lastName })
      .from(schoolMemberships).innerJoin(users, eq(users.id, schoolMemberships.userId))
      .where(and(eq(schoolMemberships.schoolId, res.locals.schoolId!), eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]), admin ? undefined : eq(users.id, req.authUser!.id)));
    res.json({ teachers });
  } catch (error) { next(error); }
});
router.use(async (req, res, next) => {
  try {
    const teacherId = typeof req.query.teacherId === "string" ? req.query.teacherId : req.authUser!.id;
    const role = await getRequestPassPilotRole(req, res);
    if (teacherId !== req.authUser!.id && !["admin", "school_admin", "super_admin"].includes(role!)) throw kioskError("Only administrators can manage another teacher's schedule.", "FORBIDDEN", 403);
    const teacher = await kioskTeacher(res.locals.schoolId!, teacherId);
    if (teacher.role === "office_staff") throw kioskError("Schedule settings are available to teachers and administrators.", "FORBIDDEN", 403);
    res.locals.kioskTeacherId = teacherId;
    next();
  } catch (error) { next(error); }
});
router.get("/", async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!, teacherId = res.locals.kioskTeacherId as string;
    const preference = await getKioskPreferences(schoolId, teacherId);
    const source = await getPasspilotClassSourceForSchool(schoolId);
    const classes = await kioskClasses(schoolId, teacherId, source);
    const now = new Date();
    const previewSession: KioskSession = { id: "preview", schoolId, teacherId, classSource: null, gradeId: null, classpilotGroupId: null,
      claimCode: "", status: "active", deviceId: null, revision: 0, createdAt: now, claimedAt: now, lastSeenAt: now,
      releasedAt: null, overrideStartedAt: null, overrideExpiresAt: null };
    let preview;
    try {
      const { roster: _roster, ...state } = await resolveKioskAssignment(schoolId, previewSession);
      preview = state;
    } catch (error) {
      preview = { status: "unavailable", message: error instanceof Error ? error.message : "Schedule unavailable" };
    }
    const canFollowClasspilot = source === "classpilot_groups" && (await resolveClasspilotEntitlement(schoolId)).entitled;
    res.json({ preference, source, classes, preview, canFollowClasspilot });
  } catch (error) { next(error); }
});
router.put("/", async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid schedule" });
    const schoolId = res.locals.schoolId!, teacherId = res.locals.kioskTeacherId as string;
    const preference = await saveKioskPreferences({ ...parsed.data, schoolId, teacherId, actorId: req.authUser!.id });
    await logAudit({ schoolId, userId: req.authUser!.id, action: "kiosk.schedule_updated", entityType: "kiosk_schedule", entityId: teacherId,
      changes: { mode: preference.mode, revision: preference.revision } });
    res.json({ preference });
  } catch (error) { next(error); }
});
router.post("/resume", async (req, res, next) => {
  try {
    const parsed = z.object({ sessionId: z.string().min(1).optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid kiosk selection" });
    const schoolId = res.locals.schoolId!, teacherId = res.locals.kioskTeacherId as string;
    await db.transaction(async tx => {
      await lockKioskSchool(tx as unknown as typeof db, schoolId);
      await assertKioskScheduleEditor(schoolId, teacherId, req.authUser!.id, tx as unknown as typeof db);
      await tx.update(passpilotKioskSessions).set({ overrideStartedAt: null, overrideExpiresAt: null, revision: sql`${passpilotKioskSessions.revision} + 1` })
        .where(and(eq(passpilotKioskSessions.schoolId, schoolId), eq(passpilotKioskSessions.teacherId, teacherId),
          eq(passpilotKioskSessions.status, "active"), parsed.data.sessionId ? eq(passpilotKioskSessions.id, parsed.data.sessionId) : undefined));
    });
    await logAudit({ schoolId, userId: req.authUser!.id, action: "kiosk.automatic_resumed", entityType: "kiosk_schedule", entityId: teacherId });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
export default router;
