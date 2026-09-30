import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import db from "../db.js";
import { schools, users, schoolMemberships, productLicenses, type User } from "../schema/core.js";
import { students } from "../schema/students.js";
import { passes, passpilotPassDenials as denials, grades } from "../schema/passpilot.js";
import { passpilotAppointments as appointments } from "../schema/passpilotAppointments.js";
import { settings, auditLogs } from "../schema/shared.js";
import { readPasspilotReportsMode } from "../config/passpilotReportsMode.js";
import { activeEntitledProducts } from "./productEntitlement.js";
import { primaryRoleFromRoles, SCHOOL_ROLES, type SchoolRole } from "./schoolIdentityModel.js";
import { getPassHistoryQueryAccessScope, canAccessCanonicalPassHistory, canAccessLegacyPassHistory,
  canAccessStudent, isPassPilotManager, type PassPilotRole, type PassHistoryQueryAccessScope } from "./passpilotAccess.js";
import { canOverridePasspilotRules, withoutNullRuleOverride } from "./passpilotRules.js";
import { utcTimestampForSql } from "../util/schoolTime.js";
import { reportError, reportScopeFingerprint, decodeReportCursor, encodeReportCursor, encodePasspilotReportCsv,
  type PasspilotReportFilters } from "./passpilotReportsValidation.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PasspilotReportActor = Pick<User, "id" | "authVersion">;

async function context(tx: Transaction, schoolId: string, actor: PasspilotReportActor) {
  if (readPasspilotReportsMode() !== "v2") throw reportError(404, "PASSPILOT_REPORTS_UNAVAILABLE", "Reports v2 is unavailable.");
  // SHARE follows the lifecycle writer's school-first lock order and prevents
  // current authority/entitlement from being revoked during this snapshot.
  const [school] = await tx.select().from(schools).where(eq(schools.id, schoolId)).limit(1).for("share");
  const licenses = await tx.select().from(productLicenses).where(eq(productLicenses.schoolId, schoolId)).for("share");
  if (!activeEntitledProducts({ school, licenses }).includes("PASSPILOT")) {
    throw reportError(403, "PASSPILOT_REPORT_NOT_ENTITLED", "An active school and PassPilot license are required.");
  }
  const [user] = await tx.select().from(users).where(eq(users.id, actor.id)).limit(1).for("share");
  if (!user || user.authVersion !== actor.authVersion) throw reportError(403, "PASSPILOT_REPORT_AUTHORITY_CHANGED", "Staff access changed. Sign in again.");
  let role: PassPilotRole = "super_admin";
  if (!user.isSuperAdmin) {
    const memberships = await tx.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId),
      eq(schoolMemberships.userId, actor.id), eq(schoolMemberships.status, "active"))).for("share");
    const roles = memberships.map(row => row.role).filter((value): value is SchoolRole => (SCHOOL_ROLES as readonly string[]).includes(value));
    const current = roles.length ? primaryRoleFromRoles(roles) : null;
    if (!current || !["admin", "school_admin", "office_staff", "teacher"].includes(current)) {
      throw reportError(403, "PASSPILOT_REPORT_ACCESS_DENIED", "No PassPilot access for this school.");
    }
    role = current as PassPilotRole;
  }
  const schoolTimezone = school!.schoolTimezone || "America/New_York";
  try { new Intl.DateTimeFormat("en-US", { timeZone: schoolTimezone }).format(new Date(0)); }
  catch { throw reportError(409, "PASSPILOT_REPORT_TIME_ZONE_INVALID", "Configure a valid school timezone before reporting."); }
  const [schoolSettings] = await tx.select({ source: settings.passpilotClassSource }).from(settings).where(eq(settings.schoolId, schoolId)).limit(1).for("share");
  // RLS binding is a mandatory mode precondition: these established helpers
  // resolve the same request connection and transaction, not a second pool lease.
  const access = await getPassHistoryQueryAccessScope(user, schoolId, role);
  return { schoolId, user, role, access, schoolTimezone, classSource: schoolSettings?.source || "legacy_grades",
    administratorEvidence: canOverridePasspilotRules(role), scope: isPassPilotManager(role) ? "school" as const : "teacher_history" as const };
}
type Context = Awaited<ReturnType<typeof context>>;

