import { and, asc, eq, gt, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import db from "../db.js";
import errorMonitor from "./errorMonitor.js";
import { readPasspilotRulesMode } from "../config/passpilotRulesMode.js";
import { schools } from "../schema/core.js";
import { students } from "../schema/students.js";
import { groups, teachingSessions } from "../schema/classpilot.js";
import {
  grades,
  passes,
  passpilotDestinationPolicies,
  passpilotEncounterRestrictions,
  passpilotPassDenials,
  passpilotPassLimits,
  PASSPILOT_RULE_CODES,
  PASSPILOT_RULE_DESTINATIONS,
  type PasspilotRuleCode,
  type PasspilotRuleDenialDetails,
  type PasspilotRuleDestination,
  type PasspilotRuleIssuanceChannel,
  type PasspilotRuleWindowKind,
} from "../schema/passpilot.js";
import { getSchoolSchedulingContext } from "./classpilotScheduling.js";
import { resolveSchoolScheduleDay, type SchoolSchedulingConfig } from "./classpilotSchedulingRules.js";
import {
  addLocalDays,
  localDateInTimeZone,
  localDateStartUtc,
  localDateTimeUtc,
  utcTimestampForSql,
} from "../util/schoolTime.js";

/**
 * PassPilot issuance rules (PASSPILOT_RULES_MODE, default off).
 *
 * enforcePasspilotIssuanceRules runs inside each transactional pass insert
 * (createLegacyPass, createCanonicalPass, createActivityKioskPass) after the
 * per-school `passpilot-class-source` advisory lock and before the insert, so
 * every count it reads is serialized with every other issuance for the school.
 * With the mode off it returns before issuing a single query.
 */

export { PASSPILOT_RULE_CODES, PASSPILOT_RULE_DESTINATIONS };
export type { PasspilotRuleCode, PasspilotRuleDestination };

export const PASSPILOT_RULE_NOT_AVAILABLE_CODE = "PASSPILOT_RULE_NOT_AVAILABLE";
export const PASSPILOT_PASS_DENIAL_RETENTION_DAYS = 400;
const DEFAULT_TIME_ZONE = "America/New_York";

type RuleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ClassSource = "legacy_grades" | "classpilot_groups";

export type PasspilotRuleWindow = {
  kind: Exclude<PasspilotRuleWindowKind, "day">;
  label: string | null;
  startsAt: Date;
  endsAt: Date;
};

/** Server-built, school-scoped facts about one evaluated rule. */
export type PasspilotRuleDenialSnapshot = {
  schoolId: string;
  studentId: string;
  destination: string;
  ruleCode: PasspilotRuleCode;
  issuedVia: PasspilotRuleIssuanceChannel;
  actorUserId: string | null;
  teacherId: string | null;
  classSource: ClassSource | null;
  gradeId: string | null;
  classpilotGroupId: string | null;
  supervisionContextId: string | null;
  issuingKioskSessionId: string | null;
  windowKind: PasspilotRuleWindowKind | null;
  details: PasspilotRuleDenialDetails;
  overridden: boolean;
};

/** Filled by the helper when an administrator override cleared one rule. */
export type PasspilotRuleOutcome = { overridden?: PasspilotRuleDenialSnapshot };

export type PasspilotIssuanceRuleContext = {
  schoolId: string;
  studentId: string;
  destination: string;
  issuedVia: PasspilotRuleIssuanceChannel;
  actorUserId: string | null;
  teacherId: string | null;
  classSource: ClassSource;
  gradeId: string | null;
  classpilotGroupId: string | null;
  supervisionContextId?: string | null;
  issuingKioskSessionId?: string | null;
  /** Activity kiosk only: the resolved assignment window. */
  kioskWindow?: { startsAt: string; endsAt: string; label: string | null } | null;
  /** Computed once, before the issuance transaction starts. */
  now: Date;
  /** Administrator override of exactly one rule code (teacher route only). */
  override?: PasspilotRuleCode | null;
  outcome?: PasspilotRuleOutcome;
};

export class PasspilotRuleError extends Error {
  readonly code: PasspilotRuleCode;
  readonly status = 409;
  readonly expose = true;
  readonly passpilotRule: PasspilotRuleDenialSnapshot;

  constructor(snapshot: PasspilotRuleDenialSnapshot) {
    // The default message is safe for any audience: an encounter never names
    // (or implies) the other student even if this error escapes unshaped.
    super(snapshot.ruleCode === "PASSPILOT_RULE_ENCOUNTER"
      ? PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE
      : passpilotRuleStaffMessage(snapshot));
    this.name = "PasspilotRuleError";
    this.code = snapshot.ruleCode;
    this.passpilotRule = snapshot;
  }
}

export function passpilotRuleError(snapshot: PasspilotRuleDenialSnapshot): PasspilotRuleError {
  return new PasspilotRuleError(snapshot);
}

export function isPasspilotRuleCode(value: unknown): value is PasspilotRuleCode {
  return typeof value === "string" && (PASSPILOT_RULE_CODES as readonly string[]).includes(value);
}

export function isPasspilotRuleError(error: unknown): error is PasspilotRuleError {
  if (error instanceof PasspilotRuleError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; passpilotRule?: unknown };
  return candidate.status === 409
    && isPasspilotRuleCode(candidate.code)
    && !!candidate.passpilotRule
    && typeof candidate.passpilotRule === "object";
}

// ---------------------------------------------------------------------------
// Messages. Staff messages are factual counts; kiosk messages are student
// facing and generic; encounter wording never identifies anyone.
// ---------------------------------------------------------------------------

export const PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE =
  "A pass isn't available for this student right now. Check with an administrator.";
export const PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE = "Please see your teacher before leaving.";
const PASSPILOT_RULE_ENCOUNTER_ADMIN_MESSAGE =
  "This pass can't be issued right now because of an encounter restriction.";

const DESTINATION_LABELS: Record<string, string> = {
  bathroom: "Bathroom",
  nurse: "Nurse",
  office: "Office",
  counselor: "Counselor",
  other_classroom: "Other classroom",
  custom: "This destination",
};

export function passpilotRuleDestinationLabel(destination: string): string {
  return DESTINATION_LABELS[destination] ?? "This destination";
}

function passCount(count: number): string {
  return `${count} ${count === 1 ? "pass" : "passes"}`;
}

function periodPhrase(snapshot: PasspilotRuleDenialSnapshot): string {
  const label = snapshot.details.windowLabel?.trim();
  if (snapshot.windowKind === "bell_period") return label ? `during ${label}` : "this period";
  if (snapshot.windowKind === "kiosk_block") return label ? `during ${label}` : "during this class block";
  return "during this class session";
}

export function passpilotRuleStaffMessage(snapshot: PasspilotRuleDenialSnapshot): string {
  const count = snapshot.details.count ?? 0;
  const limit = snapshot.details.limit ?? 0;
  switch (snapshot.ruleCode) {
    case "PASSPILOT_RULE_DAILY_LIMIT":
      return `${passCount(count)} today (limit ${limit}).`;
    case "PASSPILOT_RULE_PERIOD_LIMIT":
      return `${passCount(count)} ${periodPhrase(snapshot)} (limit ${limit}).`;
    case "PASSPILOT_RULE_DESTINATION_CAPACITY":
      return `${passpilotRuleDestinationLabel(snapshot.destination)} is at capacity (${count} of ${limit} out).`;
    case "PASSPILOT_RULE_ENCOUNTER":
      return PASSPILOT_RULE_ENCOUNTER_ADMIN_MESSAGE;
  }
}

export type PasspilotRuleSummary =
  | { kind: "daily_limit"; count: number; limit: number }
  | { kind: "period_limit"; count: number; limit: number; window: { kind: PasspilotRuleWindowKind | null; label: string | null } }
  | { kind: "destination_capacity"; count: number; limit: number; destination: string }
  | { kind: "encounter" };

function ruleSummary(snapshot: PasspilotRuleDenialSnapshot): PasspilotRuleSummary {
  const count = snapshot.details.count ?? 0;
  const limit = snapshot.details.limit ?? 0;
  switch (snapshot.ruleCode) {
    case "PASSPILOT_RULE_DAILY_LIMIT":
      return { kind: "daily_limit", count, limit };
    case "PASSPILOT_RULE_PERIOD_LIMIT":
      return {
        kind: "period_limit",
        count,
        limit,
        window: { kind: snapshot.windowKind, label: snapshot.details.windowLabel ?? null },
      };
    case "PASSPILOT_RULE_DESTINATION_CAPACITY":
      return { kind: "destination_capacity", count, limit, destination: snapshot.destination };
    case "PASSPILOT_RULE_ENCOUNTER":
      return { kind: "encounter" };
  }
}

/** Override is limited to administrators; office staff and teachers cannot. */
export function canOverridePasspilotRules(role: string | null | undefined): boolean {
  return role === "super_admin" || role === "admin" || role === "school_admin";
}

export type PasspilotRuleTeacherResponse = {
  error: string;
  code: string;
  rule?: PasspilotRuleSummary;
  canOverride: boolean;
};

/**
 * 409 body for the authenticated issue route. Only administrators receive the
 * encounter code; every other staff role gets the generic not-available code.
 */
export function passpilotRuleTeacherResponse(
  error: PasspilotRuleError,
  role: string | null | undefined
): PasspilotRuleTeacherResponse {
  const snapshot = error.passpilotRule;
  if (canOverridePasspilotRules(role)) {
    return {
      error: passpilotRuleStaffMessage(snapshot),
      code: snapshot.ruleCode,
      rule: ruleSummary(snapshot),
      canOverride: true,
    };
  }
  if (snapshot.ruleCode === "PASSPILOT_RULE_ENCOUNTER") {
    return {
      error: PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE,
      code: PASSPILOT_RULE_NOT_AVAILABLE_CODE,
      canOverride: false,
    };
  }
  return {
    error: passpilotRuleStaffMessage(snapshot),
    code: snapshot.ruleCode,
    rule: ruleSummary(snapshot),
    canOverride: false,
  };
}

/**
 * 409 body for the student-facing kiosk. The code carries no more than the
 * message: capacity is a property of the destination; limits and encounters
 * share one generic message and one generic code.
 */
export function passpilotRuleKioskResponse(error: PasspilotRuleError): { error: string; code: string } {
  const snapshot = error.passpilotRule;
  if (snapshot.ruleCode === "PASSPILOT_RULE_DESTINATION_CAPACITY") {
    return {
      error: `${passpilotRuleDestinationLabel(snapshot.destination)} is full right now. Please try again in a few minutes.`,
      code: snapshot.ruleCode,
    };
  }
  return { error: PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE, code: PASSPILOT_RULE_NOT_AVAILABLE_CODE };
}

/** AI assistant callers never learn that an encounter restriction exists. */
export function passpilotRuleAssistantMessage(error: PasspilotRuleError): string {
  const snapshot = error.passpilotRule;
  return snapshot.ruleCode === "PASSPILOT_RULE_ENCOUNTER"
    ? PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE
    : passpilotRuleStaffMessage(snapshot);
}

/** Audit metadata for an override: codes, ids and counts only, no names. */
export function passpilotRuleOverrideAuditMetadata(snapshot: PasspilotRuleDenialSnapshot) {
  return {
    ruleCode: snapshot.ruleCode,
    studentId: snapshot.studentId,
    destination: snapshot.destination,
    issuedVia: snapshot.issuedVia,
    classSource: snapshot.classSource,
    classId: snapshot.classpilotGroupId ?? snapshot.gradeId,
    windowKind: snapshot.windowKind,
    details: snapshot.details,
  };
}

// ---------------------------------------------------------------------------
// Period windows
// ---------------------------------------------------------------------------

/**
 * Pure selection of the bell period containing `now` on a school-local date.
 * Each boundary resolves the wall clock directly, so 23- and 25-hour DST days
 * keep their local start/end times. Overlapping periods resolve to the
 * earliest start, then the configured period order.
 */
export function selectBellPeriod(
  config: Pick<SchoolSchedulingConfig, "periods" | "profiles">,
  day: { instructional: boolean; profileId: string | null },
  localDate: string,
  timeZone: string,
  now: Date
): { periodId: string; label: string; startsAt: Date; endsAt: Date } | null {
  if (!day.instructional || !day.profileId) return null;
  const profile = config.profiles.find((candidate) => candidate.id === day.profileId);
  if (!profile) return null;
  const order = new Map(config.periods.map((period, index) => [period.id, index] as const));
  const instant = now.getTime();
  const current = Object.entries(profile.periods)
    .map(([periodId, window]) => ({
      periodId,
      startsAt: localDateTimeUtc(localDate, window.startTime, timeZone),
      endsAt: localDateTimeUtc(localDate, window.endTime, timeZone),
    }))
    .filter((period) => period.endsAt.getTime() > period.startsAt.getTime()
      && period.startsAt.getTime() <= instant
      && instant < period.endsAt.getTime())
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime()
      || (order.get(left.periodId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.periodId) ?? Number.MAX_SAFE_INTEGER)
      || left.periodId.localeCompare(right.periodId))[0];
  if (!current) return null;
  const label = config.periods.find((period) => period.id === current.periodId)?.name ?? current.periodId;
  return { ...current, label };
}

