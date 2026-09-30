import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import db from "../db.js";
import { schools, users, schoolMemberships, productLicenses, type User } from "../schema/core.js";
import { students, studentAttendance } from "../schema/students.js";
import { dismissalQueue, dismissalSessions } from "../schema/gopilot.js";
import { settings, auditLogs, studentTimelineEvents } from "../schema/shared.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { passes, passpilotPassDenials, type Pass } from "../schema/passpilot.js";
import { passpilotAppointments as appointments, type PasspilotAppointment } from "../schema/passpilotAppointments.js";
import { readPasspilotAppointmentsMode } from "../config/passpilotAppointmentsMode.js";
import { activeEntitledProducts } from "./productEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { createCanonicalPass, createLegacyPass, takePasspilotClassLock, type PasspilotClassTransaction } from "./storage.js";
import { isPassPilotManager, type PassPilotRole } from "./passpilotAccess.js";
import { primaryRoleFromRoles, SCHOOL_ROLES, type SchoolRole } from "./schoolIdentityModel.js";
import { readStoredSchoolSchedulingConfig, resolveSchoolScheduleDay } from "./classpilotSchedulingRules.js";
import { isWithinTrackingWindow } from "./schoolHours.js";
import { localDateInTimeZone, localDateStartUtc, addLocalDays } from "../util/schoolTime.js";
import { canOverridePasspilotRules, passpilotRuleOverrideAuditMetadata, type PasspilotRuleOutcome } from "./passpilotRules.js";
import { appointmentError, appointmentSchoolYearCutoff, validateAppointmentWindow,
  type AppointmentWindow, type CreateAppointmentInput, type EditAppointmentInput, type ActivateAppointmentInput } from "./passpilotAppointmentsValidation.js";

export type AppointmentActor = Pick<User, "id" | "authVersion">;
type Transaction = PasspilotClassTransaction;

async function context(tx: Transaction, schoolId: string, actor: AppointmentActor, write: boolean) {
  if (readPasspilotAppointmentsMode() !== "on") throw appointmentError(404, "APPOINTMENTS_UNAVAILABLE", "Appointments are unavailable.");
  // Match the established staff/class mutation order before taking an
  // appointment row lock, so revocation and class changes serialize correctly.
  if (write && !(await lockStaffAssignmentLifecycleSchool(tx, schoolId))) {
    throw appointmentError(404, "APPOINTMENT_SCHOOL_NOT_FOUND", "School not found.");
  }
  if (write) await takePasspilotClassLock(tx, schoolId);
  if (write) {
    const grants = await tx.execute<{ ready: boolean }>(sql`SELECT
      has_table_privilege(current_user,'public.passpilot_appointments','SELECT')
      AND has_table_privilege(current_user,'public.passpilot_appointments','INSERT')
      AND has_table_privilege(current_user,'public.passpilot_appointments','UPDATE') AS ready`);
    if (!grants.rows[0]?.ready) throw appointmentError(409, "APPOINTMENT_GRANTS_REQUIRED", "Appointment database grants must be configured before activation.");
  }
  const [school] = await tx.select().from(schools).where(eq(schools.id, schoolId)).limit(1).for("share");
  const licenses = await tx.select().from(productLicenses).where(eq(productLicenses.schoolId, schoolId)).for("share");
  if (!activeEntitledProducts({ school, licenses }).includes("PASSPILOT")) {
    throw appointmentError(403, "APPOINTMENT_NOT_ENTITLED", "An active school and PassPilot license are required.");
  }
  const [user] = await tx.select().from(users).where(eq(users.id, actor.id)).limit(1).for("share");
  if (!user || user.authVersion !== actor.authVersion) throw appointmentError(403, "APPOINTMENT_AUTHORITY_CHANGED", "Staff access changed. Sign in again.");
  let role: PassPilotRole;
  if (user.isSuperAdmin) role = "super_admin";
  else {
    const memberships = await tx.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId),
      eq(schoolMemberships.userId, actor.id), eq(schoolMemberships.status, "active"))).for("share");
    const roles = memberships.map(membership => membership.role).filter((role): role is SchoolRole => (SCHOOL_ROLES as readonly string[]).includes(role));
    const currentRole = roles.length ? primaryRoleFromRoles(roles) : null;
    if (!currentRole || !["admin", "school_admin", "office_staff", "teacher"].includes(currentRole)) {
      throw appointmentError(403, "APPOINTMENT_ACCESS_DENIED", "No PassPilot access for this school.");
    }
    role = currentRole as PassPilotRole;
  }
  const [schoolSettings] = await tx.select().from(settings).where(eq(settings.schoolId, schoolId)).limit(1).for("share");
  if (!schoolSettings) throw appointmentError(409, "APPOINTMENT_SETTINGS_REQUIRED", "Configure school settings before using appointments.");
  const [schedule] = await tx.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1).for("share");
  const timeZone = school!.schoolTimezone || "America/New_York";
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0)); }
  catch { throw appointmentError(409, "APPOINTMENT_TIME_ZONE_INVALID", "Configure a valid school timezone before using appointments."); }
  return { schoolId, actor, role, timeZone, schoolSettings, schedule: readStoredSchoolSchedulingConfig(schedule?.config) };
}
type Context = Awaited<ReturnType<typeof context>>;