async function validateAccess(ctx: Context, filters: PasspilotReportFilters) {
  if (filters.classId && !await canAccessCanonicalPassHistory(ctx.user, ctx.schoolId, filters.classId, ctx.role)
    || filters.gradeId && !await canAccessLegacyPassHistory(ctx.user, ctx.schoolId, filters.gradeId, ctx.role)
    || filters.teacherId && !isPassPilotManager(ctx.role) && filters.teacherId !== ctx.user.id) {
    throw reportError(403, "PASSPILOT_REPORT_FILTER_ACCESS_DENIED", "Insufficient permissions for this report filter.");
  }
  if (filters.studentId && !await canAccessStudent(ctx.user, ctx.schoolId, filters.studentId, ctx.role)) {
    // A history row already visible through the established scope must remain
    // filterable after classroom reassignment; this does not grant current
    // appointment access or access to another issuer's unscoped history.
    const [historic] = await db.select({ id: passes.id }).from(passes).where(and(eq(passes.schoolId, ctx.schoolId),
      eq(passes.studentId, filters.studentId), historyScope(passes, ctx.access))).limit(1);
    if (!historic) throw reportError(403, "PASSPILOT_REPORT_FILTER_ACCESS_DENIED", "Insufficient permissions for this report filter.");
  }
  if (filters.teacherId && isPassPilotManager(ctx.role)) {
    const [issuer] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, filters.teacherId), sql`(
      EXISTS (SELECT 1 FROM school_memberships m WHERE m.school_id=${ctx.schoolId} AND m.user_id=${users.id})
      OR EXISTS (SELECT 1 FROM passes p WHERE p.school_id=${ctx.schoolId} AND p.teacher_id=${users.id})
    )`)).limit(1);
    if (!issuer) throw reportError(403, "PASSPILOT_REPORT_FILTER_ACCESS_DENIED", "Insufficient permissions for this report filter.");
  }
}

/** The same history attribution predicate applies to passes and recorded denials. */
function historyScope(table: typeof passes | typeof denials, access: PassHistoryQueryAccessScope | null): SQL {
  if (!access) return sql`TRUE`;
  const clauses: SQL[] = [eq(table.teacherId, access.issuerTeacherId)];
  if (access.classIds.length) clauses.push(inArray(table.classpilotGroupId, access.classIds));
  if (access.gradeIds.length) clauses.push(inArray(table.gradeId, access.gradeIds));
  if (access.studentIds.length) clauses.push(and(isNull(table.classpilotGroupId), isNull(table.gradeId),
    isNull(table.supervisionContextId), inArray(table.studentId, access.studentIds))!);
  return or(...clauses)!;
}
async function historicalConditions(ctx: Context, filters: PasspilotReportFilters, table: typeof passes | typeof denials) {
  const instant = table === passes ? passes.issuedAt : denials.deniedAt;
  const from = table === passes ? utcTimestampForSql(filters.from) : filters.from.toISOString();
  const through = table === passes ? utcTimestampForSql(filters.through) : filters.through.toISOString();
  const clauses: SQL[] = [eq(table.schoolId, ctx.schoolId), sql`${instant}>=${from}`, sql`${instant}<${through}`, historyScope(table, ctx.access)];
  if (filters.studentId) clauses.push(eq(table.studentId, filters.studentId));
  if (filters.gradeId) clauses.push(eq(table.gradeId, filters.gradeId));
  if (filters.classId) {
    const mapped = await db.select({ id: grades.id }).from(grades).where(and(eq(grades.schoolId, ctx.schoolId), eq(grades.classpilotGroupId, filters.classId)));
    clauses.push(mapped.length ? or(eq(table.classpilotGroupId, filters.classId), inArray(table.gradeId, mapped.map(row => row.id)))! : eq(table.classpilotGroupId, filters.classId));
  }
  if (filters.teacherId) clauses.push(eq(table.teacherId, filters.teacherId));
  if (filters.destination) clauses.push(eq(table.destination, filters.destination));
  if (filters.issuedVia) clauses.push(eq(table.issuedVia, filters.issuedVia));
  return and(...clauses)!;
}