type SchoolDay = { timeZone: string; localDate: string; dayStart: Date; dayEnd: Date };

export function resolvePasspilotRuleDay(now: Date, timeZone: string | null | undefined): SchoolDay {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const localDate = localDateInTimeZone(now, zone);
  return {
    timeZone: zone,
    localDate,
    dayStart: localDateStartUtc(localDate, zone),
    dayEnd: localDateStartUtc(addLocalDays(localDate, 1), zone),
  };
}

/** A failed optional lookup rolls back to its savepoint and returns null. */
async function degradable<T>(
  tx: RuleTransaction,
  lookup: (savepoint: RuleTransaction) => Promise<T | null>
): Promise<T | null> {
  try {
    return await tx.transaction(async (savepoint) => lookup(savepoint));
  } catch {
    return null;
  }
}

async function resolveBellWindow(
  tx: RuleTransaction,
  ctx: PasspilotIssuanceRuleContext,
  day: SchoolDay
): Promise<PasspilotRuleWindow | null> {
  return degradable(tx, async (savepoint) => {
    const scheduling = await getSchoolSchedulingContext(ctx.schoolId, savepoint as unknown as typeof db);
    const scheduleDay = resolveSchoolScheduleDay(day.localDate, scheduling.config, scheduling.calendar);
    const bell = selectBellPeriod(scheduling.config, scheduleDay, day.localDate, day.timeZone, ctx.now);
    return bell ? { kind: "bell_period", label: bell.label, startsAt: bell.startsAt, endsAt: bell.endsAt } : null;
  });
}