/** Current official/legacy assignment, never historical pass authorship. */
function currentStudentAccess(ctx: Context): SQL {
  if (isPassPilotManager(ctx.role)) return sql`TRUE`;
  const studentId = appointments.studentId;
  return sql`EXISTS (SELECT 1 FROM students AS current_student
    WHERE current_student.school_id=${ctx.schoolId} AND current_student.id=${studentId} AND current_student.status='active'
    AND (${ctx.schoolSettings.passpilotClassSource}='classpilot_groups' AND EXISTS (
      SELECT 1 FROM groups AS current_class JOIN group_students AS roster ON roster.group_id=current_class.id
      LEFT JOIN group_teachers AS co_teacher ON co_teacher.group_id=current_class.id
      WHERE current_class.school_id=${ctx.schoolId} AND current_class.group_type='admin_class' AND current_class.status='active'
        AND roster.student_id=current_student.id AND (current_class.teacher_id=${ctx.actor.id} OR co_teacher.teacher_id=${ctx.actor.id})
    ) OR ${ctx.schoolSettings.passpilotClassSource}<>'classpilot_groups' AND EXISTS (
      SELECT 1 FROM grades AS current_grade JOIN teacher_grades AS current_teacher ON current_teacher.grade_id=current_grade.id
      WHERE current_grade.school_id=${ctx.schoolId} AND current_teacher.teacher_id=${ctx.actor.id}
        AND (current_student.grade_id=current_grade.id OR EXISTS (SELECT 1 FROM passpilot_grade_students AS roster
          WHERE roster.school_id=${ctx.schoolId} AND roster.grade_id=current_grade.id AND roster.student_id=current_student.id))
    )))`;
}

