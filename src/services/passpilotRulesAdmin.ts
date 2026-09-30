import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import db from "../db.js";
import { students } from "../schema/students.js";
import {
  grades,
  passpilotDestinationPolicies,
  passpilotEncounterRestrictions,
  passpilotPassDenials,
  passpilotPassLimits,
  passpilotTeacherKioskSettings,
  PASSPILOT_RULE_DESTINATIONS,
  type PasspilotRuleDestination,
} from "../schema/passpilot.js";
import { getSchoolSchedulingContext } from "./classpilotScheduling.js";
import { getPasspilotClassSourceForSchool } from "./passpilotAccess.js";
import { PASSPILOT_PASS_DENIAL_RETENTION_DAYS } from "./passpilotRules.js";
import { isDatabaseErrorCode } from "../util/databaseError.js";

/**
 * Administrator reads and writes for PassPilot issuance rules. Every query
 * filters by the caller's school in addition to RLS; nothing here trusts a
 * school id from a request body.
 */

export type PasspilotPeriodEnforcement = "bell_schedule" | "class_window" | "unavailable";

export type PasspilotRuleStudent = {
  id: string;
  firstName: string;
  lastName: string;
  studentIdNumber: string | null;
  status: string;
};

export type PasspilotLimitInput = {
  dailyLimit: number | null;
  periodLimit: number | null;
  enabled: boolean;
};

export type PasspilotRulesDto = {
  destinations: readonly PasspilotRuleDestination[];
  destinationPolicies: Array<{
    destination: PasspilotRuleDestination;
    maxConcurrent: number;
    enabled: boolean;
    updatedAt: string;
  }>;
  defaultLimits: (PasspilotLimitInput & { id: string; updatedAt: string }) | null;
  studentLimits: Array<PasspilotLimitInput & {
    id: string;
    studentId: string;
    student: PasspilotRuleStudent | null;
    updatedAt: string;
  }>;
  encounterRestrictions: Array<{
    id: string;
    studentAId: string;
    studentBId: string;
    students: PasspilotRuleStudent[];
    reasonNote: string | null;
    enabled: boolean;
    createdAt: string;
  }>;
  periodEnforcement: PasspilotPeriodEnforcement;
  denialRetentionDays: number;
};

export function isPasspilotRuleDestination(value: string): value is PasspilotRuleDestination {
  return (PASSPILOT_RULE_DESTINATIONS as readonly string[]).includes(value);
}

async function loadStudents(schoolId: string, ids: string[]): Promise<Map<string, PasspilotRuleStudent>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      studentIdNumber: students.studentIdNumber,
      status: students.status,
    })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), inArray(students.id, [...new Set(ids)])));
  return new Map(rows.map((row) => [row.id, { ...row, studentIdNumber: row.studentIdNumber ?? null }]));
}

/** Active students of this school only; a foreign or removed id is absent. */
export async function findActivePasspilotRuleStudents(schoolId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: students.id })
    .from(students)
    .where(and(
      eq(students.schoolId, schoolId),
      eq(students.status, "active"),
      inArray(students.id, [...new Set(ids)])
    ));
  return new Set(rows.map((row) => row.id));
}

/**
 * Whether a period limit can be enforced for this school. Bell periods cover
 * every pass; otherwise only a scheduled or live class session (canonical
 * classes, or legacy classes linked to one) or an automatic kiosk block
 * defines the period, and a school with none of these cannot enforce it.
 */
export async function readPasspilotPeriodEnforcement(schoolId: string): Promise<PasspilotPeriodEnforcement> {
  try {
    const scheduling = await getSchoolSchedulingContext(schoolId);
    if (scheduling.config.profiles.some((profile) => Object.keys(profile.periods).length > 0)) {
      return "bell_schedule";
    }
  } catch {
    // Scheduling configuration unavailable: fall through to class windows.
  }
  if ((await getPasspilotClassSourceForSchool(schoolId)) === "classpilot_groups") return "class_window";
  const [linkedGrade] = await db
    .select({ id: grades.id })
    .from(grades)
    .where(and(eq(grades.schoolId, schoolId), isNotNull(grades.classpilotGroupId)))
    .limit(1);
  if (linkedGrade) return "class_window";
  const [automaticKiosk] = await db
    .select({ teacherId: passpilotTeacherKioskSettings.teacherId })
    .from(passpilotTeacherKioskSettings)
    .where(and(eq(passpilotTeacherKioskSettings.schoolId, schoolId), ne(passpilotTeacherKioskSettings.mode, "manual")))
    .limit(1);
  return automaticKiosk ? "class_window" : "unavailable";
}