async function resolveClassWindow(
  tx: RuleTransaction,
  ctx: PasspilotIssuanceRuleContext,
  day: SchoolDay
): Promise<PasspilotRuleWindow | null> {
  return degradable(tx, async (savepoint) => {
    let groupId = ctx.classpilotGroupId;
    if (!groupId && ctx.gradeId) {
      // Legacy grades carry a period only through a confirmed ClassPilot link.
      const [grade] = await savepoint
        .select({ groupId: grades.classpilotGroupId })
        .from(grades)
        .where(and(eq(grades.id, ctx.gradeId), eq(grades.schoolId, ctx.schoolId)))
        .limit(1);
      groupId = grade?.groupId ?? null;
    }
    if (!groupId) return null;
    const nowSql = utcTimestampForSql(ctx.now);
    const [session] = await savepoint
      .select({
        scheduledStartAt: teachingSessions.scheduledStartAt,
        scheduledEndAt: teachingSessions.scheduledEndAt,
        startTime: teachingSessions.startTime,
        className: groups.name,
      })
      .from(teachingSessions)
      .innerJoin(groups, and(
        eq(groups.id, teachingSessions.groupId),
        eq(groups.schoolId, ctx.schoolId),
        eq(groups.groupType, "admin_class")
      ))
      .where(and(
        eq(teachingSessions.groupId, groupId),
        or(
          and(
            isNotNull(teachingSessions.scheduledStartAt),
            isNotNull(teachingSessions.scheduledEndAt),
            lte(teachingSessions.scheduledStartAt, ctx.now),
            gt(teachingSessions.scheduledEndAt, ctx.now)
          ),
          and(
            isNull(teachingSessions.scheduledStartAt),
            isNull(teachingSessions.endTime),
            sql`${teachingSessions.startTime} >= ${utcTimestampForSql(day.dayStart)}`,
            sql`${teachingSessions.startTime} <= ${nowSql}`
          )
        )
      ))
      .orderBy(sql`(${teachingSessions.scheduledStartAt} IS NOT NULL) DESC`, sql`${teachingSessions.startTime} DESC`)
      .limit(1);
    if (!session) return null;
    if (session.scheduledStartAt && session.scheduledEndAt) {
      return { kind: "class_window", label: session.className, startsAt: session.scheduledStartAt, endsAt: session.scheduledEndAt };
    }
    // A live session without a schedule runs from its start to the end of the day.
    return { kind: "class_window", label: session.className, startsAt: session.startTime, endsAt: day.dayEnd };
  });
}