function manager(ctx: Context) {
  if (!isPassPilotManager(ctx.role)) throw appointmentError(403, "APPOINTMENT_MANAGER_REQUIRED", "Only PassPilot managers can schedule, edit or cancel appointments.");
}
async function student(tx: Transaction, ctx: Context, studentId: string) {
  const [row] = await tx.select().from(students).where(and(eq(students.schoolId, ctx.schoolId), eq(students.id, studentId), eq(students.status, "active"))).limit(1).for("share");
  if (!row) throw appointmentError(404, "APPOINTMENT_STUDENT_NOT_FOUND", "Active student not found.");
  return row;
}
async function audit(tx: Transaction, ctx: Context, action: string, id: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({ schoolId: ctx.schoolId, userId: ctx.actor.id, userRole: ctx.role,
    action: `passpilot.appointment.${action}`, entityType: "passpilot_appointment", entityId: id, metadata });
}
function projection(row: PasspilotAppointment, ctx: Context, now = new Date()) {
  const { staffNotes, createFingerprint: _fingerprint, createRequestId: _requestId, notesScrubbedAt: _scrubbed, ...publicRow } = row;
  const status = row.status === "scheduled" && row.endsAt <= now ? "missed" as const : row.status;
  return { ...publicRow, status, ...(isPassPilotManager(ctx.role) ? { staffNotes: row.retainedUntil > now ? staffNotes : null } : {}) };
}
async function selected(tx: Transaction, ctx: Context, id: string, lock = false) {
  const query = tx.select().from(appointments).where(and(eq(appointments.schoolId, ctx.schoolId), eq(appointments.id, id), currentStudentAccess(ctx))).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw appointmentError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found.");
  return row;
}
function checkRevision(row: PasspilotAppointment, expected: number) {
  if (row.revision !== expected) throw appointmentError(409, "APPOINTMENT_REVISION_CHANGED", "Appointment changed. Refresh before continuing.");
}
function pending(row: PasspilotAppointment) {
  if (row.status !== "scheduled") throw appointmentError(409, "APPOINTMENT_NOT_PENDING", "Only an unactivated appointment can be edited or cancelled. Use the linked pass controls after activation.");
}
function scheduledWindow(ctx: Context, input: AppointmentWindow, now: Date) {
  validateAppointmentWindow(input);
  const retainedUntil = appointmentSchoolYearCutoff(ctx.schedule, ctx.timeZone, input.startsAt, input.endsAt);
  if (input.endsAt <= now) throw appointmentError(400, "APPOINTMENT_WINDOW_PASSED", "Choose an appointment window that has not ended.");
  if (!resolveSchoolScheduleDay(localDateInTimeZone(input.startsAt, ctx.timeZone), ctx.schedule, ctx.schoolSettings.instructionalCalendar ?? {}).instructional) {
    throw appointmentError(409, "APPOINTMENT_SCHOOL_CLOSED", "Appointments require an instructional school date.");
  }
  return retainedUntil;
}

export async function createPasspilotAppointment(schoolId: string, actor: AppointmentActor, input: CreateAppointmentInput) {
  return db.transaction(async (tx) => {
    const ctx = await context(tx, schoolId, actor, true); manager(ctx);
    const fingerprint = createHash("sha256").update(JSON.stringify({ studentId: input.studentId, destination: input.destination,
      customDestination: input.customDestination, staffNotes: input.staffNotes, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), duration: input.duration })).digest("hex");
    const [existing] = await tx.select().from(appointments).where(and(eq(appointments.schoolId, schoolId), eq(appointments.createdBy, actor.id), eq(appointments.createRequestId, input.requestId))).limit(1);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) throw appointmentError(409, "APPOINTMENT_REQUEST_REUSED", "Use a new request ID for a different appointment.");
      return { appointment: projection(existing, ctx), replayed: true };
    }
    await student(tx, ctx, input.studentId);
    const retainedUntil = scheduledWindow(ctx, input, new Date());
    const { requestId: _requestId, ...fields } = input;
    const [row] = await tx.insert(appointments).values({ ...fields, schoolId, createdBy: actor.id, updatedBy: actor.id,
      createRequestId: input.requestId, createFingerprint: fingerprint, schoolTimezone: ctx.timeZone, retainedUntil }).returning();
    await audit(tx, ctx, "created", row!.id);
    return { appointment: projection(row!, ctx), replayed: false };
  });
}