export async function getPasspilotRules(schoolId: string): Promise<PasspilotRulesDto> {
  const policies = await db
    .select()
    .from(passpilotDestinationPolicies)
    .where(eq(passpilotDestinationPolicies.schoolId, schoolId));
  const limits = await db
    .select()
    .from(passpilotPassLimits)
    .where(eq(passpilotPassLimits.schoolId, schoolId));
  const encounters = await db
    .select()
    .from(passpilotEncounterRestrictions)
    .where(eq(passpilotEncounterRestrictions.schoolId, schoolId))
    .orderBy(asc(passpilotEncounterRestrictions.createdAt), asc(passpilotEncounterRestrictions.id));
  const studentMap = await loadStudents(schoolId, [
    ...limits.flatMap((limit) => (limit.studentId ? [limit.studentId] : [])),
    ...encounters.flatMap((encounter) => [encounter.studentAId, encounter.studentBId]),
  ]);
  const periodEnforcement = await readPasspilotPeriodEnforcement(schoolId);
  const destinationOrder = new Map(PASSPILOT_RULE_DESTINATIONS.map((destination, index) => [destination, index] as const));
  const defaultLimit = limits.find((limit) => limit.studentId === null);
  const nameKey = (student: PasspilotRuleStudent | null) =>
    student ? `${student.lastName}\u0000${student.firstName}` : "￿";

  return {
    destinations: PASSPILOT_RULE_DESTINATIONS,
    destinationPolicies: policies
      .filter((policy) => isPasspilotRuleDestination(policy.destination))
      .sort((left, right) => (destinationOrder.get(left.destination) ?? 0) - (destinationOrder.get(right.destination) ?? 0))
      .map((policy) => ({
        destination: policy.destination,
        maxConcurrent: policy.maxConcurrent,
        enabled: policy.enabled,
        updatedAt: policy.updatedAt.toISOString(),
      })),
    defaultLimits: defaultLimit
      ? {
          id: defaultLimit.id,
          dailyLimit: defaultLimit.dailyLimit,
          periodLimit: defaultLimit.periodLimit,
          enabled: defaultLimit.enabled,
          updatedAt: defaultLimit.updatedAt.toISOString(),
        }
      : null,
    studentLimits: limits
      .flatMap((limit) => (limit.studentId ? [{ ...limit, studentId: limit.studentId }] : []))
      .map((limit) => ({
        id: limit.id,
        studentId: limit.studentId,
        student: studentMap.get(limit.studentId) ?? null,
        dailyLimit: limit.dailyLimit,
        periodLimit: limit.periodLimit,
        enabled: limit.enabled,
        updatedAt: limit.updatedAt.toISOString(),
      }))
      .sort((left, right) => nameKey(left.student).localeCompare(nameKey(right.student))
        || left.studentId.localeCompare(right.studentId)),
    encounterRestrictions: encounters.map((encounter) => ({
      id: encounter.id,
      studentAId: encounter.studentAId,
      studentBId: encounter.studentBId,
      students: [encounter.studentAId, encounter.studentBId]
        .map((id) => studentMap.get(id))
        .filter((student): student is PasspilotRuleStudent => !!student),
      reasonNote: encounter.reasonNote,
      enabled: encounter.enabled,
      createdAt: encounter.createdAt.toISOString(),
    })),
    periodEnforcement,
    denialRetentionDays: PASSPILOT_PASS_DENIAL_RETENTION_DAYS,
  };
}