function kioskWindow(ctx: PasspilotIssuanceRuleContext, day: SchoolDay): PasspilotRuleWindow | null {
  if (!ctx.kioskWindow) return null;
  const startsAt = new Date(Math.max(Date.parse(ctx.kioskWindow.startsAt), day.dayStart.getTime()));
  const endsAt = new Date(Date.parse(ctx.kioskWindow.endsAt));
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) return null;
  const instant = ctx.now.getTime();
  if (!(startsAt.getTime() <= instant && instant < endsAt.getTime())) return null;
  return { kind: "kiosk_block", label: ctx.kioskWindow.label, startsAt, endsAt };
}

/**
 * Bell period first; otherwise the activity kiosk's assignment window; otherwise
 * the issuing class's scheduled or live session. Any lookup failure means the
 * period rule is unavailable for this pass, never an issuance error.
 */
export async function resolvePasspilotPeriodWindow(
  tx: RuleTransaction,
  ctx: PasspilotIssuanceRuleContext,
  day: SchoolDay
): Promise<PasspilotRuleWindow | null> {
  const bell = await resolveBellWindow(tx, ctx, day);
  if (bell) return bell;
  if (ctx.kioskWindow) return kioskWindow(ctx, day);
  return resolveClassWindow(tx, ctx, day);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

function isRuleDestination(destination: string): destination is PasspilotRuleDestination {
  return (PASSPILOT_RULE_DESTINATIONS as readonly string[]).includes(destination);
}

async function countStudentPasses(
  tx: RuleTransaction,
  ctx: PasspilotIssuanceRuleContext,
  startsAt: Date,
  endsAt: Date
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(passes)
    .where(and(
      eq(passes.schoolId, ctx.schoolId),
      eq(passes.studentId, ctx.studentId),
      ne(passes.status, "canceled"),
      sql`${passes.issuedAt} >= ${utcTimestampForSql(startsAt)}`,
      sql`${passes.issuedAt} < ${utcTimestampForSql(endsAt)}`
    ));
  return row?.count ?? 0;
}

/**
 * Evaluates ENCOUNTER, then DESTINATION_CAPACITY, then DAILY_LIMIT, then
 * PERIOD_LIMIT. The first violation throws a PasspilotRuleError unless it is
 * the single code an administrator chose to override; an override clears that
 * one code and the remaining rules are still evaluated.
 */
export async function enforcePasspilotIssuanceRules(
  tx: RuleTransaction,
  ctx: PasspilotIssuanceRuleContext
): Promise<{ overriddenCode: PasspilotRuleCode | null }> {
  if (readPasspilotRulesMode() !== "on") return { overriddenCode: null };

  const [school] = await tx
    .select({ timeZone: schools.schoolTimezone })
    .from(schools)
    .where(eq(schools.id, ctx.schoolId))
    .limit(1);
  const day = resolvePasspilotRuleDay(ctx.now, school?.timeZone);
  const dayStartSql = utcTimestampForSql(day.dayStart);

  const snapshot = (
    ruleCode: PasspilotRuleCode,
    details: PasspilotRuleDenialDetails,
    windowKind: PasspilotRuleWindowKind | null
  ): PasspilotRuleDenialSnapshot => ({
    schoolId: ctx.schoolId,
    studentId: ctx.studentId,
    destination: ctx.destination,
    ruleCode,
    issuedVia: ctx.issuedVia,
    actorUserId: ctx.actorUserId,
    teacherId: ctx.teacherId,
    classSource: ctx.classSource,
    gradeId: ctx.gradeId,
    classpilotGroupId: ctx.classpilotGroupId,
    supervisionContextId: ctx.supervisionContextId ?? null,
    issuingKioskSessionId: ctx.issuingKioskSessionId ?? null,
    windowKind,
    details,
    overridden: false,
  });
  const state: PasspilotRuleOutcome = {};
  const violated = (denial: PasspilotRuleDenialSnapshot) => {
    if (!state.overridden && ctx.override && ctx.override === denial.ruleCode) {
      state.overridden = { ...denial, overridden: true };
      return;
    }
    throw new PasspilotRuleError(denial);
  };

  // ENCOUNTER: the paired student is out on an active pass issued today.
  // Deactivated students never block; stale actives from other days neither.
  const pairedStudent = sql`CASE WHEN ${passpilotEncounterRestrictions.studentAId} = ${ctx.studentId}
    THEN ${passpilotEncounterRestrictions.studentBId} ELSE ${passpilotEncounterRestrictions.studentAId} END`;
  const [encounter] = await tx
    .select({ id: passpilotEncounterRestrictions.id })
    .from(passpilotEncounterRestrictions)
    .innerJoin(passes, and(
      eq(passes.schoolId, passpilotEncounterRestrictions.schoolId),
      eq(passes.status, "active"),
      sql`${passes.studentId} = ${pairedStudent}`,
      sql`${passes.issuedAt} >= ${dayStartSql}`
    ))
    .innerJoin(students, and(
      eq(students.schoolId, passes.schoolId),
      eq(students.id, passes.studentId),
      eq(students.status, "active")
    ))
    .where(and(
      eq(passpilotEncounterRestrictions.schoolId, ctx.schoolId),
      eq(passpilotEncounterRestrictions.enabled, true),
      or(
        eq(passpilotEncounterRestrictions.studentAId, ctx.studentId),
        eq(passpilotEncounterRestrictions.studentBId, ctx.studentId)
      )
    ))
    .orderBy(asc(passpilotEncounterRestrictions.id))
    .limit(1);
  if (encounter) violated(snapshot("PASSPILOT_RULE_ENCOUNTER", { restrictionId: encounter.id }, null));

  // DESTINATION_CAPACITY: today's active passes of active students.
  if (isRuleDestination(ctx.destination)) {
    const [policy] = await tx
      .select({ maxConcurrent: passpilotDestinationPolicies.maxConcurrent })
      .from(passpilotDestinationPolicies)
      .where(and(
        eq(passpilotDestinationPolicies.schoolId, ctx.schoolId),
        eq(passpilotDestinationPolicies.destination, ctx.destination),
        eq(passpilotDestinationPolicies.enabled, true)
      ))
      .limit(1);
    if (policy) {
      const [out] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(passes)
        .innerJoin(students, and(
          eq(students.schoolId, passes.schoolId),
          eq(students.id, passes.studentId),
          eq(students.status, "active")
        ))
        .where(and(
          eq(passes.schoolId, ctx.schoolId),
          eq(passes.destination, ctx.destination),
          eq(passes.status, "active"),
          sql`${passes.issuedAt} >= ${dayStartSql}`
        ));
      const count = out?.count ?? 0;
      if (count >= policy.maxConcurrent) {
        violated(snapshot("PASSPILOT_RULE_DESTINATION_CAPACITY", { count, limit: policy.maxConcurrent }, null));
      }
    }
  }

  // Limits: an enabled student row overrides the enabled school default field by field.
  const limitRows = await tx
    .select({
      studentId: passpilotPassLimits.studentId,
      dailyLimit: passpilotPassLimits.dailyLimit,
      periodLimit: passpilotPassLimits.periodLimit,
    })
    .from(passpilotPassLimits)
    .where(and(
      eq(passpilotPassLimits.schoolId, ctx.schoolId),
      eq(passpilotPassLimits.enabled, true),
      or(isNull(passpilotPassLimits.studentId), eq(passpilotPassLimits.studentId, ctx.studentId))
    ));
  const studentLimits = limitRows.find((row) => row.studentId === ctx.studentId);
  const defaultLimits = limitRows.find((row) => row.studentId === null);
  const dailyLimit = studentLimits?.dailyLimit ?? defaultLimits?.dailyLimit ?? null;
  const periodLimit = studentLimits?.periodLimit ?? defaultLimits?.periodLimit ?? null;

  // DAILY_LIMIT: non-canceled passes issued on the school-local day.
  if (dailyLimit !== null) {
    const count = await countStudentPasses(tx, ctx, day.dayStart, day.dayEnd);
    if (count >= dailyLimit) {
      violated(snapshot("PASSPILOT_RULE_DAILY_LIMIT", {
        count,
        limit: dailyLimit,
        windowStartsAt: day.dayStart.toISOString(),
        windowEndsAt: day.dayEnd.toISOString(),
      }, "day"));
    }
  }

  // PERIOD_LIMIT: enforced only when a period window is known for this pass.
  if (periodLimit !== null) {
    const window = await resolvePasspilotPeriodWindow(tx, ctx, day);
    if (window) {
      const count = await countStudentPasses(tx, ctx, window.startsAt, window.endsAt);
      if (count >= periodLimit) {
        violated(snapshot("PASSPILOT_RULE_PERIOD_LIMIT", {
          count,
          limit: periodLimit,
          windowLabel: window.label,
          windowStartsAt: window.startsAt.toISOString(),
          windowEndsAt: window.endsAt.toISOString(),
        }, window.kind));
      }
    }
  }

  if (state.overridden && ctx.outcome) ctx.outcome.overridden = state.overridden;
  return { overriddenCode: state.overridden?.ruleCode ?? null };
}

// ---------------------------------------------------------------------------
// Denials, retention, DTOs
// ---------------------------------------------------------------------------

/**
 * Best-effort denial record, written after the issuance transaction rolled
 * back, on the caller's tenant context. Never throws.
 */
export async function recordPasspilotRuleDenial(snapshot: PasspilotRuleDenialSnapshot): Promise<boolean> {
  try {
    await db.insert(passpilotPassDenials).values({
      schoolId: snapshot.schoolId,
      studentId: snapshot.studentId,
      destination: snapshot.destination,
      ruleCode: snapshot.ruleCode,
      issuedVia: snapshot.issuedVia,
      actorUserId: snapshot.actorUserId,
      teacherId: snapshot.teacherId,
      classSource: snapshot.classSource,
      gradeId: snapshot.gradeId,
      classpilotGroupId: snapshot.classpilotGroupId,
      supervisionContextId: snapshot.supervisionContextId,
      issuingKioskSessionId: snapshot.issuingKioskSessionId,
      windowKind: snapshot.windowKind,
      details: snapshot.details,
      overridden: snapshot.overridden,
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "passpilot_rule_denial_write_failed", ruleCode: snapshot.ruleCode }));
    errorMonitor.trackError("api_error", error, {
      job: "passpilotRuleDenialWrite",
      errorCode: "PASSPILOT_RULE_DENIAL_WRITE_FAILED",
      schoolId: snapshot.schoolId,
    }, { persist: false });
    return false;
  }
}