export async function editPasspilotAppointment(schoolId: string, actor: AppointmentActor, id: string, input: EditAppointmentInput) {
  return db.transaction(async (tx) => {
    const ctx = await context(tx, schoolId, actor, true); manager(ctx);
    const row = await selected(tx, ctx, id, true); checkRevision(row, input.expectedRevision); pending(row);
    const { expectedRevision: _expected, ...changes } = input;
    const merged = { ...row, ...changes };
    await student(tx, ctx, merged.studentId);
    const retainedUntil = scheduledWindow(ctx, merged, new Date());
    const [updated] = await tx.update(appointments).set({ ...changes, retainedUntil, schoolTimezone: ctx.timeZone,
      revision: row.revision + 1, updatedBy: actor.id, updatedAt: new Date() }).where(and(eq(appointments.schoolId, schoolId), eq(appointments.id, id))).returning();
    await audit(tx, ctx, "updated", id, { fields: Object.keys(changes), revision: updated!.revision });
    return { appointment: projection(updated!, ctx) };
  });
}

export async function cancelPasspilotAppointment(schoolId: string, actor: AppointmentActor, id: string, expectedRevision: number) {
  return db.transaction(async (tx) => {
    const ctx = await context(tx, schoolId, actor, true); manager(ctx);
    const row = await selected(tx, ctx, id, true);
    if (row.status === "cancelled" && !row.passId) return { appointment: projection(row, ctx), replayed: true };
    checkRevision(row, expectedRevision); pending(row);
    const [updated] = await tx.update(appointments).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date(), updatedBy: actor.id,
      revision: row.revision + 1 }).where(and(eq(appointments.schoolId, schoolId), eq(appointments.id, id))).returning();
    await audit(tx, ctx, "cancelled", id);
    return { appointment: projection(updated!, ctx), replayed: false };
  });
}

export async function getPasspilotAppointment(schoolId: string, actor: AppointmentActor, id: string) {
  return db.transaction(async (tx) => { const ctx = await context(tx, schoolId, actor, false); return { appointment: projection(await selected(tx, ctx, id), ctx) }; });
}