export async function upsertPasspilotDestinationPolicy(
  schoolId: string,
  destination: PasspilotRuleDestination,
  input: { maxConcurrent: number; enabled: boolean },
  actorUserId: string
) {
  const [before] = await db
    .select()
    .from(passpilotDestinationPolicies)
    .where(and(eq(passpilotDestinationPolicies.schoolId, schoolId), eq(passpilotDestinationPolicies.destination, destination)))
    .limit(1);
  const [after] = await db
    .insert(passpilotDestinationPolicies)
    .values({ schoolId, destination, maxConcurrent: input.maxConcurrent, enabled: input.enabled, updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: [passpilotDestinationPolicies.schoolId, passpilotDestinationPolicies.destination],
      set: { maxConcurrent: input.maxConcurrent, enabled: input.enabled, updatedBy: actorUserId, updatedAt: sql`now()` },
    })
    .returning();
  return {
    before: before ? { maxConcurrent: before.maxConcurrent, enabled: before.enabled } : null,
    after: { maxConcurrent: after!.maxConcurrent, enabled: after!.enabled },
  };
}

export async function deletePasspilotDestinationPolicy(schoolId: string, destination: PasspilotRuleDestination) {
  const [deleted] = await db
    .delete(passpilotDestinationPolicies)
    .where(and(eq(passpilotDestinationPolicies.schoolId, schoolId), eq(passpilotDestinationPolicies.destination, destination)))
    .returning();
  return deleted ? { maxConcurrent: deleted.maxConcurrent, enabled: deleted.enabled } : null;
}