function currentAppointmentStudent(ctx: Context, classId?: string, gradeId?: string) {
  const studentId = appointments.studentId;
  const canonical = sql`EXISTS (SELECT 1 FROM groups current_class JOIN group_students roster ON roster.group_id=current_class.id
    WHERE current_class.school_id=${ctx.schoolId} AND current_class.group_type='admin_class' AND current_class.status='active'
      AND roster.student_id=${studentId}
      AND ${classId ? sql`current_class.id=${classId}` : sql`TRUE`}
      AND ${isPassPilotManager(ctx.role) ? sql`TRUE` : sql`(current_class.teacher_id=${ctx.user.id} OR EXISTS (
        SELECT 1 FROM group_teachers teacher WHERE teacher.group_id=current_class.id AND teacher.teacher_id=${ctx.user.id}))`})`;
  const legacy = sql`EXISTS (SELECT 1 FROM grades current_grade WHERE current_grade.school_id=${ctx.schoolId}
    AND ${gradeId ? sql`current_grade.id=${gradeId}` : sql`TRUE`}
    AND (EXISTS (SELECT 1 FROM students current_student WHERE current_student.school_id=${ctx.schoolId}
      AND current_student.id=${studentId} AND current_student.grade_id=current_grade.id)
      OR EXISTS (SELECT 1 FROM passpilot_grade_students roster WHERE roster.school_id=${ctx.schoolId}
        AND roster.grade_id=current_grade.id AND roster.student_id=${studentId}))
    AND ${isPassPilotManager(ctx.role) ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM teacher_grades teacher
      WHERE teacher.grade_id=current_grade.id AND teacher.teacher_id=${ctx.user.id})`})`;
  if (isPassPilotManager(ctx.role) && !classId && !gradeId) return sql`TRUE`;
  const roster = classId ? canonical : gradeId ? legacy : ctx.classSource === "classpilot_groups" ? canonical : legacy;
  return sql`EXISTS (SELECT 1 FROM students current_student WHERE current_student.school_id=${ctx.schoolId}
    AND current_student.id=${studentId} AND current_student.status='active') AND ${roster}`;
}

const completed = sql`${passes.status}='returned' AND ${passes.returnedAt} IS NOT NULL AND ${passes.returnedAt}>=${passes.issuedAt}`;
const validDeadline = sql`${passes.expiresAt}>=${passes.issuedAt}`;
const seconds = sql`extract(epoch FROM (${passes.returnedAt}-${passes.issuedAt}))`;
function ratio(numerator: number, denominator: number) { return { numerator, denominator, ratio: denominator ? numerator / denominator : null }; }

export async function getPasspilotReportCapabilities(schoolId: string, actor: PasspilotReportActor) {
  return db.transaction(async tx => {
    const ctx = await context(tx, schoolId, actor);
    return { enabled: true, version: 2, schoolTimezone: ctx.schoolTimezone, scope: ctx.scope,
      administratorEvidence: ctx.administratorEvidence, appointmentsAvailable: true };
  }, { isolationLevel: "repeatable read" });
}

async function summary(tx: Transaction, ctx: Context, filters: PasspilotReportFilters, asOf: Date) {
  await validateAccess(ctx, filters);
  const condition = await historicalConditions(ctx, filters, passes);
  const [stats] = await tx.select({
    total: sql<number>`count(*)::int`, active: sql<number>`count(*) FILTER(WHERE ${passes.status}='active')::int`,
    returned: sql<number>`count(*) FILTER(WHERE ${passes.status}='returned')::int`,
    canceled: sql<number>`count(*) FILTER(WHERE ${passes.status}='canceled')::int`,
    historicalExpired: sql<number>`count(*) FILTER(WHERE ${passes.status}='expired')::int`,
    other: sql<number>`count(*) FILTER(WHERE ${passes.status} NOT IN ('active','returned','canceled','expired'))::int`,
    completedCount: sql<number>`count(*) FILTER(WHERE ${completed})::int`,
    totalSeconds: sql<number>`COALESCE(sum(${seconds}) FILTER(WHERE ${completed}),0)::float8`,
    invalidCompletedCount: sql<number>`count(*) FILTER(WHERE ${passes.status}='returned' AND NOT (${completed}))::int`,
    overdueCompleted: sql<number>`count(*) FILTER(WHERE ${completed} AND ${validDeadline} AND ${passes.returnedAt}>${passes.expiresAt})::int`,
    deadlineCompleted: sql<number>`count(*) FILTER(WHERE ${completed} AND ${validDeadline})::int`,
    currentlyOverdue: sql<number>`count(*) FILTER(WHERE ${passes.status}='active' AND ${validDeadline} AND ${passes.expiresAt}<${utcTimestampForSql(asOf)})::int`,
    invalidDeadlineCount: sql<number>`count(*) FILTER(WHERE ${passes.status} IN ('active','returned') AND NOT(${validDeadline}))::int`,
  }).from(passes).where(condition);
  const counts = stats!;
  const destinations = await tx.select({ destination: passes.destination, count: sql<number>`count(*)::int` }).from(passes)
    .where(condition).groupBy(passes.destination).orderBy(desc(sql`count(*)`), asc(passes.destination));
  const hour = sql<number>`extract(hour FROM timezone(${ctx.schoolTimezone},${passes.issuedAt} AT TIME ZONE 'UTC'))::int`.as("report_hour");
  const periods = await tx.select({ hour, count: sql<number>`count(*)::int` }).from(passes).where(condition)
    // Group/order by the alias: repeated parameter placeholders for timezone
    // are distinct expressions to PostgreSQL even when their values match.
    .groupBy(sql`report_hour`).orderBy(desc(sql`count(*)`), asc(sql`report_hour`));
  const [recorded] = await tx.select({ count: sql<number>`count(*)::int` }).from(denials)
    .where(await historicalConditions(ctx, filters, denials));
  const byRule = ctx.administratorEvidence ? await tx.select({ ruleCode: passes.ruleOverrideCode, count: sql<number>`count(*)::int` }).from(passes)
    .where(and(condition, sql`${passes.ruleOverrideCode} IS NOT NULL`)).groupBy(passes.ruleOverrideCode)
    .orderBy(asc(passes.ruleOverrideCode)) : null;
  const coverage = ["RETAINED_RECORDS_ONLY", "RECORDED_DENIALS_BEST_EFFORT", "HISTORICAL_BELL_PERIODS_UNAVAILABLE"];
  if (counts.invalidCompletedCount) coverage.push("INVALID_COMPLETED_TIMESTAMPS");
  if (counts.invalidDeadlineCount) coverage.push("INVALID_PASS_DEADLINES");
  let appointmentMetrics = null;
  if (filters.teacherId || filters.issuedVia) coverage.push("APPOINTMENT_FILTER_UNAVAILABLE");
  else {
    const effective = sql`CASE WHEN ${appointments.status}='scheduled' AND ${appointments.endsAt}<=${asOf.toISOString()} THEN 'missed' ELSE ${appointments.status} END`;
    const [row] = await tx.select({ total: sql<number>`count(*)::int`,
      scheduled: sql<number>`count(*) FILTER(WHERE ${effective}='scheduled')::int`,
      activated: sql<number>`count(*) FILTER(WHERE ${effective}='activated')::int`,
      completed: sql<number>`count(*) FILTER(WHERE ${effective}='completed')::int`,
      cancelled: sql<number>`count(*) FILTER(WHERE ${effective}='cancelled')::int`,
      missed: sql<number>`count(*) FILTER(WHERE ${effective}='missed')::int`,
      futureWindowCount: sql<number>`count(*) FILTER(WHERE ${appointments.startsAt}>${asOf.toISOString()})::int`,
      maturedWindowCount: sql<number>`count(*) FILTER(WHERE ${appointments.endsAt}<=${asOf.toISOString()} AND ${appointments.status}<>'cancelled')::int`,
      maturedMissedCount: sql<number>`count(*) FILTER(WHERE ${appointments.endsAt}<=${asOf.toISOString()} AND ${effective}='missed')::int`,
    }).from(appointments).where(and(eq(appointments.schoolId, ctx.schoolId), gte(appointments.startsAt, filters.from), lt(appointments.startsAt, filters.through),
      currentAppointmentStudent(ctx, filters.classId, filters.gradeId),
      ...(filters.studentId ? [eq(appointments.studentId, filters.studentId)] : []),
      ...(filters.destination ? [eq(appointments.destination, filters.destination)] : [])));
    const { maturedMissedCount, ...publicRow } = row!;
    appointmentMetrics = { ...publicRow, missedRate: ratio(maturedMissedCount, publicRow.maturedWindowCount), attribution: "current_student_roster" as const };
  }
  return { version: 2, asOf: asOf.toISOString(), schoolTimezone: ctx.schoolTimezone, scope: ctx.scope,
    range: { from: filters.from.toISOString(), through: filters.through.toISOString() },
    counts: { total: counts.total, active: counts.active, returned: counts.returned, canceled: counts.canceled, historicalExpired: counts.historicalExpired, other: counts.other },
    completedDuration: { count: counts.completedCount, totalSeconds: counts.totalSeconds,
      averageSeconds: counts.completedCount ? counts.totalSeconds / counts.completedCount : null, invalidCompletedCount: counts.invalidCompletedCount },
    completedOverdueRate: ratio(counts.overdueCompleted, counts.deadlineCompleted), openCount: counts.active, currentlyOverdueCount: counts.currentlyOverdue,
    destinations, periods: { kind: "school_local_hour", basis: "current_school_timezone", buckets: periods.map(row => ({ ...row,
      label: `${String(row.hour).padStart(2, "0")}:00–${String(row.hour).padStart(2, "0")}:59` })) },
    recordedDenials: { count: recorded!.count, coverage: "best_effort", includesRecordedOverrideAttempts: true },
    overrides: byRule ? { count: byRule.reduce((total, row) => total + row.count, 0), byRule } : null,
    appointments: appointmentMetrics, coverage: { state: !counts.total && !recorded!.count && !appointmentMetrics?.total ? "no_data" : "partial",
      codes: coverage, administratorEvidence: ctx.administratorEvidence } };
}

export async function getPasspilotReportSummary(schoolId: string, actor: PasspilotReportActor, filters: PasspilotReportFilters) {
  return db.transaction(async tx => summary(tx, await context(tx, schoolId, actor), filters, new Date()), { isolationLevel: "repeatable read" });
}

async function page(tx: Transaction, ctx: Context, filters: PasspilotReportFilters, limit: number, encoded?: string, asOf = new Date()) {
  await validateAccess(ctx, filters);
  const scope = reportScopeFingerprint(ctx.schoolId, ctx.user.id, ctx.role, filters);
  const cursor = encoded ? decodeReportCursor(encoded, scope) : null;
  const issuedAtMs = sql`(extract(epoch FROM date_trunc('milliseconds',${passes.issuedAt}))*1000)::bigint`;
  const condition = await historicalConditions(ctx, filters, passes);
  const rows = await tx.select({ id: passes.id, studentId: passes.studentId,
    studentName: sql<string | null>`NULLIF(trim(concat_ws(' ',${students.firstName},${students.lastName})), '')`,
    teacherId: passes.teacherId, teacherName: sql<string | null>`NULLIF(trim(concat_ws(' ',${users.firstName},${users.lastName})), '')`,
    classId: sql<string | null>`COALESCE(${passes.classpilotGroupId},${grades.classpilotGroupId},${passes.gradeId})`,
    className: sql<string | null>`COALESCE(${passes.activityNameSnapshot},${passes.classNameSnapshot},${grades.name})`,
    destination: passes.destination, customDestination: passes.customDestination, issuedVia: passes.issuedVia, status: passes.status,
    issuedAt: passes.issuedAt, expiresAt: passes.expiresAt, returnedAt: passes.returnedAt,
    completedDurationSeconds: sql<number | null>`CASE WHEN ${completed} THEN ${seconds}::float8 ELSE NULL END`,
    currentlyOverdue: sql<boolean>`${passes.status}='active' AND ${validDeadline} AND ${passes.expiresAt}<${utcTimestampForSql(asOf)}`,
    ruleOverrideCode: passes.ruleOverrideCode, cursorIssuedAtMs: sql<string>`${issuedAtMs}::text`,
  }).from(passes).leftJoin(students, and(eq(students.id, passes.studentId), eq(students.schoolId, passes.schoolId)))
    .leftJoin(users, eq(users.id, passes.teacherId)).leftJoin(grades, and(eq(grades.id, passes.gradeId), eq(grades.schoolId, passes.schoolId)))
    .where(and(condition, ...(cursor ? [sql`(${issuedAtMs}<${cursor.issuedAtMs}::bigint OR (${issuedAtMs}=${cursor.issuedAtMs}::bigint AND ${passes.id}<${cursor.id}))`] : [])))
    .orderBy(desc(issuedAtMs), desc(passes.id)).limit(limit + 1);
  const hasMore = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
  return { version: 2, asOf: asOf.toISOString(), schoolTimezone: ctx.schoolTimezone,
    passes: selected.map(({ cursorIssuedAtMs: _cursor, ...row }) => withoutNullRuleOverride(row, ctx.role)),
    nextCursor: hasMore && last ? encodeReportCursor({ issuedAtMs: last.cursorIssuedAtMs, id: last.id, scope }) : null, hasMore };
}
export async function getPasspilotReportPage(schoolId: string, actor: PasspilotReportActor, filters: PasspilotReportFilters, limit: number, cursor?: string) {
  return db.transaction(async tx => page(tx, await context(tx, schoolId, actor), filters, limit, cursor), { isolationLevel: "repeatable read" });
}

function summaryCsv(result: Awaited<ReturnType<typeof summary>>) {
  const rows: unknown[][] = [["metric", "value", "numerator", "denominator", "basis"]];
  for (const [key, value] of Object.entries(result.counts)) rows.push([`passes_${key}`, value, null, null, "issued_in_range"]);
  rows.push(["completed_average_seconds", result.completedDuration.averageSeconds, result.completedDuration.totalSeconds, result.completedDuration.count, "valid_returned_passes_only"],
    ["completed_overdue_rate", result.completedOverdueRate.ratio, result.completedOverdueRate.numerator, result.completedOverdueRate.denominator, "valid_returned_passes_with_valid_deadline"],
    ["open_count", result.openCount, null, null, "active_issued_in_range"], ["currently_overdue_count", result.currentlyOverdueCount, null, null, "active_valid_deadline_passed_at_as_of"],
    ["recorded_denials", result.recordedDenials.count, null, null, "best_effort_including_recorded_override_attempts"],
    ["administrator_override_count", result.overrides?.count ?? null, null, null, result.overrides ? "durable_pass_override_column" : "administrator_only"]);
  for (const row of result.overrides?.byRule ?? []) rows.push([`override_${row.ruleCode}`, row.count, null, null, "durable_pass_override_column"]);
  for (const row of result.destinations) rows.push([`destination_${row.destination}`, row.count, null, null, "issued_in_range"]);
  for (const row of result.periods.buckets) rows.push([`school_local_hour_${row.hour}`, row.count, null, null, "current_school_timezone"]);
  if (result.appointments) {
    for (const key of ["total", "scheduled", "activated", "completed", "cancelled", "missed", "futureWindowCount", "maturedWindowCount"] as const) rows.push([`appointments_${key}`, result.appointments[key], null, null, "current_student_roster_windows_starting_in_range"]);
    rows.push(["appointment_missed_rate", result.appointments.missedRate.ratio, result.appointments.missedRate.numerator, result.appointments.missedRate.denominator, "ended_non_cancelled_windows_only"]);
  }
  rows.push(["as_of", result.asOf], ["school_timezone", result.schoolTimezone], ["from_inclusive", result.range.from], ["through_exclusive", result.range.through],
    ["coverage_state", result.coverage.state], ["coverage_codes", result.coverage.codes.join(";")]);
  return rows.map(row => Array.from({ length: 5 }, (_, index) => row[index] ?? null));
}

export async function exportPasspilotReport(schoolId: string, actor: PasspilotReportActor, filters: PasspilotReportFilters, kind: "passes" | "summary") {
  return db.transaction(async tx => {
    const ctx = await context(tx, schoolId, actor), asOf = new Date();
    let rows: unknown[][];
    if (kind === "summary") rows = summaryCsv(await summary(tx, ctx, filters, asOf));
    else {
      const result = await page(tx, ctx, filters, 10_000, undefined, asOf);
      if (result.hasMore) throw reportError(409, "PASSPILOT_REPORT_EXPORT_LIMIT", "This report exceeds 10,000 passes. Choose a smaller range or more filters.");
      const headers = ["pass_id", "student_id", "student_name", "teacher_id", "teacher_name", "class_id", "class_name", "destination", "custom_destination", "issued_via", "status", "issued_at", "expires_at", "returned_at", "completed_duration_seconds", "currently_overdue", "permitted_override_code"];
      rows = [headers, ...result.passes.map(row => [row.id, row.studentId, row.studentName, row.teacherId, row.teacherName, row.classId, row.className,
        row.destination, row.customDestination, row.issuedVia, row.status, row.issuedAt.toISOString(), row.expiresAt.toISOString(), row.returnedAt?.toISOString(),
        row.completedDurationSeconds, row.currentlyOverdue, row.ruleOverrideCode])];
    }
    const csv = encodePasspilotReportCsv(rows);
    await tx.insert(auditLogs).values({ schoolId, userId: ctx.user.id, userRole: ctx.role,
      action: "passpilot.report.exported", entityType: "passpilot_report", entityId: null,
      metadata: { kind, scope: ctx.scope, from: filters.from.toISOString(), through: filters.through.toISOString(),
        filterKeys: Object.keys(filters).filter(key => !["from", "through"].includes(key)).sort(), rowCount: rows.length - 1,
        administratorEvidence: ctx.administratorEvidence } });
    return { csv, filename: `passpilot-${kind}-${filters.from.toISOString().slice(0, 10)}.csv` };
  }, { isolationLevel: "repeatable read" });
}