type PurgeConnection = {
  query: (text: string, values: unknown[]) => Promise<{ rowCount: number | null }>;
};

/** Deletes denial records older than the 400-day retention horizon in batches. */
export async function purgeExpiredPasspilotPassDenials(
  connection: PurgeConnection,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - PASSPILOT_PASS_DENIAL_RETENTION_DAYS * 86_400_000);
  const batchSize = 5000;
  let total = 0;
  let deleted = 0;
  do {
    const result = await connection.query(
      `DELETE FROM passpilot_pass_denials WHERE id IN (
        SELECT id FROM passpilot_pass_denials WHERE denied_at < $1 ORDER BY denied_at LIMIT ${batchSize}
      )`,
      [cutoff]
    );
    deleted = result.rowCount ?? 0;
    total += deleted;
  } while (deleted >= batchSize);
  return total;
}

/**
 * Null override codes stay absent for compatibility. Encounter overrides are
 * confidential even after Rules is turned off; only a verified administrator
 * role may retain that code. Public/kiosk callers deliberately omit viewerRole.
 */
export function withoutNullRuleOverride<T extends { ruleOverrideCode?: string | null }>(
  pass: T,
  viewerRole?: string | null
): Omit<T, "ruleOverrideCode"> & { ruleOverrideCode?: string } {
  if (pass.ruleOverrideCode && (
    pass.ruleOverrideCode !== "PASSPILOT_RULE_ENCOUNTER" || canOverridePasspilotRules(viewerRole)
  )) return pass as Omit<T, "ruleOverrideCode"> & { ruleOverrideCode: string };
  const { ruleOverrideCode: _omitted, ...rest } = pass;
  return rest;
}