/** studentId null upserts the school default; the student must be pre-validated. */
export async function upsertPasspilotPassLimit(
  schoolId: string,
  studentId: string | null,
  input: PasspilotLimitInput,
  actorUserId: string
) {
  const scope = studentId === null
    ? isNull(passpilotPassLimits.studentId)
    : eq(passpilotPassLimits.studentId, studentId);
  const [before] = await db
    .select()
    .from(passpilotPassLimits)
    .where(and(eq(passpilotPassLimits.schoolId, schoolId), scope))
    .limit(1);
  const values = {
    dailyLimit: input.dailyLimit,
    periodLimit: input.periodLimit,
    enabled: input.enabled,
    updatedBy: actorUserId,
  };
  const [after] = await db
    .insert(passpilotPassLimits)
    .values({ schoolId, studentId, ...values })
    .onConflictDoUpdate({
      target: studentId === null
        ? [passpilotPassLimits.schoolId]
        : [passpilotPassLimits.schoolId, passpilotPassLimits.studentId],
      targetWhere: studentId === null ? sql`student_id IS NULL` : sql`student_id IS NOT NULL`,
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning();
  const shape = (row: typeof after) => ({
    dailyLimit: row!.dailyLimit,
    periodLimit: row!.periodLimit,
    enabled: row!.enabled,
  });
  return { before: before ? shape(before) : null, after: shape(after) };
}

export async function deletePasspilotPassLimit(schoolId: string, studentId: string | null) {
  const scope = studentId === null
    ? isNull(passpilotPassLimits.studentId)
    : eq(passpilotPassLimits.studentId, studentId);
  const [deleted] = await db
    .delete(passpilotPassLimits)
    .where(and(eq(passpilotPassLimits.schoolId, schoolId), scope))
    .returning();
  return deleted
    ? { dailyLimit: deleted.dailyLimit, periodLimit: deleted.periodLimit, enabled: deleted.enabled }
    : null;
}

/** Canonical order uses code-unit comparison, matching the C-collation CHECK. */
export function canonicalEncounterPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export async function createPasspilotEncounterRestriction(
  schoolId: string,
  input: { studentIdA: string; studentIdB: string; reasonNote: string | null },
  actorUserId: string
): Promise<{ status: "created"; id: string; studentAId: string; studentBId: string } | { status: "duplicate" }> {
  const [studentAId, studentBId] = canonicalEncounterPair(input.studentIdA, input.studentIdB);
  try {
    const [created] = await db
      .insert(passpilotEncounterRestrictions)
      .values({ schoolId, studentAId, studentBId, reasonNote: input.reasonNote, createdBy: actorUserId })
      .returning({ id: passpilotEncounterRestrictions.id });
    return { status: "created", id: created!.id, studentAId, studentBId };
  } catch (error) {
    if (isDatabaseErrorCode(error, "23505")) return { status: "duplicate" };
    throw error;
  }
}

export async function setPasspilotEncounterRestrictionEnabled(schoolId: string, id: string, enabled: boolean) {
  const [updated] = await db
    .update(passpilotEncounterRestrictions)
    .set({ enabled })
    .where(and(eq(passpilotEncounterRestrictions.schoolId, schoolId), eq(passpilotEncounterRestrictions.id, id)))
    .returning({ id: passpilotEncounterRestrictions.id, enabled: passpilotEncounterRestrictions.enabled });
  return updated ?? null;
}

export async function deletePasspilotEncounterRestriction(schoolId: string, id: string) {
  const [deleted] = await db
    .delete(passpilotEncounterRestrictions)
    .where(and(eq(passpilotEncounterRestrictions.schoolId, schoolId), eq(passpilotEncounterRestrictions.id, id)))
    .returning({ id: passpilotEncounterRestrictions.id });
  return deleted ?? null;
}

/**
 * One student's rule records for a verified access request (Privacy Policy
 * section 10.1): the student's limit row, a count of encounter restrictions
 * (the paired student is another student's record and is not disclosed), and
 * the retained denial history.
 */
export async function getPasspilotStudentRuleRecords(schoolId: string, studentId: string, now: Date = new Date()) {
  const studentMap = await loadStudents(schoolId, [studentId]);
  const student = studentMap.get(studentId);
  if (!student) return null;
  const [limit] = await db
    .select()
    .from(passpilotPassLimits)
    .where(and(eq(passpilotPassLimits.schoolId, schoolId), eq(passpilotPassLimits.studentId, studentId)))
    .limit(1);
  const [restrictionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(passpilotEncounterRestrictions)
    .where(and(
      eq(passpilotEncounterRestrictions.schoolId, schoolId),
      sql`(${passpilotEncounterRestrictions.studentAId} = ${studentId} OR ${passpilotEncounterRestrictions.studentBId} = ${studentId})`
    ));
  const retainedFrom = new Date(now.getTime() - PASSPILOT_PASS_DENIAL_RETENTION_DAYS * 86_400_000);
  const denials = await db
    .select({
      id: passpilotPassDenials.id,
      ruleCode: passpilotPassDenials.ruleCode,
      destination: passpilotPassDenials.destination,
      issuedVia: passpilotPassDenials.issuedVia,
      windowKind: passpilotPassDenials.windowKind,
      details: passpilotPassDenials.details,
      overridden: passpilotPassDenials.overridden,
      deniedAt: passpilotPassDenials.deniedAt,
    })
    .from(passpilotPassDenials)
    .where(and(
      eq(passpilotPassDenials.schoolId, schoolId),
      eq(passpilotPassDenials.studentId, studentId),
      gte(passpilotPassDenials.deniedAt, retainedFrom)
    ))
    .orderBy(desc(passpilotPassDenials.deniedAt), asc(passpilotPassDenials.id))
    .limit(5000);
  return {
    student,
    limit: limit
      ? { dailyLimit: limit.dailyLimit, periodLimit: limit.periodLimit, enabled: limit.enabled, updatedAt: limit.updatedAt.toISOString() }
      : null,
    encounterRestrictionCount: restrictionCount?.count ?? 0,
    denials: denials.map((denial) => ({
      id: denial.id,
      ruleCode: denial.ruleCode,
      destination: denial.destination,
      issuedVia: denial.issuedVia,
      windowKind: denial.windowKind,
      // Encounter rows keep only a restriction id; drop it from the export
      // so the paired student is not derivable from this student's records.
      details: denial.ruleCode === "PASSPILOT_RULE_ENCOUNTER" ? {} : denial.details,
      overridden: denial.overridden,
      deniedAt: denial.deniedAt.toISOString(),
    })),
    retentionDays: PASSPILOT_PASS_DENIAL_RETENTION_DAYS,
  };
}