export type AppointmentListInput = { from?: Date; through?: Date; status?: PasspilotAppointment["status"]; limit: number; cursor?: { startsAt: Date; id: string }; studentId?: string };
export async function getPasspilotAppointmentsCapabilities(schoolId: string, actor: AppointmentActor) {
  return db.transaction(async tx => {
    const ctx = await context(tx, schoolId, actor, false);
    return { enabled: true, manager: isPassPilotManager(ctx.role), teacherReminders: ctx.role === "teacher",
      schoolTimezone: ctx.timeZone, schoolYearConfigured: Boolean(ctx.schedule.yearStart && ctx.schedule.yearEnd) };
  });
}
export async function listPasspilotAppointments(schoolId: string, actor: AppointmentActor, input: AppointmentListInput, accessRequest = false) {
  return db.transaction(async (tx) => {
    const ctx = await context(tx, schoolId, actor, false);
    if (accessRequest && !canOverridePasspilotRules(ctx.role)) throw appointmentError(403, "APPOINTMENT_RECORDS_FORBIDDEN", "Only administrators can export appointment records.");
    const today = localDateInTimeZone(new Date(), ctx.timeZone);
    const from = input.from ?? localDateStartUtc(today, ctx.timeZone);
    const through = input.through ?? localDateStartUtc(addLocalDays(today, 7), ctx.timeZone);
    if (from >= through || through.getTime() - from.getTime() > 550 * 86400000) throw appointmentError(400, "APPOINTMENT_RANGE_INVALID", "Choose a bounded appointment date range.");
    const conditions = [eq(appointments.schoolId, schoolId), currentStudentAccess(ctx), gt(appointments.retainedUntil, new Date()),
      gte(appointments.startsAt, from), lt(appointments.startsAt, through)];
    if (input.studentId) conditions.push(eq(appointments.studentId, input.studentId));
    if (input.status) conditions.push(sql`(CASE WHEN ${appointments.status}='scheduled' AND ${appointments.endsAt}<=now() THEN 'missed' ELSE ${appointments.status} END)=${input.status}`);
    if (input.cursor) conditions.push(or(gt(appointments.startsAt, input.cursor.startsAt), and(eq(appointments.startsAt, input.cursor.startsAt), gt(appointments.id, input.cursor.id)))!);
    const rows = await tx.select({ appointment: appointments, firstName: students.firstName, lastName: students.lastName })
      .from(appointments).innerJoin(students, and(eq(students.schoolId, appointments.schoolId), eq(students.id, appointments.studentId)))
      .where(and(...conditions)).orderBy(asc(appointments.startsAt), asc(appointments.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit), last = page.at(-1);
    if (accessRequest) await audit(tx, ctx, "records_exported", input.studentId ?? schoolId, { count: page.length });
    return { appointments: page.map(({ appointment, firstName, lastName }) => ({ ...projection(appointment, ctx), studentName: [firstName, lastName].filter(Boolean).join(" ") })),
      nextCursor: rows.length > input.limit && last ? { startsAt: last.appointment.startsAt, id: last.appointment.id } : null };
  });
}

export async function activatePasspilotAppointment(schoolId: string, actor: AppointmentActor, id: string, input: ActivateAppointmentInput) {
  return db.transaction(async (tx) => {
    const ctx = await context(tx, schoolId, actor, true);
    const row = await selected(tx, ctx, id, true);
    if (row.passId) {
      const [pass] = await tx.select().from(passes).where(and(eq(passes.schoolId, schoolId), eq(passes.studentId, row.studentId), eq(passes.id, row.passId))).limit(1);
      if (!pass) throw appointmentError(410, "APPOINTMENT_PASS_REMOVED", "The linked retained pass is no longer available.");
      return { appointment: projection(row, ctx), pass, viewerRole: ctx.role, replayed: true, missed: false };
    }
    await student(tx, ctx, row.studentId);
    if (row.status !== "scheduled") throw appointmentError(409, "APPOINTMENT_NOT_PENDING", "This appointment cannot issue another pass.");
    checkRevision(row, input.expectedRevision);
    const now = new Date(); // After every lock wait, never the transaction-start clock.
    if (now >= row.endsAt) {
      const [missed] = await tx.update(appointments).set({ status: "missed", missedAt: now, updatedAt: now, revision: row.revision + 1 })
        .where(and(eq(appointments.schoolId, schoolId), eq(appointments.id, id))).returning();
      await audit(tx, ctx, "missed", id);
      return { appointment: projection(missed!, ctx, now), pass: null, viewerRole: ctx.role, replayed: false, missed: true };
    }
    if (now < row.startsAt) throw appointmentError(409, "APPOINTMENT_TOO_EARLY", "The appointment activation window has not opened.");
    if (ctx.timeZone !== row.schoolTimezone) throw appointmentError(409, "APPOINTMENT_TIME_ZONE_CHANGED", "School timezone changed. Ask a manager to review the appointment.");
    appointmentSchoolYearCutoff(ctx.schedule, ctx.timeZone, row.startsAt, row.endsAt);
    const localDate = localDateInTimeZone(now, ctx.timeZone);
    if (!resolveSchoolScheduleDay(localDate, ctx.schedule, ctx.schoolSettings.instructionalCalendar ?? {}).instructional
      || !isWithinTrackingWindow({ ...ctx.schoolSettings, schoolTimezone: ctx.timeZone }, now)) throw appointmentError(409, "APPOINTMENT_SCHOOL_CLOSED", "Passes cannot activate while the school is closed or outside operating hours.");
    const [absent] = await tx.select({ id: studentAttendance.id }).from(studentAttendance).where(and(eq(studentAttendance.schoolId, schoolId),
      eq(studentAttendance.studentId, row.studentId), eq(studentAttendance.date, localDate), inArray(studentAttendance.status, ["absent", "early_dismissal"]))).limit(1).for("share");
    if (absent) throw appointmentError(409, "APPOINTMENT_STUDENT_UNAVAILABLE", "A known absence or early dismissal prevents pass activation.");
    // Consume the shared same-day movement fact; GoPilot permissions never
    // grant scheduling or activation authority. Released students are already
    // leaving supervision, so both released and dismissed block a new pass.
    const [dismissed] = await tx.select({ id: dismissalQueue.id }).from(dismissalQueue)
      .innerJoin(dismissalSessions, and(eq(dismissalSessions.id, dismissalQueue.sessionId), eq(dismissalSessions.schoolId, schoolId)))
      .where(and(eq(dismissalQueue.schoolId, schoolId), eq(dismissalQueue.studentId, row.studentId),
        eq(dismissalSessions.date, localDate), inArray(dismissalQueue.status, ["released", "dismissed"]))).limit(1);
    // The student row is already held FOR SHARE, and every GoPilot release /
    // dismissal writer holds that same row FOR UPDATE. Do not lock the session
    // here: GoPilot's order is session then student, so that would reverse it.
    if (dismissed) throw appointmentError(409, "APPOINTMENT_STUDENT_UNAVAILABLE", "A known dismissal prevents pass activation.");
    if (input.overrideRuleCode && !canOverridePasspilotRules(ctx.role)) throw appointmentError(403, "PASSPILOT_RULE_OVERRIDE_FORBIDDEN", "Only administrators can override a pass rule.");
    const outcome: PasspilotRuleOutcome = {};
    const common = { schoolId, studentId: row.studentId, teacherId: actor.id, destination: row.destination,
      customDestination: row.customDestination, duration: row.duration, expiresAt: new Date(now.getTime() + row.duration * 60000),
      issuedAt: now, issuedVia: "teacher" as const, status: "active" as const, notes: null };
    const authorization = { actorUserId: actor.id, manager: isPassPilotManager(ctx.role), issuanceChannel: "teacher" as const,
      ruleOverride: input.overrideRuleCode, ruleOutcome: outcome };
    const pass: Pass = ctx.schoolSettings.passpilotClassSource === "classpilot_groups"
      ? await createCanonicalPass({ ...common, classId: input.classId }, authorization, tx)
      : await createLegacyPass({ ...common, gradeId: input.classId }, authorization, tx);
    if (outcome.overridden) {
      const denied = outcome.overridden;
      await tx.insert(passpilotPassDenials).values({ schoolId: denied.schoolId, studentId: denied.studentId, destination: denied.destination,
        ruleCode: denied.ruleCode, issuedVia: denied.issuedVia, actorUserId: denied.actorUserId, teacherId: denied.teacherId,
        classSource: denied.classSource, gradeId: denied.gradeId, classpilotGroupId: denied.classpilotGroupId,
        supervisionContextId: denied.supervisionContextId, issuingKioskSessionId: denied.issuingKioskSessionId,
        windowKind: denied.windowKind, details: denied.details, overridden: true });
      await tx.insert(auditLogs).values({ schoolId, userId: actor.id, userRole: ctx.role, action: "passpilot.rule.override",
        entityType: "pass", entityId: pass.id, metadata: passpilotRuleOverrideAuditMetadata(denied) });
    }
    const [activated] = await tx.update(appointments).set({ status: "activated", passId: pass.id, activatedBy: actor.id,
      activatedAt: now, updatedBy: actor.id, updatedAt: now, revision: row.revision + 1 }).where(and(eq(appointments.schoolId, schoolId), eq(appointments.id, id))).returning();
    await audit(tx, ctx, "activated", id, { passId: pass.id });
    await tx.insert(studentTimelineEvents).values({ schoolId, studentId: row.studentId, eventType: "pass", sourceType: "passpilot",
      sourceId: pass.id, title: `Hall pass issued: ${pass.destination}`, actorUserId: actor.id,
      metadata: { status: pass.status, destination: pass.destination, issuedAt: pass.issuedAt, expiresAt: pass.expiresAt } });
    return { appointment: projection(activated!, ctx), pass, viewerRole: ctx.role, replayed: false, missed: false };
  });
}
