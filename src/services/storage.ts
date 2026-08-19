import { eq, and, desc, asc, gt, lt, ilike, or, isNull, isNotNull, inArray, notInArray, getTableColumns, sql, ne, type SQL, type SQLWrapper } from "drizzle-orm";
import { PgDialect, type PgUpdateSetSource } from "drizzle-orm/pg-core";
import db from "../db.js";
import { getTenantStore, rlsGucEnabled } from "../db/tenantContext.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  dispatchCacheInvalidation,
  publishCacheInvalidation,
  registerCacheInvalidationHandler,
} from "../realtime/cacheInvalidation.js";
import { createLocalDateFormatter, localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { classpilotRetentionExpiresAt } from "../util/classpilotRetention.js";
import {
  emptyClasspilotRestrictions,
  restrictionsFromClassroomStates,
} from "./classpilotClassroomState.js";
import {
  createClasspilotReportAuthorizationMarker,
  isClasspilotReportAuthorizedStaff,
} from "./classpilotReportAuthorization.js";
import {
  assertClasspilotHistoryFallbackPiStatementDiscoverable,
  createClasspilotHistoryFallbackSqlShapeIdentity,
  type ClasspilotHistoryFallbackSqlShapeIdentity,
} from "./classpilotHistoryFallbackSqlIdentity.js";
import {
  users,
  schools,
  schoolMemberships,
  productLicenses,

  type User,
  type InsertUser,
  type School,
  type InsertSchool,
  type SchoolMembership,
  type InsertSchoolMembership,
  type ProductLicense,
  type InsertProductLicense,
} from "../schema/core.js";
import {
  students,
  studentAttendance,
  type Student,
  type InsertStudent,
  type StudentAttendance,
  type InsertStudentAttendance,
} from "../schema/students.js";
import {
  grades,
  teacherGrades,
  passpilotGradeStudents,
  passes,
  type Grade,
  type InsertGrade,
  type Pass,
  type InsertPass,
} from "../schema/passpilot.js";
import {
  homerooms,
  parentStudent,
  authorizedPickups,
  custodyAlerts,
  busRoutes,
  walkerZones,
  dismissalSessions,
  dismissalQueue,
  dismissalChanges,
  familyGroups,
  familyGroupStudents,
  activityLog,
  type Homeroom,
  type InsertHomeroom,
  type ParentStudent,
  type InsertParentStudent,
  type AuthorizedPickup,
  type InsertAuthorizedPickup,
  type CustodyAlert,
  type InsertCustodyAlert,
  type BusRoute,
  type InsertBusRoute,
  type WalkerZone,
  type InsertWalkerZone,
  type DismissalSession,
  type InsertDismissalSession,
  type DismissalQueueEntry,
  type InsertDismissalQueueEntry,
  type DismissalChange,
  type InsertDismissalChange,
  type FamilyGroup,
  type InsertFamilyGroup,
  type FamilyGroupStudent,
  type InsertFamilyGroupStudent,
  homeroomTeachers,
  dismissalOverrides,
  type HomeroomTeacher,
  type InsertHomeroomTeacher,
  type DismissalOverride,
  type InsertDismissalOverride,
} from "../schema/gopilot.js";
import {
  devices,
  studentDevices,
  studentSessions,
  heartbeats,
  events,
  groups,
  groupStudents,
  teachingSessions,
  sessionSettings,
  chatMessages,
  classpilotActiveHands,
  polls,
  pollResponses,
  classpilotCommands,
  classpilotCommandTargets,
  classpilotClassroomStates,
  classpilotScheduledConflicts,
  classpilotSessionSummaryDeliveries,
  classpilotSessionReports,
  classpilotSessionStudentReports,
  classpilotSessionStaff,
  classpilotMonitoringEvents,
  classpilotStudentControlStates,
  classpilotSessionStudents,
  classpilotSessionUsage,
  classpilotCoverageAssignments,
  classpilotCoverageScopeGroups,
  classpilotCoverageScopeGroupMembers,
  classpilotSupervisionContexts,
  classpilotSupervisionStudents,
  subgroups,
  subgroupMembers,
  flightPaths,
  blockLists,
  messages,
  checkIns,
  dashboardTabs,
  teacherSettings,
  teacherStudents,
  dailyUsage,
  classpilotScheduleChangePairs,
  classpilotScheduleChanges,
  classpilotScheduleChangeLegs,
  type Device,
  type InsertDevice,
  type StudentDevice,
  type InsertStudentDevice,
  type StudentSession,
  type InsertStudentSession,
  type Heartbeat,
  type InsertHeartbeat,
  type EventRecord,
  type InsertEvent,
  type Group,
  type InsertGroup,
  type GroupStudent,
  type InsertGroupStudent,
  type TeachingSession,
  type InsertTeachingSession,
  type SessionSetting,
  type InsertSessionSetting,
  type ChatMessage,
  type InsertChatMessage,
  type ClasspilotActiveHand,
  type InsertClasspilotActiveHand,
  type Poll,
  type InsertPoll,
  type PollResponse,
  type InsertPollResponse,
  type ClasspilotCommand,
  type InsertClasspilotCommand,
  type ClasspilotCommandTarget,
  type InsertClasspilotCommandTarget,
  type ClasspilotClassroomState,
  type InsertClasspilotClassroomState,
  type ClasspilotScheduledConflict,
  type InsertClasspilotScheduledConflict,
  type ClasspilotSessionSummaryDelivery,
  type InsertClasspilotSessionSummaryDelivery,
  type ClasspilotSessionReport,
  type ClasspilotSessionStudentReport,
  type ClasspilotSessionStaff,
  type ClasspilotMonitoringEvent,
  type InsertClasspilotMonitoringEvent,
  type ClasspilotStudentControlState,
  type ClasspilotSessionStudent,
  type ClasspilotSessionUsage,
  type ClasspilotCoverageAssignment,
  type InsertClasspilotCoverageAssignment,
  type ClasspilotCoverageScopeGroup,
  type InsertClasspilotCoverageScopeGroup,
  type ClasspilotCoverageScopeGroupMember,
  type ClasspilotSupervisionContext,
  type InsertClasspilotSupervisionContext,
  type ClasspilotSupervisionStudent,
  type InsertClasspilotSupervisionStudent,
  type Subgroup,
  type InsertSubgroup,
  type SubgroupMember,
  type InsertSubgroupMember,
  type FlightPath,
  type InsertFlightPath,
  type BlockList,
  type InsertBlockList,
  type MessageRecord,
  type InsertMessage,
  type CheckIn,
  type InsertCheckIn,
  type DashboardTab,
  type InsertDashboardTab,
  type TeacherSettingRecord,
  type InsertTeacherSetting,
  type TeacherStudent,
  type InsertTeacherStudent,
  type DailyUsage,
  type InsertDailyUsage,
  type ClasspilotScheduleChangePair,
  type ClasspilotScheduleChange,
  type ClasspilotScheduleChangeLeg,
  groupTeachers,
  type GroupTeacher,
  type InsertGroupTeacher,
} from "../schema/classpilot.js";
import {
  settings,
  googleOAuthTokens,
  googleRosterConnectors,
  classroomCourses,
  classroomCourseStudents,
  auditLogs,
  schoolInquiries,
  studentSafetyCases,
  studentTimelineEvents,
  classpilotAiDecisions,
  evidenceArtifacts,
  type Settings,
  type InsertSettings,
  type InstructionalCalendarSettings,
  type InstructionalCalendarMonthSettings,
  type GoogleOAuthToken,
  type InsertGoogleOAuthToken,
  type GoogleRosterConnector,
  type InsertGoogleRosterConnector,
  type ClassroomCourse,
  type InsertClassroomCourse,
  type ClassroomCourseStudent,
  type InsertClassroomCourseStudent,
  type AuditLog,
  type InsertAuditLog,
  type SchoolInquiry,
  type InsertSchoolInquiry,
  type StudentSafetyCase,
  type InsertStudentSafetyCase,
  type StudentTimelineEvent,
  type InsertStudentTimelineEvent,
  type ClasspilotAiDecision,
  type InsertClasspilotAiDecision,
  type EvidenceArtifact,
  type InsertEvidenceArtifact,
} from "../schema/shared.js";
import {
  mailpilotWatches,
  emailAlerts,
  emailScanLog,
  type MailpilotWatch,
  type InsertMailpilotWatch,
  type EmailAlert,
  type InsertEmailAlert,
  type InsertEmailScanLogEntry,
} from "../schema/mailpilot.js";

// ============================================================================
// User operations
// ============================================================================

export async function getUserById(
  id: string,
  dbInstance: typeof db = db
): Promise<User | undefined> {
  const [user] = await dbInstance.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function getUserByEmail(
  email: string
): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return user;
}

export async function getUserByGoogleId(
  googleId: string
): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.googleId, googleId))
    .limit(1);
  return user;
}

export async function createUser(data: InsertUser): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ ...data, email: data.email.toLowerCase() })
    .returning();
  return user!;
}

export async function updateUser(
  id: string,
  data: Partial<InsertUser>
): Promise<User | undefined> {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user;
}

// ============================================================================
// School operations
// ============================================================================

export async function getSchoolById(
  id: string,
  dbInstance: typeof db = db
): Promise<School | undefined> {
  const [school] = await dbInstance
    .select()
    .from(schools)
    .where(eq(schools.id, id))
    .limit(1);
  return school;
}

export async function getSchoolByDomain(
  domain: string
): Promise<School | undefined> {
  const [school] = await db
    .select()
    .from(schools)
    .where(eq(schools.domain, domain.toLowerCase()))
    .limit(1);
  return school;
}

export async function getSchoolsByDomain(
  domain: string
): Promise<School[]> {
  return db
    .select()
    .from(schools)
    .where(eq(schools.domain, domain.toLowerCase()));
}

/**
 * Resolve which school a student belongs to from their email.
 * - Single-school domain: returns that school (fast path).
 * - Multi-school domain: looks up the student record to disambiguate.
 * - Returns undefined if no school found or student not yet imported on a shared domain.
 */
export async function resolveSchoolForStudent(
  email: string
): Promise<{ school: School; isSharedDomain: boolean } | undefined> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;

  const matchingSchools = await getSchoolsByDomain(domain);
  if (matchingSchools.length === 0) return undefined;
  if (matchingSchools.length === 1) return { school: matchingSchools[0]!, isSharedDomain: false };

  // Multiple schools share this domain — find student by email. This is a
  // genuinely cross-school read (we don't yet know which school the email maps
  // to), so it must run super-scoped or RLS would hide all the candidate rows.
  const schoolIds = matchingSchools.map((s) => s.id);
  const [student] = await runWithTenantContext({ isSuper: true }, () =>
    db
      .select({ schoolId: students.schoolId })
      .from(students)
      .where(
        and(
          eq(students.emailLc, email.toLowerCase()),
          inArray(students.schoolId, schoolIds)
        )
      )
      .limit(1),
  );

  if (!student) return undefined; // Student not imported yet

  const school = matchingSchools.find((s) => s.id === student.schoolId);
  return school ? { school, isSharedDomain: true } : undefined;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function createSchool(data: InsertSchool): Promise<School> {
  // Auto-generate slug from school name if not provided
  if (!data.slug && data.name) {
    let base = generateSlug(data.name);
    let slug = base;
    let attempt = 0;
    while (attempt < 10) {
      const existing = await getSchoolBySlugIncludingDeleted(slug);
      if (!existing) break;
      attempt++;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    data.slug = slug;
  }
  const [school] = await db.insert(schools).values(data).returning();
  return school!;
}

// ============================================================================
// School Membership operations
// ============================================================================

export async function getMemberships(
  userId: string
): Promise<SchoolMembership[]> {
  return db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.status, "active")
      )
    );
}

export async function getMembershipsWithSchool(userId: string) {
  return db
    .select({
      membership: schoolMemberships,
      school: schools,
    })
    .from(schoolMemberships)
    .innerJoin(schools, eq(schoolMemberships.schoolId, schools.id))
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.status, "active"),
        isNull(schools.deletedAt)
      )
    );
}

const STAFF_DOMAIN_ROLES = new Set(["admin", "school_admin", "teacher", "office_staff"]);

export function normalizeDomain(domain?: string | null): string | null {
  const cleaned = String(domain || "").trim().toLowerCase();
  return cleaned || null;
}

export function getEmailDomain(email?: string | null): string | null {
  const domain = String(email || "").split("@")[1];
  return normalizeDomain(domain);
}

export function isStaffDomainRole(role?: string | null): boolean {
  return STAFF_DOMAIN_ROLES.has(String(role || ""));
}

/**
 * Guardrail for STUDENT email domains. Unlike staff, students may legitimately
 * have no email at all (GoPilot dismissal / PassPilot hall-pass identify kids by
 * name + badge/ID), so a blank email always passes. But if an email IS provided,
 * its domain must match the school's domain — otherwise the ClassPilot extension
 * (which resolves the school from the login email's domain) could never attribute
 * that student to this school. Pure/synchronous so bulk imports can validate each
 * row against a single pre-fetched school domain without a DB call per row.
 */
export function studentEmailDomainMatches(
  email: string | null | undefined,
  expectedDomain: string | null
): { ok: boolean; expectedDomain: string | null; actualDomain: string | null } {
  const normExpected = normalizeDomain(expectedDomain);
  const actualDomain = getEmailDomain(email);
  // No email → allowed (badge/ID-only students). No school domain set → can't
  // validate, so don't block (a domainless school can't use ClassPilot anyway).
  if (!email || !normExpected) {
    return { ok: true, expectedDomain: normExpected, actualDomain };
  }
  return { ok: actualDomain === normExpected, expectedDomain: normExpected, actualDomain };
}

function schoolIsolationError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

export async function validateStaffEmailDomainForSchool(
  email: string,
  schoolId: string
): Promise<{
  ok: boolean;
  code?: string;
  message?: string;
  expectedDomain?: string | null;
  actualDomain?: string | null;
}> {
  const school = await getSchoolById(schoolId);
  const expectedDomain = normalizeDomain(school?.domain);
  const actualDomain = getEmailDomain(email);

  if (!expectedDomain) {
    return {
      ok: false,
      code: "SCHOOL_DOMAIN_REQUIRED",
      message: "School domain is required before adding staff accounts.",
      expectedDomain,
      actualDomain,
    };
  }

  if (!actualDomain || actualDomain !== expectedDomain) {
    return {
      ok: false,
      code: "STAFF_EMAIL_DOMAIN_MISMATCH",
      message: `Staff email must use the school's Google Workspace domain (${expectedDomain}).`,
      expectedDomain,
      actualDomain,
    };
  }

  return { ok: true, expectedDomain, actualDomain };
}

async function assertStaffMembershipEmailDomain(
  data: Pick<InsertSchoolMembership, "userId" | "schoolId" | "role">
): Promise<void> {
  if (!isStaffDomainRole(data.role)) return;
  const user = await getUserById(data.userId);
  if (!user) return;
  const validation = await validateStaffEmailDomainForSchool(user.email, data.schoolId);
  if (!validation.ok) {
    throw schoolIsolationError(validation.code!, validation.message!);
  }
  // One email per person: a staff member can't reuse an email that already
  // belongs to a student in this school (the reverse of the student-side guard).
  const studentClash = await getStudentByEmail(data.schoolId, user.email.toLowerCase());
  if (studentClash) {
    throw schoolIsolationError(
      "EMAIL_IN_USE_BY_STUDENT",
      "This email is already assigned to a student in this school. Each person needs a unique email."
    );
  }
}

export async function getStaffEmailDomainMismatches(schoolId: string): Promise<Array<{
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  expectedDomain: string | null;
  actualDomain: string | null;
  reason: "missing_school_domain" | "domain_mismatch";
}>> {
  const school = await getSchoolById(schoolId);
  const expectedDomain = normalizeDomain(school?.domain);
  const rows = await db
    .select({ membership: schoolMemberships, user: users })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin", "teacher", "office_staff"])
      )
    );

  return rows
    .map((row) => {
      const actualDomain = getEmailDomain(row.user.email);
      if (!expectedDomain) {
        return {
          membershipId: row.membership.id,
          userId: row.user.id,
          email: row.user.email,
          role: row.membership.role,
          expectedDomain,
          actualDomain,
          reason: "missing_school_domain" as const,
        };
      }
      if (actualDomain !== expectedDomain) {
        return {
          membershipId: row.membership.id,
          userId: row.user.id,
          email: row.user.email,
          role: row.membership.role,
          expectedDomain,
          actualDomain,
          reason: "domain_mismatch" as const,
        };
      }
      return null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

export async function createMembership(
  data: InsertSchoolMembership
): Promise<SchoolMembership> {
  await assertStaffMembershipEmailDomain(data);
  const [membership] = await db
    .insert(schoolMemberships)
    .values(data)
    .returning();
  return membership!;
}

// ============================================================================
// Product License operations
// ============================================================================

export async function getProductLicenses(
  schoolId: string
): Promise<ProductLicense[]> {
  return db
    .select()
    .from(productLicenses)
    .where(eq(productLicenses.schoolId, schoolId));
}

export async function getAllProductLicenses(): Promise<ProductLicense[]> {
  return db.select().from(productLicenses);
}

export async function createProductLicense(
  data: InsertProductLicense
): Promise<ProductLicense> {
  const [license] = await db
    .insert(productLicenses)
    .values(data)
    .returning();
  return license!;
}

export type ApplySchoolBillingPaymentOptions = {
  schoolId: string;
  paidThrough: Date;
  amountPaid: number;
  planTier: string;
  now?: Date;
  studentCount?: number;
  products?: string[];
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
};

/**
 * Applies a successful billing event under the same school/config/license lock
 * domain used by schedule-change approvals and entitlement removal. Expiries
 * are monotonic, so a delayed Stripe event cannot shorten a newer paid term.
 */
export async function applySchoolBillingPayment(
  options: ApplySchoolBillingPaymentOptions
): Promise<{ school: School; updatedLicenseCount: number } | undefined> {
  if (!(options.paidThrough instanceof Date) || !Number.isFinite(options.paidThrough.getTime())) {
    throw new Error("paidThrough must be a valid date");
  }
  const now = options.now ?? new Date();
  const products = Array.from(
    new Set((options.products ?? []).map((value) => String(value).trim()).filter(Boolean))
  ).sort();
  const productsToLock = Array.from(new Set([...products, "CLASSPILOT"])).sort();
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [lockedSchool] = await tx
      .select()
      .from(schools)
      .where(and(eq(schools.id, options.schoolId), isNull(schools.deletedAt)))
      .limit(1)
      .for("update");
    if (!lockedSchool) return undefined;
    await takePasspilotClassLock(tx, options.schoolId);

    const lockedLicenses = productsToLock.length > 0
      ? await tx
          .select({
            id: productLicenses.id,
            product: productLicenses.product,
            expiresAt: productLicenses.expiresAt,
          })
          .from(productLicenses)
          .where(
            and(
              eq(productLicenses.schoolId, options.schoolId),
              eq(productLicenses.status, "active"),
              inArray(productLicenses.product, productsToLock)
            )
          )
          .orderBy(asc(productLicenses.id))
          .for("update")
      : [];

    // NULL is the established unbounded-entitlement sentinel. A payment may
    // extend a finite horizon, but must never turn an unbounded school/license
    // into a finite one.
    const nextSchoolActiveUntil = lockedSchool.activeUntil === null
      ? null
      : lockedSchool.activeUntil < options.paidThrough
        ? options.paidThrough
        : lockedSchool.activeUntil;
    const classpilotLicenses = lockedLicenses.filter(
      (license) => license.product === "CLASSPILOT"
    );
    const nextClasspilotExpiries = classpilotLicenses.map((license) => {
      if (license.expiresAt === null) return null;
      if (!products.includes("CLASSPILOT")) return license.expiresAt;
      return license.expiresAt < options.paidThrough
        ? options.paidThrough
        : license.expiresAt;
    });
    const nextClasspilotExpiry: Date | null | undefined =
      nextClasspilotExpiries.length === 0
        ? undefined
        : nextClasspilotExpiries.some((value) => value === null)
          ? null
          : new Date(Math.max(...nextClasspilotExpiries.map((value) => value!.getTime())));
    const finiteHorizons = [nextSchoolActiveUntil, nextClasspilotExpiry].filter(
      (value): value is Date => value instanceof Date
    );
    // If either existing entitlement dimension is unbounded, only the other
    // finite dimension can constrain the event. No finite values means the
    // combined entitlement remains unbounded.
    const entitlementThrough = finiteHorizons.length > 0
      ? new Date(Math.min(...finiteHorizons.map((value) => value.getTime())))
      : undefined;
    if (entitlementThrough) {
      await reconcileClasspilotScheduleChangesForEntitlementRemoval({
        schoolId: options.schoolId,
        actorId: "system",
        validUntil: entitlementThrough,
        reasonCode: "billing_entitlement_horizon_changed",
        approvedMessage:
          "The paid-through date cannot end before an approved future schedule change. Cancel it first.",
        now,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
    }

    const [savedSchool] = await tx
      .update(schools)
      .set({
        status: "active",
        planTier: options.planTier,
        planStatus: "active",
        activeUntil: nextSchoolActiveUntil,
        ...(options.studentCount && options.studentCount > 0
          ? { maxLicenses: options.studentCount }
          : {}),
        ...(options.stripeCustomerId !== undefined
          ? { stripeCustomerId: options.stripeCustomerId }
          : {}),
        ...(options.stripeSubscriptionId !== undefined
          ? { stripeSubscriptionId: options.stripeSubscriptionId }
          : {}),
        lastPaymentAmount: Math.max(0, Math.trunc(options.amountPaid || 0)),
        lastPaymentDate: now,
        totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${Math.max(
          0,
          Math.trunc(options.amountPaid || 0)
        )}`,
        updatedAt: now,
      })
      .where(eq(schools.id, options.schoolId))
      .returning();
    if (!savedSchool) return undefined;

    let updatedLicenseCount = 0;
    const touchedLicenses = lockedLicenses.filter((license) =>
      products.includes(license.product)
    );
    if (touchedLicenses.length > 0) {
      const result = await tx
        .update(productLicenses)
        .set({
          expiresAt: sql`CASE
            WHEN ${productLicenses.expiresAt} IS NULL THEN NULL
            ELSE GREATEST(${productLicenses.expiresAt}, ${options.paidThrough})
          END`,
        })
        .where(inArray(productLicenses.id, touchedLicenses.map((license) => license.id)));
      updatedLicenseCount = result.rowCount ?? 0;
    }
    return { school: savedSchool, updatedLicenseCount };
  });
}

// ============================================================================
// School counts (for super-admin dashboard)
// ============================================================================

export async function getSchoolCounts(): Promise<
  Map<string, { adminCount: number; teacherCount: number; studentCount: number }>
> {
  const [membershipRows, studentRows] = await Promise.all([
    db
      .select({
        schoolId: schoolMemberships.schoolId,
        role: schoolMemberships.role,
        cnt: sql<number>`count(*)::int`,
      })
      .from(schoolMemberships)
      .where(eq(schoolMemberships.status, "active"))
      .groupBy(schoolMemberships.schoolId, schoolMemberships.role),
    db
      .select({
        schoolId: students.schoolId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(students)
      .where(eq(students.status, "active"))
      .groupBy(students.schoolId),
  ]);

  const counts = new Map<
    string,
    { adminCount: number; teacherCount: number; studentCount: number }
  >();

  for (const row of membershipRows) {
    const entry = counts.get(row.schoolId) || { adminCount: 0, teacherCount: 0, studentCount: 0 };
    if (row.role === "admin") entry.adminCount = row.cnt;
    else if (row.role === "teacher") entry.teacherCount = row.cnt;
    counts.set(row.schoolId, entry);
  }

  for (const row of studentRows) {
    const entry = counts.get(row.schoolId) || { adminCount: 0, teacherCount: 0, studentCount: 0 };
    entry.studentCount = row.cnt;
    counts.set(row.schoolId, entry);
  }

  return counts;
}

// ============================================================================
// Student operations (basic - Phase 3 will expand)
// ============================================================================

function normalizeStudentEmailFields<T extends Partial<InsertStudent>>(data: T): T {
  if (data.email === undefined) return data;
  const email = typeof data.email === "string" ? data.email.trim() : data.email;
  return {
    ...data,
    email,
    emailLc: email ? email.toLowerCase() : null,
  };
}

export async function getStudentsBySchool(
  schoolId: string
): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(
      and(eq(students.schoolId, schoolId), eq(students.status, "active"))
    )
    .orderBy(students.lastName, students.firstName);
}

export type GoPilotStaffStudentDto = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  externalId: string | null;
  studentIdNumber: string | null;
  gradeLevel: string | null;
  homeroomId: string | null;
  homeroomName: string | null;
  dismissalType: string;
  busRoute: string | null;
  afterschoolReason: string | null;
  status: string;
  familyGroupId: string | null;
  familyName: string | null;
  carNumber: string | null;
};

/** Narrow GoPilot roster projection; unified student/device fields stay server-side. */
export async function getGoPilotStaffStudents(
  schoolId: string,
  options: {
    homeroomIds?: string[];
    homeroomId?: string;
    dismissalType?: string;
    includeManagerFields?: boolean;
  } = {}
): Promise<GoPilotStaffStudentDto[]> {
  const conditions = [
    eq(students.schoolId, schoolId),
    eq(students.status, "active"),
  ];
  if (options.homeroomIds) {
    if (options.homeroomIds.length === 0) return [];
    conditions.push(inArray(students.homeroomId, options.homeroomIds));
  }
  if (options.homeroomId) conditions.push(eq(students.homeroomId, options.homeroomId));
  if (options.dismissalType) conditions.push(eq(students.dismissalType, options.dismissalType));

  return db
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      email: students.email,
      externalId: students.externalId,
      studentIdNumber: students.studentIdNumber,
      gradeLevel: students.gradeLevel,
      homeroomId: students.homeroomId,
      homeroomName: homerooms.name,
      dismissalType: sql<string>`COALESCE(${students.dismissalType}, 'car')`,
      busRoute: students.busRoute,
      afterschoolReason: students.afterschoolReason,
      status: students.status,
      familyGroupId: familyGroups.id,
      familyName: familyGroups.familyName,
      carNumber: familyGroups.carNumber,
    })
    .from(students)
    .leftJoin(
      homerooms,
      and(
        eq(homerooms.id, students.homeroomId),
        eq(homerooms.schoolId, schoolId)
      )
    )
    .leftJoin(
      familyGroupStudents,
      and(
        eq(familyGroupStudents.schoolId, schoolId),
        eq(familyGroupStudents.studentId, students.id)
      )
    )
    .leftJoin(
      familyGroups,
      and(
        eq(familyGroups.schoolId, schoolId),
        eq(familyGroups.id, familyGroupStudents.familyGroupId)
      )
    )
    .where(and(...conditions))
    .orderBy(students.lastName, students.firstName, students.id);
}

// Lowercased emails of EVERY student in a school (any status) — used to detect
// duplicate emails on bulk/CSV import without a DB hit per row. Inactive students
// still hold the unique (school, email_lc) slot, so they count as conflicts.
export async function getStudentEmailsBySchool(
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ emailLc: students.emailLc })
    .from(students)
    .where(eq(students.schoolId, schoolId));
  return new Set(rows.map((r) => r.emailLc).filter((e): e is string => Boolean(e)));
}

export async function createStudent(data: InsertStudent): Promise<Student> {
  const [student] = await db
    .insert(students)
    .values(normalizeStudentEmailFields(data))
    .returning();
  return student!;
}

export async function getStudentById(
  id: string
): Promise<Student | undefined> {
  const [student] = await db
    .select()
    .from(students)
    .where(eq(students.id, id))
    .limit(1);
  return student;
}

export async function getStudentsByIds(ids: string[]): Promise<Student[]> {
  if (ids.length === 0) return [];
  return db.select().from(students).where(inArray(students.id, ids));
}

export async function getStudentByEmail(
  schoolId: string,
  emailLc: string
): Promise<Student | undefined> {
  const [student] = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.emailLc, emailLc)
      )
    )
    .limit(1);
  return student;
}

export async function updateStudent(
  id: string,
  data: Partial<InsertStudent>
): Promise<Student | undefined> {
  const [student] = await db
    .update(students)
    .set({ ...normalizeStudentEmailFields(data), updatedAt: new Date() })
    .where(eq(students.id, id))
    .returning();
  return student;
}

export async function getStudentsByExactEmails(
  schoolId: string,
  emailLcs: string[]
): Promise<Student[]> {
  const normalized = [...new Set(emailLcs.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return [];
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        inArray(students.emailLc, normalized)
      )
    );
}

export type StudentLifecycleAuditActor = {
  userId: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  /** Sanitized route/import identifier; never include names, emails, or request bodies. */
  source: string;
};

export type StudentRosterDeactivationResult = {
  foundStudentIds: string[];
  deactivatedStudentIds: string[];
  endedSessionCount: number;
  students: Array<Pick<Student, "id" | "email">>;
};

/**
 * Remove students from every active product roster without destroying retained
 * relationships or history. The school lock serializes this lifecycle change
 * with PassPilot issuance, while the row locks make retries and concurrent
 * single/bulk requests idempotent. Audit rows commit in the same transaction
 * and exist only for real active -> inactive transitions.
 */
export async function deactivateStudentsForRoster(
  schoolId: string,
  requestedStudentIds: string[],
  actor: StudentLifecycleAuditActor
): Promise<StudentRosterDeactivationResult> {
  const studentIds = [...new Set(requestedStudentIds.map(String).filter(Boolean))].sort();
  if (studentIds.length === 0) {
    return {
      foundStudentIds: [],
      deactivatedStudentIds: [],
      endedSessionCount: 0,
      students: [],
    };
  }

  return db.transaction(async (tx) => {
    await lockClasspilotScheduleChangeSchool(
      schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, schoolId);
    const lockedStudents = await tx
      .select({ id: students.id, email: students.email, status: students.status })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), inArray(students.id, studentIds)))
      .orderBy(asc(students.id))
      .for("update");

    const foundStudentIds = lockedStudents.map((student) => student.id);
    const deactivatedStudentIds = lockedStudents
      .filter((student) => student.status === "active")
      .map((student) => student.id);
    const now = new Date();

    // Close anomalous leftover sessions even on an idempotent retry of an
    // already-inactive student. This does not create another lifecycle audit.
    const endedSessions = foundStudentIds.length === 0
      ? { rowCount: 0 }
      : await tx
          .update(studentSessions)
          .set({ isActive: false, endedAt: now })
          .where(
            and(
              inArray(studentSessions.studentId, foundStudentIds),
              eq(studentSessions.isActive, true)
            )
          );

    if (deactivatedStudentIds.length > 0) {
      await tx
        .update(students)
        .set({ status: "inactive", updatedAt: now })
        .where(
          and(
            eq(students.schoolId, schoolId),
            inArray(students.id, deactivatedStudentIds),
            eq(students.status, "active")
          )
        );

      await tx.insert(auditLogs).values(
        deactivatedStudentIds.map((studentId) => ({
          schoolId,
          userId: actor.userId,
          userEmail: actor.userEmail ?? null,
          userRole: actor.userRole ?? null,
          action: "student.deactivated",
          entityType: "student",
          entityId: studentId,
          changes: { status: { from: "active", to: "inactive" } },
          metadata: { source: actor.source },
        }))
      );
    }

    return {
      foundStudentIds,
      deactivatedStudentIds,
      endedSessionCount: endedSessions.rowCount ?? 0,
      students: lockedStudents.map(({ id, email }) => ({ id, email })),
    };
  });
}

/**
 * Exact-email trusted roster upsert. Existing active rows receive the supplied
 * import refresh; inactive rows are reactivated with the same ID and retained
 * relationships. PIN fields are preserved unless the caller explicitly
 * supplies them. No fuzzy matching is permitted.
 */
export async function reactivateInactiveStudentForRosterImport(
  schoolId: string,
  emailLc: string,
  updates: Partial<InsertStudent>,
  actor: StudentLifecycleAuditActor
): Promise<{ student: Student | undefined; reactivated: boolean }> {
  const normalizedEmailLc = emailLc.trim().toLowerCase();
  if (!normalizedEmailLc) return { student: undefined, reactivated: false };

  const normalizedUpdates = normalizeStudentEmailFields(updates);
  if (
    normalizedUpdates.emailLc !== undefined &&
    normalizedUpdates.emailLc !== null &&
    normalizedUpdates.emailLc !== normalizedEmailLc
  ) {
    throw new Error("Roster import email does not match its exact identity key");
  }
  const safeUpdates = { ...normalizedUpdates } as Partial<InsertStudent> & Record<string, unknown>;
  delete safeUpdates.id;
  delete safeUpdates.schoolId;
  delete safeUpdates.status;
  safeUpdates.emailLc = normalizedEmailLc;

  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    await lockClasspilotScheduleChangeSchool(
      schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, schoolId);
    const [existing] = await tx
      .select()
      .from(students)
      .where(
        and(
          eq(students.schoolId, schoolId),
          eq(students.emailLc, normalizedEmailLc)
        )
      )
      .limit(1)
      .for("update");
    if (!existing) return { student: undefined, reactivated: false };

    const reactivated = existing.status !== "active";
    const now = new Date();
    if (reactivated) {
      const retainedScheduledGroups = await tx
        .select({ id: groups.id })
        .from(groupStudents)
        .innerJoin(groups, eq(groups.id, groupStudents.groupId))
        .where(
          and(
            eq(groupStudents.studentId, existing.id),
            eq(groups.schoolId, schoolId),
            eq(groups.status, "active"),
            eq(groups.scheduleEnabled, true),
            isNotNull(groups.blockStartTime),
            isNotNull(groups.blockEndTime)
          )
        )
        .orderBy(asc(groups.id));
      await lockScheduleChangeGroups(
        schoolId,
        retainedScheduledGroups.map((group) => group.id),
        tx as unknown as ScheduleChangeDb
      );
      for (const group of retainedScheduledGroups) {
        await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
          schoolId,
          groupId: group.id,
          addedStudentIds: [existing.id],
          includeInactiveProspectiveStudents: true,
          actorId: actor.userId,
          dbInstance: tx as unknown as ScheduleChangeDb,
        });
      }
      // A pre-fix race could leave an active session attached to an inactive
      // record. Never let a roster restore resurrect that credential.
      await tx
        .update(studentSessions)
        .set({ isActive: false, endedAt: now })
        .where(
          and(
            eq(studentSessions.studentId, existing.id),
            eq(studentSessions.isActive, true)
          )
        );
    }
    const [student] = await tx
      .update(students)
      .set({ ...safeUpdates, status: "active", updatedAt: now })
      .where(and(eq(students.id, existing.id), eq(students.schoolId, schoolId)))
      .returning();
    if (!student) throw new Error("Roster import could not update the matched student");

    if (reactivated) {
      await tx.insert(auditLogs).values({
        schoolId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? null,
        userRole: actor.userRole ?? null,
        action: "student.reactivated",
        entityType: "student",
        entityId: student.id,
        changes: { status: { from: existing.status, to: "active" } },
        metadata: { source: actor.source },
      });
    }

    return { student, reactivated };
  });
}

/** Counts-only credential-rotation helper. Caller must bind the school tenant. */
export async function getEncryptedClasspilotPinBatch(
  schoolId: string,
  afterId: string | undefined,
  batchSize: number
): Promise<Array<{ id: string; ciphertext: string }>> {
  const conditions = [
    eq(students.schoolId, schoolId),
    isNotNull(students.classpilotPinEncrypted),
  ];
  if (afterId) conditions.push(gt(students.id, afterId));

  const rows = await db
    .select({
      id: students.id,
      ciphertext: students.classpilotPinEncrypted,
    })
    .from(students)
    .where(and(...conditions))
    .orderBy(asc(students.id))
    .limit(batchSize);

  return rows.flatMap((row) =>
    row.ciphertext === null ? [] : [{ id: row.id, ciphertext: row.ciphertext }]
  );
}

/** Compare-and-swap prevents the rotation job from overwriting a concurrent PIN edit. */
export async function replaceEncryptedClasspilotPin(
  schoolId: string,
  rowId: string,
  expectedCiphertext: string,
  replacementCiphertext: string
): Promise<boolean> {
  const updated = await db
    .update(students)
    .set({ classpilotPinEncrypted: replacementCiphertext })
    .where(
      and(
        eq(students.id, rowId),
        eq(students.schoolId, schoolId),
        eq(students.classpilotPinEncrypted, expectedCiphertext)
      )
    )
    .returning({ id: students.id });
  return updated.length === 1;
}

export async function deleteStudent(
  id: string,
  schoolId: string,
  actor: StudentLifecycleAuditActor = {
    userId: null,
    userRole: "system",
    source: "storage.deleteStudent",
  }
): Promise<boolean> {
  const result = await deactivateStudentsForRoster(schoolId, [id], actor);
  return result.foundStudentIds.length === 1;
}

function legacyGradeMembershipCondition(schoolId: string, gradeId: string): SQL {
  return sql`(
    EXISTS (
      SELECT 1
      FROM passpilot_grade_students AS passpilot_membership
      WHERE passpilot_membership.school_id = ${schoolId}
        AND passpilot_membership.student_id = ${students.id}
        AND passpilot_membership.grade_id = ${gradeId}
    )
    OR ${students.gradeId} = ${gradeId}
  )`;
}

export async function searchStudents(
  schoolId: string,
  options: {
    search?: string;
    gradeLevel?: string;
    gradeId?: string;
    homeroomId?: string;
    status?: string;
    dismissalType?: string;
  } = {}
): Promise<Student[]> {
  const conditions = [eq(students.schoolId, schoolId)];

  if (options.status) {
    conditions.push(eq(students.status, options.status));
  } else {
    conditions.push(eq(students.status, "active"));
  }

  if (options.gradeLevel) {
    conditions.push(eq(students.gradeLevel, options.gradeLevel));
  }
  if (options.gradeId) {
    conditions.push(legacyGradeMembershipCondition(schoolId, options.gradeId));
  }
  if (options.homeroomId) {
    conditions.push(eq(students.homeroomId, options.homeroomId));
  }
  if (options.dismissalType) {
    conditions.push(eq(students.dismissalType, options.dismissalType));
  }

  let query = db
    .select()
    .from(students)
    .where(and(...conditions))
    .orderBy(students.lastName, students.firstName);

  if (options.search) {
    const term = `%${options.search}%`;
    conditions.push(
      or(
        ilike(students.firstName, term),
        ilike(students.lastName, term),
        ilike(students.email, term)
      )!
    );
    query = db
      .select()
      .from(students)
      .where(and(...conditions))
      .orderBy(students.lastName, students.firstName);
  }

  return query;
}

export async function bulkCreateStudents(data: InsertStudent[]): Promise<Student[]> {
  if (data.length === 0) return [];
  return db.insert(students).values(data.map(normalizeStudentEmailFields)).returning();
}

// ============================================================================
// School operations (extended)
// ============================================================================

export async function getAllSchools(options: {
  search?: string;
  status?: string;
} = {}): Promise<School[]> {
  const conditions: ReturnType<typeof eq>[] = [isNull(schools.deletedAt)];

  if (options.status) {
    conditions.push(eq(schools.status, options.status));
  }

  if (options.search) {
    const term = `%${options.search}%`;
    conditions.push(
      or(ilike(schools.name, term), ilike(schools.domain, term))!
    );
  }

  return db
    .select()
    .from(schools)
    .where(and(...conditions))
    .orderBy(schools.name);
}

/** Includes soft-deleted tenants so restored student PIN ciphertext remains readable. */
export async function getAllSchoolIdsForClasspilotPinMigration(): Promise<string[]> {
  const rows = await db
    .select({ id: schools.id })
    .from(schools)
    .orderBy(asc(schools.id));
  return rows.map((row) => row.id);
}

export async function updateSchool(
  id: string,
  data: Partial<InsertSchool>,
  scheduleChangeActorId?: string
): Promise<School | undefined> {
  const now = new Date();
  const passpilotSettingsFields = [
    "name",
    "schoolTimezone",
    "kioskEnabled",
    "kioskRequiresApproval",
    "kioskPinHash",
  ] as const;
  const touchesPasspilotSettings = passpilotSettingsFields.some((field) =>
    Object.prototype.hasOwnProperty.call(data, field)
  );
  const gopilotSettingsFields = [
    "dismissalTime",
    "schoolTimezone",
    "gopilotAutoStartEnabled",
    "gopilotPickupZones",
  ] as const;
  const touchesGopilotSettings = gopilotSettingsFields.some((field) =>
    Object.prototype.hasOwnProperty.call(data, field)
  );
  const entitlementFields = [
    "status",
    "isActive",
    "planStatus",
    "activeUntil",
    "disabledAt",
    "deletedAt",
  ] as const;
  const touchesClasspilotEntitlement = entitlementFields.some((field) =>
    Object.prototype.hasOwnProperty.call(data, field)
  );
  const update: PgUpdateSetSource<typeof schools> = {
    ...data,
    updatedAt: now,
    ...(touchesPasspilotSettings
      ? { passpilotSettingsRevision: sql`${schools.passpilotSettingsRevision} + 1` }
      : {}),
    ...(touchesGopilotSettings
      ? { gopilotSettingsRevision: sql`${schools.gopilotSettingsRevision} + 1` }
      : {}),
  };
  const school = await withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [lockedSchool] = await tx
      .select()
      .from(schools)
      .where(eq(schools.id, id))
      .limit(1)
      .for("update");
    if (!lockedSchool) return undefined;
    await takeClasspilotScheduleConfigLock(
      tx as unknown as ScheduleChangeDb,
      id
    );
    if (
      data.schoolTimezone !== undefined &&
      data.schoolTimezone !== lockedSchool.schoolTimezone
    ) {
      await reconcileClasspilotScheduleChangesForEntitlementRemoval({
        schoolId: id,
        actorId: scheduleChangeActorId,
        validUntil: now,
        affectedWhen: "ends_after",
        reasonCode: "school_timezone_changed",
        approvedMessage:
          "Cancel approved future schedule changes before changing the school timezone.",
        now,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
    }
    if (touchesClasspilotEntitlement) {
      const nextStatus = data.status ?? lockedSchool.status;
      const nextIsActive = data.isActive ?? lockedSchool.isActive;
      const nextPlanStatus = data.planStatus ?? lockedSchool.planStatus;
      const nextActiveUntil = data.activeUntil === undefined
        ? lockedSchool.activeUntil
        : data.activeUntil;
      const nextDisabledAt = data.disabledAt === undefined
        ? lockedSchool.disabledAt
        : data.disabledAt;
      const nextDeletedAt = data.deletedAt === undefined
        ? lockedSchool.deletedAt
        : data.deletedAt;
      const immediatelyUnavailable =
        nextStatus !== "active" ||
        !nextIsActive ||
        nextPlanStatus === "canceled" ||
        Boolean(nextDisabledAt) ||
        Boolean(nextDeletedAt) ||
        Boolean(nextActiveUntil && nextActiveUntil.getTime() <= now.getTime());
      if (immediatelyUnavailable || nextActiveUntil) {
        await reconcileClasspilotScheduleChangesForEntitlementRemoval({
          schoolId: id,
          actorId: scheduleChangeActorId,
          validUntil: immediatelyUnavailable ? now : nextActiveUntil,
          now,
          dbInstance: tx as unknown as ScheduleChangeDb,
        });
      }
    }
    const [saved] = await tx
      .update(schools)
      .set(update)
      .where(eq(schools.id, id))
      .returning();
    if (!saved) return undefined;

    // Name/timezone are duplicated for established ClassPilot consumers.
    // Keep alternate school writers transactionally consistent while their
    // revision increments force any open GoPilot/PassPilot settings draft to
    // detect the concurrent change instead of overwriting it.
    if (
      Object.prototype.hasOwnProperty.call(data, "name") ||
      Object.prototype.hasOwnProperty.call(data, "schoolTimezone")
    ) {
      await tx
        .update(settings)
        .set({
          ...(data.name !== undefined ? { schoolName: data.name } : {}),
          ...(data.schoolTimezone !== undefined
            ? { schoolTimezone: data.schoolTimezone }
            : {}),
        })
        .where(eq(settings.schoolId, id));
    }
    return saved;
  });
  if (school) {
    const target = { kind: "cache-invalidation", schoolId: id, cache: "classpilot-dashboard-school" } as const;
    dispatchCacheInvalidation(target);
    await publishCacheInvalidation(target);
  }
  return school;
}

export type PasspilotAdminSettingsDto = {
  name: string;
  schoolTimezone: string;
  kioskEnabled: boolean;
  kioskRequiresApproval: boolean;
  kioskPinConfigured: boolean;
  revision: number;
};

export type PasspilotAdminSettingsPatch = {
  name?: string;
  schoolTimezone?: string;
  kioskEnabled?: boolean;
  kioskRequiresApproval?: boolean;
  kioskPinHash?: string | null;
};

export type PasspilotAdminSettingsActor = {
  userId: string;
  userEmail?: string;
  userRole?: string;
};

export type UpdatePasspilotAdminSettingsResult =
  | {
      status: "saved";
      current: PasspilotAdminSettingsDto;
      changedFields: string[];
      kioskPinChange: "configured" | "cleared" | null;
    }
  | { status: "conflict"; current: PasspilotAdminSettingsDto }
  | { status: "pin_required"; current: PasspilotAdminSettingsDto };

function passpilotAdminSettingsDto(school: Pick<
  School,
  | "name"
  | "schoolTimezone"
  | "kioskEnabled"
  | "kioskRequiresApproval"
  | "kioskPinHash"
  | "passpilotSettingsRevision"
>): PasspilotAdminSettingsDto {
  return {
    name: school.name,
    schoolTimezone: school.schoolTimezone,
    kioskEnabled: school.kioskEnabled,
    kioskRequiresApproval: school.kioskRequiresApproval,
    kioskPinConfigured: Boolean(school.kioskPinHash),
    revision: school.passpilotSettingsRevision,
  };
}

/**
 * Read the deliberately narrow, non-secret PassPilot school-settings DTO.
 * Callers must already be inside an authenticated school tenant context.
 */
export async function getPasspilotAdminSettings(
  schoolId: string
): Promise<PasspilotAdminSettingsDto | undefined> {
  const [school] = await db
    .select({
      name: schools.name,
      schoolTimezone: schools.schoolTimezone,
      kioskEnabled: schools.kioskEnabled,
      kioskRequiresApproval: schools.kioskRequiresApproval,
      kioskPinHash: schools.kioskPinHash,
      passpilotSettingsRevision: schools.passpilotSettingsRevision,
    })
    .from(schools)
    .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
    .limit(1);
  return school ? passpilotAdminSettingsDto(school) : undefined;
}

/** Narrow compatibility write used by PassPilot's existing grade-level picker. */
export async function updatePasspilotActiveGradeLevels(
  schoolId: string,
  gradeLevels: string[]
): Promise<string | undefined> {
  const activeGradeLevels = JSON.stringify(gradeLevels);
  const [school] = await db
    .update(schools)
    .set({ activeGradeLevels, updatedAt: new Date() })
    .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
    .returning({ activeGradeLevels: schools.activeGradeLevels });
  return school?.activeGradeLevels ?? undefined;
}

/**
 * Atomically updates the authoritative school row and the ClassPilot settings
 * name/timezone mirrors. The school row lock makes the revisioned contract a
 * single winner and safely serializes the narrow legacy alias.
 */
async function persistPasspilotAdminSettings(
  schoolId: string,
  expectedRevision: number | undefined,
  patch: PasspilotAdminSettingsPatch,
  actor: PasspilotAdminSettingsActor,
  contract: "revisioned" | "legacy_alias"
): Promise<UpdatePasspilotAdminSettingsResult | undefined> {
  const result = await withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [currentSchool] = await tx
      .select({
        name: schools.name,
        schoolTimezone: schools.schoolTimezone,
        kioskEnabled: schools.kioskEnabled,
        kioskRequiresApproval: schools.kioskRequiresApproval,
        kioskPinHash: schools.kioskPinHash,
        passpilotSettingsRevision: schools.passpilotSettingsRevision,
      })
      .from(schools)
      .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
      .limit(1)
      .for("update");
    if (!currentSchool) return undefined;
    await takeClasspilotScheduleConfigLock(
      tx as unknown as ScheduleChangeDb,
      schoolId
    );

    const current = passpilotAdminSettingsDto(currentSchool);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      return { status: "conflict" as const, current };
    }

    const nextName = patch.name === undefined ? current.name : patch.name.trim();
    const nextTimezone = patch.schoolTimezone ?? current.schoolTimezone;
    const nextKioskEnabled = patch.kioskEnabled ?? current.kioskEnabled;
    const nextKioskRequiresApproval =
      patch.kioskRequiresApproval ?? current.kioskRequiresApproval;
    const nextKioskPinHash =
      patch.kioskPinHash === undefined ? currentSchool.kioskPinHash : patch.kioskPinHash;

    // Public kiosk routes deliberately fail closed without a PIN. Do not let
    // an administrator create a misleading "enabled" configuration that can
    // never authenticate, or clear the PIN while the kiosk remains enabled.
    if (nextKioskEnabled && !nextKioskPinHash) {
      return { status: "pin_required" as const, current };
    }

    const changedFields: string[] = [];
    if (nextName !== current.name) changedFields.push("name");
    if (nextTimezone !== current.schoolTimezone) changedFields.push("schoolTimezone");
    if (nextKioskEnabled !== current.kioskEnabled) changedFields.push("kioskEnabled");
    if (nextKioskRequiresApproval !== current.kioskRequiresApproval) {
      changedFields.push("kioskRequiresApproval");
    }
    const kioskPinChange = patch.kioskPinHash === undefined
      ? null
      : patch.kioskPinHash === null
        ? "cleared" as const
        : "configured" as const;
    if (kioskPinChange) changedFields.push("kioskPin");

    const revision = current.revision + 1;
    const now = new Date();
    if (nextTimezone !== current.schoolTimezone) {
      await reconcileClasspilotScheduleChangesForEntitlementRemoval({
        schoolId,
        actorId: actor.userId,
        validUntil: now,
        affectedWhen: "ends_after",
        reasonCode: "school_timezone_changed",
        approvedMessage:
          "Cancel approved future schedule changes before changing the school timezone.",
        now,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
    }
    const [savedSchool] = await tx
      .update(schools)
      .set({
        name: nextName,
        schoolTimezone: nextTimezone,
        kioskEnabled: nextKioskEnabled,
        kioskRequiresApproval: nextKioskRequiresApproval,
        kioskPinHash: nextKioskPinHash,
        passpilotSettingsRevision: revision,
        ...(nextTimezone !== current.schoolTimezone
          ? { gopilotSettingsRevision: sql`${schools.gopilotSettingsRevision} + 1` }
          : {}),
        updatedAt: now,
      })
      .where(eq(schools.id, schoolId))
      .returning({
        name: schools.name,
        schoolTimezone: schools.schoolTimezone,
        kioskEnabled: schools.kioskEnabled,
        kioskRequiresApproval: schools.kioskRequiresApproval,
        kioskPinHash: schools.kioskPinHash,
        passpilotSettingsRevision: schools.passpilotSettingsRevision,
      });
    if (!savedSchool) return undefined;

    // Some ClassPilot consumers still read these two values from settings.
    // A missing row is a provisioning/integrity failure: never manufacture one
    // with an empty security-sensitive ws_shared_key. Throwing here rolls back
    // the authoritative school update and revision increment above.
    const [savedMirror] = await tx
      .update(settings)
      .set({
        schoolName: nextName,
        schoolTimezone: nextTimezone,
      })
      .where(eq(settings.schoolId, schoolId))
      .returning({ id: settings.id });
    if (!savedMirror) {
      throw Object.assign(
        new Error("PassPilot school settings are not initialized."),
        { status: 500, code: "PASSPILOT_SETTINGS_MIRROR_MISSING" }
      );
    }

    // The audit row belongs to the same tenant transaction, so a successful
    // response cannot exist without its corresponding sanitized audit event.
    await tx.insert(auditLogs).values({
      schoolId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? null,
      userRole: actor.userRole ?? null,
      action: "passpilot.settings.update",
      entityType: "school",
      entityId: schoolId,
      changes: {
        fields: changedFields,
        kioskPin: kioskPinChange,
      },
      metadata: { revision, contract },
    });

    return {
      status: "saved" as const,
      current: passpilotAdminSettingsDto(savedSchool),
      changedFields,
      kioskPinChange,
    };
  });

  if (result?.status === "saved") {
    invalidateHeartbeatTrackingSettingsCache(schoolId);
    const targets = [
      { kind: "cache-invalidation", schoolId, cache: "classpilot-dashboard-school" },
      { kind: "cache-invalidation", schoolId, cache: "heartbeat-tracking-settings" },
    ] as const;
    for (const target of targets) {
      dispatchCacheInvalidation(target);
      await publishCacheInvalidation(target);
    }
  }
  return result;
}

export async function updatePasspilotAdminSettings(
  schoolId: string,
  expectedRevision: number,
  patch: PasspilotAdminSettingsPatch,
  actor: PasspilotAdminSettingsActor
): Promise<UpdatePasspilotAdminSettingsResult | undefined> {
  return persistPasspilotAdminSettings(
    schoolId,
    expectedRevision,
    patch,
    actor,
    "revisioned"
  );
}

/**
 * Backend-first bridge for the previously deployed web form, which did not
 * send a revision. The transaction still locks and re-reads the school row,
 * then applies only fields explicitly present in the strict legacy payload.
 */
export async function updatePasspilotAdminSettingsCompatibility(
  schoolId: string,
  patch: PasspilotAdminSettingsPatch,
  actor: PasspilotAdminSettingsActor
): Promise<UpdatePasspilotAdminSettingsResult | undefined> {
  return persistPasspilotAdminSettings(
    schoolId,
    undefined,
    patch,
    actor,
    "legacy_alias"
  );
}

export async function softDeleteSchool(
  id: string,
  scheduleChangeActorId?: string
): Promise<School | undefined> {
  // School deletion is an entitlement mutation. Reuse the guarded writer so
  // approved future swaps block deletion and pending reservations are released
  // atomically before the school becomes inaccessible.
  return updateSchool(id, { deletedAt: new Date() }, scheduleChangeActorId);
}

// ============================================================================
// Membership operations (extended)
// ============================================================================

export async function getMembershipsBySchool(
  schoolId: string
): Promise<(SchoolMembership & { user: User })[]> {
  const rows = await db
    .select({
      membership: schoolMemberships,
      user: users,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    )
    .orderBy(users.lastName, users.firstName);

  return rows.map((r) => ({ ...r.membership, user: r.user }));
}

export async function getStaffBySchool(
  schoolId: string
): Promise<(SchoolMembership & { user: User })[]> {
  const rows = await db
    .select({
      membership: schoolMemberships,
      user: users,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin", "teacher", "office_staff"])
      )
    )
    .orderBy(users.lastName, users.firstName);

  return rows.map((r) => ({ ...r.membership, user: r.user }));
}

export async function getAdminEmailsBySchool(
  schoolId: string
): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        eq(schoolMemberships.role, "admin")
      )
    );
  return rows.map((r) => r.email);
}

export async function getCentralEmailRecipientForSchool(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<User | undefined> {
  const schoolSettings = await getSettingsForSchool(schoolId, dbInstance);
  const recipientUserId = schoolSettings?.centralEmailRecipientUserId;
  if (!recipientUserId) return undefined;

  const [row] = await dbInstance
    .select({ user: users })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.userId, recipientUserId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin", "teacher", "office_staff"])
      )
    )
    .limit(1);

  return row?.user;
}

export async function addCentralEmailRecipientForSchool(
  schoolId: string,
  recipients: string[],
  dbInstance: typeof db = db
): Promise<string[]> {
  const centralRecipient = await getCentralEmailRecipientForSchool(schoolId, dbInstance);
  const centralEmail = centralRecipient?.email?.trim();
  if (!centralEmail) return recipients;

  const seen = new Set(recipients.map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (seen.has(centralEmail.toLowerCase())) return recipients;
  return [...recipients, centralEmail];
}

export async function getMembershipByUserAndSchool(
  userId: string,
  schoolId: string
): Promise<SchoolMembership | undefined> {
  const [result] = await db
    .select({ membership: schoolMemberships })
    .from(schoolMemberships)
    .innerJoin(schools, eq(schoolMemberships.schoolId, schools.id))
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        isNull(schools.deletedAt)
      )
    )
    .limit(1);
  return result?.membership;
}

export async function updateMembership(
  id: string,
  data: Partial<InsertSchoolMembership>,
  scheduleChangeActorId?: string
): Promise<SchoolMembership | undefined> {
  const [existing] = await db.select().from(schoolMemberships).where(eq(schoolMemberships.id, id)).limit(1);
  if (existing) {
    await assertStaffMembershipEmailDomain({
      userId: data.userId || existing.userId,
      schoolId: data.schoolId || existing.schoolId,
      role: data.role || existing.role,
    });
  }
  return updateMembershipWithScheduleChangeGuard({
    id,
    data,
    scheduleChangeActorId,
  });
}

export async function deleteMembership(
  id: string,
  scheduleChangeActorId?: string
): Promise<boolean> {
  const membership = await updateMembershipWithScheduleChangeGuard({
    id,
    data: { status: "inactive" },
    scheduleChangeActorId,
  });
  return Boolean(membership);
}

// School-scoped variants — for school-admin (non-super-admin) handlers, so an
// admin can never update/deactivate another school's staff membership by id.
export async function updateMembershipForSchool(
  id: string,
  schoolId: string,
  data: Partial<InsertSchoolMembership>,
  scheduleChangeActorId?: string
): Promise<SchoolMembership | undefined> {
  const [existing] = await db
    .select()
    .from(schoolMemberships)
    .where(and(eq(schoolMemberships.id, id), eq(schoolMemberships.schoolId, schoolId)))
    .limit(1);
  if (existing) {
    await assertStaffMembershipEmailDomain({
      userId: data.userId || existing.userId,
      schoolId,
      role: data.role || existing.role,
    });
  }
  return updateMembershipWithScheduleChangeGuard({
    id,
    schoolId,
    data,
    scheduleChangeActorId,
  });
}

export async function deleteMembershipForSchool(
  id: string,
  schoolId: string,
  scheduleChangeActorId?: string
): Promise<boolean> {
  const membership = await updateMembershipWithScheduleChangeGuard({
    id,
    schoolId,
    data: { status: "inactive" },
    scheduleChangeActorId,
  });
  return Boolean(membership);
}

async function updateMembershipWithScheduleChangeGuard(options: {
  id: string;
  schoolId?: string;
  data: Partial<InsertSchoolMembership>;
  scheduleChangeActorId?: string;
}): Promise<SchoolMembership | undefined> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const candidateConditions = [eq(schoolMemberships.id, options.id)];
    if (options.schoolId) {
      candidateConditions.push(eq(schoolMemberships.schoolId, options.schoolId));
    }
    const [candidate] = await tx
      .select()
      .from(schoolMemberships)
      .where(and(...candidateConditions))
      .limit(1);
    if (!candidate) return undefined;
    const transactionDb = tx as unknown as ScheduleChangeDb;
    await lockClasspilotScheduleChangeSchool(candidate.schoolId, transactionDb);
    await takeClasspilotScheduleConfigLock(transactionDb, candidate.schoolId);

    const primaryGroups = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.schoolId, candidate.schoolId),
          eq(groups.teacherId, candidate.userId),
          eq(groups.groupType, "admin_class"),
          eq(groups.status, "active")
        )
      )
      .orderBy(asc(groups.id));
    if (primaryGroups.length > 0) {
      await lockScheduleChangeGroups(
        candidate.schoolId,
        primaryGroups.map((group) => group.id),
        transactionDb
      );
    }
    const [locked] = await tx
      .select()
      .from(schoolMemberships)
      .where(and(...candidateConditions))
      .limit(1)
      .for("update");
    if (!locked) return undefined;

    const eligibleRoles = new Set(["teacher", "admin", "school_admin"]);
    const nextStatus = options.data.status ?? locked.status;
    const nextRole = options.data.role ?? locked.role;
    const nextUserId = options.data.userId ?? locked.userId;
    const nextSchoolId = options.data.schoolId ?? locked.schoolId;
    const removesPrimaryEligibility =
      locked.status === "active" &&
      eligibleRoles.has(locked.role) &&
      (nextStatus !== "active" ||
        !eligibleRoles.has(nextRole) ||
        nextUserId !== locked.userId ||
        nextSchoolId !== locked.schoolId);
    if (removesPrimaryEligibility) {
      for (const group of primaryGroups) {
        await assertNoApprovedFutureScheduleChange({
          schoolId: locked.schoolId,
          groupId: group.id,
          dbInstance: transactionDb,
        });
      }
      for (const group of primaryGroups) {
        await supersedePendingScheduleChangesForGroup({
          schoolId: locked.schoolId,
          groupId: group.id,
          actorId: options.scheduleChangeActorId,
          reason: "primary_teacher_membership_changed",
          dbInstance: transactionDb,
        });
      }
    }
    const [membership] = await tx
      .update(schoolMemberships)
      .set(options.data)
      .where(
        and(
          eq(schoolMemberships.id, options.id),
          eq(schoolMemberships.schoolId, locked.schoolId)
        )
      )
      .returning();
    return membership;
  });
}

// ============================================================================
// Grade operations
// ============================================================================

export async function getGradesBySchool(schoolId: string): Promise<Grade[]> {
  return db
    .select()
    .from(grades)
    .where(eq(grades.schoolId, schoolId))
    .orderBy(grades.displayOrder, grades.name);
}

export async function getGradeById(id: string): Promise<Grade | undefined> {
  const [grade] = await db
    .select()
    .from(grades)
    .where(eq(grades.id, id))
    .limit(1);
  return grade;
}

export async function createGrade(data: InsertGrade): Promise<Grade> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, data.schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, data.schoolId))
      .limit(1)
      .for("update");
    if (source?.value === "classpilot_groups") {
      throw passpilotClassError(
        "CLASSES_MANAGED_IN_CLASSPILOT",
        "PassPilot classes are managed in ClassPilot after migration.",
        409
      );
    }
    const [grade] = await tx.insert(grades).values(data).returning();
    return grade!;
  });
}

export async function updateGrade(
  id: string,
  data: Partial<InsertGrade>
): Promise<Grade | undefined> {
  const existing = await getGradeById(id);
  if (!existing) return undefined;
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, existing.schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, existing.schoolId))
      .limit(1)
      .for("update");
    if (source?.value === "classpilot_groups") {
      throw passpilotClassError("CLASSES_MANAGED_IN_CLASSPILOT", "PassPilot classes are managed in ClassPilot after migration.", 409);
    }
    const safeData: Partial<InsertGrade> = {};
    if (typeof data.name === "string") safeData.name = data.name;
    if (typeof data.displayOrder === "number") safeData.displayOrder = data.displayOrder;
    if (Object.keys(safeData).length === 0) return existing;
    const [grade] = await tx
      .update(grades)
      .set(safeData)
      .where(and(eq(grades.id, id), eq(grades.schoolId, existing.schoolId)))
      .returning();
    return grade;
  });
}

export async function deleteGrade(id: string): Promise<boolean> {
  const existing = await getGradeById(id);
  if (!existing) return false;
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, existing.schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, existing.schoolId))
      .limit(1)
      .for("update");
    if (source?.value === "classpilot_groups") {
      throw passpilotClassError("CLASSES_MANAGED_IN_CLASSPILOT", "PassPilot classes are managed in ClassPilot after migration.", 409);
    }
    const [lockedGrade] = await tx
      .select({
        id: grades.id,
        classpilotGroupId: grades.classpilotGroupId,
        migrationState: grades.migrationState,
      })
      .from(grades)
      .where(and(eq(grades.id, id), eq(grades.schoolId, existing.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedGrade) return false;

    const [passReference] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(passes)
      .where(and(eq(passes.schoolId, existing.schoolId), eq(passes.gradeId, id)));
    const [studentReference] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(students)
      .where(and(eq(students.schoolId, existing.schoolId), eq(students.gradeId, id)));
    const [membershipReference] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(passpilotGradeStudents)
      .where(
        and(
          eq(passpilotGradeStudents.schoolId, existing.schoolId),
          eq(passpilotGradeStudents.gradeId, id)
        )
      );
    const [teacherReference] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(teacherGrades)
      .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
      .where(and(eq(grades.schoolId, existing.schoolId), eq(teacherGrades.gradeId, id)));
    const [kioskReference] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schools)
      .where(and(eq(schools.id, existing.schoolId), eq(schools.kioskGradeId, id)));
    const hasReferences =
      (passReference?.count ?? 0) > 0 ||
      (studentReference?.count ?? 0) > 0 ||
      (membershipReference?.count ?? 0) > 0 ||
      (teacherReference?.count ?? 0) > 0 ||
      (kioskReference?.count ?? 0) > 0 ||
      lockedGrade.migrationState !== "pending" ||
      !!lockedGrade.classpilotGroupId;
    if (hasReferences) {
      throw passpilotClassError(
        "PASSPILOT_LEGACY_CLASS_REFERENCED",
        "This legacy class is still referenced by PassPilot data. Preserve it for history or mark it history-only during migration.",
        409
      );
    }
    const result = await tx
      .delete(grades)
      .where(and(eq(grades.id, id), eq(grades.schoolId, existing.schoolId)));
    return (result.rowCount ?? 0) > 0;
  });
}

// ============================================================================
// Teacher-Grade assignment operations
// ============================================================================

export async function getTeacherGrades(teacherId: string) {
  return db
    .select({
      teacherGrade: teacherGrades,
      grade: grades,
    })
    .from(teacherGrades)
    .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
    .where(eq(teacherGrades.teacherId, teacherId));
}

export async function assignTeacherGrade(
  teacherId: string,
  gradeId: string
) {
  const grade = await getGradeById(gradeId);
  if (!grade) return undefined;
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, grade.schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, grade.schoolId))
      .limit(1)
      .for("update");
    if (source?.value === "classpilot_groups") {
      throw passpilotClassError("CLASSES_MANAGED_IN_CLASSPILOT", "Teacher assignments are managed in ClassPilot after migration.", 409);
    }
    const [lockedGrade] = await tx
      .select({ migrationState: grades.migrationState })
      .from(grades)
      .where(and(eq(grades.id, gradeId), eq(grades.schoolId, grade.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedGrade) return undefined;
    if (lockedGrade.migrationState === "history_only") {
      throw passpilotClassError(
        "PASSPILOT_HISTORY_CLASS_READ_ONLY",
        "This legacy class is history-only and cannot receive new teacher assignments.",
        409
      );
    }
    const [assignment] = await tx
      .insert(teacherGrades)
      .values({ teacherId, gradeId })
      .onConflictDoNothing()
      .returning();
    return assignment;
  });
}

export async function removeTeacherGrade(
  teacherId: string,
  gradeId: string
): Promise<boolean> {
  const grade = await getGradeById(gradeId);
  if (!grade) return false;
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, grade.schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, grade.schoolId))
      .limit(1)
      .for("update");
    if (source?.value === "classpilot_groups") {
      throw passpilotClassError("CLASSES_MANAGED_IN_CLASSPILOT", "Teacher assignments are managed in ClassPilot after migration.", 409);
    }
    const result = await tx
      .delete(teacherGrades)
      .where(
        and(
          eq(teacherGrades.teacherId, teacherId),
          eq(teacherGrades.gradeId, gradeId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  });
}

// ============================================================================
// Product License operations (extended)
// ============================================================================

export async function updateProductLicense(
  id: string,
  data: Partial<InsertProductLicense>,
  scheduleChangeActorId?: string
): Promise<ProductLicense | undefined> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [candidate] = await tx
      .select({ schoolId: productLicenses.schoolId })
      .from(productLicenses)
      .where(eq(productLicenses.id, id))
      .limit(1);
    if (!candidate) return undefined;
    await lockClasspilotScheduleChangeSchool(
      candidate.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, candidate.schoolId);
    const [lockedLicense] = await tx
      .select()
      .from(productLicenses)
      .where(and(eq(productLicenses.id, id), eq(productLicenses.schoolId, candidate.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedLicense) return undefined;
    if (data.schoolId !== undefined && data.schoolId !== candidate.schoolId) {
      throw scheduleChangeError(
        "LICENSE_SCHOOL_IMMUTABLE",
        "A product license cannot be moved between schools.",
        400
      );
    }
    if (lockedLicense.product === "CLASSPILOT") {
      const now = new Date();
      const nextProduct = data.product ?? lockedLicense.product;
      const nextStatus = data.status ?? lockedLicense.status;
      const nextExpiresAt = data.expiresAt === undefined
        ? lockedLicense.expiresAt
        : data.expiresAt;
      const immediatelyUnavailable =
        nextProduct !== "CLASSPILOT" ||
        nextStatus !== "active" ||
        Boolean(nextExpiresAt && nextExpiresAt.getTime() <= now.getTime());
      if (immediatelyUnavailable || nextExpiresAt) {
        await reconcileClasspilotScheduleChangesForEntitlementRemoval({
          schoolId: candidate.schoolId,
          actorId: scheduleChangeActorId,
          validUntil: immediatelyUnavailable ? now : nextExpiresAt,
          now,
          dbInstance: tx as unknown as ScheduleChangeDb,
        });
      }
    }
    const [license] = await tx
      .update(productLicenses)
      .set(data)
      .where(and(eq(productLicenses.id, id), eq(productLicenses.schoolId, candidate.schoolId)))
      .returning();
    return license;
  });
}

export async function deleteProductLicense(
  id: string,
  scheduleChangeActorId?: string
): Promise<boolean> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [candidate] = await tx
      .select({ schoolId: productLicenses.schoolId })
      .from(productLicenses)
      .where(eq(productLicenses.id, id))
      .limit(1);
    if (!candidate) return false;
    await lockClasspilotScheduleChangeSchool(
      candidate.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, candidate.schoolId);
    const [license] = await tx
      .select()
      .from(productLicenses)
      .where(and(eq(productLicenses.id, id), eq(productLicenses.schoolId, candidate.schoolId)))
      .limit(1)
      .for("update");
    if (!license) return false;
    if (license.product === "CLASSPILOT") {
      await reconcileClasspilotScheduleChangesForEntitlementRemoval({
        schoolId: candidate.schoolId,
        actorId: scheduleChangeActorId,
        validUntil: new Date(),
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
      const [source] = await tx
        .select({ value: settings.passpilotClassSource })
        .from(settings)
        .where(eq(settings.schoolId, candidate.schoolId))
        .limit(1)
        .for("update");
      if (source?.value === "classpilot_groups") {
        throw passpilotClassError(
          "CLASSPILOT_REQUIRED_FOR_PASSPILOT_CLASSES",
          "ClassPilot cannot be removed while PassPilot uses ClassPilot classes. Migrate PassPilot away from canonical classes first.",
          409
        );
      }
    }
    const result = await tx
      .delete(productLicenses)
      .where(and(eq(productLicenses.id, id), eq(productLicenses.schoolId, candidate.schoolId)));
    return (result.rowCount ?? 0) > 0;
  });
}

// ============================================================================
// User operations (extended)
// ============================================================================

export async function getUsersBySchool(
  schoolId: string,
  role?: string
): Promise<(SchoolMembership & { user: User })[]> {
  const conditions = [
    eq(schoolMemberships.schoolId, schoolId),
    eq(schoolMemberships.status, "active"),
  ];

  if (role) {
    conditions.push(eq(schoolMemberships.role, role));
  }

  const rows = await db
    .select({
      membership: schoolMemberships,
      user: users,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(and(...conditions))
    .orderBy(users.lastName, users.firstName);

  return rows.map((r) => ({ ...r.membership, user: r.user }));
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await db.delete(users).where(eq(users.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// Pass operations (PassPilot)
// ============================================================================

export async function getActivePassesBySchool(
  schoolId: string
): Promise<Pass[]> {
  const rows = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(and(eq(passes.schoolId, schoolId), eq(passes.status, "active")))
    .orderBy(desc(passes.issuedAt));
  return rows.map((row) => row.pass);
}

export async function getActivePassesByGrade(
  schoolId: string,
  gradeId: string
): Promise<Pass[]> {
  const rows = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.gradeId, gradeId),
        eq(passes.status, "active")
      )
    )
    .orderBy(desc(passes.issuedAt));
  return rows.map((row) => row.pass);
}

export async function deleteProductLicenseForSchool(
  schoolId: string,
  licenseId: string,
  scheduleChangeActorId?: string
): Promise<boolean> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    await lockClasspilotScheduleChangeSchool(
      schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, schoolId);
    const [license] = await tx
      .select()
      .from(productLicenses)
      .where(
        and(
          eq(productLicenses.id, licenseId),
          eq(productLicenses.schoolId, schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!license) return false;
    if (license.product === "CLASSPILOT") {
      await reconcileClasspilotScheduleChangesForEntitlementRemoval({
        schoolId,
        actorId: scheduleChangeActorId,
        validUntil: new Date(),
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
      const [source] = await tx
        .select({ value: settings.passpilotClassSource })
        .from(settings)
        .where(eq(settings.schoolId, schoolId))
        .limit(1)
        .for("update");
      if (source?.value === "classpilot_groups") {
        throw passpilotClassError(
          "CLASSPILOT_REQUIRED_FOR_PASSPILOT_CLASSES",
          "ClassPilot cannot be removed while PassPilot uses ClassPilot classes. Migrate PassPilot away from canonical classes first.",
          409
        );
      }
    }
    const result = await tx
      .delete(productLicenses)
      .where(
        and(
          eq(productLicenses.id, licenseId),
          eq(productLicenses.schoolId, schoolId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getActivePassesByClass(
  schoolId: string,
  classId: string
): Promise<Pass[]> {
  const mappedGrades = await db
    .select({ id: grades.id })
    .from(grades)
    .where(and(eq(grades.schoolId, schoolId), eq(grades.classpilotGroupId, classId)));
  const classCondition = mappedGrades.length > 0
    ? or(
        eq(passes.classpilotGroupId, classId),
        inArray(passes.gradeId, mappedGrades.map((grade) => grade.id))
      )!
    : eq(passes.classpilotGroupId, classId);
  const rows = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(passes.schoolId, schoolId),
        classCondition,
        eq(passes.status, "active")
      )
    )
    .orderBy(desc(passes.issuedAt));
  return rows.map((row) => row.pass);
}

export async function getActivePassForStudent(
  studentId: string,
  schoolId: string
): Promise<Pass | undefined> {
  const [row] = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(passes.studentId, studentId),
        eq(passes.schoolId, schoolId),
        eq(passes.status, "active")
      )
    )
    .limit(1);
  return row?.pass;
}

export async function getPassById(
  id: string,
  schoolId: string
): Promise<Pass | undefined> {
  const [pass] = await db
    .select()
    .from(passes)
    .where(and(eq(passes.id, id), eq(passes.schoolId, schoolId)))
    .limit(1);
  return pass;
}

export async function getPassHistoryPage(
  schoolId: string,
  filters: {
    gradeId?: string;
    classId?: string;
    studentId?: string;
    teacherId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    cursor?: { issuedAtMs: string; id: string };
    passType?: string;
    access?: {
      issuerTeacherId: string;
      classIds: string[];
      gradeIds: string[];
      studentIds: string[];
    };
  } = {}
): Promise<{
  passes: Pass[];
  nextCursor: { issuedAtMs: string; id: string } | null;
  hasMore: boolean;
}> {
  const conditions = [eq(passes.schoolId, schoolId)];

  if (filters.gradeId) {
    conditions.push(eq(passes.gradeId, filters.gradeId));
  }
  if (filters.classId) {
    const mappedGrades = await db
      .select({ id: grades.id })
      .from(grades)
      .where(
        and(
          eq(grades.schoolId, schoolId),
          eq(grades.classpilotGroupId, filters.classId)
        )
      );
    conditions.push(
      mappedGrades.length > 0
        ? or(
            eq(passes.classpilotGroupId, filters.classId),
            inArray(passes.gradeId, mappedGrades.map((grade) => grade.id))
          )!
        : eq(passes.classpilotGroupId, filters.classId)
    );
  }
  if (filters.studentId) {
    conditions.push(eq(passes.studentId, filters.studentId));
  }
  if (filters.teacherId) {
    conditions.push(eq(passes.teacherId, filters.teacherId));
  }
  if (filters.startDate) {
    conditions.push(sql`${passes.issuedAt} >= ${filters.startDate}`);
  }
  if (filters.endDate) {
    conditions.push(sql`${passes.issuedAt} <= ${filters.endDate}`);
  }
  if (filters.passType) {
    switch (filters.passType) {
      case "nurse":
        conditions.push(eq(passes.destination, "nurse"));
        break;
      case "discipline":
        conditions.push(inArray(passes.destination, ["office", "counselor"]));
        break;
      case "general":
        conditions.push(sql`${passes.destination} NOT IN ('nurse', 'office', 'counselor')`);
        break;
    }
  }
  if (filters.access) {
    const accessConditions: SQL[] = [eq(passes.teacherId, filters.access.issuerTeacherId)];
    if (filters.access.classIds.length > 0) {
      accessConditions.push(inArray(passes.classpilotGroupId, filters.access.classIds));
    }
    if (filters.access.gradeIds.length > 0) {
      accessConditions.push(inArray(passes.gradeId, filters.access.gradeIds));
    }
    if (filters.access.studentIds.length > 0) {
      accessConditions.push(
        and(
          isNull(passes.classpilotGroupId),
          isNull(passes.gradeId),
          inArray(passes.studentId, filters.access.studentIds)
        )!
      );
    }
    conditions.push(or(...accessConditions)!);
  }
  const issuedAtMsExpression = sql`(
    extract(epoch from date_trunc('milliseconds', ${passes.issuedAt})) * 1000
  )::bigint`;
  if (filters.cursor) {
    conditions.push(
      sql`(
        ${issuedAtMsExpression} < ${filters.cursor.issuedAtMs}::bigint
        OR (
          ${issuedAtMsExpression} = ${filters.cursor.issuedAtMs}::bigint
          AND ${passes.id} < ${filters.cursor.id}
        )
      )`
    );
  }

  const limit = Math.min(500, Math.max(1, Math.trunc(filters.limit ?? 500)));
  const rows = await db
    .select({
      ...getTableColumns(passes),
      cursorIssuedAtMs: sql<string>`${issuedAtMsExpression}::text`,
    })
    .from(passes)
    .where(and(...conditions))
    .orderBy(desc(issuedAtMsExpression), desc(passes.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const page = pageRows.map(({ cursorIssuedAtMs: _cursorIssuedAtMs, ...pass }) => pass);
  return {
    passes: page,
    nextCursor: hasMore && last
      ? { issuedAtMs: last.cursorIssuedAtMs, id: last.id }
      : null,
    hasMore,
  };
}

export async function getPassHistory(
  schoolId: string,
  filters: {
    gradeId?: string;
    classId?: string;
    studentId?: string;
    teacherId?: string;
    startDate?: Date;
    endDate?: Date;
  } = {}
): Promise<Pass[]> {
  const results: Pass[] = [];
  let cursor: { issuedAtMs: string; id: string } | undefined;
  do {
    const page = await getPassHistoryPage(schoolId, { ...filters, limit: 500, cursor });
    results.push(...page.passes);
    cursor = page.nextCursor ?? undefined;
    if (!page.hasMore) break;
  } while (cursor);
  return results;
}

export async function getPasspilotClassHistoryReferences(
  schoolId: string,
  teacherId?: string
): Promise<{
  canonicalClassIds: string[];
  legacyGradeIds: string[];
  passCountByLegacyGrade: Map<string, number>;
}> {
  const schoolGrades = await db
    .select({ id: grades.id, classpilotGroupId: grades.classpilotGroupId })
    .from(grades)
    .where(eq(grades.schoolId, schoolId));
  const gradeMap = new Map(schoolGrades.map((grade) => [grade.id, grade.classpilotGroupId]));
  const passRows = await db
    .select({
      classpilotGroupId: passes.classpilotGroupId,
      gradeId: passes.gradeId,
    })
    .from(passes)
    .where(
      teacherId
        ? and(eq(passes.schoolId, schoolId), eq(passes.teacherId, teacherId))
        : eq(passes.schoolId, schoolId)
    );
  const canonicalClassIds = new Set<string>();
  const legacyGradeIds = new Set<string>();
  const passCountByLegacyGrade = new Map<string, number>();
  if (!teacherId) {
    for (const grade of schoolGrades) {
      if (grade.classpilotGroupId) canonicalClassIds.add(grade.classpilotGroupId);
    }
  }
  for (const pass of passRows) {
    if (pass.classpilotGroupId) canonicalClassIds.add(pass.classpilotGroupId);
    if (!pass.gradeId) continue;
    passCountByLegacyGrade.set(
      pass.gradeId,
      (passCountByLegacyGrade.get(pass.gradeId) ?? 0) + 1
    );
    const mappedClassId = gradeMap.get(pass.gradeId);
    if (mappedClassId) canonicalClassIds.add(mappedClassId);
    else legacyGradeIds.add(pass.gradeId);
  }
  return {
    canonicalClassIds: Array.from(canonicalClassIds),
    legacyGradeIds: Array.from(legacyGradeIds),
    passCountByLegacyGrade,
  };
}

export async function createPass(data: InsertPass): Promise<Pass> {
  const [pass] = await db.insert(passes).values(data).returning();
  return pass!;
}

export type LegacyPasspilotClassAuthorization = {
  actorUserId?: string | null;
  manager?: boolean;
  kiosk?: boolean;
  expectedKioskClassId?: string | null;
};

async function assertLegacyPasspilotClassAuthorization(
  tx: PasspilotClassTransaction,
  schoolId: string,
  gradeId: string,
  authorization: Pick<LegacyPasspilotClassAuthorization, "actorUserId" | "manager">
): Promise<void> {
  if (authorization.manager) return;
  if (!authorization.actorUserId) {
    throw passpilotClassError(
      "PASSPILOT_CLASS_ACCESS_DENIED",
      "Class access denied.",
      403
    );
  }
  const [assignment] = await tx
    .select({ id: teacherGrades.id })
    .from(teacherGrades)
    .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
    .where(
      and(
        eq(teacherGrades.teacherId, authorization.actorUserId),
        eq(teacherGrades.gradeId, gradeId),
        eq(grades.schoolId, schoolId)
      )
    )
    .limit(1);
  if (!assignment) {
    throw passpilotClassError(
      "PASSPILOT_CLASS_ACCESS_DENIED",
      "Class access denied.",
      403
    );
  }
}

export async function createLegacyPass(
  data: InsertPass,
  authorization: LegacyPasspilotClassAuthorization
): Promise<Pass> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, data.schoolId);
    const [settingsRow] = await tx
      .select({ source: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, data.schoolId))
      .limit(1)
      .for("update");
    if (settingsRow?.source !== "legacy_grades") {
      throw passpilotClassError(
        "PASSPILOT_CLASS_SOURCE_CHANGED",
        "PassPilot class configuration changed. Reload classes before issuing a pass.",
        409
      );
    }
    const [student] = await tx
      .select({ id: students.id, gradeId: students.gradeId })
      .from(students)
      .where(
        and(
          eq(students.id, data.studentId),
          eq(students.schoolId, data.schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1);
    if (!student) {
      throw passpilotClassError(
        "PASSPILOT_STUDENT_NOT_IN_CLASS",
        "Student is not enrolled in the selected class.",
        409
      );
    }

    const memberships = await tx
      .select({
        gradeId: passpilotGradeStudents.gradeId,
        name: grades.name,
        migrationState: grades.migrationState,
      })
      .from(passpilotGradeStudents)
      .innerJoin(
        grades,
        and(
          eq(grades.id, passpilotGradeStudents.gradeId),
          eq(grades.schoolId, passpilotGradeStudents.schoolId)
        )
      )
      .where(
        and(
          eq(passpilotGradeStudents.schoolId, data.schoolId),
          eq(passpilotGradeStudents.studentId, data.studentId)
        )
      )
      .orderBy(asc(passpilotGradeStudents.assignedAt), asc(passpilotGradeStudents.gradeId));

    let resolvedGradeId = data.gradeId ?? null;
    let requestedGrade: (typeof memberships)[number] | undefined;
    if (resolvedGradeId) {
      const [grade] = await tx
        .select({
          gradeId: grades.id,
          name: grades.name,
          migrationState: grades.migrationState,
        })
        .from(grades)
        .where(and(eq(grades.id, resolvedGradeId), eq(grades.schoolId, data.schoolId)))
        .limit(1);
      if (!grade) {
        throw passpilotClassError("PASSPILOT_LEGACY_CLASS_NOT_FOUND", "Class not found.", 404);
      }
      requestedGrade = grade;
    }
    let selectedGrade = resolvedGradeId
      ? memberships.find((membership) => membership.gradeId === resolvedGradeId)
      : undefined;
    if (student.gradeId && !memberships.some((membership) => membership.gradeId === student.gradeId)) {
      const [fallbackGrade] = await tx
        .select({
          gradeId: grades.id,
          name: grades.name,
          migrationState: grades.migrationState,
        })
        .from(grades)
        .where(and(eq(grades.id, student.gradeId), eq(grades.schoolId, data.schoolId)))
        .limit(1);
      if (fallbackGrade) {
        memberships.push(fallbackGrade);
        if (resolvedGradeId === fallbackGrade.gradeId) selectedGrade = fallbackGrade;
      }
    }
    const writableMemberships = memberships.filter(
      (membership) => membership.migrationState !== "history_only"
    );
    if (!resolvedGradeId) {
      if (writableMemberships.length > 1) {
        throw passpilotClassError(
          "PASSPILOT_CLASS_REQUIRED",
          "Select the class for this student before issuing a pass.",
          400
        );
      }
      if (writableMemberships.length === 1) {
        selectedGrade = writableMemberships[0];
        resolvedGradeId = selectedGrade!.gradeId;
      }
    }
    if (resolvedGradeId && !selectedGrade) {
      throw passpilotClassError(
        "PASSPILOT_STUDENT_NOT_IN_CLASS",
        "Student is not enrolled in the selected class.",
        409
      );
    }
    if (selectedGrade && requestedGrade) selectedGrade = requestedGrade;
    if (selectedGrade?.migrationState === "history_only") {
      throw passpilotClassError(
        "PASSPILOT_HISTORY_CLASS_READ_ONLY",
        "This legacy class is history-only and cannot issue new passes.",
        409
      );
    }
    if (authorization?.kiosk) {
      const [school] = await tx
        .select({ kioskGradeId: schools.kioskGradeId })
        .from(schools)
        .where(eq(schools.id, data.schoolId))
        .limit(1)
        .for("update");
      if (
        !school ||
        school.kioskGradeId !== (authorization.expectedKioskClassId ?? null) ||
        (school.kioskGradeId !== null && school.kioskGradeId !== resolvedGradeId)
      ) {
        throw passpilotClassError(
          "PASSPILOT_KIOSK_CLASS_CHANGED",
          "The configured kiosk class changed. Reload the kiosk before checking out.",
          409
        );
      }
    } else if (!authorization.manager) {
      if (!resolvedGradeId) {
        throw passpilotClassError(
          "PASSPILOT_CLASS_REQUIRED",
          "Select the class for this student before issuing a pass.",
          400
        );
      }
      await assertLegacyPasspilotClassAuthorization(
        tx,
        data.schoolId,
        resolvedGradeId,
        authorization
      );
    }
    const [pass] = await tx
      .insert(passes)
      .values({
        ...data,
        gradeId: resolvedGradeId,
        classpilotGroupId: null,
        classNameSnapshot: selectedGrade?.name ?? data.classNameSnapshot ?? null,
      })
      .returning();
    return pass!;
  });
}

export async function returnPass(
  id: string,
  schoolId: string
): Promise<Pass | undefined> {
  const [pass] = await db
    .update(passes)
    .set({ status: "returned", returnedAt: new Date() })
    .where(
      and(
        eq(passes.id, id),
        eq(passes.schoolId, schoolId),
        eq(passes.status, "active")
      )
    )
    .returning();
  return pass;
}

export async function getKioskStudentState(
  schoolId: string,
  studentId: string,
  canonicalCapability: boolean
): Promise<{
  source: PasspilotClassSource;
  configuredClassId: string | null;
  enrolled: boolean;
  activePass: Pass | null;
  hasActivePassInAnotherClass: boolean;
}> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    const classSource = source?.value ?? "legacy_grades";
    const [school] = await tx
      .select({
        kioskGradeId: schools.kioskGradeId,
        classId: schools.kioskClasspilotGroupId,
      })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1)
      .for("update");
    if (!school) {
      throw passpilotClassError("SCHOOL_NOT_FOUND", "School not found.", 404);
    }
    const [activePassRow] = await tx
      .select({ pass: passes })
      .from(passes)
      .innerJoin(
        students,
        and(
          eq(students.id, passes.studentId),
          eq(students.schoolId, passes.schoolId),
          eq(students.status, "active")
        )
      )
      .where(
        and(
          eq(passes.schoolId, schoolId),
          eq(passes.studentId, studentId),
          eq(passes.status, "active")
        )
      )
      .limit(1);
    const activePass = activePassRow?.pass;
    if (classSource === "legacy_grades") {
      const configuredClassId = school.kioskGradeId;
      if (!configuredClassId) {
        return {
          source: classSource,
          configuredClassId: null,
          enrolled: true,
          activePass: activePass ?? null,
          hasActivePassInAnotherClass: false,
        };
      }
      const [membership] = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.id, studentId),
            eq(students.schoolId, schoolId),
            eq(students.status, "active"),
            legacyGradeMembershipCondition(schoolId, configuredClassId)
          )
        )
        .limit(1);
      if (!membership) {
        return {
          source: classSource,
          configuredClassId,
          enrolled: false,
          activePass: null,
          hasActivePassInAnotherClass: false,
        };
      }
      const belongsToConfiguredClass = !activePass || activePass.gradeId === configuredClassId;
      return {
        source: classSource,
        configuredClassId,
        enrolled: true,
        activePass: belongsToConfiguredClass ? (activePass ?? null) : null,
        hasActivePassInAnotherClass: !!activePass && !belongsToConfiguredClass,
      };
    }
    if (!canonicalCapability) {
      throw passpilotClassError(
        "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
        "This kiosk must be updated before looking up ClassPilot students.",
        426
      );
    }
    if (!school?.classId) {
      throw passpilotClassError(
        "PASSPILOT_KIOSK_CLASS_REQUIRED",
        "A kiosk class must be selected before looking up students.",
        409
      );
    }
    const [configuredClass] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.id, school.classId),
          eq(groups.schoolId, schoolId),
          eq(groups.groupType, "admin_class"),
          eq(groups.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!configuredClass) {
      throw passpilotClassError(
        "PASSPILOT_KIOSK_CLASS_INACTIVE",
        "The configured kiosk class is no longer active.",
        409
      );
    }
    const [membership] = await tx
      .select({ id: groupStudents.id })
      .from(groupStudents)
      .innerJoin(students, eq(students.id, groupStudents.studentId))
      .where(
        and(
          eq(groupStudents.groupId, configuredClass.id),
          eq(groupStudents.studentId, studentId),
          eq(students.schoolId, schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1);
    if (!membership) {
      return {
        source: classSource,
        configuredClassId: configuredClass.id,
        enrolled: false,
        activePass: null,
        hasActivePassInAnotherClass: false,
      };
    }
    if (!activePass) {
      return {
        source: classSource,
        configuredClassId: configuredClass.id,
        enrolled: true,
        activePass: null,
        hasActivePassInAnotherClass: false,
      };
    }
    let belongsToConfiguredClass = activePass.classpilotGroupId === configuredClass.id;
    if (!belongsToConfiguredClass && activePass.gradeId) {
      const [mappedGrade] = await tx
        .select({ id: grades.id })
        .from(grades)
        .where(
          and(
            eq(grades.id, activePass.gradeId),
            eq(grades.schoolId, schoolId),
            eq(grades.classpilotGroupId, configuredClass.id)
          )
        )
        .limit(1);
      belongsToConfiguredClass = !!mappedGrade;
    }
    return {
      source: classSource,
      configuredClassId: configuredClass.id,
      enrolled: true,
      activePass: belongsToConfiguredClass ? activePass : null,
      hasActivePassInAnotherClass: !belongsToConfiguredClass,
    };
  });
}

export async function returnKioskPassForStudent(
  schoolId: string,
  studentId: string,
  canonicalCapability: boolean
): Promise<Pass | undefined> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [source] = await tx
      .select({ value: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    const [school] = await tx
      .select({
        kioskGradeId: schools.kioskGradeId,
        kioskClasspilotGroupId: schools.kioskClasspilotGroupId,
      })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1)
      .for("update");
    if (!school) return undefined;

    const [activePassRow] = await tx
      .select({ pass: passes })
      .from(passes)
      .innerJoin(
        students,
        and(
          eq(students.id, passes.studentId),
          eq(students.schoolId, passes.schoolId),
          eq(students.status, "active")
        )
      )
      .where(
        and(
          eq(passes.schoolId, schoolId),
          eq(passes.studentId, studentId),
          eq(passes.status, "active")
        )
      )
      .limit(1)
      .for("update", { of: passes });
    const activePass = activePassRow?.pass;
    if (!activePass) return undefined;

    if (source?.value === "legacy_grades" && school.kioskGradeId) {
      if (activePass.gradeId !== school.kioskGradeId) {
        throw passpilotClassError(
          "PASSPILOT_KIOSK_PASS_CLASS_MISMATCH",
          "This pass belongs to a different class and cannot be returned from this kiosk.",
          403
        );
      }
    } else if (source?.value === "classpilot_groups") {
      if (!canonicalCapability) {
        throw passpilotClassError(
          "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
          "This kiosk must be updated before returning ClassPilot class passes.",
          426
        );
      }
      const configuredClassId = school.kioskClasspilotGroupId;
      if (!configuredClassId) {
        throw passpilotClassError(
          "PASSPILOT_KIOSK_CLASS_REQUIRED",
          "A kiosk class must be selected before returning passes.",
          409
        );
      }
      let belongsToConfiguredClass = activePass.classpilotGroupId === configuredClassId;
      if (!belongsToConfiguredClass && activePass.gradeId) {
        const [mappedGrade] = await tx
          .select({ id: grades.id })
          .from(grades)
          .where(
            and(
              eq(grades.id, activePass.gradeId),
              eq(grades.schoolId, schoolId),
              eq(grades.classpilotGroupId, configuredClassId)
            )
          )
          .limit(1);
        belongsToConfiguredClass = !!mappedGrade;
      }
      if (!belongsToConfiguredClass) {
        throw passpilotClassError(
          "PASSPILOT_KIOSK_PASS_CLASS_MISMATCH",
          "This pass belongs to a different class and cannot be returned from this kiosk.",
          403
        );
      }
    }

    const [pass] = await tx
      .update(passes)
      .set({ status: "returned", returnedAt: new Date() })
      .where(
        and(
          eq(passes.id, activePass.id),
          eq(passes.schoolId, schoolId),
          eq(passes.status, "active")
        )
      )
      .returning();
    return pass;
  });
}

export async function cancelPass(
  id: string,
  schoolId: string
): Promise<Pass | undefined> {
  const [pass] = await db
    .update(passes)
    .set({ status: "canceled" })
    .where(
      and(
        eq(passes.id, id),
        eq(passes.schoolId, schoolId),
        eq(passes.status, "active")
      )
    )
    .returning();
  return pass;
}

export async function expireOverduePasses(
  schoolId: string
): Promise<number> {
  const result = await db
    .update(passes)
    .set({ status: "expired" })
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.status, "active"),
        sql`${passes.expiresAt} <= now()`
      )
    );
  return result.rowCount ?? 0;
}

export async function getStudentByIdNumber(
  schoolId: string,
  studentIdNumber: string
): Promise<Student | undefined> {
  const [student] = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.studentIdNumber, studentIdNumber),
        eq(students.status, "active")
      )
    )
    .limit(1);
  return student;
}

export async function getStudentsByGrade(
  schoolId: string,
  gradeId: string
): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        legacyGradeMembershipCondition(schoolId, gradeId),
        eq(students.status, "active")
      )
    )
    .orderBy(students.lastName, students.firstName);
}

export async function getLegacyPasspilotGradeIdsForStudent(
  schoolId: string,
  studentId: string
): Promise<string[]> {
  const rows = await db
    .select({ gradeId: passpilotGradeStudents.gradeId })
    .from(passpilotGradeStudents)
    .innerJoin(
      grades,
      and(
        eq(grades.id, passpilotGradeStudents.gradeId),
        eq(grades.schoolId, passpilotGradeStudents.schoolId)
      )
    )
    .where(
      and(
        eq(passpilotGradeStudents.schoolId, schoolId),
        eq(passpilotGradeStudents.studentId, studentId)
      )
    )
    .orderBy(asc(passpilotGradeStudents.assignedAt), asc(passpilotGradeStudents.gradeId));
  const gradeIds = new Set(rows.map((row) => row.gradeId));
  // Rolling-deploy compatibility: an old serving task can still change the
  // single-class projection after the startup backfill. Union that valid
  // projection with junction rows until every old task has drained.
  const [student] = await db
    .select({ gradeId: students.gradeId })
    .from(students)
    .innerJoin(
      grades,
      and(eq(grades.id, students.gradeId), eq(grades.schoolId, students.schoolId))
    )
    .where(and(eq(students.schoolId, schoolId), eq(students.id, studentId)))
    .limit(1);
  if (student?.gradeId) gradeIds.add(student.gradeId);
  return Array.from(gradeIds);
}

export async function isStudentInLegacyPasspilotGrade(
  schoolId: string,
  studentId: string,
  gradeId: string
): Promise<boolean> {
  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        eq(students.id, studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        legacyGradeMembershipCondition(schoolId, gradeId)
      )
    )
    .limit(1);
  return !!student;
}

async function assertWritableLegacyGrade(
  tx: PasspilotClassTransaction,
  schoolId: string,
  gradeId: string
): Promise<Grade> {
  const [grade] = await tx
    .select()
    .from(grades)
    .where(and(eq(grades.id, gradeId), eq(grades.schoolId, schoolId)))
    .limit(1)
    .for("update");
  if (!grade) {
    throw passpilotClassError("PASSPILOT_LEGACY_CLASS_NOT_FOUND", "Class not found.", 404);
  }
  if (grade.migrationState === "history_only") {
    throw passpilotClassError(
      "PASSPILOT_HISTORY_CLASS_READ_ONLY",
      "This legacy class is history-only and cannot accept roster changes.",
      409
    );
  }
  return grade;
}

/**
 * Preserve the old students.grade_id write contract as an explicit exclusive
 * assignment. New multi-class UI uses the additive normalized class endpoint.
 */
export async function replaceLegacyPasspilotStudentClassInTransaction(
  tx: PasspilotClassTransaction,
  schoolId: string,
  studentId: string,
  gradeId: string | null
): Promise<void> {
  if (gradeId) await assertWritableLegacyGrade(tx, schoolId, gradeId);
  const [student] = await tx
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .limit(1)
    .for("update");
  if (!student) {
    throw passpilotClassError("STUDENT_NOT_FOUND", "Student not found.", 404);
  }
  await tx
    .delete(passpilotGradeStudents)
    .where(
      and(
        eq(passpilotGradeStudents.schoolId, schoolId),
        eq(passpilotGradeStudents.studentId, studentId)
      )
    );
  if (gradeId) {
    await tx
      .insert(passpilotGradeStudents)
      .values({ schoolId, gradeId, studentId })
      .onConflictDoNothing();
  }
  await tx
    .update(students)
    .set({ gradeId, updatedAt: new Date() })
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
}

export async function addStudentsToLegacyPasspilotGrade(
  schoolId: string,
  gradeId: string,
  requestedStudentIds: string[],
  authorization: Pick<LegacyPasspilotClassAuthorization, "actorUserId" | "manager">
): Promise<{ addedCount: number; addedStudentIds: string[]; studentIds: string[] }> {
  const studentIds = Array.from(new Set(requestedStudentIds));
  return runWithPasspilotLegacyClassLock(schoolId, async (tx) => {
    await assertWritableLegacyGrade(tx, schoolId, gradeId);
    await assertLegacyPasspilotClassAuthorization(
      tx,
      schoolId,
      gradeId,
      authorization
    );
    if (studentIds.length === 0) {
      return { addedCount: 0, addedStudentIds: [], studentIds: [] };
    }
    const schoolStudents = await tx
      .select({ id: students.id, gradeId: students.gradeId })
      .from(students)
      .where(
        and(
          eq(students.schoolId, schoolId),
          eq(students.status, "active"),
          inArray(students.id, studentIds)
        )
      )
      .orderBy(asc(students.id))
      .for("update");
    if (schoolStudents.length !== studentIds.length) {
      throw passpilotClassError(
        "PASSPILOT_STUDENT_NOT_FOUND",
        "One or more students were not found in this school.",
        404
      );
    }
    const existingRows = await tx
      .select({ studentId: passpilotGradeStudents.studentId })
      .from(passpilotGradeStudents)
      .where(
        and(
          eq(passpilotGradeStudents.schoolId, schoolId),
          eq(passpilotGradeStudents.gradeId, gradeId),
          inArray(passpilotGradeStudents.studentId, studentIds)
        )
      );
    const logicallyExisting = new Set(existingRows.map((row) => row.studentId));
    for (const student of schoolStudents) {
      if (student.gradeId === gradeId) logicallyExisting.add(student.id);
    }
    await tx
      .insert(passpilotGradeStudents)
      .values(studentIds.map((studentId) => ({ schoolId, gradeId, studentId })))
      .onConflictDoNothing();
    await tx
      .update(students)
      .set({ gradeId, updatedAt: new Date() })
      .where(
        and(
          eq(students.schoolId, schoolId),
          inArray(students.id, studentIds),
          isNull(students.gradeId)
        )
      );
    const addedStudentIds = studentIds.filter((studentId) => !logicallyExisting.has(studentId));
    return { addedCount: addedStudentIds.length, addedStudentIds, studentIds };
  });
}

export async function removeStudentFromLegacyPasspilotGrade(
  schoolId: string,
  gradeId: string,
  studentId: string,
  authorization: Pick<LegacyPasspilotClassAuthorization, "actorUserId" | "manager">
): Promise<{ removed: boolean }> {
  return runWithPasspilotLegacyClassLock(schoolId, async (tx) => {
    await assertWritableLegacyGrade(tx, schoolId, gradeId);
    await assertLegacyPasspilotClassAuthorization(
      tx,
      schoolId,
      gradeId,
      authorization
    );
    const [student] = await tx
      .select({ id: students.id, gradeId: students.gradeId })
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
      .limit(1)
      .for("update");
    if (!student) {
      throw passpilotClassError("PASSPILOT_STUDENT_NOT_FOUND", "Student not found.", 404);
    }
    const [existing] = await tx
      .select({ id: passpilotGradeStudents.id })
      .from(passpilotGradeStudents)
      .where(
        and(
          eq(passpilotGradeStudents.schoolId, schoolId),
          eq(passpilotGradeStudents.gradeId, gradeId),
          eq(passpilotGradeStudents.studentId, studentId)
        )
      )
      .limit(1);
    const removed = !!existing || student.gradeId === gradeId;
    await tx
      .delete(passpilotGradeStudents)
      .where(
        and(
          eq(passpilotGradeStudents.schoolId, schoolId),
          eq(passpilotGradeStudents.gradeId, gradeId),
          eq(passpilotGradeStudents.studentId, studentId)
        )
      );
    if (student.gradeId === gradeId) {
      const [remaining] = await tx
        .select({ gradeId: passpilotGradeStudents.gradeId })
        .from(passpilotGradeStudents)
        .where(
          and(
            eq(passpilotGradeStudents.schoolId, schoolId),
            eq(passpilotGradeStudents.studentId, studentId)
          )
        )
        .orderBy(asc(passpilotGradeStudents.assignedAt), asc(passpilotGradeStudents.gradeId))
        .limit(1);
      await tx
        .update(students)
        .set({ gradeId: remaining?.gradeId ?? null, updatedAt: new Date() })
        .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
    }
    return { removed };
  });
}

// ============================================================================
// GoPilot - Homeroom operations
// ============================================================================

async function assertActiveSchoolStaffMembership(
  userId: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<void> {
  const staffRoles = ["admin", "school_admin", "office_staff", "teacher"];
  const [membership] = await dbInstance
    .select({ id: schoolMemberships.id })
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        or(
          inArray(schoolMemberships.gopilotRole, staffRoles),
          and(
            or(isNull(schoolMemberships.gopilotRole), eq(schoolMemberships.gopilotRole, "")),
            inArray(schoolMemberships.role, staffRoles)
          )
        )
      )
    )
    .limit(1);
  if (!membership) {
    const err = new Error("Teacher must be active staff at this school") as Error & { code?: string };
    err.code = "GOPILOT_INVALID_HOMEROOM_STAFF";
    throw err;
  }
}

export async function getHomeroomsBySchool(
  schoolId: string
): Promise<Homeroom[]> {
  return db
    .select()
    .from(homerooms)
    .where(eq(homerooms.schoolId, schoolId))
    .orderBy(homerooms.grade, homerooms.name);
}

export async function getHomeroomById(
  id: string
): Promise<Homeroom | undefined> {
  const [hr] = await db
    .select()
    .from(homerooms)
    .where(eq(homerooms.id, id))
    .limit(1);
  return hr;
}

export async function createHomeroom(
  data: InsertHomeroom
): Promise<Homeroom> {
  if (data.teacherId) {
    await assertActiveSchoolStaffMembership(data.teacherId, data.schoolId);
  }
  const [hr] = await db.insert(homerooms).values(data).returning();
  return hr!;
}

export async function createHomeroomWithPrimaryTeacher(
  data: InsertHomeroom
): Promise<Homeroom> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:homerooms:${data.schoolId}`}, 0::bigint))`
    );
    if (data.teacherId) {
      await assertActiveSchoolStaffMembership(data.teacherId, data.schoolId, tx as unknown as typeof db);
    }
    const [homeroom] = await tx.insert(homerooms).values(data).returning();
    if (data.teacherId) {
      await tx.insert(homeroomTeachers).values({
        schoolId: data.schoolId,
        homeroomId: homeroom!.id,
        teacherId: data.teacherId,
        role: "primary",
      });
    }
    return homeroom!;
  });
}

export async function updateHomeroom(
  id: string,
  data: Partial<InsertHomeroom>
): Promise<Homeroom | undefined> {
  if (data.teacherId) {
    const existing = await getHomeroomById(id);
    if (!existing) return undefined;
    await assertActiveSchoolStaffMembership(data.teacherId, existing.schoolId);
  }
  const [hr] = await db
    .update(homerooms)
    .set(data)
    .where(eq(homerooms.id, id))
    .returning();
  return hr;
}

export async function updateHomeroomWithPrimaryTeacher(
  id: string,
  schoolId: string,
  data: Partial<InsertHomeroom>
): Promise<Homeroom | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:homeroom:${schoolId}:${id}`}, 0::bigint))`
    );
    const [existing] = await tx
      .select()
      .from(homerooms)
      .where(and(eq(homerooms.id, id), eq(homerooms.schoolId, schoolId)))
      .limit(1);
    if (!existing) return undefined;
    if (data.schoolId !== undefined && data.schoolId !== schoolId) {
      throw new Error("Homeroom school cannot be changed");
    }
    if (data.teacherId) {
      await assertActiveSchoolStaffMembership(data.teacherId, schoolId, tx as unknown as typeof db);
    }
    const [updated] = await tx
      .update(homerooms)
      .set({ ...data, schoolId })
      .where(and(eq(homerooms.id, id), eq(homerooms.schoolId, schoolId)))
      .returning();
    if (Object.prototype.hasOwnProperty.call(data, "teacherId")) {
      await tx
        .delete(homeroomTeachers)
        .where(
          and(
            eq(homeroomTeachers.schoolId, schoolId),
            eq(homeroomTeachers.homeroomId, id),
            eq(homeroomTeachers.role, "primary")
          )
        );
      if (data.teacherId) {
        await tx.insert(homeroomTeachers).values({
          schoolId,
          homeroomId: id,
          teacherId: data.teacherId,
          role: "primary",
        });
      }
    }
    return updated;
  });
}

export async function deleteHomeroom(id: string, schoolId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [homeroom] = await tx
      .select({ id: homerooms.id })
      .from(homerooms)
      .where(and(eq(homerooms.id, id), eq(homerooms.schoolId, schoolId)))
      .limit(1)
      .for("update");
    if (!homeroom) return false;

    // The tenant FK intentionally prevents orphaned co-teacher assignments.
    // Remove those assignments and detach students in the same transaction as
    // the confirmed setup deletion so the new integrity guard remains usable.
    await tx
      .delete(homeroomTeachers)
      .where(
        and(
          eq(homeroomTeachers.schoolId, schoolId),
          eq(homeroomTeachers.homeroomId, id)
        )
      );
    await tx
      .update(students)
      .set({ homeroomId: null })
      .where(
        and(
          eq(students.schoolId, schoolId),
          eq(students.homeroomId, id)
        )
      );
    const result = await tx
      .delete(homerooms)
      .where(and(eq(homerooms.id, id), eq(homerooms.schoolId, schoolId)));
    return (result.rowCount ?? 0) > 0;
  });
}

export async function assignStudentsToHomeroom(
  homeroomId: string,
  studentIds: string[]
): Promise<void> {
  await db
    .update(students)
    .set({ homeroomId })
    .where(inArray(students.id, studentIds));
}

export async function getStudentsByHomeroom(
  schoolId: string,
  homeroomId: string
): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.homeroomId, homeroomId),
        eq(students.status, "active")
      )
    )
    .orderBy(students.lastName, students.firstName);
}

// ============================================================================
// GoPilot - Dismissal Session operations
// ============================================================================

export async function getOrCreateSession(
  schoolId: string,
  date: string,
  dbInstance: typeof db = db
): Promise<DismissalSession> {
  // Try to find existing
  const [existing] = await dbInstance
    .select()
    .from(dismissalSessions)
    .where(
      and(
        eq(dismissalSessions.schoolId, schoolId),
        eq(dismissalSessions.date, date)
      )
    )
    .limit(1);

  if (existing) return existing;

  // Create new with conflict handling
  const [session] = await dbInstance
    .insert(dismissalSessions)
    .values({ schoolId, date, status: "pending" })
    .onConflictDoNothing()
    .returning();

  if (session) return session;

  // Race condition: fetch again
  const [raced] = await dbInstance
    .select()
    .from(dismissalSessions)
    .where(
      and(
        eq(dismissalSessions.schoolId, schoolId),
        eq(dismissalSessions.date, date)
      )
    )
    .limit(1);
  return raced!;
}

export async function getSessionBySchoolAndDate(
  schoolId: string,
  date: string,
  dbInstance: typeof db = db
): Promise<DismissalSession | undefined> {
  const [session] = await dbInstance
    .select()
    .from(dismissalSessions)
    .where(
      and(
        eq(dismissalSessions.schoolId, schoolId),
        eq(dismissalSessions.date, date)
      )
    )
    .limit(1);
  return session;
}

export async function getSessionById(
  id: string
): Promise<DismissalSession | undefined> {
  const [s] = await db
    .select()
    .from(dismissalSessions)
    .where(eq(dismissalSessions.id, id))
    .limit(1);
  return s;
}

async function getSessionSchoolIdForTenantWrite(
  sessionId: string,
  expectedSchoolId?: string,
  dbInstance: typeof db = db
): Promise<string> {
  const [session] = await dbInstance
    .select({ schoolId: dismissalSessions.schoolId })
    .from(dismissalSessions)
    .where(eq(dismissalSessions.id, sessionId))
    .limit(1);
  if (!session) {
    const err = new Error("Dismissal session not found") as Error & { code?: string };
    err.code = "GOPILOT_SESSION_NOT_FOUND";
    throw err;
  }
  if (expectedSchoolId && session.schoolId !== expectedSchoolId) {
    const err = new Error("Dismissal session does not belong to the active school") as Error & { code?: string };
    err.code = "GOPILOT_SESSION_SCHOOL_MISMATCH";
    throw err;
  }
  return session.schoolId;
}

export async function updateSessionStatus(
  id: string,
  status: string,
  dbInstance: typeof db = db
): Promise<DismissalSession | undefined> {
  const updates: Record<string, unknown> = { status };
  if (status === "active") {
    updates.startedAt = sql`COALESCE(${dismissalSessions.startedAt}, NOW())`;
  }
  if (status === "completed") {
    updates.endedAt = new Date();
  }

  const [s] = await dbInstance
    .update(dismissalSessions)
    .set(updates)
    .where(eq(dismissalSessions.id, id))
    .returning();
  return s;
}

export type DismissalSessionStatus = "pending" | "active" | "paused" | "completed";

export type DismissalSessionTransitionResult =
  | {
      outcome: "updated" | "unchanged";
      session: DismissalSession;
      previousStatus: DismissalSessionStatus;
    }
  | { outcome: "not_found" }
  | { outcome: "invalid_status"; session: DismissalSession }
  | { outcome: "invalid_transition"; session: DismissalSession }
  | { outcome: "outstanding"; session: DismissalSession; outstanding: number };

const DISMISSAL_SESSION_TRANSITIONS: Record<
  DismissalSessionStatus,
  readonly DismissalSessionStatus[]
> = {
  pending: ["active"],
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: [],
};

function isDismissalSessionStatus(value: string): value is DismissalSessionStatus {
  return value === "pending" || value === "active" || value === "paused" || value === "completed";
}

/**
 * Changes a session state under a row lock. Completion and its outstanding
 * queue check share the same transaction, and arrival creation locks this same
 * session row, so a student cannot be queued while completion is committing.
 */
export async function transitionDismissalSessionStatus(options: {
  sessionId: string;
  schoolId: string;
  nextStatus: DismissalSessionStatus;
  actorId?: string | null;
}): Promise<DismissalSessionTransitionResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, options.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");

    if (!current) return { outcome: "not_found" as const };
    if (!isDismissalSessionStatus(current.status)) {
      return { outcome: "invalid_status" as const, session: current };
    }
    if (current.status === options.nextStatus) {
      return {
        outcome: "unchanged" as const,
        session: current,
        previousStatus: current.status,
      };
    }
    if (!DISMISSAL_SESSION_TRANSITIONS[current.status].includes(options.nextStatus)) {
      return { outcome: "invalid_transition" as const, session: current };
    }

    if (options.nextStatus === "completed") {
      // Retained queue history for a removed student must not prevent staff
      // from completing a live session. Lock each still-active student row so
      // this decision serializes with roster deactivation.
      const outstandingRows = await lockActiveDismissalQueueStudents(
        tx as unknown as typeof db,
        {
          schoolId: options.schoolId,
          sessionId: options.sessionId,
          outstandingOnly: true,
        }
      );
      const outstanding = outstandingRows.length;
      if (outstanding > 0) {
        return { outcome: "outstanding" as const, session: current, outstanding };
      }
    }

    const updates: Record<string, unknown> = { status: options.nextStatus };
    if (options.nextStatus === "active") {
      updates.startedAt = sql`COALESCE(${dismissalSessions.startedAt}, NOW())`;
      updates.endedAt = null;
    } else if (options.nextStatus === "completed") {
      updates.endedAt = new Date();
    }
    const [updated] = await tx
      .update(dismissalSessions)
      .set(updates)
      .where(
        and(
          eq(dismissalSessions.id, options.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId),
          eq(dismissalSessions.status, current.status)
        )
      )
      .returning();
    if (!updated) {
      return { outcome: "invalid_transition" as const, session: current };
    }

    await tx.insert(activityLog).values({
      schoolId: options.schoolId,
      sessionId: options.sessionId,
      actorId: options.actorId ?? null,
      action: `session.${options.nextStatus}`,
      entityType: "dismissal_session",
      entityId: options.sessionId,
      details: { fromStatus: current.status, toStatus: options.nextStatus },
    });
    return {
      outcome: "updated" as const,
      session: updated,
      previousStatus: current.status,
    };
  });
}

// ============================================================================
// GoPilot - Dismissal Queue operations
// ============================================================================

export async function getQueueBySession(
  sessionId: string,
  filterStatus?: string,
  options: { activeStudentsOnly?: boolean } = {}
): Promise<DismissalQueueEntry[]> {
  const conditions = [eq(dismissalQueue.sessionId, sessionId)];
  if (filterStatus) {
    conditions.push(eq(dismissalQueue.status, filterStatus));
  }
  if (options.activeStudentsOnly) {
    const rows = await db
      .select({ entry: dismissalQueue })
      .from(dismissalQueue)
      .innerJoin(
        students,
        and(
          eq(students.id, dismissalQueue.studentId),
          eq(students.schoolId, dismissalQueue.schoolId),
          eq(students.status, "active")
        )
      )
      .where(and(...conditions))
      .orderBy(dismissalQueue.position, dismissalQueue.checkInTime);
    return rows.map((row) => row.entry);
  }
  return db
    .select()
    .from(dismissalQueue)
    .where(and(...conditions))
    .orderBy(dismissalQueue.position, dismissalQueue.checkInTime);
}

export async function getQueueEntryById(
  id: string
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .select()
    .from(dismissalQueue)
    .where(eq(dismissalQueue.id, id))
    .limit(1);
  return entry;
}

export async function getMaxQueuePosition(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ maxPos: sql<number>`COALESCE(MAX(${dismissalQueue.position}), 0)` })
    .from(dismissalQueue)
    .where(eq(dismissalQueue.sessionId, sessionId));
  return row?.maxPos ?? 0;
}

export async function isStudentInQueue(
  sessionId: string,
  studentId: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: dismissalQueue.id })
    .from(dismissalQueue)
    .where(
      and(
        eq(dismissalQueue.sessionId, sessionId),
        eq(dismissalQueue.studentId, studentId)
      )
    )
    .limit(1);
  return !!existing;
}

export async function addToQueue(
  data: Omit<InsertDismissalQueueEntry, "schoolId"> & { schoolId?: string }
): Promise<DismissalQueueEntry> {
  const schoolId = await getSessionSchoolIdForTenantWrite(data.sessionId, data.schoolId);
  const student = await getStudentById(data.studentId);
  if (!student || student.schoolId !== schoolId || student.status !== "active") {
    const err = new Error("Student does not belong to the dismissal session school") as Error & { code?: string };
    err.code = "GOPILOT_STUDENT_SCHOOL_MISMATCH";
    throw err;
  }
  const [entry] = await db
    .insert(dismissalQueue)
    .values({ ...data, schoolId })
    .onConflictDoNothing({
      target: [dismissalQueue.sessionId, dismissalQueue.studentId],
    })
    .returning();
  if (entry) return entry;
  const [existing] = await db
    .select()
    .from(dismissalQueue)
    .where(
      and(
        eq(dismissalQueue.schoolId, schoolId),
        eq(dismissalQueue.sessionId, data.sessionId),
        eq(dismissalQueue.studentId, data.studentId)
      )
    )
    .limit(1);
  return existing!;
}

async function withActiveDismissalSessionQueueMutation<T>(
  schoolId: string,
  sessionId: string,
  operation: (transactionDb: typeof db) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    // All intake/session transitions take this same lock first. Once acquired,
    // the session cannot be paused/completed until this queue mutation commits.
    const [session] = await tx
      .select({ status: dismissalSessions.status })
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, sessionId),
          eq(dismissalSessions.schoolId, schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session) {
      throw Object.assign(new Error("Dismissal session not found"), {
        status: 404,
        code: "GOPILOT_SESSION_NOT_FOUND",
        expose: true,
      });
    }
    if (session.status !== "active") {
      throw Object.assign(new Error("Dismissal session must be active for this action"), {
        status: 409,
        code: "GOPILOT_SESSION_NOT_ACTIVE",
        expose: true,
      });
    }
    return operation(transactionDb);
  });
}

type ActiveDismissalQueueStudentLockOptions = {
  schoolId: string;
  sessionId: string;
  queueIds?: string[];
  outstandingOnly?: boolean;
};

/**
 * Locks the active student rows represented by queue entries in deterministic
 * order. Student deactivation takes the same row locks, so every live queue
 * mutation is serialized with roster removal instead of relying on a stale
 * route-level status check.
 */
async function lockActiveDismissalQueueStudents(
  transactionDb: typeof db,
  options: ActiveDismissalQueueStudentLockOptions
): Promise<Array<{ queueId: string; studentId: string }>> {
  const queueIds = options.queueIds
    ? [...new Set(options.queueIds.map(String))].sort()
    : undefined;
  if (queueIds && queueIds.length === 0) return [];

  const conditions = [
    eq(dismissalQueue.schoolId, options.schoolId),
    eq(dismissalQueue.sessionId, options.sessionId),
    eq(students.status, "active"),
  ];
  if (queueIds) conditions.push(inArray(dismissalQueue.id, queueIds));
  if (options.outstandingOnly) conditions.push(ne(dismissalQueue.status, "dismissed"));

  return transactionDb
    .select({ queueId: dismissalQueue.id, studentId: students.id })
    .from(dismissalQueue)
    .innerJoin(
      students,
      and(
        eq(students.id, dismissalQueue.studentId),
        eq(students.schoolId, dismissalQueue.schoolId)
      )
    )
    .where(and(...conditions))
    .orderBy(students.id, dismissalQueue.id)
    .for("update", { of: students });
}

export async function callQueueEntry(
  id: string,
  zone: string | null,
  schoolId: string,
  sessionId: string
): Promise<DismissalQueueEntry | undefined> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: [id],
    });
    if (activeRows.length !== 1) return undefined;
    const [entry] = await transactionDb
      .update(dismissalQueue)
      .set({
        status: "called",
        zone,
        calledAt: new Date(),
        holdReason: null,
        delayedUntil: null,
      })
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          or(
            eq(dismissalQueue.status, "waiting"),
            eq(dismissalQueue.status, "held"),
            and(
              eq(dismissalQueue.status, "delayed"),
              sql`${dismissalQueue.delayedUntil} <= NOW()`
            )
          )
        )
      )
      .returning();
    return entry;
  });
}

export async function callNextBatch(
  sessionId: string,
  count: number,
  zone: string | null,
  schoolId: string
): Promise<DismissalQueueEntry[]> {
  const boundedCount = Math.max(1, Math.min(Number(count) || 1, 100));
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    // SKIP LOCKED partitions concurrent batches across API tasks. The guarded
    // UPDATE is still required in case state changes between selection/write.
    const waiting = await transactionDb
      .select({ id: dismissalQueue.id })
      .from(dismissalQueue)
      .innerJoin(
        students,
        and(
          eq(students.id, dismissalQueue.studentId),
          eq(students.schoolId, dismissalQueue.schoolId),
          eq(students.status, "active")
        )
      )
      .where(
        and(
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.schoolId, schoolId),
          or(
            eq(dismissalQueue.status, "waiting"),
            and(
              eq(dismissalQueue.status, "delayed"),
              sql`${dismissalQueue.delayedUntil} <= NOW()`
            )
          )
        )
      )
      .orderBy(dismissalQueue.position, dismissalQueue.id)
      .limit(boundedCount)
      .for("update", { of: dismissalQueue, skipLocked: true });

    if (waiting.length === 0) return [];
    const lockedActiveRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: waiting.map((row) => row.id),
    });
    const ids = lockedActiveRows.map((row) => row.queueId);
    if (ids.length === 0) return [];
    return transactionDb
      .update(dismissalQueue)
      .set({
        status: "called",
        zone,
        calledAt: new Date(),
        holdReason: null,
        delayedUntil: null,
      })
      .where(
        and(
          inArray(dismissalQueue.id, ids),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          or(
            eq(dismissalQueue.status, "waiting"),
            and(
              eq(dismissalQueue.status, "delayed"),
              sql`${dismissalQueue.delayedUntil} <= NOW()`
            )
          )
        )
      )
      .returning();
  });
}

export async function releaseQueueEntry(
  id: string,
  schoolId: string,
  sessionId: string
): Promise<DismissalQueueEntry | undefined> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: [id],
    });
    if (activeRows.length !== 1) return undefined;
    const [entry] = await transactionDb
      .update(dismissalQueue)
      .set({ status: "released", releasedAt: new Date() })
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.status, "called")
        )
      )
      .returning();
    return entry;
  });
}

export async function dismissQueueEntry(
  id: string,
  schoolId: string,
  sessionId: string,
  options: { custodyAcknowledged: boolean }
): Promise<{
  entry?: DismissalQueueEntry;
  custodyAlerts: CustodyAlert[];
}> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: [id],
    });
    if (activeRows.length !== 1) {
      return { entry: undefined, custodyAlerts: [] };
    }
    const [current] = await transactionDb
      .select()
      .from(dismissalQueue)
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId)
        )
      )
      .limit(1)
      .for("update");
    if (!current || current.status !== "released") {
      return { entry: undefined, custodyAlerts: [] };
    }

    // Custody alert creation takes this same student-scoped lock. The alert
    // inventory and dismissal write are therefore one serializable decision:
    // an alert cannot appear between the acknowledgement check and pickup.
    await transactionDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:custody:${schoolId}:${current.studentId}`}, 0::bigint))`
    );
    const activeAlerts = await transactionDb
      .select({
        id: custodyAlerts.id,
        schoolId: custodyAlerts.schoolId,
        studentId: custodyAlerts.studentId,
        personName: custodyAlerts.personName,
        alertType: custodyAlerts.alertType,
        notes: custodyAlerts.notes,
        courtOrder: custodyAlerts.courtOrder,
        createdBy: custodyAlerts.createdBy,
        active: custodyAlerts.active,
        createdAt: custodyAlerts.createdAt,
        studentFirstName: students.firstName,
        studentLastName: students.lastName,
      })
      .from(custodyAlerts)
      .innerJoin(
        students,
        and(
          eq(students.schoolId, custodyAlerts.schoolId),
          eq(students.id, custodyAlerts.studentId)
        )
      )
      .where(
        and(
          eq(custodyAlerts.schoolId, schoolId),
          eq(custodyAlerts.studentId, current.studentId),
          eq(custodyAlerts.active, true)
        )
      )
      .orderBy(desc(custodyAlerts.createdAt));
    if (activeAlerts.length > 0 && !options.custodyAcknowledged) {
      return { entry: undefined, custodyAlerts: activeAlerts };
    }

    const [entry] = await transactionDb
      .update(dismissalQueue)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.status, "released")
        )
      )
      .returning();
    return { entry, custodyAlerts: activeAlerts };
  });
}

export async function batchDismiss(
  queueIds: string[],
  schoolId: string,
  sessionId: string
): Promise<{
  entries: DismissalQueueEntry[];
  custodyAlertsByQueueId: Map<string, CustodyAlert[]>;
}> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const requestedIds = [...new Set(queueIds.map(String))];
    if (requestedIds.length === 0) {
      return { entries: [], custodyAlertsByQueueId: new Map() };
    }
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: requestedIds,
    });
    if (activeRows.length !== requestedIds.length) {
      return { entries: [], custodyAlertsByQueueId: new Map() };
    }
    const current = await transactionDb
      .select()
      .from(dismissalQueue)
      .where(
        and(
          inArray(dismissalQueue.id, requestedIds),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.status, "released")
        )
      )
      .orderBy(dismissalQueue.studentId)
      .for("update");
    if (current.length !== requestedIds.length) {
      return { entries: [], custodyAlertsByQueueId: new Map() };
    }

    // Acquire in deterministic student order to avoid deadlocks between two
    // overlapping batch pickups and custody-alert creation.
    for (const studentId of [...new Set(current.map((entry) => entry.studentId))].sort()) {
      await transactionDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:custody:${schoolId}:${studentId}`}, 0::bigint))`
      );
    }
    const alertRows = await transactionDb
      .select({
        id: custodyAlerts.id,
        schoolId: custodyAlerts.schoolId,
        studentId: custodyAlerts.studentId,
        personName: custodyAlerts.personName,
        alertType: custodyAlerts.alertType,
        notes: custodyAlerts.notes,
        courtOrder: custodyAlerts.courtOrder,
        createdBy: custodyAlerts.createdBy,
        active: custodyAlerts.active,
        createdAt: custodyAlerts.createdAt,
        studentFirstName: students.firstName,
        studentLastName: students.lastName,
      })
      .from(custodyAlerts)
      .innerJoin(
        students,
        and(
          eq(students.schoolId, custodyAlerts.schoolId),
          eq(students.id, custodyAlerts.studentId)
        )
      )
      .where(
        and(
          eq(custodyAlerts.schoolId, schoolId),
          inArray(custodyAlerts.studentId, current.map((entry) => entry.studentId)),
          eq(custodyAlerts.active, true)
        )
      )
      .orderBy(desc(custodyAlerts.createdAt));
    const alertsByStudentId = new Map<string, CustodyAlert[]>();
    for (const alert of alertRows) {
      const alerts = alertsByStudentId.get(alert.studentId) ?? [];
      alerts.push(alert);
      alertsByStudentId.set(alert.studentId, alerts);
    }
    const custodyAlertsByQueueId = new Map<string, CustodyAlert[]>();
    const dismissibleIds: string[] = [];
    for (const entry of current) {
      const alerts = alertsByStudentId.get(entry.studentId) ?? [];
      if (alerts.length > 0) custodyAlertsByQueueId.set(entry.id, alerts);
      else dismissibleIds.push(entry.id);
    }
    const entries = dismissibleIds.length === 0
      ? []
      : await transactionDb
      .update(dismissalQueue)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(
        and(
          inArray(dismissalQueue.id, dismissibleIds),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.status, "released")
        )
      )
      .returning();
    return { entries, custodyAlertsByQueueId };
  });
}

export async function batchRelease(
  queueIds: string[],
  schoolId: string,
  sessionId: string
): Promise<DismissalQueueEntry[]> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds,
    });
    const activeQueueIds = activeRows.map((row) => row.queueId);
    if (activeQueueIds.length === 0) return [];
    return transactionDb
      .update(dismissalQueue)
      .set({ status: "released", releasedAt: new Date() })
      .where(
        and(
          inArray(dismissalQueue.id, activeQueueIds),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          eq(dismissalQueue.status, "called")
        )
      )
      .returning();
  });
}

export async function holdQueueEntry(
  id: string,
  reason: string,
  schoolId: string,
  sessionId: string
): Promise<DismissalQueueEntry | undefined> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: [id],
    });
    if (activeRows.length !== 1) return undefined;
    const [entry] = await transactionDb
      .update(dismissalQueue)
      .set({ status: "held", holdReason: reason })
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          inArray(dismissalQueue.status, ["waiting", "called", "delayed"])
        )
      )
      .returning();
    return entry;
  });
}

export async function delayQueueEntry(
  id: string,
  schoolId: string,
  sessionId: string
): Promise<DismissalQueueEntry | undefined> {
  return withActiveDismissalSessionQueueMutation(schoolId, sessionId, async (transactionDb) => {
    const activeRows = await lockActiveDismissalQueueStudents(transactionDb, {
      schoolId,
      sessionId,
      queueIds: [id],
    });
    if (activeRows.length !== 1) return undefined;
    const [entry] = await transactionDb
      .update(dismissalQueue)
      .set({
        status: "delayed",
        delayedUntil: sql`NOW() + INTERVAL '2 minutes'`,
      })
      .where(
        and(
          eq(dismissalQueue.id, id),
          eq(dismissalQueue.schoolId, schoolId),
          eq(dismissalQueue.sessionId, sessionId),
          inArray(dismissalQueue.status, ["waiting", "called", "held"])
        )
      )
      .returning();
    return entry;
  });
}

export async function getSessionStats(
  sessionId: string,
  options: { activeStudentsOnly?: boolean } = {}
) {
  const selectStats = {
    waiting: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'waiting')::int`,
    called: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'called')::int`,
    released: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'released')::int`,
    dismissed: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'dismissed')::int`,
    held: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'held')::int`,
    delayed: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'delayed')::int`,
    total: sql<number>`COUNT(*)::int`,
    avgWaitSeconds: sql<number | null>`AVG(EXTRACT(EPOCH FROM (${dismissalQueue.dismissedAt} - ${dismissalQueue.checkInTime}))) FILTER (WHERE ${dismissalQueue.dismissedAt} IS NOT NULL)`,
  };
  if (options.activeStudentsOnly) {
    const [stats] = await db
      .select(selectStats)
      .from(dismissalQueue)
      .innerJoin(
        students,
        and(
          eq(students.id, dismissalQueue.studentId),
          eq(students.schoolId, dismissalQueue.schoolId),
          eq(students.status, "active")
        )
      )
      .where(eq(dismissalQueue.sessionId, sessionId));
    return stats;
  }
  const [stats] = await db
    .select({
      ...selectStats,
    })
    .from(dismissalQueue)
    .where(eq(dismissalQueue.sessionId, sessionId));
  return stats;
}

export type GoPilotArrivalCandidateDto = {
  studentId: string;
  firstName: string;
  lastName: string;
  gradeLevel: string | null;
  homeroomId: string | null;
  homeroomName: string | null;
  dismissalType: string;
  effectiveDismissalType: string;
  familyGroupId: string | null;
  familyName: string | null;
  carNumber: string | null;
  isAbsent: boolean;
  alreadyQueued: boolean;
};

export async function searchGoPilotArrivalCandidates(options: {
  schoolId: string;
  sessionId: string;
  localDate: string;
  query: string;
  limit?: number;
}): Promise<GoPilotArrivalCandidateDto[]> {
  const query = options.query.trim();
  if (!query) return [];
  const pattern = `%${query}%`;
  const limit = Math.max(1, Math.min(options.limit ?? 30, 50));
  const rows = await db
    .select({
      studentId: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      gradeLevel: students.gradeLevel,
      homeroomId: students.homeroomId,
      homeroomName: homerooms.name,
      dismissalType: sql<string>`COALESCE(${students.dismissalType}, 'car')`,
      effectiveDismissalType: sql<string>`COALESCE(${dismissalOverrides.overrideType}, ${students.dismissalType}, 'car')`,
      familyGroupId: familyGroups.id,
      familyName: familyGroups.familyName,
      carNumber: familyGroups.carNumber,
      attendanceId: studentAttendance.id,
      queueId: dismissalQueue.id,
    })
    .from(students)
    .leftJoin(
      homerooms,
      and(
        eq(homerooms.schoolId, options.schoolId),
        eq(homerooms.id, students.homeroomId)
      )
    )
    .leftJoin(
      familyGroupStudents,
      and(
        eq(familyGroupStudents.schoolId, options.schoolId),
        eq(familyGroupStudents.studentId, students.id)
      )
    )
    .leftJoin(
      familyGroups,
      and(
        eq(familyGroups.schoolId, options.schoolId),
        eq(familyGroups.id, familyGroupStudents.familyGroupId)
      )
    )
    .leftJoin(
      dismissalOverrides,
      and(
        eq(dismissalOverrides.schoolId, options.schoolId),
        eq(dismissalOverrides.sessionId, options.sessionId),
        eq(dismissalOverrides.studentId, students.id)
      )
    )
    .leftJoin(
      studentAttendance,
      and(
        eq(studentAttendance.schoolId, options.schoolId),
        eq(studentAttendance.studentId, students.id),
        eq(studentAttendance.date, options.localDate),
        inArray(studentAttendance.status, ["absent", "early_dismissal"])
      )
    )
    .leftJoin(
      dismissalQueue,
      and(
        eq(dismissalQueue.schoolId, options.schoolId),
        eq(dismissalQueue.sessionId, options.sessionId),
        eq(dismissalQueue.studentId, students.id)
      )
    )
    .where(
      and(
        eq(students.schoolId, options.schoolId),
        eq(students.status, "active"),
        or(
          ilike(students.firstName, pattern),
          ilike(students.lastName, pattern),
          sql`(${students.firstName} || ' ' || ${students.lastName}) ILIKE ${pattern}`,
          ilike(familyGroups.familyName, pattern),
          ilike(familyGroups.carNumber, pattern)
        )
      )
    )
    .orderBy(students.lastName, students.firstName, students.id)
    .limit(limit);

  return rows.map((row) => ({
    studentId: row.studentId,
    firstName: row.firstName,
    lastName: row.lastName,
    gradeLevel: row.gradeLevel,
    homeroomId: row.homeroomId,
    homeroomName: row.homeroomName,
    dismissalType: row.dismissalType,
    effectiveDismissalType: row.effectiveDismissalType,
    familyGroupId: row.familyGroupId,
    familyName: row.familyName,
    carNumber: row.carNumber,
    isAbsent: Boolean(row.attendanceId),
    alreadyQueued: Boolean(row.queueId),
  }));
}

export type StaffDismissalArrivalSource = "staff_car_number" | "staff_search";

export type StaffDismissalArrivalResult = {
  source: StaffDismissalArrivalSource;
  groupLabel: string;
  entries: Array<{ entry: DismissalQueueEntry; student: Student }>;
  skippedDuplicate: Student[];
  skippedAbsent: Student[];
  skippedNotCar: Student[];
};

export type StaffOperationalQueueSource = "bus_number" | "walker";

/**
 * Transactional retained bus/walker intake. It shares the session row lock
 * with car/search arrivals and session completion, preserving unique positions
 * and making concurrent staff clicks idempotent.
 */
export async function createStaffOperationalQueueEntries(options: {
  schoolId: string;
  sessionId: string;
  actorId: string;
  source: StaffOperationalQueueSource;
  studentIds: string[];
  localDate: string;
  pickupGroupId: string;
  pickupGroupLabel: string;
  busRoute?: string;
  initialStatus?: "waiting" | "dismissed";
}): Promise<{
  entries: Array<{ entry: DismissalQueueEntry; student: Student }>;
  skippedDuplicate: Student[];
  skippedAbsent: Student[];
  skippedWrongType: Student[];
}> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, options.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session) {
      throw new GoPilotArrivalError("GOPILOT_SESSION_NOT_FOUND", "Dismissal session not found", 404);
    }
    if (session.status !== "active") {
      throw new GoPilotArrivalError(
        "GOPILOT_SESSION_NOT_ACTIVE",
        "Dismissal session must be active for this action",
        409
      );
    }

    const requestedIds = [...new Set(options.studentIds.map(String))];
    if (requestedIds.length === 0) {
      return { entries: [], skippedDuplicate: [], skippedAbsent: [], skippedWrongType: [] };
    }
    const selected = await tx
      .select()
      .from(students)
      .where(
        and(
          eq(students.schoolId, options.schoolId),
          eq(students.status, "active"),
          inArray(students.id, requestedIds)
        )
      );
    const [overrideRows, absenceRows, existingRows] = await Promise.all([
      tx
        .select({
          studentId: dismissalOverrides.studentId,
          overrideType: dismissalOverrides.overrideType,
          busRoute: dismissalOverrides.busRoute,
        })
        .from(dismissalOverrides)
        .where(
          and(
            eq(dismissalOverrides.schoolId, options.schoolId),
            eq(dismissalOverrides.sessionId, options.sessionId),
            inArray(dismissalOverrides.studentId, requestedIds)
          )
        ),
      tx
        .select({ studentId: studentAttendance.studentId })
        .from(studentAttendance)
        .where(
          and(
            eq(studentAttendance.schoolId, options.schoolId),
            eq(studentAttendance.date, options.localDate),
            inArray(studentAttendance.status, ["absent", "early_dismissal"]),
            inArray(studentAttendance.studentId, requestedIds)
          )
        ),
      tx
        .select({ studentId: dismissalQueue.studentId })
        .from(dismissalQueue)
        .where(
          and(
            eq(dismissalQueue.schoolId, options.schoolId),
            eq(dismissalQueue.sessionId, options.sessionId),
            inArray(dismissalQueue.studentId, requestedIds)
          )
        ),
    ]);
    const overrideByStudent = new Map(overrideRows.map((row) => [row.studentId, row]));
    const absentIds = new Set(absenceRows.map((row) => row.studentId));
    const duplicateIds = new Set(existingRows.map((row) => row.studentId));
    const skippedDuplicate: Student[] = [];
    const skippedAbsent: Student[] = [];
    const skippedWrongType: Student[] = [];
    const eligible: Student[] = [];
    for (const student of selected) {
      const override = overrideByStudent.get(student.id);
      const effectiveType = override?.overrideType ?? student.dismissalType ?? "car";
      const effectiveBusRoute = override?.busRoute ?? student.busRoute;
      const correctType = effectiveType === (options.source === "walker" ? "walker" : "bus")
        && (options.source !== "bus_number" || effectiveBusRoute === options.busRoute);
      if (absentIds.has(student.id)) skippedAbsent.push(student);
      else if (!correctType) skippedWrongType.push(student);
      else if (duplicateIds.has(student.id)) skippedDuplicate.push(student);
      else eligible.push(student);
    }

    const [positionRow] = await tx
      .select({ maxPosition: sql<number>`COALESCE(MAX(${dismissalQueue.position}), 0)::int` })
      .from(dismissalQueue)
      .where(
        and(
          eq(dismissalQueue.schoolId, options.schoolId),
          eq(dismissalQueue.sessionId, options.sessionId)
        )
      );
    let position = Number(positionRow?.maxPosition ?? 0);
    const entries: Array<{ entry: DismissalQueueEntry; student: Student }> = [];
    for (const student of eligible) {
      position += 1;
      const initialStatus = options.initialStatus ?? "waiting";
      const [entry] = await tx
        .insert(dismissalQueue)
        .values({
          schoolId: options.schoolId,
          sessionId: options.sessionId,
          studentId: student.id,
          guardianName: options.pickupGroupLabel,
          pickupGroupId: options.pickupGroupId,
          pickupGroupLabel: options.pickupGroupLabel,
          checkInMethod: options.source,
          status: initialStatus,
          dismissedAt: initialStatus === "dismissed" ? new Date() : null,
          position,
        })
        .onConflictDoNothing({ target: [dismissalQueue.sessionId, dismissalQueue.studentId] })
        .returning();
      if (!entry) {
        skippedDuplicate.push(student);
        continue;
      }
      entries.push({ entry, student });
      await tx.insert(activityLog).values({
        schoolId: options.schoolId,
        sessionId: options.sessionId,
        actorId: options.actorId,
        action: options.source === "walker" ? "walker.released" : "arrival.created",
        entityType: "dismissal_queue",
        entityId: entry.id,
        details: { source: options.source, studentId: student.id },
      });
    }
    return { entries, skippedDuplicate, skippedAbsent, skippedWrongType };
  });
}

export class GoPilotArrivalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GoPilotArrivalError";
  }
}

/**
 * Creates staff arrivals under one session-scoped transaction lock. The unique
 * (session_id, student_id) constraint is the final idempotency backstop for
 * concurrent office clicks and separate API tasks.
 */
export async function createStaffDismissalArrivals(options: {
  schoolId: string;
  sessionId: string;
  actorId: string;
  source: StaffDismissalArrivalSource;
  carNumber?: string;
  studentIds?: string[];
  localDate: string;
}): Promise<StaffDismissalArrivalResult> {
  return db.transaction(async (tx) => {
    const lockKey = `gopilot:dismissal-session:${options.sessionId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`);

    const [session] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, options.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session) {
      throw new GoPilotArrivalError("GOPILOT_SESSION_NOT_FOUND", "Dismissal session not found", 404);
    }
    if (session.status !== "active") {
      throw new GoPilotArrivalError(
        "GOPILOT_SESSION_NOT_ACTIVE",
        "Dismissal session must be active for arrivals",
        409
      );
    }

    let requestedStudentIds: string[];
    let groupLabel = "Staff search";
    let carFamilyGroup: FamilyGroup | undefined;
    if (options.source === "staff_car_number") {
      const carNumber = String(options.carNumber ?? "").trim();
      const [group] = await tx
        .select()
        .from(familyGroups)
        .where(
          and(
            eq(familyGroups.schoolId, options.schoolId),
            eq(familyGroups.carNumber, carNumber)
          )
        )
        .limit(1);
      if (!group) {
        throw new GoPilotArrivalError("GOPILOT_CAR_NUMBER_NOT_FOUND", "Car number not found", 404);
      }
      carFamilyGroup = group;
      groupLabel = group.familyName?.trim() || `Car #${group.carNumber}`;
      const links = await tx
        .select({ studentId: familyGroupStudents.studentId })
        .from(familyGroupStudents)
        .where(
          and(
            eq(familyGroupStudents.schoolId, options.schoolId),
            eq(familyGroupStudents.familyGroupId, group.id)
          )
        );
      requestedStudentIds = links.map((link) => link.studentId);
    } else {
      requestedStudentIds = [...new Set((options.studentIds ?? []).map(String))];
      if (requestedStudentIds.length === 0 || requestedStudentIds.length > 50) {
        throw new GoPilotArrivalError(
          "GOPILOT_INVALID_STUDENT_SELECTION",
          "Select between 1 and 50 students",
          400
        );
      }
    }

    if (requestedStudentIds.length === 0) {
      throw new GoPilotArrivalError(
        "GOPILOT_NO_STUDENTS_FOR_ARRIVAL",
        "No active car-rider students were found",
        409
      );
    }

    const selectedStudents = await tx
      .select()
      .from(students)
      .where(
        and(
          eq(students.schoolId, options.schoolId),
          eq(students.status, "active"),
          inArray(students.id, requestedStudentIds)
        )
      );
    if (options.source === "staff_search" && selectedStudents.length !== requestedStudentIds.length) {
      throw new GoPilotArrivalError(
        "GOPILOT_ARRIVAL_STUDENT_NOT_FOUND",
        "One or more selected students are unavailable",
        404
      );
    }
    const selectedById = new Map(selectedStudents.map((student) => [student.id, student]));
    const orderedStudents = requestedStudentIds
      .map((studentId) => selectedById.get(studentId))
      .filter((student): student is Student => Boolean(student));

    const [overrideRows, absenceRows, existingRows, familyRows] = await Promise.all([
      tx
        .select({ studentId: dismissalOverrides.studentId, overrideType: dismissalOverrides.overrideType })
        .from(dismissalOverrides)
        .where(
          and(
            eq(dismissalOverrides.schoolId, options.schoolId),
            eq(dismissalOverrides.sessionId, options.sessionId),
            inArray(dismissalOverrides.studentId, requestedStudentIds)
          )
        ),
      tx
        .select({ studentId: studentAttendance.studentId })
        .from(studentAttendance)
        .where(
          and(
            eq(studentAttendance.schoolId, options.schoolId),
            eq(studentAttendance.date, options.localDate),
            inArray(studentAttendance.status, ["absent", "early_dismissal"]),
            inArray(studentAttendance.studentId, requestedStudentIds)
          )
        ),
      tx
        .select({ studentId: dismissalQueue.studentId })
        .from(dismissalQueue)
        .where(
          and(
            eq(dismissalQueue.schoolId, options.schoolId),
            eq(dismissalQueue.sessionId, options.sessionId),
            inArray(dismissalQueue.studentId, requestedStudentIds)
          )
        ),
      tx
        .select({
          studentId: familyGroupStudents.studentId,
          groupId: familyGroups.id,
          familyName: familyGroups.familyName,
          carNumber: familyGroups.carNumber,
        })
        .from(familyGroupStudents)
        .innerJoin(
          familyGroups,
          and(
            eq(familyGroups.schoolId, familyGroupStudents.schoolId),
            eq(familyGroups.id, familyGroupStudents.familyGroupId)
          )
        )
        .where(
          and(
            eq(familyGroupStudents.schoolId, options.schoolId),
            inArray(familyGroupStudents.studentId, requestedStudentIds)
          )
        ),
    ]);

    const overrideByStudent = new Map(overrideRows.map((row) => [row.studentId, row.overrideType]));
    const absentIds = new Set(absenceRows.map((row) => row.studentId));
    const duplicateIds = new Set(existingRows.map((row) => row.studentId));
    const familyByStudent = new Map(familyRows.map((row) => [row.studentId, row]));
    const skippedAbsent: Student[] = [];
    const skippedDuplicate: Student[] = [];
    const skippedNotCar: Student[] = [];
    const eligible: Student[] = [];

    for (const student of orderedStudents) {
      if (absentIds.has(student.id)) {
        skippedAbsent.push(student);
      } else if ((overrideByStudent.get(student.id) ?? student.dismissalType ?? "car") !== "car") {
        skippedNotCar.push(student);
      } else if (duplicateIds.has(student.id)) {
        skippedDuplicate.push(student);
      } else {
        eligible.push(student);
      }
    }

    const [positionRow] = await tx
      .select({ maxPosition: sql<number>`COALESCE(MAX(${dismissalQueue.position}), 0)::int` })
      .from(dismissalQueue)
      .where(
        and(
          eq(dismissalQueue.schoolId, options.schoolId),
          eq(dismissalQueue.sessionId, options.sessionId)
        )
      );
    let position = Number(positionRow?.maxPosition ?? 0);
    const entries: Array<{ entry: DismissalQueueEntry; student: Student }> = [];

    for (const student of eligible) {
      position += 1;
      const family = carFamilyGroup
        ? {
            groupId: carFamilyGroup.id,
            familyName: carFamilyGroup.familyName,
            carNumber: carFamilyGroup.carNumber,
          }
        : familyByStudent.get(student.id);
      const pickupGroupId = family ? `family:${family.groupId}` : `student:${student.id}`;
      const pickupGroupLabel = family
        ? family.familyName?.trim() || `Car #${family.carNumber}`
        : studentNameForStorage(student);
      const [entry] = await tx
        .insert(dismissalQueue)
        .values({
          schoolId: options.schoolId,
          sessionId: options.sessionId,
          studentId: student.id,
          guardianName: pickupGroupLabel,
          pickupGroupId,
          pickupGroupLabel,
          checkInMethod: options.source,
          status: "waiting",
          position,
        })
        .onConflictDoNothing({
          target: [dismissalQueue.sessionId, dismissalQueue.studentId],
        })
        .returning();
      if (!entry) {
        skippedDuplicate.push(student);
        continue;
      }
      entries.push({ entry, student });
      await tx.insert(activityLog).values({
        schoolId: options.schoolId,
        sessionId: options.sessionId,
        actorId: options.actorId,
        action: "arrival.created",
        entityType: "dismissal_queue",
        entityId: entry.id,
        details: { source: options.source, studentId: student.id },
      });
    }

    return {
      source: options.source,
      groupLabel,
      entries,
      skippedDuplicate,
      skippedAbsent,
      skippedNotCar,
    };
  });
}

function studentNameForStorage(student: Pick<Student, "id" | "firstName" | "lastName">): string {
  return `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.id;
}

// ============================================================================
// GoPilot - Dismissal Changes
// ============================================================================

export async function getChangesBySession(sessionId: string) {
  return db
    .select({
      change: dismissalChanges,
      student: students,
      requester: users,
    })
    .from(dismissalChanges)
    .innerJoin(students, eq(dismissalChanges.studentId, students.id))
    .innerJoin(users, eq(dismissalChanges.requestedBy, users.id))
    .where(eq(dismissalChanges.sessionId, sessionId))
    .orderBy(desc(dismissalChanges.createdAt));
}

export async function createDismissalChange(
  data: Omit<InsertDismissalChange, "schoolId"> & { schoolId?: string }
): Promise<DismissalChange> {
  const schoolId = await getSessionSchoolIdForTenantWrite(data.sessionId, data.schoolId);
  const student = await getStudentById(data.studentId);
  if (!student || student.schoolId !== schoolId) {
    throw new Error("Student does not belong to the dismissal session school");
  }
  const [change] = await db
    .insert(dismissalChanges)
    .values({ ...data, schoolId })
    .returning();
  return change!;
}

export async function reviewDismissalChange(
  id: string,
  status: string,
  reviewedBy: string
): Promise<DismissalChange | undefined> {
  const [change] = await db
    .update(dismissalChanges)
    .set({ status, reviewedBy, reviewedAt: new Date() })
    .where(eq(dismissalChanges.id, id))
    .returning();
  return change;
}

// ============================================================================
// GoPilot - Parent-Student relationships
// ============================================================================

export async function getParentStudents(
  parentId: string
): Promise<ParentStudent[]> {
  return db
    .select()
    .from(parentStudent)
    .where(eq(parentStudent.parentId, parentId));
}

export async function getCarRiderChildrenForParent(
  parentId: string,
  schoolId?: string
): Promise<Student[]> {
  const conditions = [
    eq(parentStudent.parentId, parentId),
    eq(parentStudent.status, "approved"),
    eq(students.dismissalType, "car"),
    eq(students.status, "active"),
  ];
  if (schoolId) {
    conditions.push(eq(students.schoolId, schoolId));
  }

  const rows = await db
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      schoolId: students.schoolId,
      homeroomId: students.homeroomId,
      dismissalType: students.dismissalType,
      busRoute: students.busRoute,
      gradeLevel: students.gradeLevel,
      status: students.status,
    })
    .from(parentStudent)
    .innerJoin(students, eq(students.id, parentStudent.studentId))
    .where(and(...conditions));

  return rows as unknown as Student[];
}

// ============================================================================
// GoPilot - Authorized Pickups
// ============================================================================

export async function getPickupsForStudent(
  studentId: string
): Promise<AuthorizedPickup[]> {
  return db
    .select()
    .from(authorizedPickups)
    .where(
      and(
        eq(authorizedPickups.studentId, studentId),
        ne(authorizedPickups.status, "revoked")
      )
    )
    .orderBy(authorizedPickups.name);
}

export async function getPickupsBySchool(
  schoolId: string
): Promise<AuthorizedPickup[]> {
  return db
    .select({ pickup: authorizedPickups })
    .from(authorizedPickups)
    .innerJoin(students, eq(students.id, authorizedPickups.studentId))
    .where(
      and(
        eq(students.schoolId, schoolId),
        ne(authorizedPickups.status, "revoked")
      )
    )
    .orderBy(authorizedPickups.name)
    .then(rows => rows.map(r => r.pickup));
}

export async function createPickup(
  data: Omit<InsertAuthorizedPickup, "schoolId"> & { schoolId?: string }
): Promise<AuthorizedPickup> {
  const schoolId = await getStudentSchoolIdForTenantWrite(data.studentId, data.schoolId);
  const [p] = await db
    .insert(authorizedPickups)
    .values({ ...data, schoolId })
    .returning();
  return p!;
}

export type AuthorizedPickupStatus = "pending" | "approved" | "revoked";

export type AuthorizedPickupTransitionResult =
  | {
      outcome: "updated" | "unchanged";
      pickup: AuthorizedPickup;
      previousStatus: AuthorizedPickupStatus;
    }
  | { outcome: "not_found" }
  | { outcome: "invalid_status"; pickup: AuthorizedPickup }
  | { outcome: "invalid_transition"; pickup: AuthorizedPickup };

function isStoredAuthorizedPickupStatus(value: string): value is AuthorizedPickupStatus {
  return value === "pending" || value === "approved" || value === "revoked";
}

function canApplyAuthorizedPickupTransition(
  from: AuthorizedPickupStatus,
  to: AuthorizedPickupStatus
): boolean {
  if (from === to) return true;
  if (from === "pending") return to === "approved" || to === "revoked";
  return from === "approved" && to === "revoked";
}

/**
 * Applies the monotonic pickup-review state machine while holding the pickup
 * row lock. The school predicate is deliberately part of both the read and
 * write so a stale or cross-tenant identifier cannot mutate another school.
 */
export async function transitionAuthorizedPickupStatus(
  id: string,
  schoolId: string,
  nextStatus: AuthorizedPickupStatus
): Promise<AuthorizedPickupTransitionResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(authorizedPickups)
      .where(
        and(
          eq(authorizedPickups.id, id),
          eq(authorizedPickups.schoolId, schoolId)
        )
      )
      .limit(1)
      .for("update");

    if (!current) return { outcome: "not_found" as const };
    if (!isStoredAuthorizedPickupStatus(current.status)) {
      return { outcome: "invalid_status" as const, pickup: current };
    }
    if (!canApplyAuthorizedPickupTransition(current.status, nextStatus)) {
      return { outcome: "invalid_transition" as const, pickup: current };
    }
    if (current.status === nextStatus) {
      return {
        outcome: "unchanged" as const,
        pickup: current,
        previousStatus: current.status,
      };
    }

    const [updated] = await tx
      .update(authorizedPickups)
      .set({ status: nextStatus })
      .where(
        and(
          eq(authorizedPickups.id, id),
          eq(authorizedPickups.schoolId, schoolId),
          eq(authorizedPickups.status, current.status)
        )
      )
      .returning();

    // The row lock makes this unreachable under normal operation. Treat an
    // unexpected lost update as a conflict instead of claiming success.
    if (!updated) {
      return { outcome: "invalid_transition" as const, pickup: current };
    }
    return {
      outcome: "updated" as const,
      pickup: updated,
      previousStatus: current.status,
    };
  });
}

// ============================================================================
// GoPilot - Custody Alerts
// ============================================================================

export async function getCustodyAlertsBySchool(
  schoolId: string
): Promise<CustodyAlert[]> {
  // Join with students to filter by school
  const rows = await db
    .select({
      id: custodyAlerts.id,
      schoolId: custodyAlerts.schoolId,
      studentId: custodyAlerts.studentId,
      personName: custodyAlerts.personName,
      alertType: custodyAlerts.alertType,
      notes: custodyAlerts.notes,
      courtOrder: custodyAlerts.courtOrder,
      createdBy: custodyAlerts.createdBy,
      active: custodyAlerts.active,
      createdAt: custodyAlerts.createdAt,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
    })
    .from(custodyAlerts)
    .innerJoin(students, eq(students.id, custodyAlerts.studentId))
    .where(
      and(eq(students.schoolId, schoolId), eq(custodyAlerts.active, true))
    )
    .orderBy(desc(custodyAlerts.createdAt));
  return rows as CustodyAlert[];
}

export async function getActiveCustodyAlertsForStudent(
  studentId: string
): Promise<CustodyAlert[]> {
  const rows = await db
    .select({
      id: custodyAlerts.id,
      schoolId: custodyAlerts.schoolId,
      studentId: custodyAlerts.studentId,
      personName: custodyAlerts.personName,
      alertType: custodyAlerts.alertType,
      notes: custodyAlerts.notes,
      courtOrder: custodyAlerts.courtOrder,
      createdBy: custodyAlerts.createdBy,
      active: custodyAlerts.active,
      createdAt: custodyAlerts.createdAt,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
    })
    .from(custodyAlerts)
    .innerJoin(students, eq(students.id, custodyAlerts.studentId))
    .where(
      and(
        eq(custodyAlerts.studentId, studentId),
        eq(custodyAlerts.active, true)
      )
    )
    .orderBy(desc(custodyAlerts.createdAt));
  return rows as CustodyAlert[];
}

export async function createCustodyAlert(
  data: Omit<InsertCustodyAlert, "schoolId"> & { schoolId?: string }
): Promise<CustodyAlert> {
  const schoolId = await getStudentSchoolIdForTenantWrite(data.studentId, data.schoolId);
  return db.transaction(async (tx) => {
    // Pickup completion takes the same lock before checking active alerts, so
    // a new restriction either commits before that check or after dismissal.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:custody:${schoolId}:${data.studentId}`}, 0::bigint))`
    );
    const [student] = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.id, data.studentId),
          eq(students.schoolId, schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1);
    if (!student) {
      throw Object.assign(new Error("Student not found"), {
        status: 404,
        code: "GOPILOT_STUDENT_NOT_FOUND",
        expose: true,
      });
    }
    const [alert] = await tx
      .insert(custodyAlerts)
      .values({ ...data, schoolId })
      .returning();
    return alert!;
  });
}

// ============================================================================
// GoPilot - Bus Routes
// ============================================================================

export async function getBusRoutesBySchool(
  schoolId: string
): Promise<BusRoute[]> {
  return db
    .select()
    .from(busRoutes)
    .where(eq(busRoutes.schoolId, schoolId))
    .orderBy(busRoutes.routeNumber);
}

export async function createBusRoute(
  data: InsertBusRoute
): Promise<BusRoute> {
  const [br] = await db.insert(busRoutes).values(data).returning();
  return br!;
}

export async function updateBusRoute(
  id: string,
  data: Partial<InsertBusRoute>
): Promise<BusRoute | undefined> {
  const [br] = await db
    .update(busRoutes)
    .set(data)
    .where(eq(busRoutes.id, id))
    .returning();
  return br;
}

// ============================================================================
// GoPilot - Walker Zones
// ============================================================================

export async function getWalkerZonesBySchool(
  schoolId: string
): Promise<WalkerZone[]> {
  return db
    .select()
    .from(walkerZones)
    .where(eq(walkerZones.schoolId, schoolId));
}

// ============================================================================
// GoPilot - Family Groups
// ============================================================================

export async function getFamilyGroupsBySchool(
  schoolId: string
): Promise<FamilyGroup[]> {
  return db
    .select()
    .from(familyGroups)
    .where(eq(familyGroups.schoolId, schoolId))
    .orderBy(familyGroups.carNumber);
}

export async function getFamilyGroupById(
  id: string
): Promise<FamilyGroup | undefined> {
  const [fg] = await db
    .select()
    .from(familyGroups)
    .where(eq(familyGroups.id, id))
    .limit(1);
  return fg;
}

export async function getFamilyGroupByCarNumber(
  schoolId: string,
  carNumber: string
): Promise<FamilyGroup | undefined> {
  const [fg] = await db
    .select()
    .from(familyGroups)
    .where(
      and(
        eq(familyGroups.schoolId, schoolId),
        eq(familyGroups.carNumber, carNumber)
      )
    )
    .limit(1);
  return fg;
}

export async function createFamilyGroup(
  data: InsertFamilyGroup
): Promise<FamilyGroup> {
  const [fg] = await db.insert(familyGroups).values(data).returning();
  return fg!;
}

export async function createFamilyGroupWithStudents(
  data: InsertFamilyGroup,
  studentIds: string[]
): Promise<FamilyGroup> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:family-groups:${data.schoolId}`}, 0::bigint))`
    );
    const uniqueStudentIds = [...new Set(studentIds)];
    await assertFamilyStudentsBelongToSchool(uniqueStudentIds, data.schoolId, tx as unknown as typeof db);
    const [group] = await tx.insert(familyGroups).values(data).returning();
    if (uniqueStudentIds.length > 0) {
      await tx.insert(familyGroupStudents).values(
        uniqueStudentIds.map((studentId) => ({
          schoolId: data.schoolId,
          familyGroupId: group!.id,
          studentId,
        }))
      );
    }
    return group!;
  });
}

export async function updateFamilyGroup(
  id: string,
  data: Partial<InsertFamilyGroup>
): Promise<FamilyGroup | undefined> {
  const [fg] = await db
    .update(familyGroups)
    .set(data)
    .where(eq(familyGroups.id, id))
    .returning();
  return fg;
}

export async function updateFamilyGroupWithStudents(
  id: string,
  schoolId: string,
  data: Partial<InsertFamilyGroup>,
  studentIds?: string[]
): Promise<FamilyGroup | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:family-group:${schoolId}:${id}`}, 0::bigint))`
    );
    const [existing] = await tx
      .select()
      .from(familyGroups)
      .where(and(eq(familyGroups.id, id), eq(familyGroups.schoolId, schoolId)))
      .limit(1);
    if (!existing) return undefined;
    if (data.schoolId !== undefined && data.schoolId !== schoolId) {
      throw new Error("Family group school cannot be changed");
    }
    const uniqueStudentIds = studentIds === undefined ? undefined : [...new Set(studentIds)];
    if (uniqueStudentIds) {
      await assertFamilyStudentsBelongToSchool(uniqueStudentIds, schoolId, tx as unknown as typeof db);
    }
    const [updated] = await tx
      .update(familyGroups)
      .set({ ...data, schoolId })
      .where(and(eq(familyGroups.id, id), eq(familyGroups.schoolId, schoolId)))
      .returning();
    if (uniqueStudentIds) {
      await tx
        .delete(familyGroupStudents)
        .where(
          and(
            eq(familyGroupStudents.schoolId, schoolId),
            eq(familyGroupStudents.familyGroupId, id)
          )
        );
      if (uniqueStudentIds.length > 0) {
        await tx.insert(familyGroupStudents).values(
          uniqueStudentIds.map((studentId) => ({ schoolId, familyGroupId: id, studentId }))
        );
      }
    }
    return updated;
  });
}

export async function deleteFamilyGroup(id: string, schoolId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: familyGroups.id })
      .from(familyGroups)
      .where(and(eq(familyGroups.id, id), eq(familyGroups.schoolId, schoolId)))
      .limit(1)
      .for("update");
    if (!group) return false;
    await tx
      .delete(familyGroupStudents)
      .where(
        and(
          eq(familyGroupStudents.schoolId, schoolId),
          eq(familyGroupStudents.familyGroupId, id)
        )
      );
    const result = await tx
      .delete(familyGroups)
      .where(and(eq(familyGroups.id, id), eq(familyGroups.schoolId, schoolId)));
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getFamilyGroupStudents(
  familyGroupId: string
): Promise<Student[]> {
  const rows = await db
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      schoolId: students.schoolId,
      gradeLevel: students.gradeLevel,
      homeroomId: students.homeroomId,
      dismissalType: students.dismissalType,
      busRoute: students.busRoute,
      status: students.status,
    })
    .from(familyGroupStudents)
    .innerJoin(students, eq(students.id, familyGroupStudents.studentId))
    .where(
      and(
        eq(familyGroupStudents.familyGroupId, familyGroupId),
        eq(students.status, "active")
      )
    );
  return rows as unknown as Student[];
}

async function getFamilyGroupSchoolIdForTenantWrite(
  familyGroupId: string,
  dbInstance: typeof db = db
): Promise<string> {
  const [group] = await dbInstance
    .select({ schoolId: familyGroups.schoolId })
    .from(familyGroups)
    .where(eq(familyGroups.id, familyGroupId))
    .limit(1);
  if (!group) throw new Error("Family group not found");
  return group.schoolId;
}

async function assertFamilyStudentsBelongToSchool(
  studentIds: string[],
  schoolId: string,
  dbInstance: typeof db = db
): Promise<void> {
  const uniqueStudentIds = [...new Set(studentIds)];
  if (uniqueStudentIds.length === 0) return;
  const rows = await dbInstance
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        inArray(students.id, uniqueStudentIds)
      )
    );
  if (rows.length !== uniqueStudentIds.length) {
    throw new Error("One or more students do not belong to the family group's school");
  }
}

export async function addStudentsToFamilyGroup(
  familyGroupId: string,
  studentIds: string[]
): Promise<void> {
  const schoolId = await getFamilyGroupSchoolIdForTenantWrite(familyGroupId);
  const uniqueStudentIds = [...new Set(studentIds)];
  await assertFamilyStudentsBelongToSchool(uniqueStudentIds, schoolId);
  if (uniqueStudentIds.length === 0) return;
  await db
    .insert(familyGroupStudents)
    .values(uniqueStudentIds.map((studentId) => ({ schoolId, familyGroupId, studentId })))
    .onConflictDoNothing({
      target: [familyGroupStudents.familyGroupId, familyGroupStudents.studentId],
    });
}

export async function removeStudentFromFamilyGroup(
  familyGroupId: string,
  studentId: string
): Promise<void> {
  await db
    .delete(familyGroupStudents)
    .where(
      and(
        eq(familyGroupStudents.familyGroupId, familyGroupId),
        eq(familyGroupStudents.studentId, studentId)
      )
    );
}

export async function setFamilyGroupStudents(
  familyGroupId: string,
  studentIds: string[]
): Promise<void> {
  const schoolId = await getFamilyGroupSchoolIdForTenantWrite(familyGroupId);
  const uniqueStudentIds = [...new Set(studentIds)];
  await assertFamilyStudentsBelongToSchool(uniqueStudentIds, schoolId);
  await db.transaction(async (tx) => {
    await tx
      .delete(familyGroupStudents)
      .where(
        and(
          eq(familyGroupStudents.schoolId, schoolId),
          eq(familyGroupStudents.familyGroupId, familyGroupId)
        )
      );
    if (uniqueStudentIds.length > 0) {
      await tx.insert(familyGroupStudents).values(
        uniqueStudentIds.map((studentId) => ({ schoolId, familyGroupId, studentId }))
      );
    }
  });
}

export async function getUnassignedStudents(
  schoolId: string
): Promise<Student[]> {
  const assigned = db
    .select({ studentId: familyGroupStudents.studentId })
    .from(familyGroupStudents)
    .where(eq(familyGroupStudents.schoolId, schoolId));

  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        sql`${students.id} NOT IN (${assigned})`
      )
    )
    .orderBy(students.lastName, students.firstName);
}

export async function autoAssignFamilyGroups(
  schoolId: string
): Promise<{ created: number; assigned: number }> {
  const { generateFamilyGroupNumber } = await import(
    "../util/studentCode.js"
  );
  const unassigned = await getUnassignedStudents(schoolId);
  if (unassigned.length === 0) return { created: 0, assigned: 0 };

  // Group by lastName for sibling grouping
  const byLastName = new Map<string, Student[]>();
  for (const s of unassigned) {
    const key = (s.lastName || "").trim();
    if (!byLastName.has(key)) byLastName.set(key, []);
    byLastName.get(key)!.push(s);
  }

  let created = 0;
  let assigned = 0;

  for (const [lastName, groupStudents] of byLastName) {
    const familyName = `${lastName} Family`;

    // Check if a family group with this name already exists for the school
    const [existing] = await db
      .select()
      .from(familyGroups)
      .where(
        and(
          eq(familyGroups.schoolId, schoolId),
          eq(familyGroups.familyName, familyName)
        )
      )
      .limit(1);

    if (existing) {
      await addStudentsToFamilyGroup(
        existing.id,
        groupStudents.map((s) => s.id)
      );
    } else {
      const carNum = await generateFamilyGroupNumber(schoolId);
      const group = await createFamilyGroup({
        schoolId,
        carNumber: carNum,
        familyName,
        inviteToken: null,
      });
      await addStudentsToFamilyGroup(
        group.id,
        groupStudents.map((s) => s.id)
      );
      created++;
    }
    assigned += groupStudents.length;
  }

  return { created, assigned };
}

export async function getFamilyGroupByInviteToken(
  token: string
): Promise<FamilyGroup | undefined> {
  const [fg] = await db
    .select()
    .from(familyGroups)
    .where(eq(familyGroups.inviteToken, token))
    .limit(1);
  return fg;
}

// ============================================================================
// GoPilot - Activity Log
// ============================================================================

export async function getActivityLog(
  sessionId: string,
  limit = 50
): Promise<any[]> {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.sessionId, sessionId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}

export async function logActivity(data: {
  sessionId?: string;
  schoolId: string;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: unknown;
}): Promise<void> {
  await db.insert(activityLog).values(data);
}

// ============================================================================
// GoPilot - Helpers for dismissal check-in
// ============================================================================

export async function getStudentsByDismissalType(
  schoolId: string,
  dismissalType: string,
  filter?: { grade?: string; homeroomId?: string }
): Promise<Student[]> {
  const conditions = [
    eq(students.schoolId, schoolId),
    eq(students.dismissalType, dismissalType),
    eq(students.status, "active"),
  ];
  if (filter?.grade) {
    conditions.push(eq(students.gradeLevel, filter.grade));
  }
  if (filter?.homeroomId) {
    conditions.push(eq(students.homeroomId, filter.homeroomId));
  }
  return db
    .select()
    .from(students)
    .where(and(...conditions));
}

export async function getStudentsByBusRoute(
  schoolId: string,
  busRoute: string
): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.dismissalType, "bus"),
        eq(students.busRoute, busRoute),
        eq(students.status, "active")
      )
    );
}

export async function getStudentsByHomeroomId(
  homeroomId: string
): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.homeroomId, homeroomId),
        eq(students.status, "active")
      )
    );
}

export async function getMemberByCarNumber(
  schoolId: string,
  carNumber: string
): Promise<{ userId: string; firstName: string; lastName: string } | undefined> {
  const [row] = await db
    .select({
      userId: schoolMemberships.userId,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.carNumber, carNumber),
        eq(schoolMemberships.role, "parent"),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);
  return row;
}

export async function getFamilyGroupStudentsByCarNumber(
  schoolId: string,
  carNumber: string
): Promise<{ group: FamilyGroup; students: Student[] } | undefined> {
  const group = await getFamilyGroupByCarNumber(schoolId, carNumber);
  if (!group) return undefined;
  const studs = await getFamilyGroupStudents(group.id);
  // Filter to car riders only
  const carStudents = studs.filter((s) => s.dismissalType === "car");
  return { group, students: carStudents };
}

// ============================================================================
// Additional helpers needed by route files
// ============================================================================

export async function getSchoolBySlug(
  slug: string
): Promise<School | undefined> {
  const [school] = await db
    .select()
    .from(schools)
    .where(and(eq(schools.slug, slug), isNull(schools.deletedAt)))
    .limit(1);
  return school;
}

/**
 * Slug uniqueness includes soft-deleted rows so a deleted tenant cannot have
 * its public identifier silently reused by a new school.
 */
export async function getSchoolBySlugIncludingDeleted(
  slug: string
): Promise<School | undefined> {
  const [school] = await db
    .select()
    .from(schools)
    .where(eq(schools.slug, slug))
    .limit(1);
  return school;
}

export async function getStudentByCode(
  schoolId: string,
  code: string
): Promise<Student | undefined> {
  const [row] = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.studentCode, code),
        eq(students.status, "active")
      )
    )
    .limit(1);
  return row;
}

export async function getParentStudentLinkById(
  id: string
): Promise<ParentStudent | undefined> {
  const [row] = await db
    .select()
    .from(parentStudent)
    .where(eq(parentStudent.id, id))
    .limit(1);
  return row;
}

async function getStudentSchoolIdForTenantWrite(studentId: string, expectedSchoolId?: string): Promise<string> {
  const [student] = await db
    .select({ schoolId: students.schoolId })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student) {
    throw new Error(`student ${studentId} not found`);
  }
  if (expectedSchoolId && student.schoolId !== expectedSchoolId) {
    const err = new Error("student does not belong to the active school") as Error & { code?: string };
    err.code = "STUDENT_SCHOOL_MISMATCH";
    throw err;
  }
  return student.schoolId;
}

// parent_student.school_id is derived from the linked student. Returns the link
// only if its stored tenant belongs to the given school.
export async function getParentStudentLinkByIdAndSchool(
  id: string,
  schoolId: string
): Promise<ParentStudent | undefined> {
  const [row] = await db
    .select()
    .from(parentStudent)
    .where(and(eq(parentStudent.id, id), eq(parentStudent.schoolId, schoolId)))
    .limit(1);
  return row;
}

export async function updateParentStudentLink(
  id: string,
  data: Partial<InsertParentStudent>
): Promise<ParentStudent | undefined> {
  const values = { ...data };
  if (values.studentId) {
    values.schoolId = await getStudentSchoolIdForTenantWrite(values.studentId);
  }
  const [row] = await db
    .update(parentStudent)
    .set(values)
    .where(eq(parentStudent.id, id))
    .returning();
  return row;
}

// School-scoped update. Belt-and-suspenders so the mutation can't touch another
// school's link even if a caller forgets the read-side ownership gate.
export async function updateParentStudentLinkByIdAndSchool(
  id: string,
  schoolId: string,
  data: Partial<InsertParentStudent>
): Promise<ParentStudent | undefined> {
  const values = { ...data };
  if (values.studentId) {
    values.schoolId = await getStudentSchoolIdForTenantWrite(values.studentId, schoolId);
  }
  const [row] = await db
    .update(parentStudent)
    .set(values)
    .where(and(eq(parentStudent.id, id), eq(parentStudent.schoolId, schoolId)))
    .returning();
  return row;
}

export async function createParentStudentLink(
  data: InsertParentStudent
): Promise<ParentStudent> {
  const schoolId = await getStudentSchoolIdForTenantWrite(data.studentId, data.schoolId ?? undefined);
  const [row] = await db
    .insert(parentStudent)
    .values({ ...data, schoolId })
    .onConflictDoNothing()
    .returning();
  return row!;
}

export async function linkParentByCarNumber(
  parentId: string,
  schoolId: string,
  carNumber: string,
  membershipId: string
): Promise<{ group: FamilyGroup; students: Student[] }> {
  const group = await getFamilyGroupByCarNumber(schoolId, carNumber);
  if (!group) {
    throw new Error("No family found with that car number");
  }
  const studs = await getFamilyGroupStudents(group.id);
  if (studs.length === 0) {
    throw new Error("No students found in that family group");
  }
  // Link each student to this parent
  for (const s of studs) {
    await createParentStudentLink({
      schoolId,
      parentId,
      studentId: s.id,
      relationship: "parent",
      status: "approved",
    });
  }
  // Set car number on the parent's membership
  await updateMembership(membershipId, { carNumber });
  // Claim the family group
  if (!group.claimedByUserId) {
    await updateFamilyGroup(group.id, { claimedByUserId: parentId });
  }
  return { group, students: studs };
}

export async function getApprovedChildrenForParent(
  parentId: string,
  schoolId: string
) {
  return db
    .select({ link: parentStudent, student: students, homeroom: homerooms })
    .from(parentStudent)
    .innerJoin(students, eq(parentStudent.studentId, students.id))
    .leftJoin(homerooms, eq(students.homeroomId, homerooms.id))
    .where(
      and(
        eq(parentStudent.parentId, parentId),
        eq(parentStudent.status, "approved"),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    );
}

export async function getPendingParentRequests(schoolId: string) {
  return db
    .select({ link: parentStudent, student: students, parent: users })
    .from(parentStudent)
    .innerJoin(students, eq(parentStudent.studentId, students.id))
    .innerJoin(users, eq(parentStudent.parentId, users.id))
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(parentStudent.status, "pending")
      )
    )
    .orderBy(desc(parentStudent.createdAt));
}

export async function getParentStudentLinks(
  parentId: string
): Promise<(ParentStudent & { student: Student })[]> {
  const rows = await db
    .select({ link: parentStudent, student: students })
    .from(parentStudent)
    .innerJoin(students, eq(parentStudent.studentId, students.id))
    .where(
      and(
        eq(parentStudent.parentId, parentId),
        eq(parentStudent.status, "approved")
      )
    );
  return rows.map((r) => ({ ...r.link, student: r.student }));
}

export async function getApprovedParentLinksForStudent(
  studentId: string
): Promise<(ParentStudent & { parent: User })[]> {
  const rows = await db
    .select({ link: parentStudent, parent: users })
    .from(parentStudent)
    .innerJoin(users, eq(parentStudent.parentId, users.id))
    .where(
      and(
        eq(parentStudent.studentId, studentId),
        eq(parentStudent.status, "approved")
      )
    );
  return rows.map((r) => ({ ...r.link, parent: r.parent }));
}

export async function getMembershipByCarNumber(
  schoolId: string,
  carNumber: string
): Promise<SchoolMembership | undefined> {
  const [row] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.carNumber, carNumber),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);
  return row;
}

export async function getDismissalChangeById(
  id: string
): Promise<DismissalChange | undefined> {
  const [row] = await db
    .select()
    .from(dismissalChanges)
    .where(eq(dismissalChanges.id, id))
    .limit(1);
  return row;
}

export async function updateDismissalChange(
  id: string,
  data: Partial<InsertDismissalChange>
): Promise<DismissalChange | undefined> {
  const [row] = await db
    .update(dismissalChanges)
    .set(data)
    .where(eq(dismissalChanges.id, id))
    .returning();
  return row;
}

export async function createWalkerZone(
  data: InsertWalkerZone
): Promise<WalkerZone> {
  const [row] = await db.insert(walkerZones).values(data).returning();
  return row!;
}

export async function addStudentToFamilyGroup(
  familyGroupId: string,
  studentId: string
): Promise<FamilyGroupStudent> {
  const schoolId = await getFamilyGroupSchoolIdForTenantWrite(familyGroupId);
  await assertFamilyStudentsBelongToSchool([studentId], schoolId);
  const [row] = await db
    .insert(familyGroupStudents)
    .values({ schoolId, familyGroupId, studentId })
    .onConflictDoNothing({
      target: [familyGroupStudents.familyGroupId, familyGroupStudents.studentId],
    })
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(familyGroupStudents)
    .where(
      and(
        eq(familyGroupStudents.schoolId, schoolId),
        eq(familyGroupStudents.familyGroupId, familyGroupId),
        eq(familyGroupStudents.studentId, studentId)
      )
    )
    .limit(1);
  return existing!;
}

export async function updateSession(
  id: string,
  data: Partial<InsertDismissalSession>
): Promise<DismissalSession | undefined> {
  const [row] = await db
    .update(dismissalSessions)
    .set(data)
    .where(eq(dismissalSessions.id, id))
    .returning();
  return row;
}

export async function getNextQueuePosition(sessionId: string): Promise<number> {
  const max = await getMaxQueuePosition(sessionId);
  return max + 1;
}

export async function createQueueEntries(
  data: Array<Omit<InsertDismissalQueueEntry, "schoolId"> & { schoolId?: string }>
): Promise<DismissalQueueEntry[]> {
  if (data.length === 0) return [];
  const normalized: InsertDismissalQueueEntry[] = [];
  for (const entry of data) {
    const schoolId = await getSessionSchoolIdForTenantWrite(entry.sessionId, entry.schoolId);
    const student = await getStudentById(entry.studentId);
    if (!student || student.schoolId !== schoolId || student.status !== "active") {
      throw new Error("Student does not belong to the dismissal session school");
    }
    normalized.push({ ...entry, schoolId });
  }
  return db
    .insert(dismissalQueue)
    .values(normalized)
    .onConflictDoNothing({
      target: [dismissalQueue.sessionId, dismissalQueue.studentId],
    })
    .returning();
}

export async function getWaitingQueueEntries(
  sessionId: string,
  count: number
): Promise<DismissalQueueEntry[]> {
  return db
    .select()
    .from(dismissalQueue)
    .where(
      and(
        eq(dismissalQueue.sessionId, sessionId),
        eq(dismissalQueue.status, "waiting")
      )
    )
    .orderBy(dismissalQueue.position)
    .limit(count);
}

export async function getOrCreateTodaySession(
  schoolId: string,
  dateStr: string
): Promise<DismissalSession> {
  return getOrCreateSession(schoolId, dateStr);
}

// ============================================================================
// ClassPilot - Device operations
// ============================================================================

export async function getDeviceById(
  deviceId: string
): Promise<Device | undefined> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.deviceId, deviceId))
    .limit(1);
  return device;
}

export type ClassPilotTileReadRole =
  | "admin"
  | "school_admin"
  | "teacher"
  | "office_staff"
  | "super_admin";

export type ClassPilotTileScopeOptions = {
  schoolId: string;
  staffId: string;
  role: ClassPilotTileReadRole;
  isSuperAdmin?: boolean;
};

type ClassPilotTileReadOptions = ClassPilotTileScopeOptions & {
  deviceId: string;
};

function hasSchoolWideTileRead(options: ClassPilotTileScopeOptions): boolean {
  return Boolean(
    options.isSuperAdmin ||
      options.role === "super_admin" ||
      options.role === "admin" ||
      options.role === "school_admin"
  );
}

function hasSelectedTileTenantContext(schoolId: string): boolean {
  if (!rlsGucEnabled()) return true;
  const tenant = getTenantStore();
  return Boolean(tenant && (tenant.isSuper || tenant.schoolId === schoolId));
}

export type ClassPilotStudentTileAccess = {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentSessionId: string | null;
};

type ClassPilotTileAuthorizationRow = ClassPilotStudentTileAccess & {
  ordinal: number;
  device: Device;
};

function requestedTileStudentsSql(
  schoolId: string,
  studentIds?: readonly string[]
): SQL {
  if (studentIds) {
    if (studentIds.length === 0) {
      return sql`SELECT NULL::text AS student_id, NULL::bigint AS ordinal WHERE false`;
    }
    return sql`VALUES ${sql.join(
      studentIds.map((studentId, index) => sql`(${studentId}::text, ${index + 1}::bigint)`),
      sql`, `
    )}`;
  }
  return sql`
    SELECT student.id AS student_id,
           row_number() OVER (ORDER BY student.id)::bigint AS ordinal
    FROM ${students} AS student
    WHERE student.school_id = ${schoolId}
  `;
}

/**
 * Builds the complete set-based authorization query used by both legacy
 * device tiles and the student batch endpoints. It is exported so the guarded
 * production plan checker can wrap the exact statement in EXPLAIN without
 * maintaining a second, potentially divergent copy of the authorization SQL.
 * Values remain parameterized by Drizzle; callers must execute it inside the
 * selected school's RLS tenant context.
 */
export function buildClassPilotTileAuthorizationQuery(
  options: ClassPilotTileScopeOptions,
  accessMode: "live" | "history",
  studentIds?: readonly string[]
): SQL {
  const requestedStudents = requestedTileStudentsSql(options.schoolId, studentIds);
  const schoolWide = hasSchoolWideTileRead(options);

  const authorizedStudents = schoolWide
    ? sql`SELECT requested.student_id FROM requested_students AS requested`
    : options.role === "office_staff"
      ? sql`
          SELECT supervision.student_id
          FROM active_supervision AS supervision
          WHERE supervision.assigned_staff_id = ${options.staffId}
        `
      : options.role === "teacher"
        ? sql`
            SELECT supervision.student_id
            FROM active_supervision AS supervision
            WHERE supervision.assigned_staff_id = ${options.staffId}
            UNION
            SELECT roster.student_id
            FROM active_roster_students AS roster
            LEFT JOIN active_supervision AS reassigned
              ON reassigned.student_id = roster.student_id
             AND reassigned.assigned_staff_id <> ${options.staffId}
            WHERE reassigned.student_id IS NULL
          `
        : sql`SELECT NULL::text AS student_id WHERE false`;

  const resolvedStudents = accessMode === "live"
    ? sql`
        SELECT
          authorized.student_id,
          requested.ordinal,
          session.device_id,
          session.id AS student_session_id
        FROM authorized_students AS authorized
        INNER JOIN requested_students AS requested
          ON requested.student_id = authorized.student_id
        INNER JOIN ${studentSessions} AS session
          ON session.student_id = authorized.student_id
         AND session.is_active = true
      `
    : studentIds
      ? sql`
        SELECT
          ranked.student_id,
          ranked.ordinal,
          ranked.device_id,
          NULL::text AS student_session_id
        FROM (
          SELECT
            authorized.student_id,
            requested.ordinal,
            mapping.device_id,
            row_number() OVER (
              PARTITION BY authorized.student_id
              ORDER BY
                (active_session.device_id IS NOT NULL) DESC,
                mapping.last_seen_at DESC,
                device.last_seen_at DESC NULLS LAST,
                mapping.device_id
            ) AS device_rank
          FROM authorized_students AS authorized
          INNER JOIN requested_students AS requested
            ON requested.student_id = authorized.student_id
          INNER JOIN ${studentDevices} AS mapping
            ON mapping.student_id = authorized.student_id
          INNER JOIN ${devices} AS device
            ON device.device_id = mapping.device_id
           AND device.school_id = ${options.schoolId}
          LEFT JOIN ${studentSessions} AS active_session
            ON active_session.student_id = authorized.student_id
           AND active_session.device_id = mapping.device_id
           AND active_session.is_active = true
        ) AS ranked
        WHERE ranked.device_rank = 1
      `
      : sql`
          SELECT
            authorized.student_id,
            requested.ordinal,
            mapping.device_id,
            NULL::text AS student_session_id
          FROM authorized_students AS authorized
          INNER JOIN requested_students AS requested
            ON requested.student_id = authorized.student_id
          INNER JOIN ${studentDevices} AS mapping
            ON mapping.student_id = authorized.student_id
          INNER JOIN ${devices} AS device
            ON device.device_id = mapping.device_id
           AND device.school_id = ${options.schoolId}
        `;

  return sql`
    WITH
    requested_students(student_id, ordinal) AS MATERIALIZED (
      ${requestedStudents}
    ),
    active_supervision AS MATERIALIZED (
      SELECT DISTINCT
        supervised.student_id,
        context.assigned_staff_id
      FROM ${classpilotSupervisionStudents} AS supervised
      INNER JOIN ${classpilotSupervisionContexts} AS context
        ON context.id = supervised.context_id
       AND context.school_id = ${options.schoolId}
       AND context.status = 'active'
       AND context.ends_at > now()
      INNER JOIN requested_students AS requested
        ON requested.student_id = supervised.student_id
      WHERE supervised.school_id = ${options.schoolId}
        AND supervised.released_at IS NULL
    ),
    active_staff_groups AS MATERIALIZED (
      SELECT session.group_id
      FROM ${teachingSessions} AS session
      INNER JOIN ${groups} AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = ${options.schoolId}
      WHERE session.school_id = ${options.schoolId}
        AND session.session_mode = 'live'
        AND session.end_time IS NULL
        AND session.teacher_id = ${options.staffId}
      UNION
      SELECT session.group_id
      FROM ${teachingSessions} AS session
      INNER JOIN ${groups} AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = ${options.schoolId}
      INNER JOIN ${groupTeachers} AS co_teacher
        ON co_teacher.group_id = session.group_id
       AND co_teacher.teacher_id = ${options.staffId}
      WHERE session.school_id = ${options.schoolId}
        AND session.session_mode = 'live'
        AND session.end_time IS NULL
    ),
    active_roster_students AS MATERIALIZED (
      SELECT DISTINCT roster.student_id
      FROM active_staff_groups AS staff_group
      INNER JOIN ${groupStudents} AS roster
        ON roster.group_id = staff_group.group_id
      INNER JOIN requested_students AS requested
        ON requested.student_id = roster.student_id
    ),
    authorized_students AS MATERIALIZED (
      ${authorizedStudents}
    ),
    resolved_students AS MATERIALIZED (
      ${resolvedStudents}
    )
    SELECT
      resolved.student_id,
      resolved.ordinal,
      resolved.student_session_id,
      device.device_id,
      device.device_name,
      device.school_id,
      device.class_id,
      device.extension_version,
      device.chrome_version,
      device.last_screenshot_health,
      device.last_seen_at,
      device.registered_at
    FROM resolved_students AS resolved
    INNER JOIN ${students} AS student
      ON student.id = resolved.student_id
     AND student.school_id = ${options.schoolId}
    INNER JOIN ${devices} AS device
      ON device.device_id = resolved.device_id
     AND device.school_id = ${options.schoolId}
    ORDER BY resolved.ordinal
  `;
}

function tileDeviceFromRow(row: Record<string, unknown>): Device | undefined {
  if (
    typeof row.device_id !== "string" ||
    typeof row.school_id !== "string" ||
    typeof row.class_id !== "string"
  ) {
    return undefined;
  }
  const lastSeenAt = row.last_seen_at == null
    ? null
    : row.last_seen_at instanceof Date
      ? row.last_seen_at
      : new Date(String(row.last_seen_at));
  const registeredAt = row.registered_at instanceof Date
    ? row.registered_at
    : new Date(String(row.registered_at ?? ""));
  if (
    (lastSeenAt && Number.isNaN(lastSeenAt.getTime())) ||
    Number.isNaN(registeredAt.getTime())
  ) {
    return undefined;
  }
  return {
    deviceId: row.device_id,
    deviceName: typeof row.device_name === "string" ? row.device_name : null,
    schoolId: row.school_id,
    classId: row.class_id,
    extensionVersion: typeof row.extension_version === "string" ? row.extension_version : null,
    chromeVersion: typeof row.chrome_version === "string" ? row.chrome_version : null,
    lastScreenshotHealth: row.last_screenshot_health ?? null,
    lastSeenAt,
    registeredAt,
  };
}

async function loadClassPilotTileAuthorizationRows(
  options: ClassPilotTileScopeOptions,
  accessMode: "live" | "history",
  studentIds?: readonly string[]
): Promise<ClassPilotTileAuthorizationRow[]> {
  if (
    studentIds?.length === 0 ||
    !hasSelectedTileTenantContext(options.schoolId)
  ) {
    return [];
  }
  const result = await db.execute(
    buildClassPilotTileAuthorizationQuery(options, accessMode, studentIds)
  );
  const rows: ClassPilotTileAuthorizationRow[] = [];
  for (const raw of result.rows as Record<string, unknown>[]) {
    const device = tileDeviceFromRow(raw);
    if (!device || typeof raw.student_id !== "string") continue;
    rows.push({
      studentId: raw.student_id,
      deviceId: device.deviceId,
      schoolId: device.schoolId,
      studentSessionId:
        typeof raw.student_session_id === "string" ? raw.student_session_id : null,
      ordinal: Number(raw.ordinal),
      device,
    });
  }
  return rows;
}

export async function getBatchTileAccessForStaff(
  options: ClassPilotTileScopeOptions,
  studentIds: readonly string[],
  accessMode: "live" | "history"
): Promise<Map<string, ClassPilotStudentTileAccess>> {
  const rows = await loadClassPilotTileAuthorizationRows(
    options,
    accessMode,
    studentIds
  );
  return new Map(rows.map((row) => [row.studentId, {
    studentId: row.studentId,
    deviceId: row.deviceId,
    schoolId: row.schoolId,
    studentSessionId: row.studentSessionId,
  }]));
}

async function getSchoolWideTileDevice(
  options: ClassPilotTileReadOptions
): Promise<Device | undefined> {
  if (!hasSelectedTileTenantContext(options.schoolId)) return undefined;
  const [device] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.schoolId, options.schoolId),
        eq(devices.deviceId, options.deviceId)
      )
    )
    .limit(1);
  return device;
}

/**
 * Authorizes the current live student on a screenshot tile. This remains one
 * indexed query so aligned classroom polling cannot recreate pool starvation.
 */
export async function getLiveTileReadableDeviceForStaff(
  options: ClassPilotTileReadOptions
): Promise<Device | undefined> {
  const scope = await getTileAuthorizationScopeForStaff(options, "live");
  return scope.get(options.deviceId)?.device;
}

export type ClassPilotHistoryTileAccess = {
  device: Device;
  // School-wide staff retain the legacy per-device detail capability even
  // when the device has no active student session. Batch tile reads do not use
  // this scope and remain student/session-bound.
  schoolWide?: true;
  // null means an administrator may read all school-scoped history on the
  // device. Restricted staff must filter to this explicit student allowlist.
  authorizedStudentIds: string[] | null;
  // Present only for live screenshot authorization. These internal fields bind
  // a device-keyed screenshot to the exact currently represented student
  // session and are never serialized in a teacher response.
  liveStudentId?: string;
  liveStudentSessionId?: string;
};

export type ClassPilotTileAuthorizationScope = Map<
  string,
  ClassPilotHistoryTileAccess
>;

/**
 * Loads one complete, short-lived authorization snapshot for an aligned tile
 * cohort. The caller coalesces this query for at most two seconds; individual
 * tile requests then perform an in-memory device lookup instead of reserving a
 * PostgreSQL connection apiece.
 */
export async function getTileAuthorizationScopeForStaff(
  options: ClassPilotTileScopeOptions,
  accessMode: "live" | "history"
): Promise<ClassPilotTileAuthorizationScope> {
  if (!hasSelectedTileTenantContext(options.schoolId)) return new Map();
  if (hasSchoolWideTileRead(options)) {
    const schoolDevices = await db
      .select()
      .from(devices)
      .where(eq(devices.schoolId, options.schoolId));
    return new Map(
      schoolDevices.map((device) => [
        device.deviceId,
        { device, schoolWide: true as const, authorizedStudentIds: null },
      ])
    );
  }

  const rows = await loadClassPilotTileAuthorizationRows(options, accessMode);
  const scope: ClassPilotTileAuthorizationScope = new Map();
  for (const row of rows) {
    const current = scope.get(row.deviceId);
    if (!current) {
      scope.set(row.deviceId, {
        device: row.device,
        authorizedStudentIds:
          accessMode === "history" ? [row.studentId] : null,
        ...(accessMode === "live" && row.studentSessionId
          ? {
              liveStudentId: row.studentId,
              liveStudentSessionId: row.studentSessionId,
            }
          : {}),
      });
      continue;
    }
    if (
      current.authorizedStudentIds &&
      !current.authorizedStudentIds.includes(row.studentId)
    ) {
      current.authorizedStudentIds.push(row.studentId);
    }
  }
  return scope;
}

/**
 * Authorizes historical device mappings for heartbeat tiles. Unlike live
 * screenshots, offline students still poll history through student_devices.
 */
export async function getHistoryTileAccessForStaff(
  options: ClassPilotTileReadOptions
): Promise<ClassPilotHistoryTileAccess | undefined> {
  if (hasSchoolWideTileRead(options)) {
    const device = await getSchoolWideTileDevice(options);
    return device
      ? { device, schoolWide: true, authorizedStudentIds: null }
      : undefined;
  }

  return (await getTileAuthorizationScopeForStaff(options, "history"))
    .get(options.deviceId);
}

export async function getDevicesBySchool(
  schoolId: string
): Promise<Device[]> {
  return db
    .select()
    .from(devices)
    .where(eq(devices.schoolId, schoolId));
}

export async function createDevice(
  data: InsertDevice
): Promise<Device> {
  const [device] = await db.insert(devices).values(data).returning();
  return device!;
}

export async function updateDevice(
  deviceId: string,
  data: Partial<{ deviceName: string; classId: string }>
): Promise<Device | undefined> {
  const [device] = await db
    .update(devices)
    .set(data)
    .where(eq(devices.deviceId, deviceId))
    .returning();
  return device;
}

export async function deleteDevice(deviceId: string): Promise<boolean> {
  const result = await db
    .delete(devices)
    .where(eq(devices.deviceId, deviceId));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// ClassPilot - Student Device operations
// ============================================================================

export async function getStudentDevices(
  studentId: string
): Promise<StudentDevice[]> {
  return db
    .select()
    .from(studentDevices)
    .where(eq(studentDevices.studentId, studentId));
}

export async function linkStudentDevice(
  data: { studentId: string; deviceId: string }
): Promise<StudentDevice> {
  const [row] = await db
    .insert(studentDevices)
    .values(data)
    .onConflictDoUpdate({
      target: [studentDevices.studentId, studentDevices.deviceId],
      set: { lastSeenAt: new Date() },
    })
    .returning();
  return row!;
}

export async function updateStudentDeviceLastSeen(
  studentId: string,
  deviceId: string
): Promise<void> {
  await db
    .update(studentDevices)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(studentDevices.studentId, studentId),
        eq(studentDevices.deviceId, deviceId)
      )
    );
}

export async function getStudentsForDevice(
  deviceId: string
): Promise<Student[]> {
  const rows = await db
    .select({ student: students })
    .from(studentDevices)
    .innerJoin(students, eq(studentDevices.studentId, students.id))
    .where(
      and(
        eq(studentDevices.deviceId, deviceId),
        eq(students.status, "active")
      )
    );
  return rows.map((r) => r.student);
}

export async function getActiveStudentForDevice(
  deviceId: string
): Promise<{ student: Student; session: StudentSession } | null> {
  const rows = await db
    .select({ student: students, session: studentSessions })
    .from(studentSessions)
    .innerJoin(students, eq(studentSessions.studentId, students.id))
    .where(
      and(
        eq(studentSessions.deviceId, deviceId),
        eq(studentSessions.isActive, true),
        eq(students.status, "active")
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { student: rows[0]!.student, session: rows[0]!.session };
}

export async function setActiveStudentForDevice(
  deviceId: string,
  studentId: string
): Promise<StudentSession> {
  return db.transaction(async (tx) => {
    // Resolve the lifecycle lock key without locking the student first. The
    // active check is repeated under the shared school lock and row lock, so a
    // concurrent roster removal cannot insert a session after deactivation.
    const [candidate] = await tx
      .select({ schoolId: students.schoolId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1);
    if (!candidate) {
      throw Object.assign(new Error("Student is not enrolled"), {
        status: 403,
        code: "STUDENT_INACTIVE",
        expose: true,
      });
    }

    await takePasspilotClassLock(tx, candidate.schoolId);
    const [activeStudent] = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.id, studentId),
          eq(students.schoolId, candidate.schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!activeStudent) {
      throw Object.assign(new Error("Student is not enrolled"), {
        status: 403,
        code: "STUDENT_INACTIVE",
        expose: true,
      });
    }

    const now = new Date();
    await tx
      .update(studentSessions)
      .set({ isActive: false, endedAt: now })
      .where(
        and(
          eq(studentSessions.deviceId, deviceId),
          eq(studentSessions.isActive, true)
        )
      );
    const [session] = await tx
      .insert(studentSessions)
      .values({ studentId, deviceId })
      .returning();
    return session!;
  });
}

// ============================================================================
// ClassPilot - Heartbeat operations
// ============================================================================

export async function createHeartbeat(
  data: InsertHeartbeat
): Promise<Heartbeat> {
  const [hb] = await db.insert(heartbeats).values(data).returning();
  return hb!;
}

export async function createHeartbeatAndRefreshPresence(
  data: InsertHeartbeat & {
    deviceId: string;
    schoolId: string;
    studentId: string;
  },
  studentSessionId: string
): Promise<
  | { outcome: "recorded"; id: string; studentEmail: string; timestamp: Date }
  | { outcome: "replaced_session" }
  | { outcome: "inactive_session" }
> {
  const screenshotHealthJson =
    data.screenshotHealth === undefined || data.screenshotHealth === null
      ? null
      : JSON.stringify(data.screenshotHealth);
  const result = await db.execute(sql`
    WITH represented_session AS MATERIALIZED (
      SELECT
        represented.id,
        represented.student_id,
        represented.is_active,
        student.email AS student_email
      FROM student_sessions AS represented
      INNER JOIN students AS student
        ON student.id = represented.student_id
       AND student.school_id = ${data.schoolId}
       AND student.status = 'active'
      INNER JOIN devices AS session_device
        ON session_device.device_id = represented.device_id
       AND session_device.school_id = ${data.schoolId}
      WHERE represented.id = ${studentSessionId}
        AND represented.student_id = ${data.studentId}
        AND represented.device_id = ${data.deviceId}
      FOR UPDATE OF represented
    ),
    eligible_session AS MATERIALIZED (
      SELECT id, student_email
      FROM represented_session
      WHERE is_active = true
    ),
    inserted_heartbeat AS (
      INSERT INTO heartbeats (
        device_id,
        student_id,
        student_email,
        school_id,
        active_tab_title,
        active_tab_url,
        favicon,
        screen_locked,
        flight_path_active,
        active_flight_path_name,
        is_sharing,
        camera_active,
        extension_version,
        chrome_version,
        screenshot_health
      )
      SELECT
        ${data.deviceId},
        ${data.studentId},
        eligible_session.student_email,
        ${data.schoolId},
        ${data.activeTabTitle},
        ${data.activeTabUrl ?? null},
        ${data.favicon ?? null},
        ${data.screenLocked ?? false},
        ${data.flightPathActive ?? false},
        ${data.activeFlightPathName ?? null},
        ${data.isSharing ?? false},
        ${data.cameraActive ?? false},
        ${data.extensionVersion ?? null},
        ${data.chromeVersion ?? null},
        ${screenshotHealthJson}::jsonb
      FROM eligible_session
      RETURNING id, student_email, timestamp
    ),
    refreshed_device AS (
      UPDATE devices
      SET
        last_seen_at = now(),
        extension_version = CASE
          WHEN ${data.extensionVersion !== undefined}::boolean
            THEN ${data.extensionVersion ?? null}
          ELSE extension_version
        END,
        chrome_version = CASE
          WHEN ${data.chromeVersion !== undefined}::boolean
            THEN ${data.chromeVersion ?? null}
          ELSE chrome_version
        END,
        last_screenshot_health = CASE
          WHEN ${data.screenshotHealth !== undefined}::boolean
            THEN ${screenshotHealthJson}::jsonb
          ELSE last_screenshot_health
        END
      WHERE device_id = ${data.deviceId}
        AND school_id = ${data.schoolId}
        AND EXISTS (SELECT 1 FROM eligible_session)
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
    ),
    refreshed_session AS (
      UPDATE student_sessions
      SET last_seen_at = now()
      WHERE id = ${studentSessionId}
        AND student_id = ${data.studentId}
        AND device_id = ${data.deviceId}
        AND is_active = true
        AND EXISTS (SELECT 1 FROM eligible_session)
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
    )
    SELECT
      'recorded'::text AS outcome,
      id,
      student_email,
      timestamp
    FROM inserted_heartbeat
    UNION ALL
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM student_sessions AS replacement
          WHERE replacement.student_id = ${data.studentId}
            AND replacement.id <> ${studentSessionId}
            AND replacement.is_active = true
        ) THEN 'replaced_session'::text
        ELSE 'inactive_session'::text
      END AS outcome,
      NULL::varchar AS id,
      NULL::text AS student_email,
      NULL::timestamp AS timestamp
    WHERE NOT EXISTS (SELECT 1 FROM inserted_heartbeat)
    LIMIT 1
  `);
  const row = result.rows[0] as {
    outcome?: unknown;
    id?: unknown;
    student_email?: unknown;
    timestamp?: unknown;
  } | undefined;
  if (row?.outcome === "replaced_session") {
    return { outcome: "replaced_session" };
  }
  if (row?.outcome === "inactive_session") {
    return { outcome: "inactive_session" };
  }
  if (row?.outcome !== "recorded") {
    throw new Error("Heartbeat insert returned an invalid outcome");
  }
  const id = row?.id;
  if (typeof id !== "string" || !id) throw new Error("Heartbeat insert returned an invalid id");
  if (row.student_email !== null && typeof row.student_email !== "string") {
    throw new Error("Heartbeat insert returned an invalid student email");
  }
  const timestamp = row.timestamp instanceof Date
    ? row.timestamp
    : new Date(String(row.timestamp ?? ""));
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Heartbeat insert returned an invalid timestamp");
  }
  return {
    outcome: "recorded",
    id,
    // Student email is intentionally nullable for PIN/shared-device sessions.
    // Realtime payloads historically normalize that optional value to "".
    studentEmail: row.student_email || "",
    timestamp,
  };
}

export async function updateHeartbeatClassification(
  heartbeatId: string,
  aiCategory: string,
  safetyAlert: string | null
): Promise<void> {
  await db.update(heartbeats).set({ aiCategory, safetyAlert }).where(eq(heartbeats.id, heartbeatId));
}

export type HeartbeatClassificationUpdate = {
  heartbeatId: string;
  aiCategory: string;
  safetyAlert: string | null;
};

type HeartbeatClassificationExecutor = {
  execute(query: SQLWrapper): Promise<{ rows: unknown[] }>;
};

export async function updateHeartbeatClassifications(
  schoolId: string,
  updates: HeartbeatClassificationUpdate[],
  executor: HeartbeatClassificationExecutor = db as unknown as HeartbeatClassificationExecutor
): Promise<void> {
  if (updates.length === 0) return;
  if (updates.length > 100) {
    throw new RangeError("Heartbeat classification batch cannot exceed 100 rows");
  }
  const deduplicated = [...new Map(
    updates.map((update) => [update.heartbeatId, update])
  ).values()];
  const payload = JSON.stringify(
    deduplicated.map((update) => ({
      heartbeat_id: update.heartbeatId,
      ai_category: update.aiCategory,
      safety_alert: update.safetyAlert,
    }))
  );
  const result = await executor.execute(sql`
    UPDATE heartbeats AS heartbeat
    SET
      ai_category = batch.ai_category,
      safety_alert = batch.safety_alert
    FROM jsonb_to_recordset(${payload}::jsonb) AS batch(
      heartbeat_id text,
      ai_category text,
      safety_alert text
    )
    WHERE heartbeat.id = batch.heartbeat_id
      AND heartbeat.school_id = ${schoolId}
    RETURNING heartbeat.id
  `);
  if (result.rows.length !== deduplicated.length) {
    throw new Error("Heartbeat classification batch did not update every expected row");
  }
}

export async function getHeartbeatsByDevice(
  schoolId: string,
  deviceId: string,
  limit = 10,
  authorizedStudentIds?: string[] | null
): Promise<Heartbeat[]> {
  if (authorizedStudentIds?.length === 0) return [];
  const conditions: SQL[] = [
    eq(heartbeats.schoolId, schoolId),
    eq(heartbeats.deviceId, deviceId),
  ];
  if (authorizedStudentIds) {
    conditions.push(inArray(heartbeats.studentId, authorizedStudentIds));
  }
  return db
    .select()
    .from(heartbeats)
    .where(and(...conditions))
    .orderBy(desc(heartbeats.timestamp))
    .limit(limit);
}

/**
 * Builds the exact cache-miss query shared by the production fallback and its
 * guarded deployment plan check. Each requested student/device pair performs
 * one bounded descending lookup so PostgreSQL can stop after the newest rows
 * in heartbeats_school_device_student_timestamp_idx instead of ranking the
 * retained heartbeat history for the whole cohort.
 */
export function buildHeartbeatTileHistoryBatchQuery(
  schoolId: string,
  accesses: readonly ClassPilotStudentTileAccess[],
  limit: number
): SQL {
  if (accesses.length === 0) {
    throw new Error(
      "Heartbeat tile history query requires at least one authorized access"
    );
  }
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 10);
  const requestedStudentIds = accesses.map((access) => access.studentId);
  const requestedDeviceIds = accesses.map((access) => access.deviceId);

  return sql`
    WITH requested_tiles(student_id, device_id, ordinal) AS MATERIALIZED (
      SELECT input.student_id, input.device_id, input.ordinality::bigint
      FROM unnest(
        ${sql.param(requestedStudentIds)}::text[],
        ${sql.param(requestedDeviceIds)}::text[]
      ) WITH ORDINALITY AS input(student_id, device_id, ordinality)
    )
    SELECT
      requested.student_id AS tile_student_id,
      requested.ordinal,
      heartbeat.*
    FROM requested_tiles AS requested
    CROSS JOIN LATERAL (
      SELECT heartbeat.*
      FROM ${heartbeats} AS heartbeat
      WHERE heartbeat.school_id = ${schoolId}
        AND heartbeat.device_id = requested.device_id
        AND heartbeat.student_id = requested.student_id
      ORDER BY heartbeat.timestamp DESC
      LIMIT ${boundedLimit}
    ) AS heartbeat
    ORDER BY requested.ordinal, heartbeat.timestamp DESC
  `;
}

const HEARTBEAT_TILE_HISTORY_BATCH_SQL_SHAPE_IDENTITY = (() => {
  const query = buildHeartbeatTileHistoryBatchQuery(
    "history-fallback-identity-school",
    [{
      studentId: "history-fallback-identity-student",
      deviceId: "history-fallback-identity-device",
      schoolId: "history-fallback-identity-school",
      studentSessionId: null,
    }],
    10
  );
  const compiled = new PgDialect().sqlToQuery(query);
  assertClasspilotHistoryFallbackPiStatementDiscoverable(compiled.sql);
  return createClasspilotHistoryFallbackSqlShapeIdentity(
    compiled.sql,
    compiled.params
  );
})();

/**
 * Returns the identifier-safe portion of the exact production fallback SQL
 * identity. Runtime summaries expose only these hashes; the database-derived
 * query identifier remains confined to the guarded private receipt.
 */
export function getHeartbeatTileHistoryBatchSqlShapeIdentity():
  ClasspilotHistoryFallbackSqlShapeIdentity {
  return { ...HEARTBEAT_TILE_HISTORY_BATCH_SQL_SHAPE_IDENTITY };
}

/**
 * Loads cache misses for an authorized student cohort in one statement. The
 * exact student/device pairs come from the immediately preceding authorization
 * query; matching both columns prevents history from another student on a
 * shared Chromebook from entering that student's tile.
 */
export async function getHeartbeatTileHistoryBatch(
  schoolId: string,
  accesses: readonly ClassPilotStudentTileAccess[],
  limit: number
): Promise<Map<string, Heartbeat[]>> {
  if (accesses.length === 0) return new Map();
  const result = await db.execute(
    buildHeartbeatTileHistoryBatchQuery(schoolId, accesses, limit)
  );

  const byStudent = new Map<string, Heartbeat[]>();
  for (const raw of result.rows as Record<string, unknown>[]) {
    if (
      typeof raw.tile_student_id !== "string" ||
      typeof raw.id !== "string" ||
      typeof raw.device_id !== "string" ||
      typeof raw.active_tab_title !== "string"
    ) {
      continue;
    }
    const timestamp = raw.timestamp instanceof Date
      ? raw.timestamp
      : new Date(String(raw.timestamp ?? ""));
    if (Number.isNaN(timestamp.getTime())) continue;
    const heartbeat: Heartbeat = {
      id: raw.id,
      deviceId: raw.device_id,
      studentId: typeof raw.student_id === "string" ? raw.student_id : null,
      studentEmail: typeof raw.student_email === "string" ? raw.student_email : null,
      schoolId: typeof raw.school_id === "string" ? raw.school_id : null,
      activeTabTitle: raw.active_tab_title,
      activeTabUrl: typeof raw.active_tab_url === "string" ? raw.active_tab_url : null,
      favicon: typeof raw.favicon === "string" ? raw.favicon : null,
      screenLocked: typeof raw.screen_locked === "boolean" ? raw.screen_locked : null,
      flightPathActive: typeof raw.flight_path_active === "boolean" ? raw.flight_path_active : null,
      activeFlightPathName: typeof raw.active_flight_path_name === "string"
        ? raw.active_flight_path_name
        : null,
      isSharing: typeof raw.is_sharing === "boolean" ? raw.is_sharing : null,
      cameraActive: typeof raw.camera_active === "boolean" ? raw.camera_active : null,
      aiCategory: typeof raw.ai_category === "string" ? raw.ai_category : null,
      safetyAlert: typeof raw.safety_alert === "string" ? raw.safety_alert : null,
      extensionVersion: typeof raw.extension_version === "string" ? raw.extension_version : null,
      chromeVersion: typeof raw.chrome_version === "string" ? raw.chrome_version : null,
      screenshotHealth: raw.screenshot_health ?? null,
      timestamp,
    };
    const current = byStudent.get(raw.tile_student_id) ?? [];
    current.push(heartbeat);
    byStudent.set(raw.tile_student_id, current);
  }
  return byStudent;
}

export async function getHeartbeatsByDeviceInRange(
  schoolId: string,
  deviceId: string,
  startTime: Date,
  endTime: Date,
  authorizedStudentIds?: string[] | null
): Promise<Heartbeat[]> {
  if (authorizedStudentIds?.length === 0) return [];
  const conditions: SQL[] = [
    eq(heartbeats.schoolId, schoolId),
    eq(heartbeats.deviceId, deviceId),
    sql`${heartbeats.timestamp} >= ${startTime}`,
    sql`${heartbeats.timestamp} <= ${endTime}`,
  ];
  if (authorizedStudentIds) {
    conditions.push(inArray(heartbeats.studentId, authorizedStudentIds));
  }
  return db
    .select()
    .from(heartbeats)
    .where(and(...conditions))
    .orderBy(desc(heartbeats.timestamp))
    // A live teaching session hard-caps at 12 hours. At the normal ten-second
    // cadence that is 4,320 rows; keep modest headroom while preventing an
    // ancient startTime from turning one tile read into an unbounded response.
    .limit(5_000);
}

export async function getHeartbeatsByStudent(
  studentId: string,
  limit = 50,
  startDate?: Date,
  endDate?: Date
): Promise<Heartbeat[]> {
  const conditions: any[] = [eq(heartbeats.studentId, studentId)];
  if (startDate) conditions.push(sql`${heartbeats.timestamp} >= ${startDate.toISOString()}`);
  if (endDate) conditions.push(sql`${heartbeats.timestamp} <= ${endDate.toISOString()}`);
  return db
    .select()
    .from(heartbeats)
    .where(and(...conditions))
    .orderBy(desc(heartbeats.timestamp))
    .limit(limit);
}

export async function getHeartbeatsForStudentsInRange(
  schoolId: string,
  studentIds: string[],
  startTime: Date,
  endTime: Date,
  dbInstance: typeof db = db
): Promise<Heartbeat[]> {
  if (studentIds.length === 0) return [];
  return dbInstance
    .select()
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        inArray(heartbeats.studentId, studentIds),
        // `heartbeats.timestamp` is a legacy timestamp-without-time-zone
        // column. Passing a JavaScript Date through node-postgres serializes
        // it in the process-local timezone on Windows, which shifts the
        // requested UTC window. An explicit ISO string keeps the comparison
        // stable across worker hosts while PostgreSQL parses it in UTC.
        sql`${heartbeats.timestamp} >= ${startTime.toISOString()}`,
        // Session windows are half-open so a heartbeat exactly on a bell
        // boundary can only belong to the following class period.
        sql`${heartbeats.timestamp} < ${endTime.toISOString()}`
      )
    )
    .orderBy(heartbeats.studentId, heartbeats.timestamp);
}

// ============================================================================
// ClassPilot - Daily Usage operations
// ============================================================================

export async function upsertDailyUsage(
  data: InsertDailyUsage
): Promise<DailyUsage> {
  const [row] = await db
    .insert(dailyUsage)
    .values(data)
    .onConflictDoUpdate({
      target: [dailyUsage.studentId, dailyUsage.date],
      set: {
        totalSeconds: data.totalSeconds,
        heartbeatCount: data.heartbeatCount,
        topDomains: data.topDomains,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        computedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

export async function getDailyUsageForStudent(
  studentId: string,
  startDate: string,
  endDate: string
): Promise<DailyUsage[]> {
  return db
    .select()
    .from(dailyUsage)
    .where(
      and(
        eq(dailyUsage.studentId, studentId),
        sql`${dailyUsage.date} >= ${startDate}`,
        sql`${dailyUsage.date} <= ${endDate}`
      )
    )
    .orderBy(asc(dailyUsage.date));
}

export async function getDailyUsageForSchool(
  schoolId: string,
  date: string
): Promise<DailyUsage[]> {
  return db
    .select()
    .from(dailyUsage)
    .where(
      and(eq(dailyUsage.schoolId, schoolId), eq(dailyUsage.date, date))
    )
    .orderBy(desc(dailyUsage.totalSeconds));
}

export async function getSchoolUsageSummary(
  schoolId: string,
  startDate: string,
  endDate: string
): Promise<{
  totalSeconds: number;
  activeStudents: number;
  avgSecondsPerStudent: number;
}> {
  const [row] = await db
    .select({
      totalSeconds: sql<number>`COALESCE(SUM(${dailyUsage.totalSeconds}), 0)`,
      activeStudents: sql<number>`COUNT(DISTINCT ${dailyUsage.studentId})`,
      avgSecondsPerStudent: sql<number>`COALESCE(AVG(${dailyUsage.totalSeconds}), 0)`,
    })
    .from(dailyUsage)
    .where(
      and(
        eq(dailyUsage.schoolId, schoolId),
        sql`${dailyUsage.date} >= ${startDate}`,
        sql`${dailyUsage.date} <= ${endDate}`
      )
    );
  return {
    totalSeconds: Number(row?.totalSeconds ?? 0),
    activeStudents: Number(row?.activeStudents ?? 0),
    avgSecondsPerStudent: Number(row?.avgSecondsPerStudent ?? 0),
  };
}

export async function purgeOldHeartbeats(
  schoolId: string,
  cutoffDate: Date
): Promise<number> {
  const result = await db
    .delete(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.timestamp} < ${cutoffDate}`
      )
    )
    .returning({ id: heartbeats.id });
  return result.length;
}

// ============================================================================
// ClassPilot - Event operations
// ============================================================================

export async function createEvent(
  data: InsertEvent
): Promise<EventRecord> {
  const [event] = await db.insert(events).values(data).returning();
  return event!;
}

export async function getEventsByDevice(
  deviceId: string,
  limit = 50
): Promise<EventRecord[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.deviceId, deviceId))
    .orderBy(desc(events.timestamp))
    .limit(limit);
}

// ============================================================================
// ClassPilot - Student Session operations
// ============================================================================

export async function startStudentSession(
  schoolId: string,
  studentId: string,
  deviceId: string
): Promise<StudentSession> {
  return db.transaction(async (tx) => {
    // Student roster removal/restoration and session issuance take this lock in
    // the same order. The row-level active check is therefore authoritative at
    // the point the credential-bearing session is created.
    await takePasspilotClassLock(tx, schoolId);
    const [student] = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.id, studentId),
          eq(students.schoolId, schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!student) {
      throw Object.assign(new Error("Student is not enrolled"), {
        status: 403,
        code: "STUDENT_INACTIVE",
        expose: true,
      });
    }

    const now = new Date();
    await tx
      .update(studentSessions)
      .set({ isActive: false, endedAt: now })
      .where(
        and(
          or(
            eq(studentSessions.studentId, studentId),
            eq(studentSessions.deviceId, deviceId)
          ),
          eq(studentSessions.isActive, true)
        )
      );

    const [session] = await tx
      .insert(studentSessions)
      .values({ studentId, deviceId })
      .returning();
    return session!;
  });
}

export async function endStudentSession(
  sessionId: string
): Promise<StudentSession | undefined> {
  const [session] = await db
    .update(studentSessions)
    .set({ isActive: false, endedAt: new Date() })
    .where(eq(studentSessions.id, sessionId))
    .returning();
  return session;
}

export async function touchStudentSession(
  studentId: string,
  deviceId: string
): Promise<void> {
  await db
    .update(studentSessions)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(studentSessions.studentId, studentId),
        eq(studentSessions.deviceId, deviceId),
        eq(studentSessions.isActive, true)
      )
    );
}

export async function getActiveSessionByStudent(
  studentId: string
): Promise<StudentSession | undefined> {
  const [row] = await db
    .select({ session: studentSessions })
    .from(studentSessions)
    .innerJoin(students, eq(students.id, studentSessions.studentId))
    .where(
      and(
        eq(studentSessions.studentId, studentId),
        eq(studentSessions.isActive, true),
        eq(students.status, "active")
      )
    )
    .limit(1);
  return row?.session;
}

export async function getActiveSessionsForStudents(
  schoolId: string,
  studentIds: string[],
  dbInstance: typeof db = db
): Promise<StudentSession[]> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))];
  if (uniqueStudentIds.length === 0) return [];

  const rows = await dbInstance
    .select({ session: studentSessions })
    .from(studentSessions)
    .innerJoin(students, eq(students.id, studentSessions.studentId))
    .innerJoin(devices, eq(devices.deviceId, studentSessions.deviceId))
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        eq(devices.schoolId, schoolId),
        inArray(studentSessions.studentId, uniqueStudentIds),
        eq(studentSessions.isActive, true)
      )
    );
  return rows.map((row) => row.session);
}

export async function getActiveSessionByDevice(
  deviceId: string
): Promise<StudentSession | undefined> {
  const [session] = await db
    .select()
    .from(studentSessions)
    .where(
      and(
        eq(studentSessions.deviceId, deviceId),
        eq(studentSessions.isActive, true)
      )
    )
    .limit(1);
  return session;
}

export async function getActiveSessionById(
  sessionId: string
): Promise<StudentSession | undefined> {
  const [session] = await db
    .select()
    .from(studentSessions)
    .where(
      and(
        eq(studentSessions.id, sessionId),
        eq(studentSessions.isActive, true)
      )
    )
    .limit(1);
  return session;
}

export async function getActiveSessions(
  schoolId: string
): Promise<(StudentSession & { student: Student })[]> {
  const rows = await db
    .select({
      session: studentSessions,
      student: students,
    })
    .from(studentSessions)
    .innerJoin(students, eq(studentSessions.studentId, students.id))
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        eq(studentSessions.isActive, true)
      )
    );
  return rows.map((r) => ({ ...r.session, student: r.student }));
}

// ============================================================================
// ClassPilot - Teaching Session operations
// ============================================================================

function isUndefinedTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

export type ClasspilotSessionRosterSyncSummary = {
  rosterCount: number;
  alreadyInSession: number;
  addedToSession: number;
};

export async function resyncClasspilotSessionStudents(
  session: TeachingSession,
  dbInstance: typeof db = db,
  options: { strict?: boolean } = {}
): Promise<ClasspilotSessionRosterSyncSummary> {
  try {
    const [group] = await dbInstance
      .select({
        id: groups.id,
        schoolId: groups.schoolId,
        groupType: groups.groupType,
        status: groups.status,
      })
      .from(groups)
      .where(eq(groups.id, session.groupId))
      .limit(1);

    if (!group || group.status !== "active") {
      return { rosterCount: 0, alreadyInSession: 0, addedToSession: 0 };
    }

    const roster = await dbInstance
      .select({
        studentId: groupStudents.studentId,
        firstName: students.firstName,
        lastName: students.lastName,
        email: students.email,
      })
      .from(groupStudents)
      .innerJoin(
        students,
        and(
          eq(students.id, groupStudents.studentId),
          eq(students.schoolId, group.schoolId),
          eq(students.status, "active")
        )
      )
      .where(eq(groupStudents.groupId, session.groupId));

    if (roster.length === 0) {
      return { rosterCount: 0, alreadyInSession: 0, addedToSession: 0 };
    }

    const existing = await getClasspilotSessionStudents(session.id, dbInstance);
    const existingIds = new Set(existing.map((row) => row.studentId));
    const missing = roster.filter((row) => !existingIds.has(row.studentId));

    if (missing.length === 0) {
      return {
        rosterCount: roster.length,
        alreadyInSession: roster.length,
        addedToSession: 0,
      };
    }

    const inserted = await dbInstance
      .insert(classpilotSessionStudents)
      .values(
        missing.map((row) => ({
          schoolId: group.schoolId,
          teachingSessionId: session.id,
          groupId: session.groupId,
          studentId: row.studentId,
          studentNameSnapshot:
            [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
            || row.email
            || "Unknown student",
        }))
      )
      .onConflictDoNothing()
      .returning({ studentId: classpilotSessionStudents.studentId });

    return {
      rosterCount: roster.length,
      alreadyInSession: roster.length - inserted.length,
      addedToSession: inserted.length,
    };
  } catch (err) {
    if (isUndefinedTableError(err) && !options.strict) {
      return { rosterCount: 0, alreadyInSession: 0, addedToSession: 0 };
    }
    throw err;
  }
}

export type ClasspilotActiveSessionRosterResyncResult = {
  session: TeachingSession;
  summary: ClasspilotSessionRosterSyncSummary;
};

async function lockClasspilotTeachingSessionLifecycle(
  teachingSessionId: string,
  dbInstance: typeof db
): Promise<void> {
  const lockKey = `classpilot:teaching-session-lifecycle:${teachingSessionId}`;
  await dbInstance.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`
  );
}

/**
 * Reconcile a live class roster as one ownership transition. The candidate
 * roster is captured before taking the per-student authority locks, then the
 * teaching-session row is locked and revalidated before any snapshot rows are
 * inserted. This shares finalization's lock order, so an End Class race either
 * completes before this transaction (and no rows are added) or observes and
 * clears the complete reconciled roster.
 */
export async function resyncActiveClasspilotSessionStudents(
  options: { schoolId: string; teachingSessionId: string; resyncedAt?: Date },
  dbInstance: typeof db = db
): Promise<ClasspilotActiveSessionRosterResyncResult | undefined> {
  const resyncedAt = options.resyncedAt || new Date();
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    // Finalization takes the same lifecycle lock before discovering its frozen
    // roster. That prevents either side from acquiring a different subset of
    // student locks while a mid-class resync is adding snapshot rows.
    await lockClasspilotTeachingSessionLifecycle(options.teachingSessionId, transactionDb);
    const [candidate] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.teachingSessionId),
        eq(teachingSessions.schoolId, options.schoolId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNull(teachingSessions.endTime)
      ))
      .limit(1);
    if (!candidate) return undefined;

    const [group] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(
        eq(groups.id, candidate.groupId),
        eq(groups.schoolId, options.schoolId),
        eq(groups.status, "active")
      ))
      .limit(1);
    if (!group) return undefined;

    // Freeze exactly this accepted resync candidate. A concurrent roster edit
    // is intentionally picked up by the next explicit resync rather than being
    // inserted without first participating in the authority-lock set.
    const roster = await tx
      .select({
        studentId: groupStudents.studentId,
        firstName: students.firstName,
        lastName: students.lastName,
        email: students.email,
      })
      .from(groupStudents)
      .innerJoin(students, and(
        eq(students.id, groupStudents.studentId),
        eq(students.schoolId, options.schoolId),
        eq(students.status, "active")
      ))
      .where(eq(groupStudents.groupId, candidate.groupId));
    const existing = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, options.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, candidate.id)
      ));
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      [...existing.map((row) => row.studentId), ...roster.map((row) => row.studentId)],
      transactionDb
    );

    const [locked] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.teachingSessionId),
        eq(teachingSessions.schoolId, options.schoolId),
        eq(teachingSessions.groupId, candidate.groupId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNull(teachingSessions.endTime)
      ))
      .limit(1)
      .for("update");
    if (!locked) return undefined;

    const existingIds = new Set(existing.map((row) => row.studentId));
    const missing = roster.filter((row) => !existingIds.has(row.studentId));
    const inserted = missing.length > 0
      ? await tx
          .insert(classpilotSessionStudents)
          .values(missing.map((row) => ({
            schoolId: options.schoolId,
            teachingSessionId: locked.id,
            groupId: locked.groupId,
            studentId: row.studentId,
            studentNameSnapshot:
              [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
              || row.email
              || "Unknown student",
            capturedAt: resyncedAt,
          })))
          .onConflictDoNothing()
          .returning({ studentId: classpilotSessionStudents.studentId })
      : [];

    // Make the frozen roster visible to authority resolution before composing
    // its desired snapshots. This is also the ordering required when repairing
    // a pre-rollout live session with a missing completion marker.
    const [updatedSession] = await tx
      .update(teachingSessions)
      .set({
        controlUpdatedAt: resyncedAt,
        rosterSnapshotCompletedAt: locked.rosterSnapshotCompletedAt || resyncedAt,
      })
      .where(and(
        eq(teachingSessions.id, locked.id),
        eq(teachingSessions.schoolId, options.schoolId),
        isNull(teachingSessions.endTime)
      ))
      .returning();
    if (!updatedSession) return undefined;
    const frozenStudentIds = [...new Set([
      ...existing.map((row) => row.studentId),
      ...roster.map((row) => row.studentId),
    ])];
    const hardExpiresAt = new Date(updatedSession.startTime.getTime() + 12 * 60 * 60 * 1000);
    if (hardExpiresAt > resyncedAt && frozenStudentIds.length > 0) {
      await replaceClasspilotStudentControlSnapshots({
        schoolId: options.schoolId,
        teachingSessionId: updatedSession.id,
        studentIds: frozenStudentIds,
        desiredState: (
          _studentId: string,
          currentState: ClasspilotStudentControlState | null,
          activeClassroomStates: ClasspilotClassroomState[]
        ) =>
          currentState?.teachingSessionId === updatedSession.id
            ? currentState.desiredState
            : { restrictions: restrictionsFromClassroomStates(activeClassroomStates, resyncedAt) },
        scheduledEndAt: effectiveClasspilotScheduledControlEndAt(
          updatedSession.scheduledEndAt,
          hardExpiresAt
        ),
        hardExpiresAt,
        now: resyncedAt,
        authorityMode: "filter",
      }, transactionDb);
    }

    return {
      session: updatedSession,
      summary: {
        rosterCount: roster.length,
        alreadyInSession: roster.length - inserted.length,
        addedToSession: inserted.length,
      },
    };
  });
}

export async function snapshotClasspilotSessionStaff(
  session: TeachingSession,
  dbInstance: typeof db = db
): Promise<number> {
  if (!session.schoolId) return 0;
  const [existingSnapshot] = await dbInstance
    .select({ id: classpilotSessionStaff.id })
    .from(classpilotSessionStaff)
    .where(and(
      eq(classpilotSessionStaff.schoolId, session.schoolId),
      eq(classpilotSessionStaff.teachingSessionId, session.id)
    ))
    .limit(1);
  // Once captured, membership is an immutable authorization boundary. This
  // also prevents a later group-roster edit from granting access to history.
  if (existingSnapshot) return 0;
  const assigned = await dbInstance
    .select({ staffId: groupTeachers.teacherId, role: groupTeachers.role })
    .from(groupTeachers)
    .where(eq(groupTeachers.groupId, session.groupId));
  const roles = new Map<string, "primary" | "co_teacher">();
  roles.set(session.teacherId, "primary");
  for (const row of assigned) {
    if (!roles.has(row.staffId)) {
      roles.set(row.staffId, row.role === "primary" ? "primary" : "co_teacher");
    }
  }
  const staffIds = Array.from(roles.keys());
  if (staffIds.length === 0) return 0;
  const staff = await dbInstance
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
    })
    .from(users)
    .where(inArray(users.id, staffIds));
  const byId = new Map(staff.map((user) => [user.id, user]));
  const inserted = await dbInstance
    .insert(classpilotSessionStaff)
    .values(staffIds.map((staffId) => {
      const user = byId.get(staffId);
      return {
        schoolId: session.schoolId!,
        teachingSessionId: session.id,
        staffId,
        role: roles.get(staffId)!,
        staffNameSnapshot:
          user?.displayName
          || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim()
          || user?.email
          || null,
        staffEmailSnapshot: user?.email || null,
      };
    }))
    .onConflictDoNothing()
    .returning({ id: classpilotSessionStaff.id });
  return inserted.length;
}

/**
 * Rollout bridge for sessions opened before immutable roster snapshots existed
 * (including teacher-created groups that the legacy helper skipped). Only open
 * rows with no snapshot are touched; ended history is never backfilled.
 */
export async function backfillOpenTeachingSessionRosterSnapshots(
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<number> {
  const conditions: SQL[] = [
    isNull(teachingSessions.endTime),
    or(
      isNull(teachingSessions.rosterSnapshotCompletedAt),
      isNull(teachingSessions.classNameSnapshot),
      isNull(teachingSessions.timezoneSnapshot)
    )!,
  ];
  if (schoolId) conditions.push(eq(teachingSessions.schoolId, schoolId));
  const openWithoutSnapshot = await dbInstance
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .where(and(...conditions));

  let backfilled = 0;
  for (const { session } of openWithoutSnapshot) {
    await dbInstance.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof db;
      await lockClasspilotTeachingSessionLifecycle(session.id, transactionDb);
      const [candidate] = await tx
        .select()
        .from(teachingSessions)
        .where(and(
          eq(teachingSessions.id, session.id),
          isNull(teachingSessions.endTime),
          or(
            isNull(teachingSessions.rosterSnapshotCompletedAt),
            isNull(teachingSessions.classNameSnapshot),
            isNull(teachingSessions.timezoneSnapshot)
          )
        ))
        .limit(1);
      if (!candidate) return;

      // Keep the global control-authority lock order consistent: student
      // advisory locks must be acquired before the teaching-session row lock.
      // Legacy roster repair is additive and is revalidated after both locks.
      if (!candidate.rosterSnapshotCompletedAt) {
        await resyncClasspilotSessionStudents(candidate, transactionDb, { strict: true });
      }
      const frozenRoster = await tx
        .select({ studentId: classpilotSessionStudents.studentId })
        .from(classpilotSessionStudents)
        .where(and(
          eq(classpilotSessionStudents.schoolId, candidate.schoolId!),
          eq(classpilotSessionStudents.teachingSessionId, candidate.id)
        ));
      await lockClasspilotStudentControlAuthorities(
        candidate.schoolId!,
        frozenRoster.map((row) => row.studentId),
        transactionDb
      );
      const [locked] = await tx
        .select()
        .from(teachingSessions)
        .where(and(
          eq(teachingSessions.id, candidate.id),
          isNull(teachingSessions.endTime),
          or(
            isNull(teachingSessions.rosterSnapshotCompletedAt),
            isNull(teachingSessions.classNameSnapshot),
            isNull(teachingSessions.timezoneSnapshot)
          )
        ))
        .limit(1)
        .for("update");
      if (!locked) return;
      const [group] = await tx
        .select({ name: groups.name, timezone: schools.schoolTimezone })
        .from(groups)
        .innerJoin(schools, eq(schools.id, groups.schoolId))
        .where(and(eq(groups.id, locked.groupId), eq(groups.schoolId, locked.schoolId!)))
        .limit(1);
      if (!group) throw new Error(`Open teaching session ${locked.id} has no parent group`);
      await tx.execute(sql`
        UPDATE classpilot_session_students AS snapshot
        SET student_name_snapshot = COALESCE(
          NULLIF(btrim(concat_ws(' ', student.first_name, student.last_name)), ''),
          student.email,
          'Unknown student'
        )
        FROM students AS student
        WHERE snapshot.teaching_session_id = ${locked.id}
          AND snapshot.school_id = ${locked.schoolId!}
          AND snapshot.student_id = student.id
          AND student.school_id = ${locked.schoolId!}
          AND snapshot.student_name_snapshot IS NULL
      `);
      await snapshotClasspilotSessionStaff(locked, transactionDb);
      const [snapshotted] = await tx
        .update(teachingSessions)
        .set({
          rosterSnapshotCompletedAt: locked.rosterSnapshotCompletedAt || new Date(),
          classNameSnapshot: locked.classNameSnapshot || group.name,
          timezoneSnapshot: locked.timezoneSnapshot || group.timezone || "America/New_York",
        })
        .where(eq(teachingSessions.id, locked.id))
        .returning();
      await initializeClasspilotStudentControlStatesForSession(snapshotted || locked, transactionDb);
      backfilled += 1;
    });
  }
  return backfilled;
}

export async function getClasspilotSessionStudents(
  teachingSessionId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSessionStudent[]> {
  return dbInstance
    .select()
    .from(classpilotSessionStudents)
    .where(eq(classpilotSessionStudents.teachingSessionId, teachingSessionId))
    .orderBy(classpilotSessionStudents.studentId);
}

/**
 * Return the active operational roster frozen onto a teaching session.
 * Snapshot rows remain retained for reports, but inactive students cannot be
 * shown or targeted in a still-open classroom workflow.
 */
export async function getClasspilotSessionStudentRoster(
  schoolId: string,
  teachingSessionId: string,
  dbInstance: typeof db = db
): Promise<Array<{ studentId: string; studentNameSnapshot: string | null; student: Student | null }>> {
  return dbInstance
    .select({
      studentId: classpilotSessionStudents.studentId,
      studentNameSnapshot: classpilotSessionStudents.studentNameSnapshot,
      student: students,
    })
    .from(classpilotSessionStudents)
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotSessionStudents.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(and(
      eq(classpilotSessionStudents.schoolId, schoolId),
      eq(classpilotSessionStudents.teachingSessionId, teachingSessionId)
    ))
    .orderBy(classpilotSessionStudents.studentId);
}

export async function aggregateClasspilotSessionUsage(
  teachingSessionId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSessionUsage[]> {
  try {
    const [sessionRow] = await dbInstance
      .select({
        session: teachingSessions,
        startTimeText: sql<string>`${teachingSessions.startTime}::text`,
        endTimeText: sql<string>`${teachingSessions.endTime}::text`,
        schoolId: groups.schoolId,
        groupId: groups.id,
        groupType: groups.groupType,
        groupStatus: groups.status,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(teachingSessions)
      .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
      .innerJoin(schools, eq(groups.schoolId, schools.id))
      .where(eq(teachingSessions.id, teachingSessionId))
      .limit(1);

    if (
      !sessionRow?.session.endTime ||
      !sessionRow.endTimeText ||
      sessionRow.groupType !== "admin_class" ||
      sessionRow.groupStatus !== "active"
    ) {
      return [];
    }

    const roster = await getClasspilotSessionStudents(teachingSessionId, dbInstance);
    if (roster.length === 0) return [];

    const heartbeatRows = await dbInstance
      .select({
        studentId: heartbeats.studentId,
        activeTabUrl: heartbeats.activeTabUrl,
        timestampText: sql<string>`${heartbeats.timestamp}::text`,
      })
      .from(heartbeats)
      .where(
        and(
          eq(heartbeats.schoolId, sessionRow.schoolId),
          inArray(heartbeats.studentId, roster.map((row) => row.studentId)),
          sql`${heartbeats.timestamp} >= ${sessionRow.startTimeText}`,
          sql`${heartbeats.timestamp} < ${sessionRow.endTimeText}`
        )
      )
      .orderBy(heartbeats.studentId, heartbeats.timestamp);

    type UsageBucket = {
      heartbeatCount: number;
      firstSeen: Date | null;
      lastSeen: Date | null;
      domains: Map<string, { seconds: number; visits: number }>;
    };
    const buckets = new Map<string, UsageBucket>();
    const timezone = sessionRow.schoolTimezone || "America/New_York";
    const formatLocalDate = createLocalDateFormatter(timezone);

    for (const hb of heartbeatRows) {
      if (!hb.studentId) continue;
      const heartbeatInstant = new Date(`${hb.timestampText.replace(" ", "T")}Z`);
      const localDate = formatLocalDate(heartbeatInstant);
      const key = `${hb.studentId}|${localDate}`;
      const existing = buckets.get(key) || {
        heartbeatCount: 0,
        firstSeen: null,
        lastSeen: null,
        domains: new Map<string, { seconds: number; visits: number }>(),
      };
      const timestamp = heartbeatInstant;
      existing.heartbeatCount += 1;
      if (!existing.firstSeen || timestamp < existing.firstSeen) existing.firstSeen = timestamp;
      if (!existing.lastSeen || timestamp > existing.lastSeen) existing.lastSeen = timestamp;
      if (hb.activeTabUrl) {
        try {
          const domain = new URL(hb.activeTabUrl).hostname.replace(/^www\./, "");
          const domainBucket = existing.domains.get(domain) || { seconds: 0, visits: 0 };
          domainBucket.seconds += 10;
          domainBucket.visits += 1;
          existing.domains.set(domain, domainBucket);
        } catch {
          /* skip invalid URLs */
        }
      }
      buckets.set(key, existing);
    }

    const upserted: ClasspilotSessionUsage[] = [];
    for (const [key, bucket] of buckets) {
      const [studentId, localDate] = key.split("|");
      if (!studentId || !localDate) continue;
      const topDomains = Array.from(bucket.domains.entries())
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .slice(0, 5)
        .map(([domain, value]) => ({ domain, seconds: value.seconds, visits: value.visits }));

      const [usage] = await dbInstance
        .insert(classpilotSessionUsage)
        .values({
          schoolId: sessionRow.schoolId,
          teachingSessionId,
          groupId: sessionRow.groupId,
          studentId,
          localDate,
          totalSeconds: bucket.heartbeatCount * 10,
          heartbeatCount: bucket.heartbeatCount,
          topDomains,
          firstSeen: bucket.firstSeen,
          lastSeen: bucket.lastSeen,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            classpilotSessionUsage.teachingSessionId,
            classpilotSessionUsage.studentId,
            classpilotSessionUsage.localDate,
          ],
          set: {
            totalSeconds: bucket.heartbeatCount * 10,
            heartbeatCount: bucket.heartbeatCount,
            topDomains,
            firstSeen: bucket.firstSeen,
            lastSeen: bucket.lastSeen,
            computedAt: new Date(),
          },
        })
        .returning();
      if (usage) upserted.push(usage);
    }

    return upserted;
  } catch (err) {
    if (isUndefinedTableError(err)) return [];
    throw err;
  }
}

export async function createTeachingSession(
  data: InsertTeachingSession & { groupId: string; teacherId: string },
  dbInstance: typeof db = db
): Promise<TeachingSession> {
  // teaching_sessions.school_id must mirror the parent group's school (RLS
  // WITH CHECK requires it). Derive it from the group rather than trusting the
  // caller, so it can never be omitted or mismatched. Under a request GUC the
  // group lookup only resolves the caller's own school; the scheduler passes
  // schedulerDb (is_super) so it resolves across schools.
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const [group] = await tx
      .select({
        schoolId: groups.schoolId,
        name: groups.name,
        timezone: schools.schoolTimezone,
      })
      .from(groups)
      .innerJoin(schools, eq(schools.id, groups.schoolId))
      .where(eq(groups.id, data.groupId))
      .limit(1)
      .for("share");
    if (!group) {
      throw new Error(`createTeachingSession: group ${data.groupId} not found`);
    }
    const [session] = await tx
      .insert(teachingSessions)
      .values({
        ...data,
        schoolId: group.schoolId,
        classNameSnapshot: data.classNameSnapshot || group.name,
        timezoneSnapshot: data.timezoneSnapshot || group.timezone || "America/New_York",
      })
      .returning();
    if (!session) throw new Error("createTeachingSession: insert did not return a session");
    await resyncClasspilotSessionStudents(session, transactionDb, { strict: true });
    await snapshotClasspilotSessionStaff(session, transactionDb);
    const [snapshotted] = await tx
      .update(teachingSessions)
      .set({ rosterSnapshotCompletedAt: new Date() })
      .where(eq(teachingSessions.id, session.id))
      .returning();
    const authoritativeSession = snapshotted || session;
    await initializeClasspilotStudentControlStatesForSession(authoritativeSession, transactionDb);
    return authoritativeSession;
  });
}

export async function getActiveScheduledReportSessionForConflict(
  schoolId: string,
  scheduledConflictId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [row] = await dbInstance
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(and(
      eq(groups.schoolId, schoolId),
      eq(teachingSessions.scheduledConflictId, scheduledConflictId),
      eq(teachingSessions.sessionMode, SCHEDULED_REPORT_SESSION_MODE),
      isNull(teachingSessions.endTime)
    ))
    .limit(1);
  return row?.session;
}

export async function getScheduledTeachingSessionOccurrence(
  schoolId: string,
  groupId: string,
  scheduledDate: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [session] = await dbInstance
    .select()
    .from(teachingSessions)
    .where(and(
      eq(teachingSessions.schoolId, schoolId),
      eq(teachingSessions.groupId, groupId),
      eq(teachingSessions.scheduledDate, scheduledDate)
    ))
    .limit(1);
  return session;
}

export async function createOrReuseScheduledReportSession(
  data: {
    schoolId: string;
    groupId: string;
    teacherId: string;
    scheduledDate: string;
    scheduledTimezone: string;
    scheduledStartAt: Date;
    scheduledEndAt: Date;
    scheduledTeacherEmail?: string | null;
    scheduledTeacherName?: string | null;
    scheduledConflictId?: string | null;
  },
  dbInstance: typeof db = db
): Promise<TeachingSession> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const [groupSnapshot] = await tx
      .select({ name: groups.name })
      .from(groups)
      .where(and(eq(groups.id, data.groupId), eq(groups.schoolId, data.schoolId)))
      .limit(1)
      // Canonical creation and Skip Today use the same group-row lock. Besides
      // keeping hard deletion out, the exclusive lock makes the occurrence
      // tombstone and canonical creation linearizable.
      .for("update");
    if (!groupSnapshot) throw new Error(`Scheduled occurrence group ${data.groupId} was not found`);
    const existing = await getScheduledTeachingSessionOccurrence(
      data.schoolId,
      data.groupId,
      data.scheduledDate,
      transactionDb
    );
    if (existing) {
      if (!existing.endTime) {
        await initializeClasspilotStudentControlStatesForSession(existing, transactionDb);
      }
      if (data.scheduledConflictId && !existing.scheduledConflictId && !existing.endTime) {
        const [updated] = await tx
          .update(teachingSessions)
          .set({ scheduledConflictId: data.scheduledConflictId })
          .where(and(
            eq(teachingSessions.id, existing.id),
            isNull(teachingSessions.scheduledConflictId),
            isNull(teachingSessions.endTime)
          ))
          .returning();
        return updated || existing;
      }
      return existing;
    }

    const [created] = await tx
      .insert(teachingSessions)
      .values({
        schoolId: data.schoolId,
        groupId: data.groupId,
        teacherId: data.teacherId,
        startTime: data.scheduledStartAt,
        sessionMode: SCHEDULED_REPORT_SESSION_MODE,
        scheduledConflictId: data.scheduledConflictId || null,
        scheduledDate: data.scheduledDate,
        scheduledTimezone: data.scheduledTimezone,
        scheduledStartAt: data.scheduledStartAt,
        scheduledEndAt: data.scheduledEndAt,
        scheduledState: "active",
        scheduledTeacherEmail: data.scheduledTeacherEmail || null,
        scheduledTeacherName: data.scheduledTeacherName || null,
        classNameSnapshot: groupSnapshot.name,
        timezoneSnapshot: data.scheduledTimezone,
      })
      // The partial occurrence unique index is the concurrency authority. A
      // second scheduler/API racer simply reads the winner below.
      .onConflictDoNothing()
      .returning();
    if (created) {
      // The occurrence and immutable roster snapshot commit atomically; a
      // worker crash can never strand a canonical row with an empty snapshot.
      await resyncClasspilotSessionStudents(created, transactionDb, { strict: true });
      await snapshotClasspilotSessionStaff(created, transactionDb);
      const [snapshotted] = await tx
        .update(teachingSessions)
        .set({ rosterSnapshotCompletedAt: new Date() })
        .where(eq(teachingSessions.id, created.id))
        .returning();
      const authoritativeSession = snapshotted || created;
      await initializeClasspilotStudentControlStatesForSession(authoritativeSession, transactionDb);
      return authoritativeSession;
    }

    const raced = await getScheduledTeachingSessionOccurrence(
      data.schoolId,
      data.groupId,
      data.scheduledDate,
      transactionDb
    );
    if (!raced) throw new Error("Scheduled occurrence conflict did not produce a session row");
    return raced;
  });
}

export async function skipScheduledTeachingSessionOccurrence(
  data: {
    schoolId: string;
    groupId: string;
    teacherId: string;
    scheduledDate: string;
    scheduledTimezone: string;
    scheduledStartAt: Date;
    scheduledEndAt: Date;
    scheduledTeacherEmail?: string | null;
    scheduledTeacherName?: string | null;
    now?: Date;
  },
  dbInstance: typeof db = db
): Promise<{ skipped: boolean; session?: TeachingSession }> {
  const now = data.now || new Date();
  return dbInstance.transaction(async (tx) => {
    const [groupSnapshot] = await tx
      .select({ name: groups.name })
      .from(groups)
      .where(and(eq(groups.id, data.groupId), eq(groups.schoolId, data.schoolId)))
      .limit(1)
      .for("update");
    if (!groupSnapshot) throw new Error(`Scheduled occurrence group ${data.groupId} was not found`);
    const existing = await getScheduledTeachingSessionOccurrence(
      data.schoolId,
      data.groupId,
      data.scheduledDate,
      tx as unknown as typeof db
    );
    if (existing) return { skipped: existing.scheduledState === "skipped", session: existing };
    if (now >= data.scheduledStartAt) return { skipped: false };

    const [skipped] = await tx
      .insert(teachingSessions)
      .values({
        schoolId: data.schoolId,
        groupId: data.groupId,
        teacherId: data.teacherId,
        startTime: data.scheduledStartAt,
        endTime: data.scheduledStartAt,
        sessionMode: SCHEDULED_REPORT_SESSION_MODE,
        scheduledDate: data.scheduledDate,
        scheduledTimezone: data.scheduledTimezone,
        scheduledStartAt: data.scheduledStartAt,
        scheduledEndAt: data.scheduledEndAt,
        scheduledState: "skipped",
        scheduledFinalizationReason: "scheduled_skipped",
        scheduledTeacherEmail: data.scheduledTeacherEmail || null,
        scheduledTeacherName: data.scheduledTeacherName || null,
        classNameSnapshot: groupSnapshot.name,
        timezoneSnapshot: data.scheduledTimezone,
      })
      .onConflictDoNothing()
      .returning();
    if (!skipped) {
      const raced = await getScheduledTeachingSessionOccurrence(
        data.schoolId,
        data.groupId,
        data.scheduledDate,
        tx as unknown as typeof db
      );
      return { skipped: raced?.scheduledState === "skipped", session: raced };
    }
    await tx
      .update(groups)
      .set({ scheduleSkippedDate: data.scheduledDate })
      .where(and(eq(groups.id, data.groupId), eq(groups.schoolId, data.schoolId)));
    return { skipped: true, session: skipped };
  });
}

export async function promoteScheduledReportSessionToLive(
  data: {
    schoolId: string;
    sessionId?: string;
    scheduledConflictId?: string;
  },
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const identity = data.sessionId
    ? eq(teachingSessions.id, data.sessionId)
    : data.scheduledConflictId
      ? eq(teachingSessions.scheduledConflictId, data.scheduledConflictId)
      : sql`false`;
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const [current] = await tx.select().from(teachingSessions).where(and(
      identity,
      eq(teachingSessions.schoolId, data.schoolId),
      eq(teachingSessions.sessionMode, SCHEDULED_REPORT_SESSION_MODE),
      eq(teachingSessions.scheduledState, "active"),
      isNull(teachingSessions.endTime)
    )).limit(1);
    if (!current) return undefined;
    const roster = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, data.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, current.id)
      ));
    await lockClasspilotStudentControlAuthorities(
      data.schoolId,
      roster.map((row) => row.studentId),
      transactionDb
    );
    const [session] = await tx
      .update(teachingSessions)
      .set({ sessionMode: LIVE_TEACHING_SESSION_MODE, controlUpdatedAt: new Date() })
      .where(and(
        eq(teachingSessions.id, current.id),
        eq(teachingSessions.schoolId, data.schoolId),
        eq(teachingSessions.sessionMode, SCHEDULED_REPORT_SESSION_MODE),
        eq(teachingSessions.scheduledState, "active"),
        isNull(teachingSessions.endTime)
      ))
      .returning();
    if (session) await initializeClasspilotStudentControlStatesForSession(session, transactionDb);
    return session;
  });
}

export async function updateTeachingSessionControlTimestamp(
  sessionId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const [current] = await tx
      .select()
      .from(teachingSessions)
      .where(and(eq(teachingSessions.id, sessionId), isNull(teachingSessions.endTime)))
      .limit(1);
    if (!current?.schoolId) return undefined;
    const roster = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, current.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, sessionId)
      ));
    await lockClasspilotStudentControlAuthorities(
      current.schoolId,
      roster.map((row) => row.studentId),
      transactionDb
    );
    const [session] = await tx
      .update(teachingSessions)
      .set({ controlUpdatedAt: new Date() })
      .where(and(eq(teachingSessions.id, sessionId), isNull(teachingSessions.endTime)))
      .returning();
    if (session) await initializeClasspilotStudentControlStatesForSession(session, transactionDb);
    return session;
  });
}

export async function endTeachingSession(
  sessionId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  // Legacy storage/test compatibility wrapper. Runtime routes and workers use
  // finalizeClasspilotSession so recipients and post-commit side effects are
  // included, but even this low-level helper must not bypass the canonical
  // transactional cleanup path.
  const [existing] = await dbInstance
    .select()
    .from(teachingSessions)
    .where(eq(teachingSessions.id, sessionId))
    .limit(1);
  if (!existing?.schoolId) return undefined;
  const result = await finalizeTeachingSession({
    schoolId: existing.schoolId,
    sessionId,
    reason: existing.scheduledDate ? "teacher_end" : "manual_end",
    recipients: [],
  }, dbInstance);
  return result?.session;
}

export type TeachingSessionFinalizationReason =
  | "manual_end"
  | "teacher_end"
  | "admin_end"
  | "scheduled_end"
  | "safety_timeout"
  | "replacement_start";

export type SessionSummaryRecipientSnapshot = {
  kind: "teacher" | "central";
  email: string;
  name?: string | null;
};

export async function withTeachingSessionStartLock<T>(
  schoolId: string,
  teacherId: string,
  callback: (dbInstance: typeof db) => Promise<T>,
  dbInstance: typeof db = db
): Promise<T> {
  return dbInstance.transaction(async (tx) => {
    const lockKey = `classpilot:teaching-session-start:${schoolId}:${teacherId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return callback(tx as unknown as typeof db);
  });
}

export type FinalizeTeachingSessionResult = {
  session: TeachingSession;
  finalized: boolean;
  summaryDisposition: "queued" | "already_queued" | "not_applicable";
  deliveryCount: number;
  resolvedConflictIds: string[];
  clearedControlStates: ClasspilotStudentControlState[];
  restoredControlStates: ClasspilotStudentControlState[];
};

/**
 * The single database authority for ending a ClassPilot teaching session.
 * The row lock makes teacher, scheduler and safety-timeout races idempotent;
 * lifecycle state, classroom cleanup and outbox creation commit together.
 */
export async function finalizeTeachingSession(
  options: {
    schoolId: string;
    sessionId: string;
    reason: TeachingSessionFinalizationReason;
    finalizedAt?: Date;
    recipients?: SessionSummaryRecipientSnapshot[];
  },
  dbInstance: typeof db = db
): Promise<FinalizeTeachingSessionResult | undefined> {
  const now = options.finalizedAt || new Date();
  const result = await dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotTeachingSessionLifecycle(options.sessionId, transactionDb);
    const [candidateSession] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.sessionId),
        eq(teachingSessions.schoolId, options.schoolId)
      ))
      .limit(1);
    if (!candidateSession) return undefined;
    if (!candidateSession.endTime && !candidateSession.rosterSnapshotCompletedAt) {
      // Repair an open legacy session before acquiring either student or
      // session locks. The resulting rows become the frozen final roster;
      // never discover new students after the session row lock is held.
      await resyncClasspilotSessionStudents(candidateSession, transactionDb, { strict: true });
    }
    const finalizingRoster = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, options.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, options.sessionId)
      ));
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      finalizingRoster.map((row) => row.studentId),
      transactionDb
    );
    const [session] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.sessionId),
        eq(teachingSessions.schoolId, options.schoolId)
      ))
      .limit(1)
      .for("update");
    if (!session) return undefined;

    const existingDeliveries = await tx
      .select({ id: classpilotSessionSummaryDeliveries.id })
      .from(classpilotSessionSummaryDeliveries)
      .where(and(
        eq(classpilotSessionSummaryDeliveries.schoolId, options.schoolId),
        eq(classpilotSessionSummaryDeliveries.teachingSessionId, session.id)
      ));

    if (session.endTime) {
      return {
        session,
        finalized: false,
        summaryDisposition: existingDeliveries.length > 0 ? "already_queued" as const : "not_applicable" as const,
        deliveryCount: existingDeliveries.length,
        resolvedConflictIds: [],
        clearedControlStates: [],
        restoredControlStates: [],
      };
    }

    const isScheduled = !!session.scheduledDate;
    const candidateEndTime = isScheduled && options.reason === "scheduled_end" && session.scheduledEndAt
      ? session.scheduledEndAt
      : isScheduled && session.scheduledEndAt && now > session.scheduledEndAt
        ? session.scheduledEndAt
        : now;
    // A future frozen/synthetic occurrence can be replaced before its nominal
    // start. Reports must still have a valid zero-length window instead of
    // making the entire session-finalization transaction fail its invariant.
    const endTime = candidateEndTime < session.startTime ? session.startTime : candidateEndTime;
    const [groupSnapshot] = await tx
      .select({ className: groups.name, timezone: schools.schoolTimezone })
      .from(groups)
      .innerJoin(schools, eq(schools.id, groups.schoolId))
      .where(and(
        eq(groups.id, session.groupId),
        eq(groups.schoolId, options.schoolId)
      ))
      .limit(1);
    if (!groupSnapshot) throw new Error("Teaching session parent class was not found");
    const timezoneSnapshot = session.timezoneSnapshot
      || session.scheduledTimezone
      || groupSnapshot.timezone
      || "America/New_York";
    const classNameSnapshot = session.classNameSnapshot || groupSnapshot.className;
    let rosterSnapshotCompletedAt = session.rosterSnapshotCompletedAt;
    if (!rosterSnapshotCompletedAt) {
      // The open legacy roster was repaired before the student/session locks.
      // From this point onward, only enrich that frozen set; never reread the
      // mutable group roster after finalization has acquired its row lock.
      await tx.execute(sql`
        UPDATE classpilot_session_students AS snapshot
        SET student_name_snapshot = COALESCE(
          NULLIF(btrim(concat_ws(' ', student.first_name, student.last_name)), ''),
          student.email,
          'Unknown student'
        )
        FROM students AS student
        WHERE snapshot.teaching_session_id = ${session.id}
          AND snapshot.school_id = ${options.schoolId}
          AND snapshot.student_id = student.id
          AND student.school_id = ${options.schoolId}
          AND snapshot.student_name_snapshot IS NULL
      `);
      await tx
        .update(classpilotSessionStudents)
        .set({ studentNameSnapshot: "Unknown student" })
        .where(and(
          eq(classpilotSessionStudents.schoolId, options.schoolId),
          eq(classpilotSessionStudents.teachingSessionId, session.id),
          isNull(classpilotSessionStudents.studentNameSnapshot)
        ));
      rosterSnapshotCompletedAt = now;
    }

    const [ended] = await tx
      .update(teachingSessions)
      .set({
        endTime,
        scheduledState: isScheduled ? "finalized" : session.scheduledState,
        // Despite the legacy column name, this is the unified lifecycle audit
        // reason for both manual and scheduled sessions.
        scheduledFinalizationReason: options.reason,
        classNameSnapshot,
        timezoneSnapshot,
        rosterSnapshotCompletedAt,
      })
      .where(and(eq(teachingSessions.id, session.id), isNull(teachingSessions.endTime)))
      .returning();
    if (!ended) throw new Error("Teaching session finalization lost its row lock");

    await tx
      .update(classpilotClassroomStates)
      .set({ clearedAt: endTime, updatedAt: endTime })
      .where(and(
        eq(classpilotClassroomStates.schoolId, options.schoolId),
        eq(classpilotClassroomStates.teachingSessionId, session.id),
        isNull(classpilotClassroomStates.clearedAt)
      ));
    await tx
      .update(classpilotActiveHands)
      .set({ clearedAt: endTime, updatedAt: endTime })
      .where(and(
        eq(classpilotActiveHands.schoolId, options.schoolId),
        eq(classpilotActiveHands.teachingSessionId, session.id),
        isNull(classpilotActiveHands.clearedAt)
      ));
    const clearedControlStates = await clearClasspilotStudentControlStatesForSession({
      schoolId: options.schoolId,
      teachingSessionId: session.id,
      clearedAt: endTime,
    }, transactionDb);
    const restoredControlStates: ClasspilotStudentControlState[] = [];

    const frozenBlockStartTime = session.scheduledStartAt && session.scheduledTimezone
      ? session.scheduledStartAt.toLocaleString("en-US", {
          timeZone: session.scheduledTimezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).replace(/^24:/, "00:")
      : null;
    const conflictIdentities: SQL[] = [];
    if (session.scheduledConflictId) {
      conflictIdentities.push(eq(classpilotScheduledConflicts.id, session.scheduledConflictId));
    }
    if (session.scheduledDate && frozenBlockStartTime) {
      conflictIdentities.push(and(
        eq(classpilotScheduledConflicts.groupId, session.groupId),
        eq(classpilotScheduledConflicts.scheduledDate, session.scheduledDate),
        eq(classpilotScheduledConflicts.blockStartTime, frozenBlockStartTime)
      )!);
    }
    const matchingConflicts = conflictIdentities.length > 0
      ? await tx
          .select({ id: classpilotScheduledConflicts.id })
          .from(classpilotScheduledConflicts)
          .where(and(
            eq(classpilotScheduledConflicts.schoolId, options.schoolId),
            inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES),
            or(...conflictIdentities)
          ))
          .for("update")
      : [];
    const conflictIds = matchingConflicts.map((conflict) => conflict.id);

    if (conflictIds.length > 0) {
      const contexts = await tx
        .select({ id: classpilotSupervisionContexts.id })
        .from(classpilotSupervisionContexts)
        .where(and(
          eq(classpilotSupervisionContexts.schoolId, options.schoolId),
          inArray(classpilotSupervisionContexts.scheduledConflictId, conflictIds),
          eq(classpilotSupervisionContexts.status, "active")
        ));
      const contextIds = contexts.map((context) => context.id);
      if (contextIds.length > 0) {
        const releasedSupervisionStudents = await tx
          .update(classpilotSupervisionStudents)
          .set({ releasedAt: endTime, releaseReason: options.reason })
          .where(and(
            eq(classpilotSupervisionStudents.schoolId, options.schoolId),
            inArray(classpilotSupervisionStudents.contextId, contextIds),
            isNull(classpilotSupervisionStudents.releasedAt)
          ))
          .returning();
        await tx
          .update(classpilotSupervisionContexts)
          .set({ status: "ended", endedAt: endTime, updatedAt: endTime })
          .where(and(
            eq(classpilotSupervisionContexts.schoolId, options.schoolId),
            inArray(classpilotSupervisionContexts.id, contextIds)
          ));
        for (const context of contexts) {
          const restored = await restoreClasspilotStudentControlStatesAfterSupervision({
            schoolId: options.schoolId,
            supervisionContextId: context.id,
            studentIds: releasedSupervisionStudents
              .filter((row) => row.contextId === context.id)
              .map((row) => row.studentId),
            restoredAt: endTime,
          }, transactionDb);
          for (const state of restored) {
            if (state.teachingSessionId || state.supervisionContextId) {
              restoredControlStates.push(state);
            } else {
              clearedControlStates.push(state);
            }
          }
        }
      }
      await tx
        .update(classpilotScheduledConflicts)
        .set({
          status: "ended",
          resolution: options.reason,
          resolvedAt: endTime,
          updatedAt: endTime,
        })
        .where(and(
          inArray(classpilotScheduledConflicts.id, conflictIds),
          eq(classpilotScheduledConflicts.schoolId, options.schoolId),
          inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
        ));
    }

    // Any finalized scheduled occurrence is terminal for that local day. This
    // is especially important for an early teacher/admin End Class action.
    if (session.scheduledDate) {
      await tx
        .update(groups)
        .set({ scheduleSkippedDate: session.scheduledDate })
        .where(and(eq(groups.id, session.groupId), eq(groups.schoolId, options.schoolId)));
    }

    // Staff membership is frozen when the session starts. The fallback below
    // exists only for an open session created by a pre-rollout server; never
    // append people whose group assignment changed after the snapshot.
    const [existingStaffSnapshot] = await tx
      .select({ id: classpilotSessionStaff.id })
      .from(classpilotSessionStaff)
      .where(and(
        eq(classpilotSessionStaff.schoolId, options.schoolId),
        eq(classpilotSessionStaff.teachingSessionId, session.id)
      ))
      .limit(1);
    if (!existingStaffSnapshot) {
      await snapshotClasspilotSessionStaff(ended, transactionDb);
    }
    const reportStaff = await tx
      .select({ staffId: classpilotSessionStaff.staffId })
      .from(classpilotSessionStaff)
      .where(and(
        eq(classpilotSessionStaff.schoolId, options.schoolId),
        eq(classpilotSessionStaff.teachingSessionId, session.id)
      ));
    const authorizationMarker = createClasspilotReportAuthorizationMarker({
      schoolId: options.schoolId,
      teachingSessionId: session.id,
      staffIds: reportStaff.map((row) => row.staffId),
    });
    const [schoolSettings] = await tx
      .select({
        retentionHours: settings.retentionHours,
        enableTrackingHours: settings.enableTrackingHours,
        trackingStartTime: settings.trackingStartTime,
        trackingEndTime: settings.trackingEndTime,
        trackingDays: settings.trackingDays,
        afterHoursMode: settings.afterHoursMode,
      })
      .from(settings)
      .where(eq(settings.schoolId, options.schoolId))
      .limit(1);
    const reportSettleAt = new Date(now.getTime() + 30_000);
    const reportExpiresAt = classpilotRetentionExpiresAt(endTime, schoolSettings?.retentionHours);
    const clearedStudentIds = [...new Set(clearedControlStates.map((state) => state.studentId))];
    if (clearedStudentIds.length > 0) {
      // The extension's acknowledgement necessarily arrives after the class
      // window closes and is correctly rejected by the half-open scope guard.
      // Preserve the authoritative class-end clear inside this transaction
      // instead, bound to the latest authenticated student session that
      // overlapped the frozen class window.
      const overlappingStudentSessions = await tx
        .select({
          id: studentSessions.id,
          studentId: studentSessions.studentId,
          startedAt: studentSessions.startedAt,
        })
        .from(studentSessions)
        .innerJoin(students, eq(students.id, studentSessions.studentId))
        .where(and(
          eq(students.schoolId, options.schoolId),
          inArray(studentSessions.studentId, clearedStudentIds),
          lt(studentSessions.startedAt, endTime),
          or(isNull(studentSessions.endedAt), gt(studentSessions.endedAt, session.startTime))
        ))
        .orderBy(asc(studentSessions.studentId), desc(studentSessions.startedAt));
      const latestSessionByStudent = new Map<string, string>();
      for (const studentSession of overlappingStudentSessions) {
        if (!latestSessionByStudent.has(studentSession.studentId)) {
          latestSessionByStudent.set(studentSession.studentId, studentSession.id);
        }
      }
      const clearedStateByStudent = new Map(
        clearedControlStates.map((state) => [state.studentId, state])
      );
      const clearEvents = clearedStudentIds.flatMap((studentId) => {
        const studentSessionId = latestSessionByStudent.get(studentId);
        const state = clearedStateByStudent.get(studentId);
        if (!studentSessionId || !state) return [];
        return [{
          schoolId: options.schoolId,
          studentId,
          studentSessionId,
          teachingSessionId: session.id,
          sourceEventId: `finalize:${session.id}:restriction-clear:${studentId}`,
          schemaVersion: 1,
          origin: "server",
          eventType: "restriction_state_cleared",
          occurredAt: endTime,
          receivedAt: now,
          metadata: { revision: state.revision, outcome: "cleared" },
          retentionExpiresAt: reportExpiresAt,
        } as const];
      });
      if (clearEvents.length > 0) {
        await tx.insert(classpilotMonitoringEvents).values(clearEvents).onConflictDoNothing();
      }
    }
    await tx
      .insert(classpilotSessionReports)
      .values({
        schoolId: options.schoolId,
        teachingSessionId: session.id,
        state: "pending",
        windowStart: session.startTime,
        windowEnd: endTime,
        timezone: timezoneSnapshot,
        coverageAlgorithmVersion: "heartbeat-coverage-v1",
        eventSchemaVersion: 1,
        authorizationMarker,
        trackingPolicy: {
          enableTrackingHours: schoolSettings?.enableTrackingHours === true,
          trackingStartTime: schoolSettings?.trackingStartTime || null,
          trackingEndTime: schoolSettings?.trackingEndTime || null,
          trackingDays: schoolSettings?.trackingDays || [],
          schoolTimezone: timezoneSnapshot,
          afterHoursMode: schoolSettings?.afterHoursMode || "off",
        },
        settleAt: reportSettleAt,
        nextAttemptAt: reportSettleAt,
        expiresAt: reportExpiresAt,
      })
      .onConflictDoNothing();

    const uniqueRecipients = new Map<string, SessionSummaryRecipientSnapshot>();
    for (const recipient of options.recipients || []) {
      const email = recipient.email.trim();
      if (!email) continue;
      const normalized = email.toLowerCase();
      if (!uniqueRecipients.has(normalized)) uniqueRecipients.set(normalized, { ...recipient, email });
    }
    const inserted = uniqueRecipients.size > 0
      ? await tx
          .insert(classpilotSessionSummaryDeliveries)
          .values(Array.from(uniqueRecipients.values()).map((recipient) => ({
            schoolId: options.schoolId,
            teachingSessionId: session.id,
            recipientKind: recipient.kind,
            recipientEmail: recipient.email,
            recipientName: recipient.name || null,
            state: "waiting_report",
            nextAttemptAt: reportSettleAt,
          } as InsertClasspilotSessionSummaryDelivery)))
          .onConflictDoNothing()
          .returning({ id: classpilotSessionSummaryDeliveries.id })
      : [];

    const deliveryCount = existingDeliveries.length + inserted.length;
    return {
      session: ended,
      finalized: true,
      summaryDisposition: inserted.length > 0
        ? "queued" as const
        : deliveryCount > 0
          ? "already_queued" as const
          : "not_applicable" as const,
      deliveryCount,
      resolvedConflictIds: conflictIds,
      clearedControlStates,
      restoredControlStates,
    };
  });

  return result;
}

export async function listScheduledSessionsReadyToFinalize(
  now = new Date(),
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<TeachingSession[]> {
  const conditions: SQL[] = [
    eq(teachingSessions.scheduledState, "active"),
    isNull(teachingSessions.endTime),
    isNotNull(teachingSessions.scheduledEndAt),
    sql`${teachingSessions.scheduledEndAt} <= ${now}`,
  ];
  if (schoolId) conditions.push(eq(teachingSessions.schoolId, schoolId));
  return dbInstance
    .select()
    .from(teachingSessions)
    .where(and(...conditions))
    .orderBy(teachingSessions.scheduledEndAt);
}

export async function listScheduledReportSessionsDueNow(
  now = new Date(),
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<TeachingSession[]> {
  const conditions: SQL[] = [
    eq(teachingSessions.sessionMode, SCHEDULED_REPORT_SESSION_MODE),
    eq(teachingSessions.scheduledState, "active"),
    isNull(teachingSessions.endTime),
    isNotNull(teachingSessions.scheduledStartAt),
    isNotNull(teachingSessions.scheduledEndAt),
    sql`${teachingSessions.scheduledStartAt} <= ${now}`,
    sql`${teachingSessions.scheduledEndAt} > ${now}`,
  ];
  if (schoolId) conditions.push(eq(teachingSessions.schoolId, schoolId));
  return dbInstance
    .select()
    .from(teachingSessions)
    .where(and(...conditions))
    .orderBy(teachingSessions.scheduledStartAt, teachingSessions.id);
}

export async function getClasspilotSessionReportBySession(
  schoolId: string,
  teachingSessionId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSessionReport | undefined> {
  const [report] = await dbInstance
    .select()
    .from(classpilotSessionReports)
    .where(and(
      eq(classpilotSessionReports.schoolId, schoolId),
      eq(classpilotSessionReports.teachingSessionId, teachingSessionId)
    ))
    .limit(1);
  return report;
}

export async function getClasspilotSessionStudentReports(
  schoolId: string,
  reportId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSessionStudentReport[]> {
  return dbInstance
    .select()
    .from(classpilotSessionStudentReports)
    .where(and(
      eq(classpilotSessionStudentReports.schoolId, schoolId),
      eq(classpilotSessionStudentReports.reportId, reportId)
    ))
    .orderBy(classpilotSessionStudentReports.studentNameSnapshot, classpilotSessionStudentReports.studentId);
}

export type AuthorizedClasspilotSessionReportRead =
  | { status: "not_found" | "unauthorized" | "expired" }
  | {
      status: "available";
      report: ClasspilotSessionReport;
      studentReports: ClasspilotSessionStudentReport[];
    };

/**
 * Authorize and read an immutable report from one database snapshot. The
 * shared report-row lock prevents the retention worker from deleting detail
 * between the parent read and the student-detail read. Before expiry the
 * immutable staff snapshot is authoritative; after expiry only the report's
 * one-way authorization marker is consulted so raw staff rows can be purged.
 */
export async function readAuthorizedClasspilotSessionReport(options: {
  schoolId: string;
  teachingSessionId: string;
  staffId: string;
  isAdmin: boolean;
  now?: Date;
}, dbInstance: typeof db = db): Promise<AuthorizedClasspilotSessionReportRead> {
  const now = options.now || new Date();
  return dbInstance.transaction(async (tx) => {
    const [report] = await tx
      .select()
      .from(classpilotSessionReports)
      .where(and(
        eq(classpilotSessionReports.schoolId, options.schoolId),
        eq(classpilotSessionReports.teachingSessionId, options.teachingSessionId)
      ))
      .limit(1)
      .for("share");
    if (!report) return { status: "not_found" as const };

    const expired = report.state === "expired"
      || !!report.detailExpiredAt
      || report.expiresAt <= now;
    const authorized = options.isAdmin
      ? true
      : expired
        ? isClasspilotReportAuthorizedStaff({
            marker: report.authorizationMarker,
            schoolId: options.schoolId,
            teachingSessionId: options.teachingSessionId,
            staffId: options.staffId,
          })
        : !!(await tx
            .select({ id: classpilotSessionStaff.id })
            .from(classpilotSessionStaff)
            .where(and(
              eq(classpilotSessionStaff.schoolId, options.schoolId),
              eq(classpilotSessionStaff.teachingSessionId, options.teachingSessionId),
              eq(classpilotSessionStaff.staffId, options.staffId)
            ))
            .limit(1))[0];
    if (!authorized) return { status: "unauthorized" as const };
    if (expired) return { status: "expired" as const };

    const studentReports = report.state === "ready"
      ? await tx
          .select()
          .from(classpilotSessionStudentReports)
          .where(and(
            eq(classpilotSessionStudentReports.schoolId, options.schoolId),
            eq(classpilotSessionStudentReports.reportId, report.id)
          ))
          .orderBy(
            classpilotSessionStudentReports.studentNameSnapshot,
            classpilotSessionStudentReports.studentId
          )
      : [];
    return { status: "available" as const, report, studentReports };
  });
}

export async function isAuthorizedClasspilotSessionStaff(
  schoolId: string,
  teachingSessionId: string,
  staffId: string,
  dbInstance: typeof db = db
): Promise<boolean> {
  const [row] = await dbInstance
    .select({ id: classpilotSessionStaff.id })
    .from(classpilotSessionStaff)
    .where(and(
      eq(classpilotSessionStaff.schoolId, schoolId),
      eq(classpilotSessionStaff.teachingSessionId, teachingSessionId),
      eq(classpilotSessionStaff.staffId, staffId)
    ))
    .limit(1);
  return !!row;
}

export async function claimDueClasspilotSessionReports(
  options: {
    leaseOwner: string;
    now?: Date;
    leaseMs?: number;
    limit?: number;
    schoolId?: string;
    teachingSessionId?: string;
  },
  dbInstance: typeof db = db
): Promise<{ reports: ClasspilotSessionReport[]; exhaustedLeaseCount: number }> {
  const now = options.now || new Date();
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs || 2 * 60 * 1000));
  const limit = Math.max(1, Math.min(options.limit || 25, 100));
  return dbInstance.transaction(async (tx) => {
    const reportScope: SQL[] = [];
    if (options.schoolId) reportScope.push(eq(classpilotSessionReports.schoolId, options.schoolId));
    if (options.teachingSessionId) {
      reportScope.push(eq(classpilotSessionReports.teachingSessionId, options.teachingSessionId));
    }
    const expired = await tx
      .update(classpilotSessionReports)
      .set({
        state: "expired",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "Session report expired before processing completed",
        updatedAt: now,
      })
      .where(and(
        inArray(classpilotSessionReports.state, ["pending", "materializing", "ready", "failed"]),
        sql`${classpilotSessionReports.expiresAt} <= ${now}`,
        ...reportScope
      ))
      .returning({
        schoolId: classpilotSessionReports.schoolId,
        teachingSessionId: classpilotSessionReports.teachingSessionId,
      });
    for (const report of expired) {
      await tx
        .update(classpilotSessionSummaryDeliveries)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "Session summary expired before email was sent",
          updatedAt: now,
        })
        .where(and(
          eq(classpilotSessionSummaryDeliveries.schoolId, report.schoolId),
          eq(classpilotSessionSummaryDeliveries.teachingSessionId, report.teachingSessionId),
          or(
            inArray(classpilotSessionSummaryDeliveries.state, ["waiting_report", "queued", "retry"]),
            and(
              eq(classpilotSessionSummaryDeliveries.state, "leased"),
              isNull(classpilotSessionSummaryDeliveries.submissionStartedAt)
            )
          )!
        ));
    }
    await tx
      .update(classpilotSessionReports)
      .set({
        state: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        lastError: "Report worker lease expired before materialization committed",
        updatedAt: now,
      })
      .where(and(
        eq(classpilotSessionReports.state, "materializing"),
        sql`${classpilotSessionReports.leaseExpiresAt} < ${now}`,
        sql`${classpilotSessionReports.attemptCount} < 5`,
        gt(classpilotSessionReports.expiresAt, now),
        ...reportScope
      ));
    const exhausted = await tx
      .update(classpilotSessionReports)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "Report generation exhausted retries after worker lease expiry",
        updatedAt: now,
      })
      .where(and(
        eq(classpilotSessionReports.state, "materializing"),
        sql`${classpilotSessionReports.leaseExpiresAt} < ${now}`,
        sql`${classpilotSessionReports.attemptCount} >= 5`,
        gt(classpilotSessionReports.expiresAt, now),
        ...reportScope
      ))
      .returning({
        schoolId: classpilotSessionReports.schoolId,
        teachingSessionId: classpilotSessionReports.teachingSessionId,
      });
    for (const report of exhausted) {
      await tx
        .update(classpilotSessionSummaryDeliveries)
        .set({
          state: "failed",
          lastError: "Session report generation failed; email was not sent",
          updatedAt: now,
        })
        .where(and(
          eq(classpilotSessionSummaryDeliveries.schoolId, report.schoolId),
          eq(classpilotSessionSummaryDeliveries.teachingSessionId, report.teachingSessionId),
          eq(classpilotSessionSummaryDeliveries.state, "waiting_report")
        ));
    }
    const candidates = await tx
      .select({ id: classpilotSessionReports.id })
      .from(classpilotSessionReports)
      .where(and(
        eq(classpilotSessionReports.state, "pending"),
        sql`${classpilotSessionReports.settleAt} <= ${now}`,
        sql`${classpilotSessionReports.nextAttemptAt} <= ${now}`,
        gt(classpilotSessionReports.expiresAt, now),
        ...reportScope
      ))
      .orderBy(classpilotSessionReports.nextAttemptAt, classpilotSessionReports.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {
      return { reports: [], exhaustedLeaseCount: exhausted.length };
    }
    const reports = await tx
      .update(classpilotSessionReports)
      .set({
        state: "materializing",
        attemptCount: sql`${classpilotSessionReports.attemptCount} + 1`,
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(and(
        inArray(classpilotSessionReports.id, candidates.map((candidate) => candidate.id)),
        eq(classpilotSessionReports.state, "pending"),
        gt(classpilotSessionReports.expiresAt, now)
      ))
      .returning();
    return { reports, exhaustedLeaseCount: exhausted.length };
  });
}

export type ClasspilotSessionReportInput = {
  session: TeachingSession;
  roster: Array<{ studentId: string; studentName: string; capturedAt: Date }>;
  authenticatedSessions: Array<{
    id: string;
    studentId: string;
    startedAt: Date;
    endedAt: Date | null;
    lastSeenAt: Date;
  }>;
  heartbeats: Array<{ studentId: string | null; timestamp: Date; activeTabUrl: string | null }>;
  exclusions: Array<{
    studentId: string;
    start: Date;
    end: Date;
    source: "delegated_supervision";
  }>;
  monitoringEvents: ClasspilotMonitoringEvent[];
  trackingPolicy: {
    enableTrackingHours: boolean;
    trackingStartTime: string | null;
    trackingEndTime: string | null;
    trackingDays: string[];
    schoolTimezone: string;
    afterHoursMode: "off" | "limited" | "full";
  };
};

export async function getClasspilotSessionReportInput(
  report: ClasspilotSessionReport,
  dbInstance: typeof db = db
): Promise<ClasspilotSessionReportInput | undefined> {
  const [session] = await dbInstance
    .select()
    .from(teachingSessions)
    .where(and(
      eq(teachingSessions.id, report.teachingSessionId),
      eq(teachingSessions.schoolId, report.schoolId)
    ))
    .limit(1);
  if (!session?.endTime
    || !session.rosterSnapshotCompletedAt
    || !session.classNameSnapshot
    || !session.timezoneSnapshot
    || !report.trackingPolicy) return undefined;
  const roster = await dbInstance
    .select({
      studentId: classpilotSessionStudents.studentId,
      studentName: classpilotSessionStudents.studentNameSnapshot,
      capturedAt: classpilotSessionStudents.capturedAt,
    })
    .from(classpilotSessionStudents)
    .where(and(
      eq(classpilotSessionStudents.schoolId, report.schoolId),
      eq(classpilotSessionStudents.teachingSessionId, report.teachingSessionId)
    ));
  const studentIds = roster.map((row) => row.studentId);
  if (studentIds.length === 0) {
    return {
      session,
      roster: [],
      authenticatedSessions: [],
      heartbeats: [],
      exclusions: [],
      monitoringEvents: [],
      trackingPolicy: {
        enableTrackingHours: report.trackingPolicy?.enableTrackingHours === true,
        trackingStartTime: report.trackingPolicy?.trackingStartTime || null,
        trackingEndTime: report.trackingPolicy?.trackingEndTime || null,
        trackingDays: report.trackingPolicy?.trackingDays || [],
        schoolTimezone: report.trackingPolicy?.schoolTimezone || report.timezone,
        afterHoursMode: report.trackingPolicy?.afterHoursMode || "off",
      },
    };
  }
  const [authenticatedSessions, heartbeatRows, supervisionRows, monitoringEvents] = await Promise.all([
    dbInstance
      .select({
        id: studentSessions.id,
        studentId: studentSessions.studentId,
        startedAt: studentSessions.startedAt,
        endedAt: studentSessions.endedAt,
        lastSeenAt: studentSessions.lastSeenAt,
      })
      .from(studentSessions)
      .where(and(
        inArray(studentSessions.studentId, studentIds),
        sql`${studentSessions.startedAt} < ${report.windowEnd.toISOString()}`,
        sql`coalesce(${studentSessions.endedAt}, ${report.windowEnd.toISOString()}) > ${report.windowStart.toISOString()}`
      )),
    getHeartbeatsForStudentsInRange(
      report.schoolId,
      studentIds,
      report.windowStart,
      report.windowEnd,
      dbInstance
    ),
    dbInstance
      .select({
        studentId: classpilotSupervisionStudents.studentId,
        assignedAt: classpilotSupervisionStudents.assignedAt,
        releasedAt: classpilotSupervisionStudents.releasedAt,
        startsAt: classpilotSupervisionContexts.startsAt,
        endsAt: classpilotSupervisionContexts.endsAt,
        endedAt: classpilotSupervisionContexts.endedAt,
      })
      .from(classpilotSupervisionStudents)
      .innerJoin(classpilotSupervisionContexts, and(
        eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId),
        eq(classpilotSupervisionContexts.schoolId, report.schoolId)
      ))
      .where(and(
        eq(classpilotSupervisionStudents.schoolId, report.schoolId),
        inArray(classpilotSupervisionStudents.studentId, studentIds),
        sql`${classpilotSupervisionStudents.assignedAt} < ${report.windowEnd.toISOString()}`,
        sql`coalesce(${classpilotSupervisionStudents.releasedAt}, ${classpilotSupervisionContexts.endedAt}, ${classpilotSupervisionContexts.endsAt}) > ${report.windowStart.toISOString()}`
      )),
    dbInstance
      .select()
      .from(classpilotMonitoringEvents)
      .where(and(
        eq(classpilotMonitoringEvents.schoolId, report.schoolId),
        eq(classpilotMonitoringEvents.teachingSessionId, report.teachingSessionId),
        inArray(classpilotMonitoringEvents.studentId, studentIds),
        sql`${classpilotMonitoringEvents.occurredAt} >= ${report.windowStart}`,
        sql`${classpilotMonitoringEvents.occurredAt} < ${report.windowEnd}`,
        ne(classpilotMonitoringEvents.eventType, "monitoring_gap")
      )),
  ]);
  return {
    session,
    roster: roster.map((row) => ({
      studentId: row.studentId,
      studentName: row.studentName || "Unknown student",
      capturedAt: row.capturedAt,
    })),
    authenticatedSessions,
    heartbeats: heartbeatRows,
    exclusions: supervisionRows.map((row) => ({
      studentId: row.studentId,
      start: row.assignedAt > row.startsAt ? row.assignedAt : row.startsAt,
      end: [row.releasedAt, row.endedAt, row.endsAt]
        .filter((value): value is Date => !!value)
        .sort((a, b) => a.getTime() - b.getTime())[0]!,
      source: "delegated_supervision" as const,
    })),
    monitoringEvents,
    trackingPolicy: {
      enableTrackingHours: report.trackingPolicy?.enableTrackingHours === true,
      trackingStartTime: report.trackingPolicy?.trackingStartTime || null,
      trackingEndTime: report.trackingPolicy?.trackingEndTime || null,
      trackingDays: report.trackingPolicy?.trackingDays || [],
      schoolTimezone: report.trackingPolicy?.schoolTimezone || report.timezone,
      afterHoursMode: report.trackingPolicy?.afterHoursMode || "off",
    },
  };
}

export type MaterializedClasspilotStudentReport = {
  studentId: string;
  studentNameSnapshot: string;
  status: "complete" | "partial" | "none" | "not_expected" | "unavailable";
  eligibleSeconds: number;
  observedSeconds: number;
  gapSeconds: number;
  coveragePercent: number | null;
  heartbeatCount: number;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
  gapIntervals: Array<{
    start: string;
    end: string;
    durationSeconds: number;
    cause: "unknown";
    studentSessionId: string;
  }>;
  eventCounts: Record<string, number>;
  topDomains: Array<{ domain: string; seconds: number; visits: number }>;
};

export type MaterializedClasspilotSessionBoundaryEvent = {
  studentId: string;
  studentSessionId: string;
  eventType: "student_session_started" | "student_session_ended";
  occurredAt: Date;
};

export async function completeClasspilotSessionReport(
  options: {
    report: ClasspilotSessionReport;
    leaseOwner: string;
    students: MaterializedClasspilotStudentReport[];
    sessionBoundaryEvents?: MaterializedClasspilotSessionBoundaryEvent[];
    completedAt?: Date;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotSessionReport | undefined> {
  const completedAt = options.completedAt || new Date();
  return dbInstance.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(classpilotSessionReports)
      .where(and(
        eq(classpilotSessionReports.id, options.report.id),
        eq(classpilotSessionReports.state, "materializing"),
        eq(classpilotSessionReports.leaseOwner, options.leaseOwner)
      ))
      .limit(1)
      .for("update");
    if (!locked) return undefined;
    if (!locked.leaseExpiresAt || locked.leaseExpiresAt <= completedAt) {
      // A stale worker must not touch detail after its lease can be reclaimed.
      // The recovery claimant will own the next state transition.
      return undefined;
    }
    if (locked.expiresAt <= completedAt) {
      await tx
        .update(classpilotSessionReports)
        .set({
          state: "expired",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "Session report expired before materialization committed",
          updatedAt: completedAt,
        })
        .where(eq(classpilotSessionReports.id, locked.id));
      await tx
        .update(classpilotSessionSummaryDeliveries)
        .set({
          state: "failed",
          lastError: "Session summary expired before email was sent",
          updatedAt: completedAt,
        })
        .where(and(
          eq(classpilotSessionSummaryDeliveries.schoolId, locked.schoolId),
          eq(classpilotSessionSummaryDeliveries.teachingSessionId, locked.teachingSessionId),
          eq(classpilotSessionSummaryDeliveries.state, "waiting_report")
        ));
      return undefined;
    }
    const [sessionIdentity] = await tx
      .select({ groupId: teachingSessions.groupId })
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, locked.teachingSessionId),
        eq(teachingSessions.schoolId, locked.schoolId)
      ))
      .limit(1);
    if (!sessionIdentity) throw new Error("Materialized report teaching session was not found");

    await tx.delete(classpilotSessionStudentReports).where(and(
      eq(classpilotSessionStudentReports.schoolId, locked.schoolId),
      eq(classpilotSessionStudentReports.reportId, locked.id)
    ));
    await tx.delete(classpilotMonitoringEvents).where(and(
      eq(classpilotMonitoringEvents.schoolId, locked.schoolId),
      eq(classpilotMonitoringEvents.teachingSessionId, locked.teachingSessionId),
      eq(classpilotMonitoringEvents.origin, "server"),
      eq(classpilotMonitoringEvents.eventType, "monitoring_gap")
    ));
    const sessionBoundaryEvents = options.sessionBoundaryEvents || [];
    if (sessionBoundaryEvents.length > 0) {
      await tx
        .insert(classpilotMonitoringEvents)
        .values(sessionBoundaryEvents.map((event) => ({
          schoolId: locked.schoolId,
          studentId: event.studentId,
          studentSessionId: event.studentSessionId,
          teachingSessionId: locked.teachingSessionId,
          sourceEventId: `report:${locked.id}:${event.eventType}:${event.studentSessionId}`,
          schemaVersion: 1,
          origin: "server",
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          receivedAt: completedAt,
          metadata: {},
          retentionExpiresAt: locked.expiresAt,
        })))
        .onConflictDoNothing();
    }
    if (options.students.length > 0) {
      await tx.insert(classpilotSessionStudentReports).values(options.students.map((student) => ({
        schoolId: locked.schoolId,
        reportId: locked.id,
        teachingSessionId: locked.teachingSessionId,
        studentId: student.studentId,
        studentNameSnapshot: student.studentNameSnapshot,
        status: student.status,
        eligibleSeconds: student.eligibleSeconds,
        observedSeconds: student.observedSeconds,
        gapSeconds: student.gapSeconds,
        coveragePercent: student.coveragePercent,
        heartbeatCount: student.heartbeatCount,
        firstObservedAt: student.firstObservedAt,
        lastObservedAt: student.lastObservedAt,
        gapIntervals: student.gapIntervals,
        eventCounts: student.eventCounts,
        topDomains: student.topDomains,
      })));
      const gapEvents = options.students.flatMap((student) => student.gapIntervals.map((gap, index) => ({
        schoolId: locked.schoolId,
        studentId: student.studentId,
        studentSessionId: gap.studentSessionId,
        teachingSessionId: locked.teachingSessionId,
        sourceEventId: `report:${locked.id}:gap:${student.studentId}:${index}`,
        schemaVersion: 1,
        origin: "server",
        eventType: "monitoring_gap",
        occurredAt: new Date(gap.start),
        receivedAt: completedAt,
        metadata: {
          endedAt: gap.end,
          durationSeconds: gap.durationSeconds,
          message: "Monitoring signal lost — cause unknown",
        },
        retentionExpiresAt: locked.expiresAt,
      } as const)));
      if (gapEvents.length > 0) {
        await tx.insert(classpilotMonitoringEvents).values(gapEvents).onConflictDoNothing();
      }

      const localDate = localDateInTimeZone(locked.windowStart, locked.timezone);
      for (const student of options.students) {
        await tx
          .insert(classpilotSessionUsage)
          .values({
            schoolId: locked.schoolId,
            teachingSessionId: locked.teachingSessionId,
            groupId: sessionIdentity.groupId,
            studentId: student.studentId,
            localDate,
            totalSeconds: student.observedSeconds,
            heartbeatCount: student.heartbeatCount,
            topDomains: student.topDomains,
            firstSeen: student.firstObservedAt,
            lastSeen: student.lastObservedAt,
            computedAt: completedAt,
          })
          .onConflictDoUpdate({
            target: [
              classpilotSessionUsage.teachingSessionId,
              classpilotSessionUsage.studentId,
              classpilotSessionUsage.localDate,
            ],
            set: {
              totalSeconds: student.observedSeconds,
              heartbeatCount: student.heartbeatCount,
              topDomains: student.topDomains,
              firstSeen: student.firstObservedAt,
              lastSeen: student.lastObservedAt,
              computedAt: completedAt,
            },
          });
      }
    }

    const counts = {
      complete: options.students.filter((student) => student.status === "complete").length,
      partial: options.students.filter((student) => student.status === "partial").length,
      none: options.students.filter((student) => student.status === "none").length,
      notExpected: options.students.filter((student) => student.status === "not_expected").length,
      unavailable: options.students.filter((student) => student.status === "unavailable").length,
    };
    const [ready] = await tx
      .update(classpilotSessionReports)
      .set({
        state: "ready",
        rosterCount: options.students.length,
        eligibleStudentCount: options.students.filter((student) => student.eligibleSeconds > 0).length,
        completeCount: counts.complete,
        partialCount: counts.partial,
        noneCount: counts.none,
        notExpectedCount: counts.notExpected,
        unavailableCount: counts.unavailable,
        totalEligibleSeconds: options.students.reduce((sum, student) => sum + student.eligibleSeconds, 0),
        totalObservedSeconds: options.students.reduce((sum, student) => sum + student.observedSeconds, 0),
        totalGapSeconds: options.students.reduce((sum, student) => sum + student.gapSeconds, 0),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        materializedAt: completedAt,
        updatedAt: completedAt,
      })
      .where(and(
        eq(classpilotSessionReports.id, locked.id),
        eq(classpilotSessionReports.state, "materializing"),
        eq(classpilotSessionReports.leaseOwner, options.leaseOwner),
        gt(classpilotSessionReports.leaseExpiresAt, completedAt),
        gt(classpilotSessionReports.expiresAt, completedAt),
        isNull(classpilotSessionReports.detailExpiredAt)
      ))
      .returning();
    if (!ready) {
      // Roll back all detail writes if the lease fence cannot promote the
      // exact claimed row. Returning here would otherwise commit orphaned
      // materialization detail without a ready parent.
      throw new Error("ClassPilot report lease was lost before commit");
    }
    await tx
      .update(classpilotSessionSummaryDeliveries)
      .set({ state: "queued", nextAttemptAt: completedAt, updatedAt: completedAt })
      .where(and(
        eq(classpilotSessionSummaryDeliveries.schoolId, locked.schoolId),
        eq(classpilotSessionSummaryDeliveries.teachingSessionId, locked.teachingSessionId),
        eq(classpilotSessionSummaryDeliveries.state, "waiting_report")
      ));
    return ready;
  });
}

export async function failClasspilotSessionReport(
  options: {
    reportId: string;
    leaseOwner: string;
    error: string;
    retryAt?: Date;
    failedAt?: Date;
  },
  dbInstance: typeof db = db
): Promise<"retry" | "failed" | "lost_lease"> {
  const failedAt = options.failedAt || new Date();
  return dbInstance.transaction(async (tx) => {
    const [report] = await tx
      .select()
      .from(classpilotSessionReports)
      .where(and(
        eq(classpilotSessionReports.id, options.reportId),
        eq(classpilotSessionReports.state, "materializing"),
        eq(classpilotSessionReports.leaseOwner, options.leaseOwner)
      ))
      .limit(1)
      .for("update");
    if (!report) return "lost_lease";
    const expired = report.expiresAt <= failedAt;
    const retry = !expired && report.attemptCount < 5 && !!options.retryAt;
    await tx
      .update(classpilotSessionReports)
      .set({
        state: expired ? "expired" : retry ? "pending" : "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: retry ? options.retryAt! : failedAt,
        lastError: options.error.slice(0, 500),
        // detailExpiredAt is the durable marker that the retention worker
        // actually removed/redacted report detail. Merely crossing expiresAt
        // makes the report unreadable, but must not pretend PII was purged.
        detailExpiredAt: report.detailExpiredAt,
        updatedAt: failedAt,
      })
      .where(eq(classpilotSessionReports.id, report.id));
    if (!retry) {
      await tx
        .update(classpilotSessionSummaryDeliveries)
        .set({
          state: "failed",
          lastError: expired
            ? "Session summary expired before email was sent"
            : "Session report generation failed; email was not sent",
          updatedAt: failedAt,
        })
        .where(and(
          eq(classpilotSessionSummaryDeliveries.schoolId, report.schoolId),
          eq(classpilotSessionSummaryDeliveries.teachingSessionId, report.teachingSessionId),
          eq(classpilotSessionSummaryDeliveries.state, "waiting_report")
        ));
    }
    return retry ? "retry" : "failed";
  });
}

export type ClasspilotMonitoringScope =
  | { kind: "teaching_session"; id: string }
  | { kind: "supervision_context"; id: string };

export async function resolveClasspilotMonitoringScope(
  options: {
    schoolId: string;
    studentId: string;
    occurredAt: Date;
    claimedTeachingSessionId?: string | null;
    claimedSupervisionContextId?: string | null;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotMonitoringScope | null> {
  const claimedScopeProvided = options.claimedTeachingSessionId !== undefined
    || options.claimedSupervisionContextId !== undefined;
  const supervision = await dbInstance
    .select({ id: classpilotSupervisionContexts.id })
    .from(classpilotSupervisionStudents)
    .innerJoin(classpilotSupervisionContexts, and(
      eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId),
      eq(classpilotSupervisionContexts.schoolId, options.schoolId)
    ))
    .where(and(
      eq(classpilotSupervisionStudents.schoolId, options.schoolId),
      eq(classpilotSupervisionStudents.studentId, options.studentId),
      sql`${classpilotSupervisionStudents.assignedAt} <= ${options.occurredAt}`,
      sql`coalesce(${classpilotSupervisionStudents.releasedAt}, ${classpilotSupervisionContexts.endedAt}, ${classpilotSupervisionContexts.endsAt}) > ${options.occurredAt}`,
      sql`${classpilotSupervisionContexts.startsAt} <= ${options.occurredAt}`
    ))
    .limit(2);
  if (supervision.length === 1) {
    const resolved = { kind: "supervision_context" as const, id: supervision[0]!.id };
    return !claimedScopeProvided
      || (options.claimedSupervisionContextId === resolved.id && !options.claimedTeachingSessionId)
      ? resolved
      : null;
  }
  if (supervision.length > 1) return null;

  const sessions = await dbInstance
    .select({ id: teachingSessions.id })
    .from(classpilotSessionStudents)
    .innerJoin(teachingSessions, and(
      eq(teachingSessions.id, classpilotSessionStudents.teachingSessionId),
      eq(teachingSessions.schoolId, options.schoolId)
    ))
    .where(and(
      eq(classpilotSessionStudents.schoolId, options.schoolId),
      eq(classpilotSessionStudents.studentId, options.studentId),
      sql`${teachingSessions.startTime} <= ${options.occurredAt}`,
      sql`coalesce(${teachingSessions.endTime}, ${teachingSessions.scheduledEndAt}, now()) > ${options.occurredAt}`
    ))
    .limit(2);
  if (sessions.length !== 1) return null;
  const resolved = { kind: "teaching_session" as const, id: sessions[0]!.id };
  return !claimedScopeProvided
    || (options.claimedTeachingSessionId === resolved.id && !options.claimedSupervisionContextId)
    ? resolved
    : null;
}

export async function insertClasspilotMonitoringEvent(
  event: InsertClasspilotMonitoringEvent,
  dbInstance: typeof db = db
): Promise<"stored" | "duplicate"> {
  const inserted = await dbInstance
    .insert(classpilotMonitoringEvents)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: classpilotMonitoringEvents.id });
  return inserted.length > 0 ? "stored" : "duplicate";
}

export type InsertScopedClasspilotMonitoringEvent = Omit<
  InsertClasspilotMonitoringEvent,
  "teachingSessionId" | "supervisionContextId"
> & {
  claimedTeachingSessionId?: string | null;
  claimedSupervisionContextId?: string | null;
};

/**
 * Resolve the student's occurrence-time authority and insert the event under
 * the same per-student transaction lock used by class/supervision handoffs.
 * This prevents a delegation transition from committing between scope
 * resolution and retention of the scoped event.
 */
export async function insertClasspilotMonitoringEventForResolvedScope(
  options: InsertScopedClasspilotMonitoringEvent,
  dbInstance: typeof db = db
): Promise<"stored" | "duplicate" | "not_retained"> {
  const {
    claimedTeachingSessionId,
    claimedSupervisionContextId,
    ...event
  } = options;
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotStudentControlAuthorities(
      event.schoolId,
      [event.studentId],
      transactionDb
    );
    const scope = await resolveClasspilotMonitoringScope({
      schoolId: event.schoolId,
      studentId: event.studentId,
      occurredAt: event.occurredAt,
      claimedTeachingSessionId,
      claimedSupervisionContextId,
    }, transactionDb);
    if (!scope) return "not_retained";
    return insertClasspilotMonitoringEvent({
      ...event,
      teachingSessionId: scope.kind === "teaching_session" ? scope.id : null,
      supervisionContextId: scope.kind === "supervision_context" ? scope.id : null,
    }, transactionDb);
  });
}

export type ClasspilotMonitoringEventView = {
  event: ClasspilotMonitoringEvent;
  studentName: string;
};

export async function listClasspilotMonitoringEvents(options: {
  schoolId: string;
  scope: ClasspilotMonitoringScope;
  studentId?: string;
  eventTypes?: string[];
  before?: { occurredAt: Date; id: string };
  limit?: number;
}, dbInstance: typeof db = db): Promise<ClasspilotMonitoringEventView[]> {
  const conditions: SQL[] = [
    eq(classpilotMonitoringEvents.schoolId, options.schoolId),
    gt(classpilotMonitoringEvents.retentionExpiresAt, new Date()),
    options.scope.kind === "teaching_session"
      ? eq(classpilotMonitoringEvents.teachingSessionId, options.scope.id)
      : eq(classpilotMonitoringEvents.supervisionContextId, options.scope.id),
  ];
  if (options.studentId) conditions.push(eq(classpilotMonitoringEvents.studentId, options.studentId));
  if (options.eventTypes?.length) conditions.push(inArray(classpilotMonitoringEvents.eventType, options.eventTypes));
  if (options.before) {
    conditions.push(or(
      lt(classpilotMonitoringEvents.occurredAt, options.before.occurredAt),
      and(
        eq(classpilotMonitoringEvents.occurredAt, options.before.occurredAt),
        lt(classpilotMonitoringEvents.id, options.before.id)
      )
    )!);
  }
  const limit = Math.max(1, Math.min(options.limit || 100, 50_001));
  const rows = await dbInstance
    .select({
      event: classpilotMonitoringEvents,
      firstName: students.firstName,
      lastName: students.lastName,
      email: students.email,
      sessionNameSnapshot: classpilotSessionStudents.studentNameSnapshot,
    })
    .from(classpilotMonitoringEvents)
    .leftJoin(students, and(
      eq(students.id, classpilotMonitoringEvents.studentId),
      eq(students.schoolId, options.schoolId)
    ))
    .leftJoin(classpilotSessionStudents, and(
      eq(classpilotSessionStudents.schoolId, options.schoolId),
      eq(classpilotSessionStudents.studentId, classpilotMonitoringEvents.studentId),
      eq(classpilotSessionStudents.teachingSessionId, classpilotMonitoringEvents.teachingSessionId)
    ))
    .where(and(...conditions))
    .orderBy(desc(classpilotMonitoringEvents.occurredAt), desc(classpilotMonitoringEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    event: row.event,
    studentName: row.sessionNameSnapshot
      || [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
      || row.email
      || "Unknown student",
  }));
}

export async function isAuthorizedClasspilotSupervisionStaff(
  schoolId: string,
  contextId: string,
  staffId: string,
  dbInstance: typeof db = db
): Promise<boolean> {
  const [context] = await dbInstance
    .select({ id: classpilotSupervisionContexts.id })
    .from(classpilotSupervisionContexts)
    .where(and(
      eq(classpilotSupervisionContexts.schoolId, schoolId),
      eq(classpilotSupervisionContexts.id, contextId),
      eq(classpilotSupervisionContexts.assignedStaffId, staffId)
    ))
    .limit(1);
  return !!context;
}

/**
 * Adopt only still-open pre-lifecycle scheduled-report rows. Ended historical
 * rows are deliberately excluded so rollout can never create retroactive mail.
 */
export async function reconcileLegacyOpenScheduledSessions(
  now = new Date(),
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<TeachingSession[]> {
  const legacy = await dbInstance
    .select({
      session: teachingSessions,
      conflict: classpilotScheduledConflicts,
      group: groups,
      schoolTimezone: schools.schoolTimezone,
      teacherEmail: users.email,
      teacherFirstName: users.firstName,
      teacherLastName: users.lastName,
      teacherDisplayName: users.displayName,
    })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .innerJoin(schools, eq(groups.schoolId, schools.id))
    .leftJoin(
      classpilotScheduledConflicts,
      eq(teachingSessions.scheduledConflictId, classpilotScheduledConflicts.id)
    )
    .leftJoin(users, eq(teachingSessions.teacherId, users.id))
    .where(and(
      isNull(teachingSessions.endTime),
      isNull(teachingSessions.scheduledDate),
      schoolId ? eq(groups.schoolId, schoolId) : sql`true`,
      or(
        isNotNull(teachingSessions.scheduledConflictId),
        and(
          eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
          eq(groups.scheduleEnabled, true),
          isNotNull(groups.blockStartTime),
          isNotNull(groups.blockEndTime)
        )
      )
    ));

  const adopted: TeachingSession[] = [];
  for (const row of legacy) {
    let inferredEndAt = now;
    try {
      const timeZone = row.schoolTimezone || "America/New_York";
      const scheduledDate = row.conflict?.scheduledDate
        || localDateInTimeZone(row.session.startTime, timeZone);
      const blockStartTime = row.conflict?.blockStartTime || row.group.blockStartTime;
      const blockEndTime = row.conflict?.blockEndTime || row.group.blockEndTime;
      if (!blockStartTime || !blockEndTime) continue;
      const startAt = localDateTimeUtc(scheduledDate, blockStartTime, timeZone);
      const endAt = localDateTimeUtc(scheduledDate, blockEndTime, timeZone);
      inferredEndAt = endAt;
      if (!(endAt > startAt)) continue;
      if (!row.conflict && (row.session.startTime < startAt || row.session.startTime >= endAt)) {
        // No historical conflict snapshot exists. Infer only a live session
        // that actually began inside today's configured scheduled block.
        continue;
      }
      const teacherName = row.teacherDisplayName
        || [row.teacherFirstName, row.teacherLastName].filter(Boolean).join(" ").trim()
        || row.teacherEmail
        || "Teacher";
      const canonical = await getScheduledTeachingSessionOccurrence(
        row.group.schoolId,
        row.session.groupId,
        scheduledDate,
        dbInstance
      );
      if (canonical && canonical.id !== row.session.id) {
        await finalizeTeachingSession({
          schoolId: row.group.schoolId,
          sessionId: row.session.id,
          reason: "scheduled_end",
          // A duplicate legacy row is cleanup, not a future scheduled
          // occurrence. Never leave it open with a future end timestamp.
          finalizedAt: inferredEndAt < now ? inferredEndAt : now,
          recipients: [],
        }, dbInstance);
        continue;
      }
      const [updated] = await dbInstance
        .update(teachingSessions)
        .set({
          startTime: startAt,
          schoolId: row.group.schoolId,
          scheduledDate,
          scheduledTimezone: timeZone,
          scheduledStartAt: startAt,
          scheduledEndAt: endAt,
          scheduledState: "active",
          scheduledTeacherEmail: row.teacherEmail || null,
          scheduledTeacherName: teacherName,
          classNameSnapshot: row.group.name,
        })
        .where(and(
          eq(teachingSessions.id, row.session.id),
          isNull(teachingSessions.endTime),
          isNull(teachingSessions.scheduledDate)
        ))
        .returning();
      if (updated) adopted.push(updated);
    } catch (error) {
      if ((error as any)?.code === "23505") {
        await finalizeTeachingSession({
          schoolId: row.group.schoolId,
          sessionId: row.session.id,
          reason: "scheduled_end",
          finalizedAt: inferredEndAt < now ? inferredEndAt : now,
          recipients: [],
        }, dbInstance);
      } else {
        console.warn(`[ClassPilot] Legacy scheduled occurrence ${row.session.id} could not be adopted:`, error);
      }
    }
  }
  return adopted;
}

export async function recoverExpiredSessionSummaryLeases(
  now = new Date(),
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<{ retried: number; quarantined: number }> {
  const schoolCondition = schoolId
    ? eq(classpilotSessionSummaryDeliveries.schoolId, schoolId)
    : sql`true`;
  await dbInstance
    .update(classpilotSessionSummaryDeliveries)
    .set({
      state: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "Session summary expired before email was sent",
      updatedAt: now,
    })
    .where(and(
      eq(classpilotSessionSummaryDeliveries.state, "leased"),
      schoolCondition,
      isNull(classpilotSessionSummaryDeliveries.submissionStartedAt),
      sql`EXISTS (
        SELECT 1 FROM classpilot_session_reports AS report
        WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
          AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
          AND (report.expires_at <= ${now} OR report.detail_expired_at IS NOT NULL OR report.state = 'expired')
      )`
    ));
  const safe = await dbInstance
    .update(classpilotSessionSummaryDeliveries)
    .set({
      state: "retry",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: now,
      lastError: "Delivery worker lease expired before provider submission",
      updatedAt: now,
    })
    .where(and(
      eq(classpilotSessionSummaryDeliveries.state, "leased"),
      schoolCondition,
      sql`${classpilotSessionSummaryDeliveries.leaseExpiresAt} < ${now}`,
      isNull(classpilotSessionSummaryDeliveries.submissionStartedAt),
      sql`EXISTS (
        SELECT 1 FROM classpilot_session_reports AS report
        WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
          AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
          AND report.state = 'ready'
          AND report.detail_expired_at IS NULL
          AND report.expires_at > ${now}
      )`
    ))
    .returning({ id: classpilotSessionSummaryDeliveries.id });

  const ambiguous = await dbInstance
    .update(classpilotSessionSummaryDeliveries)
    .set({
      state: "unknown",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "Delivery worker lease expired after provider submission began",
      updatedAt: now,
    })
    .where(and(
      eq(classpilotSessionSummaryDeliveries.state, "leased"),
      schoolCondition,
      sql`${classpilotSessionSummaryDeliveries.leaseExpiresAt} < ${now}`,
      isNotNull(classpilotSessionSummaryDeliveries.submissionStartedAt)
    ))
    .returning({ id: classpilotSessionSummaryDeliveries.id });
  return { retried: safe.length, quarantined: ambiguous.length };
}

export async function claimDueSessionSummaryDeliveries(
  options: {
    leaseOwner: string;
    now?: Date;
    leaseMs?: number;
    limit?: number;
    schoolId?: string;
    teachingSessionId?: string;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotSessionSummaryDelivery[]> {
  const now = options.now || new Date();
  const deliveryScope: SQL[] = [];
  if (options.schoolId) deliveryScope.push(eq(classpilotSessionSummaryDeliveries.schoolId, options.schoolId));
  if (options.teachingSessionId) deliveryScope.push(eq(classpilotSessionSummaryDeliveries.teachingSessionId, options.teachingSessionId));
  const dueConditions: SQL[] = [
    inArray(classpilotSessionSummaryDeliveries.state, ["queued", "retry"]),
    sql`${classpilotSessionSummaryDeliveries.nextAttemptAt} <= ${now}`,
    ...deliveryScope,
  ];
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs || 5 * 60 * 1000));
  const limit = Math.max(1, Math.min(options.limit || 25, 100));
  return dbInstance.transaction(async (tx) => {
    await tx
      .update(classpilotSessionSummaryDeliveries)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "Session summary expired before email was sent",
        updatedAt: now,
      })
      .where(and(
        inArray(classpilotSessionSummaryDeliveries.state, ["waiting_report", "queued", "retry"]),
        ...deliveryScope,
        sql`EXISTS (
          SELECT 1 FROM classpilot_session_reports AS report
          WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
            AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
            AND (report.expires_at <= ${now} OR report.detail_expired_at IS NOT NULL OR report.state = 'expired')
        )`
      ));
    const candidates = await tx
      .select({ id: classpilotSessionSummaryDeliveries.id })
      .from(classpilotSessionSummaryDeliveries)
      .where(and(
        ...dueConditions,
        sql`EXISTS (
          SELECT 1 FROM classpilot_session_reports AS report
          WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
            AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
            AND report.state = 'ready'
            AND report.detail_expired_at IS NULL
            AND report.expires_at > ${now}
        )`
      ))
      .orderBy(classpilotSessionSummaryDeliveries.nextAttemptAt, classpilotSessionSummaryDeliveries.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .update(classpilotSessionSummaryDeliveries)
      .set({
        state: "leased",
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        submissionStartedAt: null,
        updatedAt: now,
      })
      .where(and(
        inArray(classpilotSessionSummaryDeliveries.id, candidates.map((candidate) => candidate.id)),
        ...dueConditions,
        sql`EXISTS (
          SELECT 1 FROM classpilot_session_reports AS report
          WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
            AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
            AND report.state = 'ready'
            AND report.detail_expired_at IS NULL
            AND report.expires_at > ${now}
        )`
      ))
      .returning();
  });
}

export async function markSessionSummarySubmissionStarted(
  deliveryId: string,
  leaseOwner: string,
  startedAt = new Date(),
  dbInstance: typeof db = db
): Promise<ClasspilotSessionSummaryDelivery | undefined> {
  return dbInstance.transaction(async (tx) => {
    const [delivery] = await tx
      .update(classpilotSessionSummaryDeliveries)
      .set({
        submissionStartedAt: startedAt,
        attemptCount: sql`${classpilotSessionSummaryDeliveries.attemptCount} + 1`,
        updatedAt: startedAt,
      })
      .where(and(
        eq(classpilotSessionSummaryDeliveries.id, deliveryId),
        eq(classpilotSessionSummaryDeliveries.state, "leased"),
        eq(classpilotSessionSummaryDeliveries.leaseOwner, leaseOwner),
        isNull(classpilotSessionSummaryDeliveries.submissionStartedAt),
        sql`EXISTS (
          SELECT 1 FROM classpilot_session_reports AS report
          WHERE report.school_id = ${classpilotSessionSummaryDeliveries.schoolId}
            AND report.teaching_session_id = ${classpilotSessionSummaryDeliveries.teachingSessionId}
            AND report.state = 'ready'
            AND report.detail_expired_at IS NULL
            AND report.expires_at > ${startedAt}
        )`
      ))
      .returning();
    if (delivery) return delivery;
    await tx
      .update(classpilotSessionSummaryDeliveries)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "Session summary expired before email was sent",
        updatedAt: startedAt,
      })
      .where(and(
        eq(classpilotSessionSummaryDeliveries.id, deliveryId),
        eq(classpilotSessionSummaryDeliveries.state, "leased"),
        eq(classpilotSessionSummaryDeliveries.leaseOwner, leaseOwner),
        isNull(classpilotSessionSummaryDeliveries.submissionStartedAt)
      ));
    return undefined;
  });
}

export async function completeSessionSummaryDelivery(
  options: {
    deliveryId: string;
    leaseOwner: string;
    state: "sent" | "retry" | "failed" | "unknown";
    providerMessageId?: string | null;
    error?: string | null;
    nextAttemptAt?: Date | null;
    completedAt?: Date;
    incrementAttempt?: boolean;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotSessionSummaryDelivery | undefined> {
  const completedAt = options.completedAt || new Date();
  const update: Partial<InsertClasspilotSessionSummaryDelivery> = {
    state: options.state,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: options.nextAttemptAt || completedAt,
    providerMessageId: options.providerMessageId || null,
    lastError: options.error?.slice(0, 500) || null,
    sentAt: options.state === "sent" ? completedAt : null,
    updatedAt: completedAt,
  };
  if (options.incrementAttempt) {
    update.attemptCount = sql`${classpilotSessionSummaryDeliveries.attemptCount} + 1` as any;
  }
  const [delivery] = await dbInstance
    .update(classpilotSessionSummaryDeliveries)
    .set(update)
    .where(and(
      eq(classpilotSessionSummaryDeliveries.id, options.deliveryId),
      eq(classpilotSessionSummaryDeliveries.state, "leased"),
      eq(classpilotSessionSummaryDeliveries.leaseOwner, options.leaseOwner)
    ))
    .returning();
  return delivery;
}

export async function countOverdueSessionSummaryDeliveries(
  cutoff: Date,
  dbInstance: typeof db = db,
  schoolId?: string
): Promise<number> {
  const [row] = await dbInstance
    .select({ count: sql<number>`count(*)::int` })
    .from(classpilotSessionSummaryDeliveries)
    .where(and(
      inArray(classpilotSessionSummaryDeliveries.state, ["queued", "retry"]),
      schoolId ? eq(classpilotSessionSummaryDeliveries.schoolId, schoolId) : sql`true`,
      sql`${classpilotSessionSummaryDeliveries.createdAt} < ${cutoff}`
    ));
  return Number(row?.count || 0);
}

export async function upsertScheduledClassConflict(
  data: InsertClasspilotScheduledConflict & {
    schoolId: string;
    groupId: string;
    teacherId: string;
    scheduledDate: string;
    blockStartTime: string;
    conflictPayload: unknown;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict> {
  const now = new Date();
  const status = data.status || "coverage_needed";
  const terminal = ["ended", "expired", "skipped", "started"].includes(status);
  const [row] = await dbInstance
    .insert(classpilotScheduledConflicts)
    .values({
      ...data,
      status,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        classpilotScheduledConflicts.schoolId,
        classpilotScheduledConflicts.groupId,
        classpilotScheduledConflicts.scheduledDate,
        classpilotScheduledConflicts.blockStartTime,
      ],
      set: {
        teacherId: data.teacherId,
        blockEndTime: data.blockEndTime || null,
        status,
        conflictPayload: data.conflictPayload as any,
        scheduledTeacherConnected: data.scheduledTeacherConnected || false,
        lastCheckedAt: now,
        resolvedAt: terminal ? data.resolvedAt || now : null,
        resolvedBy: terminal ? data.resolvedBy || null : null,
        resolution: terminal ? data.resolution || status : null,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

/**
 * Create/update a coverage conflict and attach it to its canonical occurrence
 * under the same occurrence row lock. If finalization won the race, the
 * conflict is persisted as terminal and can never become an actionable card.
 */
export async function upsertScheduledClassConflictForOccurrence(
  data: InsertClasspilotScheduledConflict & {
    teachingSessionId: string;
    schoolId: string;
    groupId: string;
    teacherId: string;
    scheduledDate: string;
    blockStartTime: string;
    conflictPayload: unknown;
  },
  dbInstance: typeof db = db
): Promise<{
  conflict: ClasspilotScheduledConflict;
  occurrenceActive: boolean;
  restoredStudentIds: string[];
}> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const restoredStudentIds: string[] = [];
    const [existingConflict] = await tx
      .select({ id: classpilotScheduledConflicts.id })
      .from(classpilotScheduledConflicts)
      .where(and(
        eq(classpilotScheduledConflicts.schoolId, data.schoolId),
        eq(classpilotScheduledConflicts.groupId, data.groupId),
        eq(classpilotScheduledConflicts.scheduledDate, data.scheduledDate),
        eq(classpilotScheduledConflicts.blockStartTime, data.blockStartTime)
      ))
      .limit(1);
    const existingAssignments = existingConflict
      ? await tx
          .select({ studentId: classpilotSupervisionStudents.studentId })
          .from(classpilotSupervisionStudents)
          .innerJoin(
            classpilotSupervisionContexts,
            eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId)
          )
          .where(and(
            eq(classpilotSupervisionContexts.schoolId, data.schoolId),
            eq(classpilotSupervisionContexts.scheduledConflictId, existingConflict.id),
            eq(classpilotSupervisionContexts.status, "active"),
            isNull(classpilotSupervisionStudents.releasedAt)
          ))
      : [];
    await lockClasspilotStudentControlAuthorities(
      data.schoolId,
      existingAssignments.map((row) => row.studentId),
      transactionDb
    );
    const [occurrence] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, data.teachingSessionId),
        eq(teachingSessions.schoolId, data.schoolId)
      ))
      .limit(1)
      .for("update");
    if (!occurrence) throw new Error("Scheduled occurrence was not found while creating coverage");

    const occurrenceActive = !occurrence.endTime
      && occurrence.scheduledState === "active"
      && occurrence.sessionMode === SCHEDULED_REPORT_SESSION_MODE;
    const { teachingSessionId: _teachingSessionId, ...conflictData } = data;
    const conflict = await upsertScheduledClassConflict({
      ...conflictData,
      status: occurrenceActive ? data.status : "ended",
      resolvedAt: occurrenceActive ? null : occurrence.endTime || new Date(),
      resolution: occurrenceActive
        ? null
        : occurrence.scheduledFinalizationReason || "scheduled_end",
    }, transactionDb);

    if (occurrenceActive) {
      await tx
        .update(teachingSessions)
        .set({ scheduledConflictId: conflict.id })
        .where(and(
          eq(teachingSessions.id, occurrence.id),
          isNull(teachingSessions.endTime),
          eq(teachingSessions.scheduledState, "active")
        ));
    } else {
      const contexts = await tx
        .select({ id: classpilotSupervisionContexts.id })
        .from(classpilotSupervisionContexts)
        .where(and(
          eq(classpilotSupervisionContexts.schoolId, data.schoolId),
          eq(classpilotSupervisionContexts.scheduledConflictId, conflict.id),
          eq(classpilotSupervisionContexts.status, "active")
        ));
      const contextIds = contexts.map((context) => context.id);
      if (contextIds.length > 0) {
        const releasedAt = occurrence.endTime || new Date();
        const released = await tx
          .update(classpilotSupervisionStudents)
          .set({ releasedAt, releaseReason: "scheduled_occurrence_finalized" })
          .where(and(
            eq(classpilotSupervisionStudents.schoolId, data.schoolId),
            inArray(classpilotSupervisionStudents.contextId, contextIds),
            isNull(classpilotSupervisionStudents.releasedAt)
          ))
          .returning();
        restoredStudentIds.push(...released.map((row) => row.studentId));
        await tx
          .update(classpilotSupervisionContexts)
          .set({ status: "ended", endedAt: releasedAt, updatedAt: releasedAt })
          .where(and(
            eq(classpilotSupervisionContexts.schoolId, data.schoolId),
            inArray(classpilotSupervisionContexts.id, contextIds)
          ));
        for (const context of contexts) {
          await restoreClasspilotStudentControlStatesAfterSupervision({
            schoolId: data.schoolId,
            supervisionContextId: context.id,
            studentIds: released
              .filter((row) => row.contextId === context.id)
              .map((row) => row.studentId),
            restoredAt: releasedAt,
          }, transactionDb);
        }
      }
    }
    return { conflict, occurrenceActive, restoredStudentIds };
  });
}

const ACTIVE_SCHEDULED_COVERAGE_STATUSES = ["coverage_needed", "claimed", "pending"];
const LIVE_TEACHING_SESSION_MODE = "live";
const SCHEDULED_REPORT_SESSION_MODE = "scheduled_report";

export async function getScheduledClassConflictByIdAndSchool(
  id: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict | undefined> {
  const [row] = await dbInstance
    .select()
    .from(classpilotScheduledConflicts)
    .where(and(eq(classpilotScheduledConflicts.id, id), eq(classpilotScheduledConflicts.schoolId, schoolId)))
    .limit(1);
  return row;
}

export async function getScheduledClassConflictForSlot(
  options: { schoolId: string; groupId: string; scheduledDate: string; blockStartTime: string },
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict | undefined> {
  const [row] = await dbInstance
    .select()
    .from(classpilotScheduledConflicts)
    .where(and(
      eq(classpilotScheduledConflicts.schoolId, options.schoolId),
      eq(classpilotScheduledConflicts.groupId, options.groupId),
      eq(classpilotScheduledConflicts.scheduledDate, options.scheduledDate),
      eq(classpilotScheduledConflicts.blockStartTime, options.blockStartTime)
    ))
    .limit(1);
  return row;
}

export async function listActiveScheduledClassConflicts(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict[]> {
  return dbInstance
    .select()
    .from(classpilotScheduledConflicts)
    .where(and(
      eq(classpilotScheduledConflicts.schoolId, schoolId),
      inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
    ))
    .orderBy(desc(classpilotScheduledConflicts.lastCheckedAt), desc(classpilotScheduledConflicts.createdAt));
}

export const listPendingScheduledClassConflicts = listActiveScheduledClassConflicts;

export async function listActiveScheduledClassConflictsForTeacher(
  schoolId: string,
  teacherId: string,
  scheduledDate?: string,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict[]> {
  const conditions: SQL[] = [
    eq(classpilotScheduledConflicts.schoolId, schoolId),
    eq(classpilotScheduledConflicts.teacherId, teacherId),
    inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES),
  ];
  if (scheduledDate) conditions.push(eq(classpilotScheduledConflicts.scheduledDate, scheduledDate));
  return dbInstance
    .select()
    .from(classpilotScheduledConflicts)
    .where(and(...conditions))
    .orderBy(desc(classpilotScheduledConflicts.lastCheckedAt), desc(classpilotScheduledConflicts.createdAt));
}

export async function listActiveScheduledClassConflictsReadyToExpire(
  schoolId: string,
  scheduledDate: string,
  currentTimeHHMM: string,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict[]> {
  return dbInstance
    .select()
    .from(classpilotScheduledConflicts)
    .where(and(
      eq(classpilotScheduledConflicts.schoolId, schoolId),
      inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES),
      sql`${classpilotScheduledConflicts.blockEndTime} IS NOT NULL`,
      sql`(
        ${classpilotScheduledConflicts.scheduledDate} < ${scheduledDate}
        OR (
          ${classpilotScheduledConflicts.scheduledDate} = ${scheduledDate}
          AND ${classpilotScheduledConflicts.blockEndTime} <= ${currentTimeHHMM}
        )
      )`
    ))
    .orderBy(desc(classpilotScheduledConflicts.lastCheckedAt), desc(classpilotScheduledConflicts.createdAt));
}

export async function resolveScheduledClassConflict(
  id: string,
  schoolId: string,
  resolution: string,
  resolvedBy: string | null,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict | undefined> {
  const [row] = await dbInstance
    .update(classpilotScheduledConflicts)
    .set({
      status: resolution,
      resolution,
      resolvedBy,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(classpilotScheduledConflicts.id, id), eq(classpilotScheduledConflicts.schoolId, schoolId)))
    .returning();
  return row;
}

/** Resolve coverage as started only while its canonical occurrence is live. */
export async function resolveScheduledConflictForStartedOccurrence(
  options: {
    schoolId: string;
    teachingSessionId: string;
    scheduledConflictId: string;
    actorId?: string | null;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict | undefined> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const activeAssignments = await tx
      .select({ studentId: classpilotSupervisionStudents.studentId })
      .from(classpilotSupervisionStudents)
      .innerJoin(
        classpilotSupervisionContexts,
        eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId)
      )
      .where(and(
        eq(classpilotSupervisionContexts.schoolId, options.schoolId),
        eq(classpilotSupervisionContexts.scheduledConflictId, options.scheduledConflictId),
        eq(classpilotSupervisionContexts.status, "active"),
        isNull(classpilotSupervisionStudents.releasedAt)
      ));
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      activeAssignments.map((row) => row.studentId),
      transactionDb
    );
    const [occurrence] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.teachingSessionId),
        eq(teachingSessions.schoolId, options.schoolId)
      ))
      .limit(1)
      .for("update");
    if (
      !occurrence
      || occurrence.endTime
      || occurrence.scheduledState !== "active"
      || occurrence.sessionMode !== LIVE_TEACHING_SESSION_MODE
    ) return undefined;

    const [conflict] = await tx
      .select()
      .from(classpilotScheduledConflicts)
      .where(and(
        eq(classpilotScheduledConflicts.id, options.scheduledConflictId),
        eq(classpilotScheduledConflicts.schoolId, options.schoolId),
        inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
      ))
      .limit(1)
      .for("update");
    if (!conflict) return undefined;

    const endedAt = new Date();
    const contexts = await tx
      .select({ id: classpilotSupervisionContexts.id })
      .from(classpilotSupervisionContexts)
      .where(and(
        eq(classpilotSupervisionContexts.schoolId, options.schoolId),
        eq(classpilotSupervisionContexts.scheduledConflictId, conflict.id),
        eq(classpilotSupervisionContexts.status, "active")
      ));
    const contextIds = contexts.map((context) => context.id);
    if (contextIds.length > 0) {
      const released = await tx
        .update(classpilotSupervisionStudents)
        .set({ releasedAt: endedAt, releaseReason: "scheduled_teacher_started" })
        .where(and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          inArray(classpilotSupervisionStudents.contextId, contextIds),
          isNull(classpilotSupervisionStudents.releasedAt)
        ))
        .returning();
      await tx
        .update(classpilotSupervisionContexts)
        .set({ status: "ended", endedAt, updatedAt: endedAt })
        .where(and(
          eq(classpilotSupervisionContexts.schoolId, options.schoolId),
          inArray(classpilotSupervisionContexts.id, contextIds)
        ));
      for (const context of contexts) {
        await restoreClasspilotStudentControlStatesAfterSupervision({
          schoolId: options.schoolId,
          supervisionContextId: context.id,
          studentIds: released
            .filter((row) => row.contextId === context.id)
            .map((row) => row.studentId),
          restoredAt: endedAt,
        }, transactionDb);
      }
    }

    const [resolved] = await tx
      .update(classpilotScheduledConflicts)
      .set({
        status: "started",
        resolution: "started",
        resolvedBy: options.actorId || null,
        resolvedAt: endedAt,
        updatedAt: endedAt,
      })
      .where(and(
        eq(classpilotScheduledConflicts.id, conflict.id),
        eq(classpilotScheduledConflicts.schoolId, options.schoolId),
        inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
      ))
      .returning();
    return resolved;
  });
}

export async function updateScheduledClassConflictStatus(
  id: string,
  schoolId: string,
  status: string,
  conflictPayload?: unknown,
  dbInstance: typeof db = db
): Promise<ClasspilotScheduledConflict | undefined> {
  const data: Partial<InsertClasspilotScheduledConflict> & { updatedAt: Date; lastCheckedAt: Date } = {
    status,
    updatedAt: new Date(),
    lastCheckedAt: new Date(),
  };
  if (conflictPayload !== undefined) data.conflictPayload = conflictPayload as any;
  const [row] = await dbInstance
    .update(classpilotScheduledConflicts)
    .set(data)
    .where(and(
      eq(classpilotScheduledConflicts.id, id),
      eq(classpilotScheduledConflicts.schoolId, schoolId),
      status === "claimed"
        ? inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
        : sql`true`
    ))
    .returning();
  return row;
}

export async function getActiveTeachingSessions(
  schoolId: string
): Promise<TeachingSession[]> {
  return db
    .select({
      id: teachingSessions.id,
      groupId: teachingSessions.groupId,
      teacherId: teachingSessions.teacherId,
      schoolId: teachingSessions.schoolId,
      startTime: teachingSessions.startTime,
      controlUpdatedAt: teachingSessions.controlUpdatedAt,
      sessionMode: teachingSessions.sessionMode,
      scheduledConflictId: teachingSessions.scheduledConflictId,
      scheduledDate: teachingSessions.scheduledDate,
      scheduledTimezone: teachingSessions.scheduledTimezone,
      scheduledStartAt: teachingSessions.scheduledStartAt,
      scheduledEndAt: teachingSessions.scheduledEndAt,
      scheduledState: teachingSessions.scheduledState,
      scheduledFinalizationReason: teachingSessions.scheduledFinalizationReason,
      scheduledTeacherEmail: teachingSessions.scheduledTeacherEmail,
      scheduledTeacherName: teachingSessions.scheduledTeacherName,
      classNameSnapshot: teachingSessions.classNameSnapshot,
      timezoneSnapshot: teachingSessions.timezoneSnapshot,
      rosterSnapshotCompletedAt: teachingSessions.rosterSnapshotCompletedAt,
      endTime: teachingSessions.endTime,
      createdAt: teachingSessions.createdAt,
    })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        or(
          eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
          eq(teachingSessions.scheduledState, "active")
        ),
        isNull(teachingSessions.endTime)
      )
    );
}

export async function getActiveTeachingSession(
  teacherId: string
): Promise<TeachingSession | undefined> {
  const [session] = await db
    .select()
    .from(teachingSessions)
    .where(
      and(
        eq(teachingSessions.teacherId, teacherId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNull(teachingSessions.endTime)
      )
    )
    .limit(1);
  return session;
}

// School-scoped active session visible to immutable session staff. Prefer a
// session the caller owns when a co-teacher is captured on more than one open
// class, then choose the most recently started session deterministically.
export async function getActiveTeachingSessionForSchool(
  staffId: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [row] = await dbInstance
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .innerJoin(classpilotSessionStaff, and(
      eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
      eq(classpilotSessionStaff.schoolId, schoolId),
      eq(classpilotSessionStaff.staffId, staffId)
    ))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNull(teachingSessions.endTime)
      )
    )
    .orderBy(
      sql`CASE WHEN ${teachingSessions.teacherId} = ${staffId} THEN 0 ELSE 1 END`,
      desc(teachingSessions.startTime),
      teachingSessions.id
    )
    .limit(1);
  return row?.session;
}

export async function listOtherActiveTeachingSessionsForSchool(
  teacherId: string,
  schoolId: string,
  excludeSessionId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession[]> {
  const rows = await dbInstance
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(and(
      eq(teachingSessions.teacherId, teacherId),
      eq(groups.schoolId, schoolId),
      eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
      isNull(teachingSessions.endTime),
      ne(teachingSessions.id, excludeSessionId)
    ))
    .orderBy(teachingSessions.startTime, teachingSessions.id);
  return rows.map((row) => row.session);
}

export async function getTeachingSessionById(
  sessionId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [session] = await dbInstance
    .select()
    .from(teachingSessions)
    .where(eq(teachingSessions.id, sessionId))
    .limit(1);
  return session;
}

// Returns the session only if it belongs to the given school.
export async function getTeachingSessionByIdAndSchool(
  sessionId: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [session] = await dbInstance
    .select()
    .from(teachingSessions)
    .where(and(
      eq(teachingSessions.id, sessionId),
      eq(teachingSessions.schoolId, schoolId)
    ))
    .limit(1);
  return session;
}

export async function getActiveTeachingSessionsForStudent(
  schoolId: string,
  studentId: string
): Promise<TeachingSession[]> {
  const owner = await getActiveClassOwnerForStudent(schoolId, studentId);
  return owner ? [owner.session] : [];
}

export type ActiveClassOwner = {
  studentId: string;
  session: TeachingSession;
  groupId: string;
  groupName: string;
};

export async function getActiveClassOwnersForStudents(
  schoolId: string,
  studentIds: string[],
  dbInstance: typeof db = db
): Promise<ActiveClassOwner[]> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))];
  if (uniqueStudentIds.length === 0) return [];

  const snapshotRows = await dbInstance
    .select({
      studentId: classpilotSessionStudents.studentId,
      groupId: groups.id,
      groupName: groups.name,
      session: teachingSessions,
    })
    .from(classpilotSessionStudents)
    .innerJoin(
      teachingSessions,
      and(
        eq(teachingSessions.id, classpilotSessionStudents.teachingSessionId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNotNull(teachingSessions.rosterSnapshotCompletedAt),
        isNull(teachingSessions.endTime)
      )
    )
    .innerJoin(groups, eq(groups.id, teachingSessions.groupId))
    .where(
      and(
        eq(classpilotSessionStudents.schoolId, schoolId),
        eq(groups.schoolId, schoolId),
        inArray(classpilotSessionStudents.studentId, uniqueStudentIds)
      )
    );

  // Rollout fallback only: pre-snapshot open sessions continue to use the
  // mutable group roster until the startup bridge marks their snapshot done.
  const legacyRows = await dbInstance
    .select({
      studentId: groupStudents.studentId,
      groupId: groups.id,
      groupName: groups.name,
      session: teachingSessions,
    })
    .from(groupStudents)
    .innerJoin(groups, eq(groups.id, groupStudents.groupId))
    .innerJoin(teachingSessions, and(
      eq(teachingSessions.groupId, groups.id),
      eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
      isNull(teachingSessions.rosterSnapshotCompletedAt),
      isNull(teachingSessions.endTime)
    ))
    .where(and(
      eq(groups.schoolId, schoolId),
      inArray(groupStudents.studentId, uniqueStudentIds)
    ));

  const rows = [...snapshotRows, ...legacyRows].sort((a, b) => {
    const aControl = (a.session.controlUpdatedAt || a.session.startTime).getTime();
    const bControl = (b.session.controlUpdatedAt || b.session.startTime).getTime();
    return bControl - aControl
      || b.session.startTime.getTime() - a.session.startTime.getTime()
      || b.session.createdAt.getTime() - a.session.createdAt.getTime()
      || b.session.id.localeCompare(a.session.id);
  });

  const owners = new Map<string, ActiveClassOwner>();
  for (const row of rows) {
    if (owners.has(row.studentId)) continue;
    owners.set(row.studentId, {
      studentId: row.studentId,
      session: row.session,
      groupId: row.groupId,
      groupName: row.groupName,
    });
  }
  return [...owners.values()];
}

export async function getActiveClassOwnerForStudent(
  schoolId: string,
  studentId: string,
  dbInstance: typeof db = db
): Promise<ActiveClassOwner | undefined> {
  const [owner] = await getActiveClassOwnersForStudents(schoolId, [studentId], dbInstance);
  return owner;
}

export async function getTeachingSessionForStudent(
  schoolId: string,
  sessionId: string,
  studentId: string
): Promise<TeachingSession | undefined> {
  const owner = await getActiveClassOwnerForStudent(schoolId, studentId);
  return owner?.session.id === sessionId ? owner.session : undefined;
}

export async function getSessionSettings(
  sessionId: string
): Promise<SessionSetting | undefined> {
  const [settings] = await db
    .select()
    .from(sessionSettings)
    .where(eq(sessionSettings.sessionId, sessionId))
    .limit(1);
  return settings;
}

export async function upsertSessionSettings(
  sessionId: string,
  data: { chatEnabled?: boolean; raiseHandEnabled?: boolean }
): Promise<SessionSetting> {
  const [row] = await db
    .insert(sessionSettings)
    .values({ sessionId, ...data })
    .onConflictDoUpdate({
      target: sessionSettings.sessionId,
      set: data,
    })
    .returning();
  return row!;
}

// ============================================================================
// ClassPilot - Scheduled class block helpers
// ============================================================================

export async function getScheduledGroupsReadyToStart(
  schoolId: string,
  currentTimeHHMM: string,
  todayDate: string,
  dbInstance: typeof db = db
): Promise<Group[]> {
  return dbInstance
    .select({
      id: groups.id,
      schoolId: groups.schoolId,
      teacherId: groups.teacherId,
      name: groups.name,
      description: groups.description,
      periodLabel: groups.periodLabel,
      gradeLevel: groups.gradeLevel,
      groupType: groups.groupType,
      parentGroupId: groups.parentGroupId,
      status: groups.status,
      archivedAt: groups.archivedAt,
      schoolYear: groups.schoolYear,
      term: groups.term,
      googleClassroomCourseId: groups.googleClassroomCourseId,
      scheduleEnabled: groups.scheduleEnabled,
      blockStartTime: groups.blockStartTime,
      blockEndTime: groups.blockEndTime,
      scheduleSkippedDate: groups.scheduleSkippedDate,
      createdAt: groups.createdAt,
    })
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.scheduleEnabled, true),
        sql`${groups.blockStartTime} IS NOT NULL`,
        sql`${groups.blockEndTime} IS NOT NULL`,
        sql`${groups.blockStartTime} <= ${currentTimeHHMM}`,
        sql`${groups.blockEndTime} > ${currentTimeHHMM}`,
        or(
          isNull(groups.scheduleSkippedDate),
          ne(groups.scheduleSkippedDate, todayDate)
        )
      )
    )
    .orderBy(groups.blockStartTime, groups.id);
}

export async function getScheduledGroupsReadyToEnd(
  schoolId: string,
  currentTimeHHMM: string,
  dbInstance: typeof db = db
): Promise<(Group & { sessionId: string; sessionMode: string })[]> {
  const rows = await dbInstance
    .select({
      id: groups.id,
      schoolId: groups.schoolId,
      teacherId: groups.teacherId,
      name: groups.name,
      description: groups.description,
      periodLabel: groups.periodLabel,
      gradeLevel: groups.gradeLevel,
      groupType: groups.groupType,
      parentGroupId: groups.parentGroupId,
      scheduleEnabled: groups.scheduleEnabled,
      blockStartTime: groups.blockStartTime,
      blockEndTime: groups.blockEndTime,
      scheduleSkippedDate: groups.scheduleSkippedDate,
      createdAt: groups.createdAt,
      sessionId: teachingSessions.id,
      sessionMode: teachingSessions.sessionMode,
    })
    .from(groups)
    .innerJoin(
      teachingSessions,
      and(
        eq(teachingSessions.groupId, groups.id),
        isNull(teachingSessions.endTime)
      )
    )
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.scheduleEnabled, true),
        sql`${groups.blockEndTime} IS NOT NULL`,
        sql`${groups.blockEndTime} <= ${currentTimeHHMM}`
      )
    );
  return rows as (Group & { sessionId: string; sessionMode: string })[];
}

export async function setScheduleSkippedDate(
  groupId: string,
  date: string | null
): Promise<void> {
  await db
    .update(groups)
    .set({ scheduleSkippedDate: date })
    .where(eq(groups.id, groupId));
}

export async function hasActiveSessionForGroup(
  groupId: string,
  dbInstance: typeof db = db
): Promise<boolean> {
  const [row] = await dbInstance
    .select({ id: teachingSessions.id })
    .from(teachingSessions)
    .where(
      and(
        eq(teachingSessions.groupId, groupId),
        eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
        isNull(teachingSessions.endTime)
      )
    )
    .limit(1);
  return !!row;
}

// ============================================================================
// ClassPilot - Group operations
// ============================================================================

export async function getGroupsBySchool(
  schoolId: string
): Promise<Group[]> {
  return db
    .select()
    .from(groups)
    .where(eq(groups.schoolId, schoolId))
    .orderBy(groups.name);
}

export type AdminClassSummary = Group & {
  studentCount: number;
};

export type GroupTeacherSummary = {
  id: string;
  teacherId: string;
  relationshipRole: string;
  assignedAt: Date;
  teacher: {
    id: string;
    email: string;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    role: string | null;
  };
};

export async function getAdminClassSummariesBySchool(
  schoolId: string,
  options: {
    status?: string;
    schoolYear?: string;
    term?: string;
    search?: string;
  } = {}
): Promise<AdminClassSummary[]> {
  const conditions: SQL[] = [
    eq(groups.schoolId, schoolId),
    eq(groups.groupType, "admin_class"),
  ];
  if (options.status && options.status !== "all") {
    conditions.push(eq(groups.status, options.status));
  }
  if (options.schoolYear) conditions.push(eq(groups.schoolYear, options.schoolYear));
  if (options.term) conditions.push(eq(groups.term, options.term));
  if (options.search?.trim()) {
    const pattern = `%${options.search.trim()}%`;
    conditions.push(
      or(
        ilike(groups.name, pattern),
        ilike(groups.periodLabel, pattern),
        ilike(groups.gradeLevel, pattern)
      )!
    );
  }

  return db
    .select({
      id: groups.id,
      schoolId: groups.schoolId,
      teacherId: groups.teacherId,
      name: groups.name,
      description: groups.description,
      periodLabel: groups.periodLabel,
      gradeLevel: groups.gradeLevel,
      groupType: groups.groupType,
      parentGroupId: groups.parentGroupId,
      status: groups.status,
      archivedAt: groups.archivedAt,
      schoolYear: groups.schoolYear,
      term: groups.term,
      googleClassroomCourseId: groups.googleClassroomCourseId,
      scheduleEnabled: groups.scheduleEnabled,
      blockStartTime: groups.blockStartTime,
      blockEndTime: groups.blockEndTime,
      scheduleSkippedDate: groups.scheduleSkippedDate,
      createdAt: groups.createdAt,
      studentCount: sql<number>`COUNT(DISTINCT ${students.id})::int`,
    })
    .from(groups)
    .leftJoin(groupStudents, eq(groupStudents.groupId, groups.id))
    .leftJoin(
      students,
      and(
        eq(students.id, groupStudents.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(and(...conditions))
    .groupBy(
      groups.id,
      groups.schoolId,
      groups.teacherId,
      groups.name,
      groups.description,
      groups.periodLabel,
      groups.gradeLevel,
      groups.groupType,
      groups.parentGroupId,
      groups.status,
      groups.archivedAt,
      groups.schoolYear,
      groups.term,
      groups.googleClassroomCourseId,
      groups.scheduleEnabled,
      groups.blockStartTime,
      groups.blockEndTime,
      groups.scheduleSkippedDate,
      groups.createdAt
    )
    .orderBy(asc(groups.status), asc(groups.name));
}

export async function getGroupsByTeacher(
  teacherId: string
): Promise<Group[]> {
  const primaryGroups = await db
    .select()
    .from(groups)
    .where(eq(groups.teacherId, teacherId));
  const coTeacherRows = await db
    .select({ group: groups })
    .from(groupTeachers)
    .innerJoin(groups, eq(groups.id, groupTeachers.groupId))
    .where(eq(groupTeachers.teacherId, teacherId))
    .orderBy(groups.name);
  return dedupeAndSortGroups(primaryGroups, coTeacherRows.map((r) => r.group));
}

// School-scoped — a teacher's groups in a specific school only (so a multi-school
// teacher's group list is partitioned by the school context they're viewing).
export async function getGroupsByTeacherAndSchool(
  teacherId: string,
  schoolId: string
): Promise<Group[]> {
  const primaryGroups = await db
    .select()
    .from(groups)
    .where(and(eq(groups.teacherId, teacherId), eq(groups.schoolId, schoolId)));
  const coTeacherRows = await db
    .select({ group: groups })
    .from(groupTeachers)
    .innerJoin(groups, eq(groups.id, groupTeachers.groupId))
    .where(and(eq(groupTeachers.teacherId, teacherId), eq(groups.schoolId, schoolId)))
    .orderBy(groups.name);
  return dedupeAndSortGroups(primaryGroups, coTeacherRows.map((r) => r.group));
}

function dedupeAndSortGroups(...lists: Group[][]): Group[] {
  const byId = new Map<string, Group>();
  for (const list of lists) {
    for (const group of list) {
      byId.set(group.id, group);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Group Teachers (co-teacher support)
// ============================================================================

async function withPasspilotGroupMutationLock<T>(
  groupId: string,
  operation: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    group: { id: string; schoolId: string }
  ) => Promise<T>
): Promise<T> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: groups.id, schoolId: groups.schoolId })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (!candidate) {
      throw schoolIsolationError("CLASS_NOT_FOUND", "Class not found", 404);
    }
    await lockClasspilotScheduleChangeSchool(
      candidate.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, candidate.schoolId);
    const [lockedGroup] = await tx
      .select({ id: groups.id, schoolId: groups.schoolId })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, candidate.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedGroup) {
      throw schoolIsolationError("CLASS_NOT_FOUND", "Class not found", 404);
    }
    return operation(tx, lockedGroup);
  });
}

export async function getGroupTeachers(
  groupId: string
): Promise<GroupTeacher[]> {
  return db
    .select()
    .from(groupTeachers)
    .where(eq(groupTeachers.groupId, groupId))
    .orderBy(groupTeachers.role, groupTeachers.assignedAt);
}

export async function getGroupTeacherSummaries(
  groupId: string,
  schoolId: string
): Promise<GroupTeacherSummary[]> {
  const rows = await db
    .select({
      id: groupTeachers.id,
      teacherId: groupTeachers.teacherId,
      relationshipRole: groupTeachers.role,
      assignedAt: groupTeachers.assignedAt,
      teacherIdValue: users.id,
      email: users.email,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      membershipRole: schoolMemberships.role,
    })
    .from(groupTeachers)
    .innerJoin(users, eq(users.id, groupTeachers.teacherId))
    .leftJoin(
      schoolMemberships,
      and(
        eq(schoolMemberships.userId, users.id),
        eq(schoolMemberships.schoolId, schoolId)
      )
    )
    .where(eq(groupTeachers.groupId, groupId))
    .orderBy(groupTeachers.role, users.lastName, users.firstName, users.email);

  return rows.map((row) => ({
    id: row.id,
    teacherId: row.teacherId,
    relationshipRole: row.relationshipRole,
    assignedAt: row.assignedAt,
    teacher: {
      id: row.teacherIdValue,
      email: row.email,
      displayName: row.displayName,
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.membershipRole,
    },
  }));
}

export async function addGroupTeacher(
  groupId: string,
  teacherId: string,
  role: string = "co-teacher",
  scheduleChangeActorId?: string
): Promise<GroupTeacher> {
  return withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId,
      addedTeacherIds: [teacherId],
      actorId: scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    const [row] = await tx
      .insert(groupTeachers)
      .values({ groupId, teacherId, role })
      .onConflictDoNothing()
      .returning();
    return row!;
  });
}

export async function replaceGroupTeachers(
  groupId: string,
  primaryTeacherId: string,
  coTeacherIds: string[],
  scheduleChangeActorId?: string
): Promise<void> {
  const uniqueCoTeachers = Array.from(
    new Set(coTeacherIds.filter((id) => id && id !== primaryTeacherId))
  );
  await withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    const existing = await tx
      .select({ teacherId: groupTeachers.teacherId })
      .from(groupTeachers)
      .where(eq(groupTeachers.groupId, groupId));
    const existingIds = new Set(existing.map((row) => row.teacherId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId,
      addedTeacherIds: [primaryTeacherId, ...uniqueCoTeachers].filter(
        (teacherId) => !existingIds.has(teacherId)
      ),
      actorId: scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    await tx
      .delete(groupTeachers)
      .where(eq(groupTeachers.groupId, groupId));
    await tx.insert(groupTeachers).values([
      { groupId, teacherId: primaryTeacherId, role: "primary" },
      ...uniqueCoTeachers.map((teacherId) => ({
        groupId,
        teacherId,
        role: "co-teacher",
      })),
    ]);
  });
}

export async function removeGroupTeacher(
  groupId: string,
  teacherId: string
): Promise<boolean> {
  return withPasspilotGroupMutationLock(groupId, async (tx) => {
    const result = await tx
      .delete(groupTeachers)
      .where(
        and(eq(groupTeachers.groupId, groupId), eq(groupTeachers.teacherId, teacherId))
      );
    return (result.rowCount ?? 0) > 0;
  });
}

// ============================================================================
// Homeroom Teachers (co-teacher support)
// ============================================================================

export async function getHomeroomTeachers(
  homeroomId: string
): Promise<HomeroomTeacher[]> {
  return db
    .select()
    .from(homeroomTeachers)
    .where(eq(homeroomTeachers.homeroomId, homeroomId))
    .orderBy(homeroomTeachers.role, homeroomTeachers.assignedAt);
}

export async function addHomeroomTeacher(
  homeroomId: string,
  teacherId: string,
  role: string = "co-teacher"
): Promise<HomeroomTeacher> {
  const homeroom = await getHomeroomById(homeroomId);
  if (!homeroom) throw new Error("Homeroom not found");
  await assertActiveSchoolStaffMembership(teacherId, homeroom.schoolId);
  const [row] = await db
    .insert(homeroomTeachers)
    .values({ schoolId: homeroom.schoolId, homeroomId, teacherId, role })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(homeroomTeachers)
    .where(
      and(
        eq(homeroomTeachers.schoolId, homeroom.schoolId),
        eq(homeroomTeachers.homeroomId, homeroomId),
        eq(homeroomTeachers.teacherId, teacherId)
      )
    )
    .limit(1);
  return existing!;
}

export async function removeHomeroomTeacher(
  homeroomId: string,
  teacherId: string
): Promise<boolean> {
  const result = await db
    .delete(homeroomTeachers)
    .where(
      and(eq(homeroomTeachers.homeroomId, homeroomId), eq(homeroomTeachers.teacherId, teacherId))
    );
  return (result.rowCount ?? 0) > 0;
}

export async function getGroupById(
  groupId: string,
  dbInstance: typeof db = db
): Promise<Group | undefined> {
  const [group] = await dbInstance
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  return group;
}

// School-scoped variant — enforces multi-tenant isolation in the WHERE clause.
// Use this in every handler that takes a groupId from the URL/body so a caller
// can never read/mutate another school's group by guessing an id.
export async function getGroupByIdAndSchool(
  groupId: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<Group | undefined> {
  const [group] = await dbInstance
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.schoolId, schoolId)))
    .limit(1);
  return group;
}

// Returns the subgroup only if it belongs to the given school.
export async function getSubgroupByIdAndSchool(
  subgroupId: string,
  schoolId: string
): Promise<Subgroup | undefined> {
  const [row] = await db
    .select({ subgroup: subgroups })
    .from(subgroups)
    .innerJoin(groups, eq(subgroups.groupId, groups.id))
    .where(and(eq(subgroups.id, subgroupId), eq(groups.schoolId, schoolId)))
    .limit(1);
  return row?.subgroup;
}

async function assertNoLockedRecurringClassScheduleOverlap(options: {
  schoolId: string;
  excludeGroupId?: string | null;
  status: string;
  scheduleEnabled: boolean;
  blockStartTime: string | null;
  blockEndTime: string | null;
  teacherIds: string[];
  dbInstance: ScheduleChangeDb;
}): Promise<void> {
  const teacherIds = Array.from(new Set(options.teacherIds.filter(Boolean)));
  if (
    options.status !== "active" ||
    !options.scheduleEnabled ||
    !options.blockStartTime ||
    !options.blockEndTime ||
    teacherIds.length === 0
  ) {
    return;
  }
  const conditions: SQL[] = [
    eq(groups.schoolId, options.schoolId),
    eq(groups.status, "active"),
    eq(groups.scheduleEnabled, true),
    isNotNull(groups.blockStartTime),
    isNotNull(groups.blockEndTime),
    sql`${groups.blockStartTime} < ${options.blockEndTime}`,
    sql`${groups.blockEndTime} > ${options.blockStartTime}`,
    or(
      inArray(groups.teacherId, teacherIds),
      inArray(groupTeachers.teacherId, teacherIds)
    )!,
  ];
  if (options.excludeGroupId) {
    conditions.push(ne(groups.id, options.excludeGroupId));
  }
  const [conflict] = await options.dbInstance
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(and(...conditions))
    .limit(1);
  if (conflict) {
    throw schoolIsolationError(
      "CLASS_SCHEDULE_CONFLICT",
      "A selected teacher is already assigned to an overlapping scheduled class.",
      409
    );
  }
}

export async function createGroup(
  data: InsertGroup
): Promise<Group> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const transactionDb = tx as unknown as ScheduleChangeDb;
    await lockClasspilotScheduleChangeSchool(data.schoolId, transactionDb);
    await takePasspilotClassLock(tx, data.schoolId);
    await assertNoLockedRecurringClassScheduleOverlap({
      schoolId: data.schoolId,
      status: data.status ?? "active",
      scheduleEnabled: data.scheduleEnabled ?? false,
      blockStartTime: data.blockStartTime ?? null,
      blockEndTime: data.blockEndTime ?? null,
      teacherIds: [data.teacherId],
      dbInstance: transactionDb,
    });
    const [group] = await tx.insert(groups).values(data).returning();
    if (!group) throw new Error("Class could not be created");
    if (
      group.status === "active" &&
      group.scheduleEnabled &&
      group.blockStartTime &&
      group.blockEndTime
    ) {
      await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
        schoolId: data.schoolId,
        groupId: group.id,
        addedTeacherIds: [group.teacherId],
        dbInstance: transactionDb,
      });
    }
    return group;
  });
}

export async function findOverlappingScheduledAdminClass(options: {
  schoolId: string;
  teacherId: string;
  blockStartTime: string;
  blockEndTime: string;
  excludeGroupId?: string;
}): Promise<Group | undefined> {
  const conditions: SQL[] = [
    eq(groups.schoolId, options.schoolId),
    eq(groups.teacherId, options.teacherId),
    eq(groups.groupType, "admin_class"),
    eq(groups.status, "active"),
    eq(groups.scheduleEnabled, true),
    sql`${groups.blockStartTime} IS NOT NULL`,
    sql`${groups.blockEndTime} IS NOT NULL`,
    sql`${groups.blockStartTime} < ${options.blockEndTime}`,
    sql`${groups.blockEndTime} > ${options.blockStartTime}`,
  ];
  if (options.excludeGroupId) {
    conditions.push(ne(groups.id, options.excludeGroupId));
  }
  const [group] = await db
    .select()
    .from(groups)
    .where(and(...conditions))
    .limit(1);
  return group;
}

export async function updateGroup(
  groupId: string,
  data: Partial<InsertGroup>,
  scheduleChangeActorId?: string
): Promise<Group | undefined> {
  return withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    const [current] = await tx
      .select()
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, lockedGroup.schoolId)))
      .limit(1);
    if (!current) return undefined;
    const scheduleIdentityChanged =
      (data.teacherId !== undefined && data.teacherId !== current.teacherId) ||
      (data.scheduleEnabled !== undefined && data.scheduleEnabled !== current.scheduleEnabled) ||
      (data.blockStartTime !== undefined && data.blockStartTime !== current.blockStartTime) ||
      (data.blockEndTime !== undefined && data.blockEndTime !== current.blockEndTime) ||
      (data.status !== undefined && data.status !== current.status);
    if (scheduleIdentityChanged) {
      const transactionDb = tx as unknown as ScheduleChangeDb;
      const assignedTeachers = await tx
        .select({ teacherId: groupTeachers.teacherId })
        .from(groupTeachers)
        .where(eq(groupTeachers.groupId, groupId));
      await assertNoLockedRecurringClassScheduleOverlap({
        schoolId: lockedGroup.schoolId,
        excludeGroupId: groupId,
        status: data.status ?? current.status,
        scheduleEnabled: data.scheduleEnabled ?? current.scheduleEnabled,
        blockStartTime:
          data.blockStartTime !== undefined ? data.blockStartTime : current.blockStartTime,
        blockEndTime:
          data.blockEndTime !== undefined ? data.blockEndTime : current.blockEndTime,
        teacherIds: [
          data.teacherId ?? current.teacherId,
          ...assignedTeachers.map((row) => row.teacherId),
        ],
        dbInstance: transactionDb,
      });
      await assertNoApprovedFutureScheduleChange({
        schoolId: lockedGroup.schoolId,
        groupId,
        prospectiveGroup: {
          teacherId: data.teacherId ?? current.teacherId,
          scheduleEnabled: data.scheduleEnabled ?? current.scheduleEnabled,
          blockStartTime:
            data.blockStartTime !== undefined ? data.blockStartTime : current.blockStartTime,
          blockEndTime:
            data.blockEndTime !== undefined ? data.blockEndTime : current.blockEndTime,
          status: data.status ?? current.status,
        },
        actorId: scheduleChangeActorId,
        dbInstance: transactionDb,
      });
      await supersedePendingScheduleChangesForGroup({
        schoolId: lockedGroup.schoolId,
        groupId,
        actorId: scheduleChangeActorId,
        reason: "class_configuration_changed",
        dbInstance: transactionDb,
      });
    }
    const [group] = await tx
      .update(groups)
      .set(data)
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, lockedGroup.schoolId)))
      .returning();
    return group;
  });
}

export async function updateAdminClassWithTeachers(options: {
  groupId: string;
  data: Partial<InsertGroup>;
  /** Undefined preserves the primary teacher read under the class lock. */
  primaryTeacherId?: string;
  /** Undefined preserves co-teachers; an explicit empty array clears them. */
  coTeacherIds?: string[];
  scheduleChangeActorId?: string;
}): Promise<Group | undefined> {
  return withPasspilotGroupMutationLock(options.groupId, async (tx, lockedGroup) => {
    const [current] = await tx
      .select()
      .from(groups)
      .where(
        and(eq(groups.id, options.groupId), eq(groups.schoolId, lockedGroup.schoolId))
      )
      .limit(1);
    if (!current) return undefined;
    const existingTeacherRows = await tx
      .select({ teacherId: groupTeachers.teacherId, role: groupTeachers.role })
      .from(groupTeachers)
      .where(eq(groupTeachers.groupId, options.groupId));
    const primaryTeacherId = options.primaryTeacherId ?? current.teacherId;
    const submittedCoTeachers = options.coTeacherIds === undefined
      ? existingTeacherRows
          .filter((row) => row.role === "co-teacher")
          .map((row) => row.teacherId)
      : options.coTeacherIds;
    const uniqueCoTeachers = Array.from(
      new Set(submittedCoTeachers.filter((id) => id && id !== primaryTeacherId))
    );
    const intendedTeacherIds = [primaryTeacherId, ...uniqueCoTeachers];
    const activeMemberships = await tx
      .select({ userId: schoolMemberships.userId })
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.schoolId, lockedGroup.schoolId),
          eq(schoolMemberships.status, "active"),
          inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]),
          inArray(schoolMemberships.userId, intendedTeacherIds)
        )
      );
    if (new Set(activeMemberships.map((row) => row.userId)).size !== intendedTeacherIds.length) {
      throw schoolIsolationError(
        "CLASS_TEACHER_NOT_FOUND",
        "One or more teachers are unavailable in this school.",
        404
      );
    }
    const scheduleIdentityChanged =
      primaryTeacherId !== current.teacherId ||
      (options.data.scheduleEnabled !== undefined &&
        options.data.scheduleEnabled !== current.scheduleEnabled) ||
      (options.data.blockStartTime !== undefined &&
        options.data.blockStartTime !== current.blockStartTime) ||
      (options.data.blockEndTime !== undefined &&
        options.data.blockEndTime !== current.blockEndTime) ||
      (options.data.status !== undefined && options.data.status !== current.status);
    if (
      scheduleIdentityChanged ||
      options.primaryTeacherId !== undefined ||
      options.coTeacherIds !== undefined
    ) {
      await assertNoLockedRecurringClassScheduleOverlap({
        schoolId: lockedGroup.schoolId,
        excludeGroupId: options.groupId,
        status: options.data.status ?? current.status,
        scheduleEnabled: options.data.scheduleEnabled ?? current.scheduleEnabled,
        blockStartTime:
          options.data.blockStartTime !== undefined
            ? options.data.blockStartTime
            : current.blockStartTime,
        blockEndTime:
          options.data.blockEndTime !== undefined
            ? options.data.blockEndTime
            : current.blockEndTime,
        teacherIds: intendedTeacherIds,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
    }
    if (scheduleIdentityChanged) {
      const transactionDb = tx as unknown as ScheduleChangeDb;
      await assertNoApprovedFutureScheduleChange({
        schoolId: lockedGroup.schoolId,
        groupId: options.groupId,
        prospectiveGroup: {
          teacherId: primaryTeacherId,
          scheduleEnabled: options.data.scheduleEnabled ?? current.scheduleEnabled,
          blockStartTime:
            options.data.blockStartTime !== undefined
              ? options.data.blockStartTime
              : current.blockStartTime,
          blockEndTime:
            options.data.blockEndTime !== undefined
              ? options.data.blockEndTime
              : current.blockEndTime,
          status: options.data.status ?? current.status,
        },
        prospectiveTeacherIds: intendedTeacherIds,
        actorId: options.scheduleChangeActorId,
        dbInstance: transactionDb,
      });
      await supersedePendingScheduleChangesForGroup({
        schoolId: lockedGroup.schoolId,
        groupId: options.groupId,
        actorId: options.scheduleChangeActorId,
        reason: "class_configuration_changed",
        dbInstance: transactionDb,
      });
    }
    const existingTeacherIds = new Set(existingTeacherRows.map((row) => row.teacherId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId: options.groupId,
      addedTeacherIds: intendedTeacherIds.filter(
        (teacherId) => !existingTeacherIds.has(teacherId)
      ),
      actorId: options.scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    const [group] = await tx
      .update(groups)
      .set({
        ...options.data,
        teacherId: primaryTeacherId,
      })
      .where(and(eq(groups.id, options.groupId), eq(groups.schoolId, lockedGroup.schoolId)))
      .returning();
    if (!group) return undefined;

    if (options.primaryTeacherId !== undefined || options.coTeacherIds !== undefined) {
      await tx
        .delete(groupTeachers)
        .where(eq(groupTeachers.groupId, options.groupId));
      await tx.insert(groupTeachers).values([
        {
          groupId: options.groupId,
          teacherId: primaryTeacherId,
          role: "primary",
        },
        ...uniqueCoTeachers.map((teacherId) => ({
          groupId: options.groupId,
          teacherId,
          role: "co-teacher",
        })),
      ]);
    }
    return group;
  });
}

export async function upsertAdminClassroomClass(options: {
  schoolId: string;
  existingGroupId?: string | null;
  data: Partial<InsertGroup>;
  /** Undefined preserves the locked current primary teacher on update. */
  primaryTeacherId?: string;
  /** Undefined preserves the locked current co-teachers on update. */
  coTeacherIds?: string[];
  studentIds?: string[];
  replaceStudentRoster?: boolean;
  requireAdminClass?: boolean;
  scheduleChangeActorId?: string;
}): Promise<{
  group: Group;
  roster: {
    added: string[];
    alreadyPresent: string[];
  };
}> {
  const submittedStudentIds = options.studentIds === undefined
    ? undefined
    : Array.from(new Set(options.studentIds.filter(Boolean)));

  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    await lockClasspilotScheduleChangeSchool(
      options.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, options.schoolId);
    let lockedGroup: Group | undefined;
    let existingStudentIds: string[] = [];
    let existingTeacherRows: Array<{ teacherId: string; role: string }> = [];
    if (options.existingGroupId) {
      const existingConditions: SQL[] = [
        eq(groups.id, options.existingGroupId),
        eq(groups.schoolId, options.schoolId),
      ];
      if (options.requireAdminClass !== false) {
        existingConditions.push(eq(groups.groupType, "admin_class"));
      }
      [lockedGroup] = await tx
        .select()
        .from(groups)
        .where(and(...existingConditions))
        .limit(1)
        .for("update");
      if (!lockedGroup) {
        throw schoolIsolationError("CLASS_NOT_FOUND", "Class not found", 404);
      }
      existingStudentIds = (
        await tx
          .select({ studentId: groupStudents.studentId })
          .from(groupStudents)
          .where(eq(groupStudents.groupId, lockedGroup.id))
      ).map((row) => row.studentId);
      existingTeacherRows = await tx
        .select({ teacherId: groupTeachers.teacherId, role: groupTeachers.role })
        .from(groupTeachers)
        .where(eq(groupTeachers.groupId, lockedGroup.id));
    }

    const primaryTeacherId = options.primaryTeacherId ?? lockedGroup?.teacherId;
    if (!primaryTeacherId) {
      throw schoolIsolationError(
        "CLASS_TEACHER_REQUIRED",
        "A primary teacher is required when creating a class.",
        400
      );
    }
    const submittedCoTeachers = options.coTeacherIds === undefined
      ? existingTeacherRows
          .filter((row) => row.role === "co-teacher")
          .map((row) => row.teacherId)
      : options.coTeacherIds;
    const uniqueCoTeachers = Array.from(
      new Set(submittedCoTeachers.filter((id) => id && id !== primaryTeacherId))
    );
    const intendedTeacherIds = [primaryTeacherId, ...uniqueCoTeachers];
    const activeTeacherMemberships = await tx
      .select({ userId: schoolMemberships.userId })
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.schoolId, options.schoolId),
          eq(schoolMemberships.status, "active"),
          inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]),
          inArray(schoolMemberships.userId, intendedTeacherIds)
        )
      );
    if (
      new Set(activeTeacherMemberships.map((membership) => membership.userId)).size !==
      intendedTeacherIds.length
    ) {
      throw schoolIsolationError(
        "CLASS_TEACHER_NOT_FOUND",
        "One or more teachers are unavailable in this school.",
        404
      );
    }
    if (submittedStudentIds !== undefined && submittedStudentIds.length > 0) {
      const activeStudentRows = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.schoolId, options.schoolId),
            eq(students.status, "active"),
            inArray(students.id, submittedStudentIds)
          )
        );
      if (new Set(activeStudentRows.map((student) => student.id)).size !== submittedStudentIds.length) {
        throw schoolIsolationError(
          "CLASS_STUDENT_NOT_FOUND",
          "One or more students are unavailable in this school.",
          404
        );
      }
    }
    const recurringScheduleIdentityChanged =
      !lockedGroup ||
      primaryTeacherId !== lockedGroup.teacherId ||
      options.coTeacherIds !== undefined ||
      (options.data.scheduleEnabled !== undefined &&
        options.data.scheduleEnabled !== lockedGroup.scheduleEnabled) ||
      (options.data.blockStartTime !== undefined &&
        options.data.blockStartTime !== lockedGroup.blockStartTime) ||
      (options.data.blockEndTime !== undefined &&
        options.data.blockEndTime !== lockedGroup.blockEndTime) ||
      (options.data.status !== undefined && options.data.status !== lockedGroup.status);
    if (recurringScheduleIdentityChanged) {
      await assertNoLockedRecurringClassScheduleOverlap({
        schoolId: options.schoolId,
        excludeGroupId: options.existingGroupId,
        status: options.data.status ?? lockedGroup?.status ?? "active",
        scheduleEnabled:
          options.data.scheduleEnabled ?? lockedGroup?.scheduleEnabled ?? false,
        blockStartTime:
          options.data.blockStartTime !== undefined
            ? options.data.blockStartTime
            : lockedGroup?.blockStartTime ?? null,
        blockEndTime:
          options.data.blockEndTime !== undefined
            ? options.data.blockEndTime
            : lockedGroup?.blockEndTime ?? null,
        teacherIds: intendedTeacherIds,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
    }
    if (lockedGroup && options.existingGroupId) {
      const scheduleIdentityChanged =
        primaryTeacherId !== lockedGroup.teacherId ||
        (options.data.scheduleEnabled !== undefined &&
          options.data.scheduleEnabled !== lockedGroup.scheduleEnabled) ||
        (options.data.blockStartTime !== undefined &&
          options.data.blockStartTime !== lockedGroup.blockStartTime) ||
        (options.data.blockEndTime !== undefined &&
          options.data.blockEndTime !== lockedGroup.blockEndTime) ||
        (options.data.status !== undefined && options.data.status !== lockedGroup.status);
      if (scheduleIdentityChanged) {
        const transactionDb = tx as unknown as ScheduleChangeDb;
        await assertNoApprovedFutureScheduleChange({
          schoolId: options.schoolId,
          groupId: options.existingGroupId,
          prospectiveGroup: {
            teacherId: primaryTeacherId,
            scheduleEnabled: options.data.scheduleEnabled ?? lockedGroup.scheduleEnabled,
            blockStartTime:
              options.data.blockStartTime !== undefined
                ? options.data.blockStartTime
                : lockedGroup.blockStartTime,
            blockEndTime:
              options.data.blockEndTime !== undefined
                ? options.data.blockEndTime
                : lockedGroup.blockEndTime,
            status: options.data.status ?? lockedGroup.status,
          },
          prospectiveTeacherIds: intendedTeacherIds,
          prospectiveStudentIds: submittedStudentIds ?? existingStudentIds,
          actorId: options.scheduleChangeActorId,
          dbInstance: transactionDb,
        });
        await supersedePendingScheduleChangesForGroup({
          schoolId: options.schoolId,
          groupId: options.existingGroupId,
          actorId: options.scheduleChangeActorId,
          reason: "class_configuration_changed",
          dbInstance: transactionDb,
        });
      }
    }
    const groupValues = {
      ...options.data,
      schoolId: options.schoolId,
      teacherId: primaryTeacherId,
    };
    const [group] = options.existingGroupId
      ? await tx
          .update(groups)
          .set(groupValues)
          .where(
            and(
              eq(groups.id, options.existingGroupId),
              eq(groups.schoolId, options.schoolId),
              options.requireAdminClass !== false
                ? eq(groups.groupType, "admin_class")
                : undefined
            )
          )
          .returning()
      : await tx
          .insert(groups)
          .values({
            ...groupValues,
            status: options.data.status || "active",
          } as InsertGroup)
          .returning();

    if (!group) {
      throw schoolIsolationError("CLASS_NOT_FOUND", "Class not found", 404);
    }

    const finalStudentIds = submittedStudentIds === undefined
      ? existingStudentIds
      : options.replaceStudentRoster
        ? submittedStudentIds
        : Array.from(new Set([...existingStudentIds, ...submittedStudentIds]));
    const existingTeacherIds = new Set(existingTeacherRows.map((row) => row.teacherId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: options.schoolId,
      groupId: group.id,
      prospectiveGroup: {
        teacherId: group.teacherId,
        scheduleEnabled: group.scheduleEnabled,
        blockStartTime: group.blockStartTime,
        blockEndTime: group.blockEndTime,
        status: group.status,
      },
      prospectiveTeacherIds: intendedTeacherIds,
      prospectiveStudentIds: finalStudentIds,
      addedTeacherIds: intendedTeacherIds.filter((teacherId) => !existingTeacherIds.has(teacherId)),
      actorId: options.scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });

    const replaceTeachers =
      !options.existingGroupId ||
      options.primaryTeacherId !== undefined ||
      options.coTeacherIds !== undefined;
    if (replaceTeachers) {
      await tx.delete(groupTeachers).where(eq(groupTeachers.groupId, group.id));
      await tx.insert(groupTeachers).values([
        {
          groupId: group.id,
          teacherId: primaryTeacherId,
          role: "primary",
        },
        ...uniqueCoTeachers.map((teacherId) => ({
          groupId: group.id,
          teacherId,
          role: "co-teacher",
        })),
      ]);
    }

    let roster = { added: [] as string[], alreadyPresent: [] as string[] };
    if (submittedStudentIds !== undefined) {
      const beforeRows = await tx
        .select({ studentId: groupStudents.studentId })
        .from(groupStudents)
        .where(eq(groupStudents.groupId, group.id));
      const before = new Set(beforeRows.map((row) => row.studentId));
      await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
        schoolId: options.schoolId,
        groupId: group.id,
        addedStudentIds: finalStudentIds.filter((id) => !before.has(id)),
        actorId: options.scheduleChangeActorId,
        dbInstance: tx as unknown as ScheduleChangeDb,
      });
      if (options.replaceStudentRoster) {
        await tx.delete(groupStudents).where(eq(groupStudents.groupId, group.id));
      }
      const inserted = finalStudentIds.length > 0
        ? await tx
            .insert(groupStudents)
            .values(finalStudentIds.map((studentId) => ({ groupId: group.id, studentId })))
            .onConflictDoNothing()
            .returning({ studentId: groupStudents.studentId })
        : [];
      const added = inserted.map((row) => row.studentId);
      const addedSet = new Set(added);
      roster = {
        added,
        alreadyPresent: finalStudentIds.filter((id) => before.has(id) && !addedSet.has(id)),
      };
    }

    return { group, roster };
  });
}

/**
 * Atomic create/update primitive for teacher-created and small ClassPilot
 * groups. Schedule, teacher junctions, and an optional exact roster commit as
 * one unit under the same school configuration lock used by swap approval.
 */
export async function upsertClasspilotGroupWithAssignments(options: {
  schoolId: string;
  existingGroupId?: string | null;
  data: Partial<InsertGroup>;
  /** Required on create; undefined preserves the locked primary on update. */
  primaryTeacherId?: string;
  /** Undefined preserves the locked co-teachers on update; [] clears them. */
  coTeacherIds?: string[];
  studentIds?: string[];
  scheduleChangeActorId?: string;
}): Promise<{
  group: Group;
  roster: { added: string[]; alreadyPresent: string[] };
}> {
  if (!options.existingGroupId && (!options.data.name || !options.data.groupType)) {
    throw schoolIsolationError(
      "INVALID_CLASS",
      "A class name and group type are required.",
      400
    );
  }
  return upsertAdminClassroomClass({
    schoolId: options.schoolId,
    existingGroupId: options.existingGroupId,
    data: {
      ...options.data,
      schoolId: options.schoolId,
    },
    primaryTeacherId: options.primaryTeacherId,
    coTeacherIds: options.coTeacherIds,
    studentIds: options.studentIds,
    replaceStudentRoster: options.studentIds !== undefined,
    requireAdminClass: false,
    scheduleChangeActorId: options.scheduleChangeActorId,
  });
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  await db
    .delete(groupStudents)
    .where(eq(groupStudents.groupId, groupId));
  const result = await db.delete(groups).where(eq(groups.id, groupId));
  return (result.rowCount ?? 0) > 0;
}

export async function archiveGroup(
  groupId: string,
  scheduleChangeActorId?: string
): Promise<Group | undefined> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: groups.id, schoolId: groups.schoolId })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (!candidate) return undefined;

    // Class archiving and PassPilot class cutover use the same lock order so a
    // mapped class cannot become archived between final validation and cutover.
    await lockClasspilotScheduleChangeSchool(
      candidate.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, candidate.schoolId);
    const [lockedGroup] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, candidate.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedGroup) return undefined;

    const transactionDb = tx as unknown as ScheduleChangeDb;
    await assertNoApprovedFutureScheduleChange({
      schoolId: candidate.schoolId,
      groupId,
      dbInstance: transactionDb,
    });
    await supersedePendingScheduleChangesForGroup({
      schoolId: candidate.schoolId,
      groupId,
      actorId: scheduleChangeActorId,
      reason: "class_archived",
      dbInstance: transactionDb,
    });

    const [group] = await tx
      .update(groups)
      .set({ status: "archived", archivedAt: new Date(), scheduleEnabled: false })
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, candidate.schoolId)))
      .returning();
    return group;
  });
}

export async function groupHasTeachingHistory(groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: sql<number>`COUNT(*)::int` })
    .from(teachingSessions)
    .where(eq(teachingSessions.groupId, groupId));
  return (row?.value ?? 0) > 0;
}

export async function hardDeleteGroupWithCleanup(
  groupId: string,
  _scheduleChangeActorId?: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: groups.id, schoolId: groups.schoolId })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (!candidate) return false;
    await lockClasspilotScheduleChangeSchool(
      candidate.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takePasspilotClassLock(tx, candidate.schoolId);
    const [lockedGroup] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.schoolId, candidate.schoolId)))
      .limit(1)
      .for("update");
    if (!lockedGroup) return false;
    const transactionDb = tx as unknown as ScheduleChangeDb;
    await assertNoApprovedFutureScheduleChange({
      schoolId: candidate.schoolId,
      groupId,
      dbInstance: transactionDb,
    });
    const [scheduleChangeHistory] = await tx
      .select({ value: sql<number>`COUNT(*)::int` })
      .from(classpilotScheduleChangeLegs)
      .where(
        and(
          eq(classpilotScheduleChangeLegs.schoolId, candidate.schoolId),
          eq(classpilotScheduleChangeLegs.groupId, groupId)
        )
      );
    if ((scheduleChangeHistory?.value ?? 0) > 0) {
      throw scheduleChangeError(
        "CLASS_HAS_SCHEDULE_CHANGE_HISTORY",
        "Classes with schedule-change history cannot be deleted. Archive the class instead.",
        409
      );
    }
    const [history] = await tx
      .select({ value: sql<number>`COUNT(*)::int` })
      .from(teachingSessions)
      .where(eq(teachingSessions.groupId, groupId));
    if ((history?.value ?? 0) > 0) {
      throw Object.assign(new Error("Classes with teaching history cannot be deleted. Archive the class instead."), {
        status: 409,
        code: "CLASS_HAS_HISTORY",
      });
    }
    const [[passReference], [gradeReference], [kioskReference]] = await Promise.all([
      tx
        .select({ value: sql<number>`COUNT(*)::int` })
        .from(passes)
        .where(eq(passes.classpilotGroupId, groupId)),
      tx
        .select({ value: sql<number>`COUNT(*)::int` })
        .from(grades)
        .where(eq(grades.classpilotGroupId, groupId)),
      tx
        .select({ value: sql<number>`COUNT(*)::int` })
        .from(schools)
        .where(eq(schools.kioskClasspilotGroupId, groupId)),
    ]);
    if (
      (passReference?.value ?? 0) > 0 ||
      (gradeReference?.value ?? 0) > 0 ||
      (kioskReference?.value ?? 0) > 0
    ) {
      throw Object.assign(
        new Error("This class is referenced by PassPilot history, migration mappings, or kiosk settings. Archive the class instead."),
        {
          status: 409,
          code: "CLASSPILOT_CLASS_IN_USE_BY_PASSPILOT",
          expose: true,
        }
      );
    }
    const subgroupRows = await tx
      .select({ id: subgroups.id })
      .from(subgroups)
      .where(eq(subgroups.groupId, groupId));
    const subgroupIds = subgroupRows.map((row) => row.id);
    if (subgroupIds.length > 0) {
      await tx
        .delete(subgroupMembers)
        .where(inArray(subgroupMembers.subgroupId, subgroupIds));
    }
    await tx.delete(subgroups).where(eq(subgroups.groupId, groupId));
    await tx
      .delete(classpilotScheduleChangePairs)
      .where(
        and(
          eq(classpilotScheduleChangePairs.schoolId, candidate.schoolId),
          or(
            eq(classpilotScheduleChangePairs.firstGroupId, groupId),
            eq(classpilotScheduleChangePairs.secondGroupId, groupId)
          )!
        )
      );
    await tx.delete(groupTeachers).where(eq(groupTeachers.groupId, groupId));
    await tx.delete(groupStudents).where(eq(groupStudents.groupId, groupId));
    await tx.delete(groups).where(eq(groups.id, groupId));
    return true;
  });
}

export async function getGroupStudents(
  groupId: string,
  dbInstance: typeof db = db
): Promise<(GroupStudent & { student: Student })[]> {
  const rows = await dbInstance
    .select({
      groupStudent: groupStudents,
      student: students,
    })
    .from(groupStudents)
    .innerJoin(students, eq(groupStudents.studentId, students.id))
    .where(
      and(
        eq(groupStudents.groupId, groupId),
        eq(students.status, "active")
      )
    );
  return rows.map((r) => ({ ...r.groupStudent, student: r.student }));
}

export async function getGroupStudentIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ studentId: groupStudents.studentId })
    .from(groupStudents)
    .innerJoin(students, eq(students.id, groupStudents.studentId))
    .where(
      and(
        eq(groupStudents.groupId, groupId),
        eq(students.status, "active")
      )
    );
  return rows.map((row) => row.studentId);
}

export async function addGroupStudentsDetailed(
  groupId: string,
  studentIds: string[],
  scheduleChangeActorId?: string
): Promise<{
  added: string[];
  alreadyPresent: string[];
}> {
  const uniqueIds = Array.from(new Set(studentIds));
  if (uniqueIds.length === 0) return { added: [], alreadyPresent: [] };
  return withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    const beforeRows = await tx
      .select({ studentId: groupStudents.studentId })
      .from(groupStudents)
      .where(eq(groupStudents.groupId, groupId));
    const before = new Set(beforeRows.map((row) => row.studentId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId,
      addedStudentIds: uniqueIds.filter((id) => !before.has(id)),
      actorId: scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    const inserted = await tx
      .insert(groupStudents)
      .values(uniqueIds.map((studentId) => ({ groupId, studentId })))
      .onConflictDoNothing()
      .returning({ studentId: groupStudents.studentId });
    const added = inserted.map((row) => row.studentId);
    const addedSet = new Set(added);
    return {
      added,
      alreadyPresent: uniqueIds.filter((id) => before.has(id) && !addedSet.has(id)),
    };
  });
}

export async function addGroupStudents(
  groupId: string,
  studentIds: string[],
  scheduleChangeActorId?: string
): Promise<void> {
  if (studentIds.length === 0) return;
  const values = studentIds.map((studentId) => ({ groupId, studentId }));
  await withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    const existing = await tx
      .select({ studentId: groupStudents.studentId })
      .from(groupStudents)
      .where(eq(groupStudents.groupId, groupId));
    const existingIds = new Set(existing.map((row) => row.studentId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId,
      addedStudentIds: studentIds.filter((id) => !existingIds.has(id)),
      actorId: scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    await tx.insert(groupStudents).values(values).onConflictDoNothing();
  });
}

export async function removeGroupStudent(
  groupId: string,
  studentId: string
): Promise<void> {
  await withPasspilotGroupMutationLock(groupId, async (tx) => {
    await tx
      .delete(groupStudents)
      .where(
        and(
          eq(groupStudents.groupId, groupId),
          eq(groupStudents.studentId, studentId)
        )
      );
  });
}

export async function setGroupStudents(
  groupId: string,
  studentIds: string[],
  scheduleChangeActorId?: string
): Promise<void> {
  await withPasspilotGroupMutationLock(groupId, async (tx, lockedGroup) => {
    const existing = await tx
      .select({ studentId: groupStudents.studentId })
      .from(groupStudents)
      .where(eq(groupStudents.groupId, groupId));
    const existingIds = new Set(existing.map((row) => row.studentId));
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: lockedGroup.schoolId,
      groupId,
      addedStudentIds: studentIds.filter((id) => !existingIds.has(id)),
      actorId: scheduleChangeActorId,
      dbInstance: tx as unknown as ScheduleChangeDb,
    });
    await tx
      .delete(groupStudents)
      .where(eq(groupStudents.groupId, groupId));
    if (studentIds.length === 0) return;
    const values = studentIds.map((studentId) => ({ groupId, studentId }));
    await tx.insert(groupStudents).values(values).onConflictDoNothing();
  });
}

// ============================================================================
// ClassPilot - Subgroup operations
// ============================================================================

export async function getSubgroupsByGroup(
  groupId: string
): Promise<Subgroup[]> {
  return db
    .select()
    .from(subgroups)
    .where(eq(subgroups.groupId, groupId))
    .orderBy(subgroups.name);
}

export async function createSubgroup(
  data: InsertSubgroup
): Promise<Subgroup> {
  // subgroups.school_id must mirror the parent group's school (RLS WITH CHECK).
  // Derive it from the group so a caller can never omit or mismatch it.
  const [group] = await db
    .select({ schoolId: groups.schoolId })
    .from(groups)
    .where(eq(groups.id, data.groupId))
    .limit(1);
  if (!group) {
    throw new Error(`createSubgroup: group ${data.groupId} not found`);
  }
  const [sg] = await db
    .insert(subgroups)
    .values({ ...data, schoolId: group.schoolId })
    .returning();
  return sg!;
}

export async function updateSubgroup(
  subgroupId: string,
  data: Partial<InsertSubgroup>
): Promise<Subgroup | undefined> {
  const [sg] = await db
    .update(subgroups)
    .set(data)
    .where(eq(subgroups.id, subgroupId))
    .returning();
  return sg;
}

export async function deleteSubgroup(subgroupId: string): Promise<boolean> {
  await db
    .delete(subgroupMembers)
    .where(eq(subgroupMembers.subgroupId, subgroupId));
  const result = await db.delete(subgroups).where(eq(subgroups.id, subgroupId));
  return (result.rowCount ?? 0) > 0;
}

export async function getSubgroupMembers(
  subgroupId: string
): Promise<(SubgroupMember & { student: Student })[]> {
  const rows = await db
    .select({
      member: subgroupMembers,
      student: students,
    })
    .from(subgroupMembers)
    .innerJoin(students, eq(subgroupMembers.studentId, students.id))
    .where(
      and(
        eq(subgroupMembers.subgroupId, subgroupId),
        eq(students.status, "active")
      )
    );
  return rows.map((r) => ({ ...r.member, student: r.student }));
}

export async function addSubgroupMembers(
  subgroupId: string,
  studentIds: string[]
): Promise<void> {
  if (studentIds.length === 0) return;
  const values = studentIds.map((studentId) => ({ subgroupId, studentId }));
  await db.insert(subgroupMembers).values(values).onConflictDoNothing();
}

export async function removeSubgroupMember(
  subgroupId: string,
  studentId: string
): Promise<void> {
  await db
    .delete(subgroupMembers)
    .where(
      and(
        eq(subgroupMembers.subgroupId, subgroupId),
        eq(subgroupMembers.studentId, studentId)
      )
    );
}

// ============================================================================
// ClassPilot - Flight Path operations
// ============================================================================

export async function getFlightPathsBySchool(
  schoolId: string
): Promise<FlightPath[]> {
  return db
    .select()
    .from(flightPaths)
    .where(eq(flightPaths.schoolId, schoolId))
    .orderBy(flightPaths.flightPathName);
}

export async function getFlightPathsByTeacher(
  teacherId: string
): Promise<FlightPath[]> {
  return db
    .select()
    .from(flightPaths)
    .where(eq(flightPaths.teacherId, teacherId))
    .orderBy(flightPaths.flightPathName);
}

export async function getFlightPathsByTeacherAndSchool(
  teacherId: string,
  schoolId: string
): Promise<FlightPath[]> {
  return db
    .select()
    .from(flightPaths)
    .where(and(eq(flightPaths.teacherId, teacherId), eq(flightPaths.schoolId, schoolId)))
    .orderBy(flightPaths.flightPathName);
}

export async function getFlightPathById(
  flightPathId: string,
  schoolId: string
): Promise<FlightPath | undefined> {
  const [fp] = await db
    .select()
    .from(flightPaths)
    .where(and(eq(flightPaths.id, flightPathId), eq(flightPaths.schoolId, schoolId)))
    .limit(1);
  return fp;
}

export async function createFlightPath(
  data: InsertFlightPath
): Promise<FlightPath> {
  const [fp] = await db.insert(flightPaths).values(data).returning();
  return fp!;
}

export async function updateFlightPath(
  id: string,
  schoolId: string,
  data: Partial<InsertFlightPath>
): Promise<FlightPath | undefined> {
  const [fp] = await db
    .update(flightPaths)
    .set(data)
    .where(and(eq(flightPaths.id, id), eq(flightPaths.schoolId, schoolId)))
    .returning();
  return fp;
}

export async function deleteFlightPath(id: string, schoolId: string): Promise<boolean> {
  const result = await db
    .delete(flightPaths)
    .where(and(eq(flightPaths.id, id), eq(flightPaths.schoolId, schoolId)));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// ClassPilot - Block List operations
// ============================================================================

export async function getBlockListsBySchool(
  schoolId: string
): Promise<BlockList[]> {
  return db
    .select()
    .from(blockLists)
    .where(eq(blockLists.schoolId, schoolId))
    .orderBy(blockLists.name);
}

export async function getBlockListsByTeacher(
  teacherId: string
): Promise<BlockList[]> {
  return db
    .select()
    .from(blockLists)
    .where(eq(blockLists.teacherId, teacherId))
    .orderBy(blockLists.name);
}

export async function getBlockListsByTeacherAndSchool(
  teacherId: string,
  schoolId: string
): Promise<BlockList[]> {
  return db
    .select()
    .from(blockLists)
    .where(and(eq(blockLists.teacherId, teacherId), eq(blockLists.schoolId, schoolId)))
    .orderBy(blockLists.name);
}

export async function getBlockListById(
  id: string,
  schoolId: string
): Promise<BlockList | undefined> {
  const [bl] = await db
    .select()
    .from(blockLists)
    .where(and(eq(blockLists.id, id), eq(blockLists.schoolId, schoolId)))
    .limit(1);
  return bl;
}

export async function createBlockList(
  data: InsertBlockList
): Promise<BlockList> {
  const [bl] = await db.insert(blockLists).values(data).returning();
  return bl!;
}

export async function updateBlockList(
  id: string,
  schoolId: string,
  data: Partial<InsertBlockList>
): Promise<BlockList | undefined> {
  const [bl] = await db
    .update(blockLists)
    .set(data)
    .where(and(eq(blockLists.id, id), eq(blockLists.schoolId, schoolId)))
    .returning();
  return bl;
}

export async function deleteBlockList(id: string, schoolId: string): Promise<boolean> {
  const result = await db
    .delete(blockLists)
    .where(and(eq(blockLists.id, id), eq(blockLists.schoolId, schoolId)));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// ClassPilot - Chat Message operations
// ============================================================================

export async function getChatMessages(
  sessionId: string,
  schoolId?: string
): Promise<ChatMessage[]> {
  const conditions: SQL[] = [eq(chatMessages.sessionId, sessionId)];
  if (schoolId) conditions.push(eq(chatMessages.schoolId, schoolId));
  return db
    .select()
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(asc(chatMessages.createdAt));
}

export async function createChatMessage(
  data: InsertChatMessage
): Promise<ChatMessage> {
  const [msg] = await db.insert(chatMessages).values(data).returning();
  return msg!;
}

export async function getChatMessageByIdAndSchool(
  messageId: string,
  schoolId: string
): Promise<ChatMessage | undefined> {
  const [message] = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.schoolId, schoolId)))
    .limit(1);
  return message;
}

export async function deleteChatMessage(
  messageId: string,
  schoolId: string
): Promise<boolean> {
  const result = await db
    .delete(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.schoolId, schoolId)));
  return (result.rowCount ?? 0) > 0;
}

export async function updateChatMessageDelivery(options: {
  messageId: string;
  schoolId: string;
  deviceId?: string | null;
  deliveryStatus: "delivered" | "failed";
  errorMessage?: string | null;
}): Promise<ChatMessage | undefined> {
  const update: Partial<InsertChatMessage> & Record<string, unknown> = {
    deliveryStatus: options.deliveryStatus,
    errorMessage: options.errorMessage || null,
  };
  if (options.deliveryStatus === "delivered") {
    update.deliveredAt = new Date();
  }
  if (options.deliveryStatus === "failed") {
    update.failedAt = new Date();
  }
  const conditions: SQL[] = [
    eq(chatMessages.id, options.messageId),
    eq(chatMessages.schoolId, options.schoolId),
  ];
  if (options.deviceId) {
    conditions.push(eq(chatMessages.deviceId, options.deviceId));
  }
  const [message] = await db
    .update(chatMessages)
    .set(update)
    .where(and(...conditions))
    .returning();
  return message;
}

// ============================================================================
// ClassPilot - Active hand operations
// ============================================================================

export type ClasspilotActiveHandWithStudent = ClasspilotActiveHand & {
  student: Student;
};

export async function clearExpiredClasspilotActiveHands(
  schoolId: string
): Promise<void> {
  await db
    .update(classpilotActiveHands)
    .set({ clearedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(classpilotActiveHands.schoolId, schoolId),
        isNull(classpilotActiveHands.clearedAt),
        sql`${classpilotActiveHands.expiresAt} IS NOT NULL`,
        sql`${classpilotActiveHands.expiresAt} <= now()`
      )
    );
}

export async function getActiveHandsBySession(
  schoolId: string,
  teachingSessionId: string
): Promise<ClasspilotActiveHandWithStudent[]> {
  await clearExpiredClasspilotActiveHands(schoolId);
  const rows = await db
    .select({ hand: classpilotActiveHands, student: students })
    .from(classpilotActiveHands)
    .innerJoin(
      students,
      and(
        eq(classpilotActiveHands.studentId, students.id),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(classpilotActiveHands.schoolId, schoolId),
        eq(classpilotActiveHands.teachingSessionId, teachingSessionId),
        isNull(classpilotActiveHands.clearedAt)
      )
    )
    .orderBy(asc(classpilotActiveHands.raisedAt));
  return rows.map((row) => ({ ...row.hand, student: row.student }));
}

export async function getActiveHandsForStudent(
  schoolId: string,
  studentId: string
): Promise<ClasspilotActiveHand[]> {
  const rows = await db
    .select({ hand: classpilotActiveHands })
    .from(classpilotActiveHands)
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotActiveHands.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(classpilotActiveHands.schoolId, schoolId),
        eq(classpilotActiveHands.studentId, studentId),
        isNull(classpilotActiveHands.clearedAt),
        sql`(${classpilotActiveHands.expiresAt} IS NULL OR ${classpilotActiveHands.expiresAt} > now())`
      )
    )
    .orderBy(desc(classpilotActiveHands.raisedAt));
  return rows.map((row) => row.hand);
}

export async function upsertClasspilotActiveHand(
  data: InsertClasspilotActiveHand
): Promise<ClasspilotActiveHand> {
  const [existing] = await db
    .select()
    .from(classpilotActiveHands)
    .where(
      and(
        eq(classpilotActiveHands.schoolId, data.schoolId),
        eq(classpilotActiveHands.teachingSessionId, data.teachingSessionId),
        eq(classpilotActiveHands.studentId, data.studentId),
        isNull(classpilotActiveHands.clearedAt)
      )
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(classpilotActiveHands)
      .set({
        deviceId: data.deviceId,
        raisedAt: data.raisedAt || new Date(),
        expiresAt: data.expiresAt || null,
        updatedAt: new Date(),
      })
      .where(eq(classpilotActiveHands.id, existing.id))
      .returning();
    return row!;
  }

  const [row] = await db.insert(classpilotActiveHands).values(data).returning();
  return row!;
}

export async function clearClasspilotActiveHand(options: {
  schoolId: string;
  teachingSessionId?: string;
  studentId: string;
}): Promise<ClasspilotActiveHand[]> {
  const conditions: SQL[] = [
    eq(classpilotActiveHands.schoolId, options.schoolId),
    eq(classpilotActiveHands.studentId, options.studentId),
    isNull(classpilotActiveHands.clearedAt),
  ];
  if (options.teachingSessionId) {
    conditions.push(eq(classpilotActiveHands.teachingSessionId, options.teachingSessionId));
  }
  return db
    .update(classpilotActiveHands)
    .set({ clearedAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions))
    .returning();
}

export async function clearClasspilotActiveHandsForSession(
  schoolId: string,
  teachingSessionId: string,
  dbInstance: typeof db = db
): Promise<void> {
  await dbInstance
    .update(classpilotActiveHands)
    .set({ clearedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(classpilotActiveHands.schoolId, schoolId),
        eq(classpilotActiveHands.teachingSessionId, teachingSessionId),
        isNull(classpilotActiveHands.clearedAt)
      )
    );
}

// ============================================================================
// ClassPilot - Poll operations
// ============================================================================

export async function getPollsBySession(
  sessionId: string
): Promise<Poll[]> {
  return db
    .select()
    .from(polls)
    .where(eq(polls.sessionId, sessionId))
    .orderBy(desc(polls.createdAt));
}

export async function getPollById(
  pollId: string
): Promise<Poll | undefined> {
  const [poll] = await db
    .select()
    .from(polls)
    .where(eq(polls.id, pollId))
    .limit(1);
  return poll;
}

export async function createPoll(
  data: InsertPoll
): Promise<Poll> {
  const [poll] = await db.insert(polls).values(data).returning();
  return poll!;
}

export async function closePoll(
  pollId: string
): Promise<Poll | undefined> {
  const [poll] = await db
    .update(polls)
    .set({ isActive: false, closedAt: new Date() })
    .where(eq(polls.id, pollId))
    .returning();
  return poll;
}

export async function getPollResponses(
  pollId: string
): Promise<PollResponse[]> {
  return db
    .select()
    .from(pollResponses)
    .where(eq(pollResponses.pollId, pollId))
    .orderBy(pollResponses.createdAt);
}

export async function createPollResponse(
  data: InsertPollResponse
): Promise<PollResponse> {
  const [resp] = await db.insert(pollResponses).values(data).returning();
  return resp!;
}

// ============================================================================
// ClassPilot - Teacher command operations
// ============================================================================

export type ClasspilotCommandWithTargets = ClasspilotCommand & {
  targets: ClasspilotCommandTarget[];
};

export async function createClasspilotCommandWithTargets(
  commandData: InsertClasspilotCommand,
  targetData: InsertClasspilotCommandTarget[]
): Promise<ClasspilotCommandWithTargets> {
  return await db.transaction(async (tx) => {
    const [command] = await tx
      .insert(classpilotCommands)
      .values(commandData)
      .returning();
    if (!command) throw new Error("Failed to create ClassPilot command");

    const targets = targetData.length > 0
      ? await tx
          .insert(classpilotCommandTargets)
          .values(targetData.map((target) => ({ ...target, commandId: command.id })))
          .returning()
      : [];

    return { ...command, targets };
  });
}

export async function updateClasspilotCommandSummary(
  commandId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotCommand | undefined> {
  const summary = dbInstance
    .select({
      commandId: sql<string>`${commandId}`.as("target_command_id"),
      targetRequestedCount: sql<number>`count(*)::int`.as("target_requested_count"),
      targetSentCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.sentAt} is not null or ${classpilotCommandTargets.status} in ('received', 'completed', 'failed'))::int`.as("target_sent_count"),
      targetReceivedCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.receivedAt} is not null)::int`.as("target_received_count"),
      targetCompletedCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.status} = 'completed')::int`.as("target_completed_count"),
      targetFailedCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.status} = 'failed')::int`.as("target_failed_count"),
      targetUnavailableCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.status} = 'unavailable')::int`.as("target_unavailable_count"),
      targetExpiredCount: sql<number>`count(*) filter (where ${classpilotCommandTargets.status} = 'expired')::int`.as("target_expired_count"),
    })
    .from(classpilotCommandTargets)
    .where(eq(classpilotCommandTargets.commandId, commandId))
    .as("classpilot_command_target_summary");

  const [command] = await dbInstance
    .update(classpilotCommands)
    .set({
      status: sql<ClasspilotCommand["status"]>`case
        when greatest(${classpilotCommands.requestedCount}, ${summary.targetRequestedCount}) = 0
          or greatest(${classpilotCommands.unavailableCount}, ${summary.targetUnavailableCount}) = greatest(${classpilotCommands.requestedCount}, ${summary.targetRequestedCount}) then 'unavailable'
        when ${summary.targetCompletedCount}
          + ${summary.targetFailedCount}
          + ${summary.targetUnavailableCount}
          + ${summary.targetExpiredCount} = greatest(${classpilotCommands.requestedCount}, ${summary.targetRequestedCount})
          then case
            when ${summary.targetFailedCount} > 0 then 'failed'
            when ${summary.targetExpiredCount} > 0 then 'expired'
            else 'completed'
          end
        when greatest(${classpilotCommands.receivedCount}, ${summary.targetReceivedCount}) > 0 then 'received'
        when greatest(${classpilotCommands.sentCount}, ${summary.targetSentCount}) > 0 then 'sent'
        else 'requested'
      end`,
      requestedCount: sql<number>`greatest(${classpilotCommands.requestedCount}, ${summary.targetRequestedCount})`,
      sentCount: sql<number>`greatest(${classpilotCommands.sentCount}, ${summary.targetSentCount})`,
      receivedCount: sql<number>`greatest(${classpilotCommands.receivedCount}, ${summary.targetReceivedCount})`,
      completedCount: sql<number>`greatest(${classpilotCommands.completedCount}, ${summary.targetCompletedCount})`,
      failedCount: sql<number>`greatest(${classpilotCommands.failedCount}, ${summary.targetFailedCount})`,
      unavailableCount: sql<number>`greatest(${classpilotCommands.unavailableCount}, ${summary.targetUnavailableCount})`,
      updatedAt: sql<Date>`clock_timestamp()`,
    })
    .from(summary)
    .where(and(
      eq(classpilotCommands.id, commandId),
      eq(classpilotCommands.id, summary.commandId)
    ))
    .returning({ ...getTableColumns(classpilotCommands) });

  return command;
}

export async function markClasspilotCommandTargetsSent(
  commandId: string,
  deviceIds: string[]
): Promise<ClasspilotCommandTarget[]> {
  if (deviceIds.length === 0) {
    // The dispatcher uses this as the single post-delivery summary refresh even
    // when every requested target was unavailable.
    await updateClasspilotCommandSummary(commandId);
    return [];
  }
  const now = new Date();
  const targets = await db
    .update(classpilotCommandTargets)
    .set({
      status: sql<ClasspilotCommandTarget["status"]>`case
        when ${classpilotCommandTargets.status} = 'requested' then 'sent'
        else ${classpilotCommandTargets.status}
      end`,
      sentAt: sql<Date>`coalesce(${classpilotCommandTargets.sentAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(classpilotCommandTargets.commandId, commandId),
        inArray(classpilotCommandTargets.deviceId, deviceIds)
      )
    )
    .returning();
  await updateClasspilotCommandSummary(commandId);
  return targets;
}

export async function markClasspilotCommandTargetsServerCompleted(
  commandId: string,
  studentIds: string[]
): Promise<ClasspilotCommandTarget[]> {
  const uniqueStudentIds = [...new Set(studentIds.filter(Boolean))];
  if (uniqueStudentIds.length === 0) return [];
  const now = new Date();
  const targets = await db
    .update(classpilotCommandTargets)
    .set({
      status: "completed",
      completedAt: sql<Date>`coalesce(${classpilotCommandTargets.completedAt}, ${now})`,
      result: sql`coalesce(${classpilotCommandTargets.result}, '{}'::jsonb) || '{"serverAuthoritative":true}'::jsonb`,
      errorMessage: null,
      updatedAt: now,
    })
    .where(and(
      eq(classpilotCommandTargets.commandId, commandId),
      inArray(classpilotCommandTargets.studentId, uniqueStudentIds),
      inArray(classpilotCommandTargets.status, ["requested", "sent", "received"])
    ))
    .returning();
  await updateClasspilotCommandSummary(commandId);
  return targets;
}

/**
 * Persist one-shot targets that were never acknowledged before the command
 * deadline. The command row owns the existing expiry field, so this remains
 * additive and requires no target-table migration.
 */
export async function expireClasspilotTransientCommandTargets(
  options: {
    commandId?: string;
    schoolId?: string;
    teacherId?: string;
    now?: Date;
  } = {},
  dbInstance: typeof db = db
): Promise<string[]> {
  const now = options.now || new Date();
  const commandConditions: SQL[] = [
    isNotNull(classpilotCommands.expiresAt),
    sql`${classpilotCommands.expiresAt} <= ${now}`,
  ];
  if (options.commandId) commandConditions.push(eq(classpilotCommands.id, options.commandId));
  if (options.schoolId) commandConditions.push(eq(classpilotCommands.schoolId, options.schoolId));
  if (options.teacherId) commandConditions.push(eq(classpilotCommands.teacherId, options.teacherId));

  const dueCommands = await dbInstance
    .selectDistinct({ id: classpilotCommands.id })
    .from(classpilotCommands)
    .innerJoin(
      classpilotCommandTargets,
      eq(classpilotCommandTargets.commandId, classpilotCommands.id)
    )
    .where(and(
      ...commandConditions,
      inArray(classpilotCommandTargets.status, ["requested", "sent"]),
      isNull(classpilotCommandTargets.receivedAt)
    ))
    .limit(options.commandId ? 1 : 500);
  if (dueCommands.length === 0) return [];

  const expired = await dbInstance
    .update(classpilotCommandTargets)
    .set({
      status: "expired",
      errorMessage: "Not delivered before command expired",
      updatedAt: now,
    })
    .where(and(
      inArray(classpilotCommandTargets.commandId, dueCommands.map((command) => command.id)),
      inArray(classpilotCommandTargets.status, ["requested", "sent"]),
      isNull(classpilotCommandTargets.receivedAt)
    ))
    .returning({ commandId: classpilotCommandTargets.commandId });

  const commandIds = [...new Set(expired.map((target) => target.commandId))];
  for (const commandId of commandIds) {
    await updateClasspilotCommandSummary(commandId, dbInstance);
  }
  return commandIds;
}

export async function updateClasspilotCommandTargetAck(options: {
  commandId: string;
  schoolId: string;
  deviceId: string;
  studentId: string;
  studentSessionId: string;
  ackState: "received" | "completed" | "failed" | "expired";
  result?: unknown;
  errorMessage?: string | null;
  now?: Date;
}): Promise<ClasspilotCommandTarget | undefined> {
  const now = options.now || new Date();
  return db.transaction(async (tx) => {
    const identityConditions = [
      eq(classpilotCommandTargets.commandId, options.commandId),
      eq(classpilotCommandTargets.schoolId, options.schoolId),
      eq(classpilotCommandTargets.deviceId, options.deviceId),
      eq(classpilotCommandTargets.studentId, options.studentId),
      eq(classpilotCommandTargets.studentSessionId, options.studentSessionId),
      eq(classpilotCommands.id, classpilotCommandTargets.commandId),
      eq(classpilotCommands.schoolId, options.schoolId),
      sql`exists (
        select 1
        from ${studentSessions} as authenticated_session
        join ${students} as authenticated_student
          on authenticated_student.id = authenticated_session.student_id
         and authenticated_student.school_id = ${options.schoolId}
        join ${devices} as authenticated_device
          on authenticated_device.device_id = authenticated_session.device_id
         and authenticated_device.school_id = ${options.schoolId}
        where authenticated_session.id = ${options.studentSessionId}
          and authenticated_session.student_id = ${options.studentId}
          and authenticated_session.device_id = ${options.deviceId}
          and authenticated_session.is_active = true
          and authenticated_session.ended_at is null
      )`,
    ];
    const [binding] = await tx
      .select({
        target: getTableColumns(classpilotCommandTargets),
        commandExpiresAt: classpilotCommands.expiresAt,
      })
      .from(classpilotCommandTargets)
      .innerJoin(classpilotCommands, eq(classpilotCommands.id, classpilotCommandTargets.commandId))
      .where(and(...identityConditions))
      .limit(1)
      .for("update");
    if (!binding) return undefined;

    const target = binding.target;
    const deadline = binding.commandExpiresAt;
    const deadlinePassed = !!deadline && deadline.getTime() <= now.getTime();
    const receivedBeforeDeadline = !!deadline
      && !!target.receivedAt
      && target.receivedAt.getTime() <= deadline.getTime();

    if (options.ackState === "expired") {
      if (!deadlinePassed || target.receivedAt) return undefined;
      if (target.status === "expired") {
        if (target.ackState === "expired") return target;
      } else if (!(["requested", "sent"] as string[]).includes(target.status)) {
        return undefined;
      }
      const [expiredTarget] = await tx
        .update(classpilotCommandTargets)
        .set({
          status: "expired",
          ackState: "expired",
          result: options.result ?? target.result ?? null,
          errorMessage: options.errorMessage || "Not delivered before command expired",
          updatedAt: now,
        })
        .where(eq(classpilotCommandTargets.id, target.id))
        .returning();
      return expiredTarget;
    }

    if (deadlinePassed && options.ackState === "received") {
      if (!target.receivedAt && (["requested", "sent"] as string[]).includes(target.status)) {
        const [expiredTarget] = await tx
          .update(classpilotCommandTargets)
          .set({
            status: "expired",
            errorMessage: "Not delivered before command expired",
            updatedAt: now,
          })
          .where(eq(classpilotCommandTargets.id, target.id))
          .returning();
        return expiredTarget;
      }
      return undefined;
    }

    if (
      deadlinePassed
      && (options.ackState === "completed" || options.ackState === "failed")
      && !receivedBeforeDeadline
    ) {
      if (!target.receivedAt && (["requested", "sent"] as string[]).includes(target.status)) {
        const [expiredTarget] = await tx
          .update(classpilotCommandTargets)
          .set({
            status: "expired",
            errorMessage: "Not delivered before command expired",
            updatedAt: now,
          })
          .where(eq(classpilotCommandTargets.id, target.id))
          .returning();
        return expiredTarget;
      }
      return undefined;
    }

    const allowedStatuses: ClasspilotCommandTarget["status"][] = options.ackState === "received"
      ? ["requested", "sent"]
      : ["requested", "sent", "received"];
    if (!allowedStatuses.includes(target.status)) {
      if (
        options.ackState === "received"
        && target.status === "failed"
        && !target.receivedAt
      ) {
        // Preserve the cumulative receipt milestone for non-expiring legacy or
        // persistent commands without reopening the failed terminal state.
        const [failedTarget] = await tx
          .update(classpilotCommandTargets)
          .set({
            receivedAt: now,
            updatedAt: now,
          })
          .where(eq(classpilotCommandTargets.id, target.id))
          .returning();
        return failedTarget;
      }
      return undefined;
    }

    const status = options.ackState === "failed" ? "failed" : options.ackState;
    const update: PgUpdateSetSource<typeof classpilotCommandTargets> = {
      status,
      ackState: options.ackState,
      result: options.result ?? null,
      errorMessage: options.errorMessage || null,
      updatedAt: now,
    };
    if (options.ackState === "received") {
      update.receivedAt = sql<Date>`coalesce(${classpilotCommandTargets.receivedAt}, ${now})`;
    }
    if (options.ackState === "completed") {
      update.receivedAt = sql<Date>`coalesce(${classpilotCommandTargets.receivedAt}, ${now})`;
      update.completedAt = sql<Date>`coalesce(${classpilotCommandTargets.completedAt}, ${now})`;
    }
    if (options.ackState === "failed") update.failedAt = now;

    const [updatedTarget] = await tx
      .update(classpilotCommandTargets)
      .set(update)
      .where(eq(classpilotCommandTargets.id, target.id))
      .returning();
    return updatedTarget;
  });
}

export async function getClasspilotCommandByIdAndSchool(
  commandId: string,
  schoolId: string
): Promise<ClasspilotCommandWithTargets | undefined> {
  await expireClasspilotTransientCommandTargets({ commandId, schoolId });
  const [command] = await db
    .select()
    .from(classpilotCommands)
    .where(and(eq(classpilotCommands.id, commandId), eq(classpilotCommands.schoolId, schoolId)))
    .limit(1);
  if (!command) return undefined;
  const targets = await db
    .select()
    .from(classpilotCommandTargets)
    .where(eq(classpilotCommandTargets.commandId, command.id))
    .orderBy(classpilotCommandTargets.createdAt);
  return { ...command, targets };
}

export async function withClasspilotCommandBroadcastLock<T>(
  commandId: string,
  schoolId: string,
  callback: (command: ClasspilotCommandWithTargets, revision: string) => Promise<T> | T
): Promise<T | undefined> {
  const snapshot = await db.transaction(async (tx) => {
    // A command can receive ACKs on several ECS tasks. Serialize snapshot reads
    // and revision allocation across the service, but never hold the database
    // transaction while local or Redis network publication runs.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${commandId}, 0::bigint))`);

    const [commandRow] = await tx
      .select({
        ...getTableColumns(classpilotCommands),
        // Allocated only after the per-command advisory lock is held. PostgreSQL
        // full transaction IDs are atomic, strictly increasing, and epoch-aware.
        broadcastRevision: sql<string>`txid_current()::text`,
      })
      .from(classpilotCommands)
      .where(and(eq(classpilotCommands.id, commandId), eq(classpilotCommands.schoolId, schoolId)))
      .limit(1);
    if (!commandRow) return undefined;
    const { broadcastRevision, ...command } = commandRow;

    const targets = await tx
      .select()
      .from(classpilotCommandTargets)
      .where(eq(classpilotCommandTargets.commandId, command.id))
      .orderBy(classpilotCommandTargets.createdAt);

    return { command: { ...command, targets }, revision: broadcastRevision };
  });
  if (!snapshot) return undefined;

  // Revision-aware local and Redis publication reject a stale revision if a
  // later committed snapshot happens to publish first after this transaction
  // releases its advisory lock.
  return callback(snapshot.command, snapshot.revision);
}

export async function getRecentClasspilotCommands(
  schoolId: string,
  teacherId: string,
  teachingSessionId?: string | null,
  limit = 10
): Promise<ClasspilotCommandWithTargets[]> {
  await expireClasspilotTransientCommandTargets({
    schoolId,
    teacherId,
  });
  const conditions = [
    eq(classpilotCommands.schoolId, schoolId),
    eq(classpilotCommands.teacherId, teacherId),
  ];
  if (teachingSessionId) {
    conditions.push(eq(classpilotCommands.teachingSessionId, teachingSessionId));
  }

  const commands = await db
    .select()
    .from(classpilotCommands)
    .where(and(...conditions))
    .orderBy(desc(classpilotCommands.createdAt))
    .limit(limit);

  if (commands.length === 0) return [];
  const targets = await db
    .select()
    .from(classpilotCommandTargets)
    .where(inArray(classpilotCommandTargets.commandId, commands.map((command) => command.id)))
    .orderBy(classpilotCommandTargets.createdAt);
  const targetsByCommand = new Map<string, ClasspilotCommandTarget[]>();
  for (const target of targets) {
    const list = targetsByCommand.get(target.commandId) || [];
    list.push(target);
    targetsByCommand.set(target.commandId, list);
  }
  return commands.map((command) => ({
    ...command,
    targets: targetsByCommand.get(command.id) || [],
  }));
}

export type ClasspilotControlEnforcementHealth =
  | "synced"
  | "pending"
  | "failed"
  | "unsupported"
  | "expired";

/** Serialize all control-authority mutations for a student across classes and
 * delegated supervision. Sorted transaction locks prevent cross-student
 * deadlocks while keeping identifiers inside PostgreSQL only. */
export async function lockClasspilotStudentControlAuthorities(
  schoolId: string,
  studentIds: readonly string[],
  dbInstance: typeof db = db
): Promise<string[]> {
  const normalized = [...new Set(studentIds.map(String).map((id) => id.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  for (const studentId of normalized) {
    const lockKey = `classpilot:student-control:${schoolId}:${studentId}`;
    await dbInstance.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`
    );
  }
  return normalized;
}

async function lockActiveSchoolStudentsForOperationalWrite(
  schoolId: string,
  studentIds: readonly string[],
  dbInstance: typeof db
): Promise<string[]> {
  const normalized = [...new Set(studentIds.map(String).map((id) => id.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (normalized.length === 0) return [];
  const activeRows = await dbInstance
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        inArray(students.id, normalized),
        eq(students.status, "active")
      )
    )
    .orderBy(students.id)
    .for("update");
  if (activeRows.length !== normalized.length) {
    throw Object.assign(new Error("One or more students are not active in this school"), {
      status: 409,
      code: "STUDENT_INACTIVE",
      expose: true,
    });
  }
  return normalized;
}

/**
 * The extension clears controls at the earlier of the scheduled class end and
 * the absolute 12-hour backstop. Persist that effective scheduled deadline so
 * long reporting windows can start without weakening the safety cutoff or
 * violating the control-state expiry constraint.
 */
function effectiveClasspilotScheduledControlEndAt(
  scheduledEndAt: Date | null | undefined,
  hardExpiresAt: Date
): Date | null {
  if (!scheduledEndAt) return null;
  return scheduledEndAt < hardExpiresAt ? scheduledEndAt : hardExpiresAt;
}

/**
 * Bind every frozen roster student to a revisioned empty control snapshot as
 * soon as a class begins. Besides replacing a former teacher's state, this
 * gives the extension an authenticated teaching-session scope for its bounded
 * monitoring-event outbox even before the new teacher applies a restriction.
 */
export async function initializeClasspilotStudentControlStatesForSession(
  session: TeachingSession,
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  if (!session.schoolId || session.endTime) return [];
  const roster = await dbInstance
    .select({ studentId: classpilotSessionStudents.studentId })
    .from(classpilotSessionStudents)
    .where(and(
      eq(classpilotSessionStudents.schoolId, session.schoolId),
      eq(classpilotSessionStudents.teachingSessionId, session.id)
    ));
  if (roster.length === 0) return [];

  const now = new Date();
  const hardExpiresAt = new Date(session.startTime.getTime() + 12 * 60 * 60 * 1000);
  if (hardExpiresAt <= now) return [];
  return replaceClasspilotStudentControlSnapshots({
    schoolId: session.schoolId,
    teachingSessionId: session.id,
    // The replacement transaction rechecks the authoritative owner after it
    // acquires the per-student locks. Passing the full frozen roster here
    // avoids a pre-lock supervision read racing a simultaneous release.
    studentIds: roster.map((row) => row.studentId),
    desiredState: { restrictions: {} },
    scheduledEndAt: effectiveClasspilotScheduledControlEndAt(
      session.scheduledEndAt,
      hardExpiresAt
    ),
    hardExpiresAt,
    now,
    authorityMode: "filter",
  }, dbInstance);
}

function assertDesiredControlState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("A complete desired control-state object is required"), {
      status: 400,
      code: "INVALID_CONTROL_STATE",
    });
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    throw Object.assign(new Error("Desired control state exceeds 64 KiB"), {
      status: 400,
      code: "CONTROL_STATE_TOO_LARGE",
    });
  }
  return value as Record<string, unknown>;
}

/**
 * Atomically replaces the complete desired snapshot for every selected roster
 * student. Revisions are allocated in PostgreSQL so concurrent command paths
 * can never publish the same or a decreasing revision.
 */
export async function replaceClasspilotStudentControlSnapshots(
  options: {
    schoolId: string;
    teachingSessionId: string;
    studentIds: string[];
    desiredState: unknown | ((
      studentId: string,
      currentState: ClasspilotStudentControlState | null,
      activeClassroomStates: ClasspilotClassroomState[]
    ) => unknown);
    sourceCommandId?: string | null;
    scheduledEndAt?: Date | null;
    hardExpiresAt?: Date;
    now?: Date;
    authorityMode?: "require" | "filter";
  },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  const studentIds = [...new Set(options.studentIds.filter(Boolean))];
  if (studentIds.length === 0) return [];
  const now = options.now || new Date();

  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotStudentControlAuthorities(options.schoolId, studentIds, transactionDb);
    const [session] = await tx
      .select({
        id: teachingSessions.id,
        schoolId: teachingSessions.schoolId,
        startTime: teachingSessions.startTime,
        endTime: teachingSessions.endTime,
        scheduledEndAt: teachingSessions.scheduledEndAt,
      })
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.teachingSessionId),
        eq(teachingSessions.schoolId, options.schoolId)
      ))
      .limit(1);
    if (!session || session.endTime) {
      throw Object.assign(new Error("Active teaching session not found"), {
        status: 404,
        code: "TEACHING_SESSION_NOT_FOUND",
      });
    }

    const absoluteCap = new Date(session.startTime.getTime() + 12 * 60 * 60 * 1000);
    const hardExpiresAt = options.hardExpiresAt || absoluteCap;
    if (hardExpiresAt > absoluteCap || hardExpiresAt <= now) {
      throw Object.assign(new Error("Control-state hard expiry must be valid and within 12 hours of class start"), {
        status: 400,
        code: "INVALID_CONTROL_EXPIRY",
      });
    }
    const scheduledEndAt = options.scheduledEndAt ?? session.scheduledEndAt ?? null;
    if (scheduledEndAt && scheduledEndAt > hardExpiresAt) {
      throw Object.assign(new Error("Scheduled control end cannot exceed the 12-hour safety cutoff"), {
        status: 400,
        code: "INVALID_CONTROL_EXPIRY",
      });
    }

    const roster = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, options.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, options.teachingSessionId),
        inArray(classpilotSessionStudents.studentId, studentIds)
      ));
    if (roster.length !== studentIds.length) {
      throw Object.assign(new Error("One or more control targets are outside the session roster"), {
        status: 404,
        code: "CONTROL_TARGET_NOT_FOUND",
      });
    }

    // The route preflight is advisory UX only. Re-resolve the authoritative
    // class/supervision owner after acquiring the per-student locks, in the
    // same transaction that advances the desired-state revision.
    const activeSupervision = await getActiveSupervisionForStudents(
      options.schoolId,
      studentIds,
      transactionDb
    );
    const activeOwners = await getActiveClassOwnersForStudents(
      options.schoolId,
      studentIds,
      transactionDb
    );
    const supervisedIds = new Set(activeSupervision.map((row) => row.studentId));
    const ownerByStudent = new Map(activeOwners.map((owner) => [owner.studentId, owner.session.id]));
    const authorizedStudentIds = studentIds.filter((studentId) => {
      if (supervisedIds.has(studentId)) return false;
      const ownerSessionId = ownerByStudent.get(studentId);
      return !ownerSessionId || ownerSessionId === options.teachingSessionId;
    });
    if (authorizedStudentIds.length !== studentIds.length && options.authorityMode !== "filter") {
      throw Object.assign(new Error("One or more control targets changed classroom authority"), {
        status: 409,
        code: "CONTROL_AUTHORITY_CHANGED",
      });
    }
    if (authorizedStudentIds.length === 0) return [];

    const currentStates = await tx
      .select()
      .from(classpilotStudentControlStates)
      .where(and(
        eq(classpilotStudentControlStates.schoolId, options.schoolId),
        inArray(classpilotStudentControlStates.studentId, authorizedStudentIds)
      ))
      .orderBy(classpilotStudentControlStates.studentId)
      .for("update");
    const currentByStudent = new Map(currentStates.map((state) => [state.studentId, state]));
    const activeClassroomStates = await tx
      .select()
      .from(classpilotClassroomStates)
      .where(and(
        eq(classpilotClassroomStates.schoolId, options.schoolId),
        eq(classpilotClassroomStates.teachingSessionId, options.teachingSessionId),
        inArray(classpilotClassroomStates.studentId, authorizedStudentIds),
        isNull(classpilotClassroomStates.clearedAt)
      ))
      .orderBy(classpilotClassroomStates.appliedAt);

    const rows: ClasspilotStudentControlState[] = [];
    for (const studentId of authorizedStudentIds) {
      const desiredState = assertDesiredControlState(
        typeof options.desiredState === "function"
          ? options.desiredState(
              studentId,
              currentByStudent.get(studentId) || null,
              activeClassroomStates.filter((state) => state.studentId === studentId)
            )
          : options.desiredState
      );
      const [row] = await tx
        .insert(classpilotStudentControlStates)
        .values({
          schoolId: options.schoolId,
          studentId,
          teachingSessionId: options.teachingSessionId,
          supervisionContextId: null,
          revision: 1,
          desiredState,
          sourceCommandId: options.sourceCommandId || null,
          scheduledEndAt,
          hardExpiresAt,
          enforcementHealth: "pending",
          appliedRevision: null,
          lastOutcome: null,
          lastError: null,
          lastAcknowledgedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            classpilotStudentControlStates.schoolId,
            classpilotStudentControlStates.studentId,
          ],
          set: {
            teachingSessionId: options.teachingSessionId,
            supervisionContextId: null,
            revision: sql`${classpilotStudentControlStates.revision} + 1`,
            desiredState,
            sourceCommandId: options.sourceCommandId || null,
            scheduledEndAt,
            hardExpiresAt,
            enforcementHealth: "pending",
            appliedRevision: null,
            lastOutcome: null,
            lastError: null,
            lastAcknowledgedAt: null,
            updatedAt: now,
          },
        })
        .returning();
      if (row) rows.push(row);
    }
    return rows;
  });
}

/**
 * Revisioned desired state while a student is delegated to an authorized
 * supervision context. The same school/student row is reused so transitions
 * between class and coverage always increase one monotonic revision.
 */
export async function replaceClasspilotSupervisionControlSnapshots(
  options: {
    schoolId: string;
    supervisionContextId: string;
    studentIds: string[];
    desiredState: unknown | ((
      studentId: string,
      currentState: ClasspilotStudentControlState | null
    ) => unknown);
    sourceCommandId?: string | null;
    authorizedActorId?: string;
    actorIsAdmin?: boolean;
    now?: Date;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  const studentIds = [...new Set(options.studentIds.filter(Boolean))];
  if (studentIds.length === 0) return [];
  const now = options.now || new Date();

  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotStudentControlAuthorities(options.schoolId, studentIds, transactionDb);
    const [context] = await tx
      .select()
      .from(classpilotSupervisionContexts)
      .where(and(
        eq(classpilotSupervisionContexts.schoolId, options.schoolId),
        eq(classpilotSupervisionContexts.id, options.supervisionContextId)
      ))
      .limit(1)
      .for("update");
    if (!context || context.status !== "active" || context.endsAt <= now) {
      throw Object.assign(new Error("Active supervision context not found"), {
        status: 404,
        code: "SUPERVISION_CONTEXT_NOT_FOUND",
      });
    }
    if (
      options.authorizedActorId
      && options.actorIsAdmin !== true
      && context.assignedStaffId !== options.authorizedActorId
    ) {
      throw Object.assign(new Error("Active supervision context not found"), {
        status: 404,
        code: "SUPERVISION_CONTEXT_NOT_FOUND",
      });
    }

    const assignments = await tx
      .select({ studentId: classpilotSupervisionStudents.studentId })
      .from(classpilotSupervisionStudents)
      .where(and(
        eq(classpilotSupervisionStudents.schoolId, options.schoolId),
        eq(classpilotSupervisionStudents.contextId, options.supervisionContextId),
        inArray(classpilotSupervisionStudents.studentId, studentIds),
        isNull(classpilotSupervisionStudents.releasedAt)
      ));
    if (assignments.length !== studentIds.length) {
      throw Object.assign(new Error("One or more control targets are outside the supervision context"), {
        status: 404,
        code: "CONTROL_TARGET_NOT_FOUND",
      });
    }

    const hardExpiresAt = new Date(context.startsAt.getTime() + 12 * 60 * 60 * 1000);
    if (hardExpiresAt <= now) {
      throw Object.assign(new Error("Supervision control safety cutoff has expired"), {
        status: 400,
        code: "INVALID_CONTROL_EXPIRY",
      });
    }
    const scheduledEndAt = context.endsAt < hardExpiresAt ? context.endsAt : hardExpiresAt;
    const currentStates = await tx
      .select()
      .from(classpilotStudentControlStates)
      .where(and(
        eq(classpilotStudentControlStates.schoolId, options.schoolId),
        inArray(classpilotStudentControlStates.studentId, studentIds)
      ))
      .orderBy(classpilotStudentControlStates.studentId)
      .for("update");
    const currentByStudent = new Map(currentStates.map((state) => [state.studentId, state]));
    const rows: ClasspilotStudentControlState[] = [];
    for (const studentId of studentIds) {
      const desiredState = assertDesiredControlState(
        typeof options.desiredState === "function"
          ? options.desiredState(studentId, currentByStudent.get(studentId) || null)
          : options.desiredState
      );
      const [row] = await tx
        .insert(classpilotStudentControlStates)
        .values({
          schoolId: options.schoolId,
          studentId,
          teachingSessionId: null,
          supervisionContextId: options.supervisionContextId,
          revision: 1,
          desiredState,
          sourceCommandId: options.sourceCommandId || null,
          scheduledEndAt,
          hardExpiresAt,
          enforcementHealth: "pending",
          appliedRevision: null,
          lastOutcome: null,
          lastError: null,
          lastAcknowledgedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            classpilotStudentControlStates.schoolId,
            classpilotStudentControlStates.studentId,
          ],
          set: {
            teachingSessionId: null,
            supervisionContextId: options.supervisionContextId,
            revision: sql`${classpilotStudentControlStates.revision} + 1`,
            desiredState,
            sourceCommandId: options.sourceCommandId || null,
            scheduledEndAt,
            hardExpiresAt,
            enforcementHealth: "pending",
            appliedRevision: null,
            lastOutcome: null,
            lastError: null,
            lastAcknowledgedAt: null,
            updatedAt: now,
          },
        })
        .returning();
      if (row) rows.push(row);
    }
    return rows;
  });
}

export async function initializeClasspilotSupervisionControlStates(
  options: {
    schoolId: string;
    supervisionContextId: string;
    studentIds: string[];
    now?: Date;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  return replaceClasspilotSupervisionControlSnapshots({
    ...options,
    desiredState: { restrictions: emptyClasspilotRestrictions() },
  }, dbInstance);
}

/** Restore the class snapshot hidden by delegation, or publish an explicit
 * higher-revision clear when no live class still owns the student. */
export async function restoreClasspilotStudentControlStatesAfterSupervision(
  options: {
    schoolId: string;
    supervisionContextId: string;
    studentIds: string[];
    restoredAt?: Date;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  const studentIds = [...new Set(options.studentIds.filter(Boolean))];
  if (studentIds.length === 0) return [];
  const now = options.restoredAt || new Date();

  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotStudentControlAuthorities(options.schoolId, studentIds, transactionDb);
    const currentRows = await tx
      .select()
      .from(classpilotStudentControlStates)
      .where(and(
        eq(classpilotStudentControlStates.schoolId, options.schoolId),
        inArray(classpilotStudentControlStates.studentId, studentIds)
      ))
      .for("update");
    const restorableIds = currentRows
      .filter((row) => row.supervisionContextId === options.supervisionContextId)
      .map((row) => row.studentId);
    if (restorableIds.length === 0) return [];

    const owners = await getActiveClassOwnersForStudents(options.schoolId, restorableIds, transactionDb);
    const ownerByStudent = new Map(owners.map((owner) => [owner.studentId, owner]));
    const restored: ClasspilotStudentControlState[] = [];
    for (const studentId of restorableIds) {
      const owner = ownerByStudent.get(studentId);
      const hardExpiresAt = owner
        ? new Date(owner.session.startTime.getTime() + 12 * 60 * 60 * 1000)
        : null;
      if (owner && hardExpiresAt && hardExpiresAt > now) {
        const activeStates = await transactionDb
          .select()
          .from(classpilotClassroomStates)
          .where(and(
            eq(classpilotClassroomStates.schoolId, options.schoolId),
            eq(classpilotClassroomStates.teachingSessionId, owner.session.id),
            or(eq(classpilotClassroomStates.studentId, studentId), isNull(classpilotClassroomStates.studentId)),
            isNull(classpilotClassroomStates.clearedAt)
          ))
          .orderBy(classpilotClassroomStates.appliedAt);
        const scheduledEndAt = effectiveClasspilotScheduledControlEndAt(
          owner.session.scheduledEndAt,
          hardExpiresAt
        );
        const rows = await replaceClasspilotStudentControlSnapshots({
          schoolId: options.schoolId,
          teachingSessionId: owner.session.id,
          studentIds: [studentId],
          desiredState: {
            restrictions: restrictionsFromClassroomStates(activeStates, now),
          },
          scheduledEndAt,
          hardExpiresAt,
          now,
        }, transactionDb);
        restored.push(...rows);
        continue;
      }

      const [cleared] = await tx
        .update(classpilotStudentControlStates)
        .set({
          teachingSessionId: null,
          supervisionContextId: null,
          revision: sql`${classpilotStudentControlStates.revision} + 1`,
          desiredState: {},
          sourceCommandId: null,
          scheduledEndAt: null,
          hardExpiresAt: null,
          enforcementHealth: "pending",
          appliedRevision: null,
          lastOutcome: "cleared",
          lastError: null,
          lastAcknowledgedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(classpilotStudentControlStates.schoolId, options.schoolId),
          eq(classpilotStudentControlStates.studentId, studentId),
          eq(classpilotStudentControlStates.supervisionContextId, options.supervisionContextId)
        ))
        .returning();
      if (cleared) restored.push(cleared);
    }
    return restored;
  });
}

/**
 * Finalization-safe empty snapshots. A row that already belongs to a newer
 * class is deliberately left alone; missing rows receive revision 1 so every
 * former roster student has an explicit clear state to reconcile.
 */
export async function clearClasspilotStudentControlStatesForSession(
  options: { schoolId: string; teachingSessionId: string; clearedAt?: Date },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  const now = options.clearedAt || new Date();
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    const roster = await tx
      .select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents)
      .where(and(
        eq(classpilotSessionStudents.schoolId, options.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, options.teachingSessionId)
      ));
    if (roster.length === 0) return [];

    const studentIds = roster.map((row) => row.studentId);
    await lockClasspilotStudentControlAuthorities(options.schoolId, studentIds, transactionDb);
    const cleared = await tx
      .update(classpilotStudentControlStates)
      .set({
        teachingSessionId: null,
        supervisionContextId: null,
        revision: sql`${classpilotStudentControlStates.revision} + 1`,
        desiredState: {},
        sourceCommandId: null,
        scheduledEndAt: null,
        hardExpiresAt: null,
        enforcementHealth: "pending",
        appliedRevision: null,
        lastOutcome: "cleared",
        lastError: null,
        lastAcknowledgedAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(classpilotStudentControlStates.schoolId, options.schoolId),
        eq(classpilotStudentControlStates.teachingSessionId, options.teachingSessionId),
        inArray(classpilotStudentControlStates.studentId, studentIds)
      ))
      .returning();
    const existingStudentIds = new Set((await tx
      .select({ studentId: classpilotStudentControlStates.studentId })
      .from(classpilotStudentControlStates)
      .where(and(
        eq(classpilotStudentControlStates.schoolId, options.schoolId),
        inArray(classpilotStudentControlStates.studentId, studentIds)
      ))).map((row) => row.studentId));
    const missing = studentIds.filter((studentId) => !existingStudentIds.has(studentId));
    const inserted = missing.length > 0
      ? await tx
          .insert(classpilotStudentControlStates)
          .values(missing.map((studentId) => ({
            schoolId: options.schoolId,
            studentId,
            teachingSessionId: null,
            supervisionContextId: null,
            revision: 1,
            desiredState: {},
            enforcementHealth: "pending" as const,
            lastOutcome: "cleared",
            updatedAt: now,
          })))
          .onConflictDoNothing()
          .returning()
      : [];
    return [...cleared, ...inserted];
  });
}

export async function getClasspilotStudentControlState(
  schoolId: string,
  studentId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState | undefined> {
  const [state] = await dbInstance
    .select()
    .from(classpilotStudentControlStates)
    .where(and(
      eq(classpilotStudentControlStates.schoolId, schoolId),
      eq(classpilotStudentControlStates.studentId, studentId)
    ))
    .limit(1);
  return state;
}

export async function getClasspilotStudentControlStates(
  schoolId: string,
  studentIds: string[],
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState[]> {
  const uniqueStudentIds = [...new Set(studentIds.filter(Boolean))];
  if (uniqueStudentIds.length === 0) return [];
  return dbInstance
    .select()
    .from(classpilotStudentControlStates)
    .where(and(
      eq(classpilotStudentControlStates.schoolId, schoolId),
      inArray(classpilotStudentControlStates.studentId, uniqueStudentIds)
    ));
}

export async function acknowledgeClasspilotStudentControlState(
  options: {
    schoolId: string;
    studentId: string;
    studentSessionId: string;
    deviceId: string;
    appliedRevision: number;
    outcome: "applied" | "failed" | "unsupported" | "expired";
    error?: string | null;
    acknowledgedAt?: Date;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotStudentControlState | undefined> {
  if (!Number.isSafeInteger(options.appliedRevision) || options.appliedRevision < 0) return undefined;
  const health: ClasspilotControlEnforcementHealth = options.outcome === "applied"
    ? "synced"
    : options.outcome;
  const [state] = await dbInstance
    .update(classpilotStudentControlStates)
    .set({
      enforcementHealth: health,
      appliedRevision: options.appliedRevision,
      lastOutcome: options.outcome,
      lastError: options.error?.slice(0, 500) || null,
      lastAcknowledgedAt: options.acknowledgedAt || new Date(),
      updatedAt: options.acknowledgedAt || new Date(),
    })
    .where(and(
      eq(classpilotStudentControlStates.schoolId, options.schoolId),
      eq(classpilotStudentControlStates.studentId, options.studentId),
      eq(classpilotStudentControlStates.revision, options.appliedRevision),
      sql`EXISTS (
        SELECT 1
        FROM student_sessions active_session
        JOIN student_devices active_device
          ON active_device.device_id = active_session.device_id
        WHERE active_session.id = ${options.studentSessionId}
          AND active_session.student_id = ${options.studentId}
          AND active_session.device_id = ${options.deviceId}
          AND active_session.is_active = true
          AND active_session.ended_at IS NULL
          AND active_device.school_id = ${options.schoolId}
      )`
    ))
    .returning();
  return state;
}

/**
 * Canonical transaction boundary for a stateful teacher command. The legacy
 * active-state representation and the per-student full desired snapshots
 * either both commit or neither does. The dispatcher remains responsible for
 * constructing the complete post-command snapshot before calling this helper.
 */
export async function persistClasspilotControlCommandState(
  options: {
    classroomStateUpserts?: InsertClasspilotClassroomState[];
    classroomStateClears?: Array<{
      schoolId: string;
      teachingSessionId: string;
      studentIds?: string[];
      stateTypes?: string[];
      commandId?: string;
    }>;
    studentSnapshots: {
      schoolId: string;
      teachingSessionId: string;
      studentIds: string[];
      desiredState: unknown | ((
        studentId: string,
        currentState: ClasspilotStudentControlState | null,
        activeClassroomStates: ClasspilotClassroomState[]
      ) => unknown);
      sourceCommandId?: string | null;
      scheduledEndAt?: Date | null;
      hardExpiresAt?: Date;
      now?: Date;
    };
  },
  dbInstance: typeof db = db
): Promise<{
  classroomStates: ClasspilotClassroomState[];
  studentControlStates: ClasspilotStudentControlState[];
}> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockClasspilotStudentControlAuthorities(
      options.studentSnapshots.schoolId,
      options.studentSnapshots.studentIds,
      transactionDb
    );
    // Serialize the entire read/modify/write operation before changing the
    // legacy active-state rows. Building a full snapshot outside this lock can
    // otherwise drop a concurrent teacher command even when revisions remain
    // monotonic.
    const [lockedSession] = await tx
      .select({ id: teachingSessions.id })
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.studentSnapshots.teachingSessionId),
        eq(teachingSessions.schoolId, options.studentSnapshots.schoolId),
        isNull(teachingSessions.endTime)
      ))
      .limit(1)
      .for("update");
    if (!lockedSession) {
      throw Object.assign(new Error("Active teaching session not found"), {
        status: 404,
        code: "TEACHING_SESSION_NOT_FOUND",
      });
    }
    for (const clear of options.classroomStateClears || []) {
      await clearClasspilotClassroomStates(clear, transactionDb);
    }
    const classroomStates = await upsertClasspilotClassroomStates(
      options.classroomStateUpserts || [],
      transactionDb
    );
    const studentControlStates = await replaceClasspilotStudentControlSnapshots(
      options.studentSnapshots,
      transactionDb
    );
    return { classroomStates, studentControlStates };
  });
}

export async function upsertClasspilotClassroomStates(
  statesData: InsertClasspilotClassroomState[],
  dbInstance: typeof db = db
): Promise<ClasspilotClassroomState[]> {
  if (statesData.length === 0) return [];
  const rows: ClasspilotClassroomState[] = [];
  for (const state of statesData) {
    const [existing] = await dbInstance
      .select()
      .from(classpilotClassroomStates)
      .where(
        and(
          eq(classpilotClassroomStates.schoolId, state.schoolId),
          eq(classpilotClassroomStates.teachingSessionId, state.teachingSessionId),
          state.studentId === null || state.studentId === undefined
            ? isNull(classpilotClassroomStates.studentId)
            : eq(classpilotClassroomStates.studentId, state.studentId),
          eq(classpilotClassroomStates.stateType, state.stateType),
          eq(classpilotClassroomStates.stateKey, state.stateKey),
          isNull(classpilotClassroomStates.clearedAt)
        )
      )
      .limit(1);

    if (existing) {
      const [row] = await dbInstance
        .update(classpilotClassroomStates)
        .set({
          payload: state.payload,
          commandId: state.commandId,
          appliedBy: state.appliedBy,
          appliedAt: state.appliedAt || new Date(),
          expiresAt: state.expiresAt || null,
          updatedAt: new Date(),
        })
        .where(eq(classpilotClassroomStates.id, existing.id))
        .returning();
      if (row) rows.push(row);
      continue;
    }

    const [row] = await dbInstance
      .insert(classpilotClassroomStates)
      .values(state)
      .returning();
    if (row) rows.push(row);
  }
  return rows;
}

export async function clearClasspilotClassroomStates(options: {
  schoolId: string;
  teachingSessionId: string;
  studentIds?: string[];
  stateTypes?: string[];
  commandId?: string;
}, dbInstance: typeof db = db): Promise<void> {
  const conditions: SQL[] = [
    eq(classpilotClassroomStates.schoolId, options.schoolId),
    eq(classpilotClassroomStates.teachingSessionId, options.teachingSessionId),
    isNull(classpilotClassroomStates.clearedAt),
  ];
  if (options.studentIds?.length) {
    conditions.push(inArray(classpilotClassroomStates.studentId, options.studentIds));
  }
  if (options.stateTypes?.length) {
    conditions.push(inArray(classpilotClassroomStates.stateType, options.stateTypes));
  }
  await dbInstance
    .update(classpilotClassroomStates)
    .set({ clearedAt: new Date(), commandId: options.commandId || null, updatedAt: new Date() })
    .where(and(...conditions));
}

export async function getActiveClasspilotClassroomStates(
  schoolId: string,
  teachingSessionId: string
): Promise<ClasspilotClassroomState[]> {
  return db
    .select()
    .from(classpilotClassroomStates)
    .where(
      and(
        eq(classpilotClassroomStates.schoolId, schoolId),
        eq(classpilotClassroomStates.teachingSessionId, teachingSessionId),
        isNull(classpilotClassroomStates.clearedAt)
      )
    )
    .orderBy(classpilotClassroomStates.appliedAt);
}

// ============================================================================
// ClassPilot - Supervision coverage operations
// ============================================================================

export type ActiveStudentSupervision = {
  studentId: string;
  assignment: ClasspilotSupervisionStudent;
  context: ClasspilotSupervisionContext;
};

export type OnlineUnassignedStudent = {
  student: Student;
  studentSession: StudentSession;
};

export type CoverageScopeGroupWithMembers = ClasspilotCoverageScopeGroup & {
  members: (ClasspilotCoverageScopeGroupMember & { student: Student })[];
};

function activeSupervisionCondition(schoolId: string) {
  return and(
    eq(classpilotSupervisionStudents.schoolId, schoolId),
    isNull(classpilotSupervisionStudents.releasedAt),
    eq(classpilotSupervisionContexts.schoolId, schoolId),
    eq(classpilotSupervisionContexts.status, "active"),
    sql`${classpilotSupervisionContexts.endsAt} > now()`
  );
}

export async function listCoverageScopeGroups(
  schoolId: string,
  options: { activeOnly?: boolean } = {}
): Promise<CoverageScopeGroupWithMembers[]> {
  const conditions: SQL[] = [eq(classpilotCoverageScopeGroups.schoolId, schoolId)];
  if (options.activeOnly) conditions.push(eq(classpilotCoverageScopeGroups.active, true));

  const groupsRows = await db
    .select()
    .from(classpilotCoverageScopeGroups)
    .where(and(...conditions))
    .orderBy(desc(classpilotCoverageScopeGroups.active), classpilotCoverageScopeGroups.name);

  if (groupsRows.length === 0) return [];
  const groupIds = groupsRows.map((group) => group.id);
  const members = await db
    .select({ member: classpilotCoverageScopeGroupMembers, student: students })
    .from(classpilotCoverageScopeGroupMembers)
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotCoverageScopeGroupMembers.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(classpilotCoverageScopeGroupMembers.schoolId, schoolId),
        inArray(classpilotCoverageScopeGroupMembers.coverageGroupId, groupIds)
      )
    )
    .orderBy(students.lastName, students.firstName);

  const membersByGroup = new Map<string, (ClasspilotCoverageScopeGroupMember & { student: Student })[]>();
  for (const row of members) {
    const list = membersByGroup.get(row.member.coverageGroupId) || [];
    list.push({ ...row.member, student: row.student });
    membersByGroup.set(row.member.coverageGroupId, list);
  }

  return groupsRows.map((group) => ({
    ...group,
    members: membersByGroup.get(group.id) || [],
  }));
}

export async function getCoverageScopeGroupByIdAndSchool(
  schoolId: string,
  groupId: string
): Promise<CoverageScopeGroupWithMembers | undefined> {
  const groups = await listCoverageScopeGroups(schoolId, { activeOnly: false });
  return groups.find((group) => group.id === groupId);
}

export async function createCoverageScopeGroup(options: {
  group: InsertClasspilotCoverageScopeGroup;
  studentIds: string[];
}): Promise<CoverageScopeGroupWithMembers> {
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));
  const created = await db.transaction(async (tx) => {
    await lockActiveSchoolStudentsForOperationalWrite(
      options.group.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    const [group] = await tx
      .insert(classpilotCoverageScopeGroups)
      .values(options.group)
      .returning();
    if (!group) throw new Error("Failed to create coverage group");

    if (uniqueStudentIds.length > 0) {
      await tx.insert(classpilotCoverageScopeGroupMembers).values(
        uniqueStudentIds.map((studentId) => ({
          schoolId: group.schoolId,
          coverageGroupId: group.id,
          studentId,
        }))
      );
    }

    return group;
  });

  return (await getCoverageScopeGroupByIdAndSchool(created.schoolId, created.id))!;
}

export async function updateCoverageScopeGroup(options: {
  schoolId: string;
  groupId: string;
  name?: string;
  description?: string | null;
  active?: boolean;
}): Promise<CoverageScopeGroupWithMembers | undefined> {
  const data: Partial<InsertClasspilotCoverageScopeGroup> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (options.name !== undefined) data.name = options.name;
  if (options.description !== undefined) data.description = options.description;
  if (options.active !== undefined) data.active = options.active;

  const [updated] = await db
    .update(classpilotCoverageScopeGroups)
    .set(data)
    .where(
      and(
        eq(classpilotCoverageScopeGroups.schoolId, options.schoolId),
        eq(classpilotCoverageScopeGroups.id, options.groupId)
      )
    )
    .returning();
  if (!updated) return undefined;
  return getCoverageScopeGroupByIdAndSchool(options.schoolId, options.groupId);
}

export async function replaceCoverageScopeGroupMembers(options: {
  schoolId: string;
  groupId: string;
  studentIds: string[];
}): Promise<CoverageScopeGroupWithMembers | undefined> {
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));
  const group = await getCoverageScopeGroupByIdAndSchool(options.schoolId, options.groupId);
  if (!group) return undefined;

  await db.transaction(async (tx) => {
    await lockActiveSchoolStudentsForOperationalWrite(
      options.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    await tx
      .delete(classpilotCoverageScopeGroupMembers)
      .where(
        and(
          eq(classpilotCoverageScopeGroupMembers.schoolId, options.schoolId),
          eq(classpilotCoverageScopeGroupMembers.coverageGroupId, options.groupId)
        )
      );
    if (uniqueStudentIds.length > 0) {
      await tx.insert(classpilotCoverageScopeGroupMembers).values(
        uniqueStudentIds.map((studentId) => ({
          schoolId: options.schoolId,
          coverageGroupId: options.groupId,
          studentId,
        }))
      );
    }
    await tx
      .update(classpilotCoverageScopeGroups)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(classpilotCoverageScopeGroups.schoolId, options.schoolId),
          eq(classpilotCoverageScopeGroups.id, options.groupId)
        )
      );
  });

  return getCoverageScopeGroupByIdAndSchool(options.schoolId, options.groupId);
}

export async function getCoverageScopeGroupStudentIds(
  schoolId: string,
  groupId: string
): Promise<string[]> {
  const rows = await db
    .select({ studentId: classpilotCoverageScopeGroupMembers.studentId })
    .from(classpilotCoverageScopeGroupMembers)
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotCoverageScopeGroupMembers.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(classpilotCoverageScopeGroupMembers.schoolId, schoolId),
        eq(classpilotCoverageScopeGroupMembers.coverageGroupId, groupId)
      )
    );
  return rows.map((row) => row.studentId);
}

export async function getActiveCoverageAssignmentsForScopeGroup(
  schoolId: string,
  groupId: string
): Promise<ClasspilotCoverageAssignment[]> {
  return db
    .select()
    .from(classpilotCoverageAssignments)
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.scopeType, "coverage_group"),
        eq(classpilotCoverageAssignments.scopeValue, groupId),
        eq(classpilotCoverageAssignments.active, true)
      )
    )
    .orderBy(classpilotCoverageAssignments.createdAt);
}

export async function replaceCoverageScopeGroupStaff(options: {
  schoolId: string;
  groupId: string;
  staffIds: string[];
  createdBy: string;
}): Promise<ClasspilotCoverageAssignment[]> {
  const staffIds = Array.from(new Set(options.staffIds.map(String).filter(Boolean)));
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(classpilotCoverageAssignments)
      .where(
        and(
          eq(classpilotCoverageAssignments.schoolId, options.schoolId),
          eq(classpilotCoverageAssignments.scopeType, "coverage_group"),
          eq(classpilotCoverageAssignments.scopeValue, options.groupId),
          eq(classpilotCoverageAssignments.active, true)
        )
      );
    const selected = new Set(staffIds);

    for (const assignment of existing) {
      const permissions = (assignment.permissions || {}) as Record<string, unknown>;
      const hasSetup = permissions.setup === true;
      const hasClaim = permissions.claim === true || permissions.observe === true;
      const shouldClaim = selected.has(assignment.staffId);

      if (shouldClaim) {
        if (!hasClaim) {
          await tx
            .update(classpilotCoverageAssignments)
            .set({
              permissions: { ...permissions, observe: true, claim: true },
              updatedAt: new Date(),
            })
            .where(eq(classpilotCoverageAssignments.id, assignment.id));
        }
        selected.delete(assignment.staffId);
      } else if (hasSetup && hasClaim) {
        const setupOnly = { ...permissions };
        delete setupOnly.claim;
        delete setupOnly.observe;
        await tx
          .update(classpilotCoverageAssignments)
          .set({ permissions: setupOnly, updatedAt: new Date() })
          .where(eq(classpilotCoverageAssignments.id, assignment.id));
      } else if (hasClaim) {
        await tx
          .update(classpilotCoverageAssignments)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(classpilotCoverageAssignments.id, assignment.id));
      }
    }

    if (selected.size > 0) {
      await tx.insert(classpilotCoverageAssignments).values(
        Array.from(selected).map((staffId) => ({
          schoolId: options.schoolId,
          staffId,
          scopeType: "coverage_group" as const,
          scopeValue: options.groupId,
          permissions: { observe: true, claim: true },
          active: true,
          createdBy: options.createdBy,
        }))
      );
    }
  });

  return getActiveCoverageAssignmentsForScopeGroup(options.schoolId, options.groupId);
}

export async function listCoverageAssignments(
  schoolId: string
): Promise<ClasspilotCoverageAssignment[]> {
  return db
    .select()
    .from(classpilotCoverageAssignments)
    .where(eq(classpilotCoverageAssignments.schoolId, schoolId))
    .orderBy(desc(classpilotCoverageAssignments.active), classpilotCoverageAssignments.scopeType, classpilotCoverageAssignments.createdAt);
}

export async function getActiveCoverageAssignmentsForStaff(
  schoolId: string,
  staffId: string
): Promise<ClasspilotCoverageAssignment[]> {
  return db
    .select()
    .from(classpilotCoverageAssignments)
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.staffId, staffId),
        eq(classpilotCoverageAssignments.active, true)
      )
    )
    .orderBy(classpilotCoverageAssignments.scopeType, classpilotCoverageAssignments.createdAt);
}

export async function createCoverageAssignment(
  data: InsertClasspilotCoverageAssignment
): Promise<ClasspilotCoverageAssignment> {
  const [row] = await db
    .insert(classpilotCoverageAssignments)
    .values(data)
    .returning();
  return row!;
}

export async function updateCoverageAssignmentActive(
  schoolId: string,
  assignmentId: string,
  active: boolean
): Promise<ClasspilotCoverageAssignment | undefined> {
  const [row] = await db
    .update(classpilotCoverageAssignments)
    .set({ active, updatedAt: new Date() })
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.id, assignmentId)
      )
    )
    .returning();
  return row;
}

export async function updateCoverageAssignment(
  schoolId: string,
  assignmentId: string,
  data: Partial<Pick<InsertClasspilotCoverageAssignment, "staffId" | "scopeType" | "scopeValue" | "permissions" | "active">>
): Promise<ClasspilotCoverageAssignment | undefined> {
  const [row] = await db
    .update(classpilotCoverageAssignments)
    .set({ ...data, updatedAt: new Date() })
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.id, assignmentId)
      )
    )
    .returning();
  return row;
}

export async function getActiveSupervisionForStudents(
  schoolId: string,
  studentIds: string[],
  dbInstance: typeof db = db
): Promise<ActiveStudentSupervision[]> {
  if (studentIds.length === 0) return [];
  const rows = await dbInstance
    .select({
      assignment: classpilotSupervisionStudents,
      context: classpilotSupervisionContexts,
    })
    .from(classpilotSupervisionStudents)
    .innerJoin(
      classpilotSupervisionContexts,
      eq(classpilotSupervisionStudents.contextId, classpilotSupervisionContexts.id)
    )
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotSupervisionStudents.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        activeSupervisionCondition(schoolId),
        inArray(classpilotSupervisionStudents.studentId, studentIds)
      )
    );
  return rows.map((row) => ({
    studentId: row.assignment.studentId,
    assignment: row.assignment,
    context: row.context,
  }));
}

export async function getActiveSupervisionForStudent(
  schoolId: string,
  studentId: string
): Promise<ActiveStudentSupervision | undefined> {
  const rows = await getActiveSupervisionForStudents(schoolId, [studentId]);
  return rows[0];
}

export async function getSupervisionContextByIdAndSchool(
  schoolId: string,
  contextId: string
): Promise<ClasspilotSupervisionContext | undefined> {
  const [context] = await db
    .select()
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.id, contextId)
      )
    )
    .limit(1);
  return context;
}

export async function getActiveSupervisionContextForStaffGroup(
  schoolId: string,
  staffId: string,
  coverageGroupId: string
): Promise<ClasspilotSupervisionContext | undefined> {
  const [context] = await db
    .select()
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, staffId),
        eq(classpilotSupervisionContexts.coverageGroupId, coverageGroupId),
        eq(classpilotSupervisionContexts.status, "active"),
        sql`${classpilotSupervisionContexts.endsAt} > now()`
      )
    )
    .orderBy(desc(classpilotSupervisionContexts.createdAt))
    .limit(1);
  return context;
}

export async function getActiveDirectSupervisionContextForStaff(
  schoolId: string,
  staffId: string
): Promise<ClasspilotSupervisionContext | undefined> {
  const [context] = await db
    .select()
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, staffId),
        eq(classpilotSupervisionContexts.contextType, "direct_pickup"),
        isNull(classpilotSupervisionContexts.coverageGroupId),
        eq(classpilotSupervisionContexts.status, "active"),
        sql`${classpilotSupervisionContexts.endsAt} > now()`
      )
    )
    .orderBy(desc(classpilotSupervisionContexts.createdAt))
    .limit(1);
  return context;
}

export async function getActiveSupervisionContextForStaffScheduledConflict(
  schoolId: string,
  staffId: string,
  scheduledConflictId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSupervisionContext | undefined> {
  const [context] = await dbInstance
    .select()
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, staffId),
        eq(classpilotSupervisionContexts.scheduledConflictId, scheduledConflictId),
        eq(classpilotSupervisionContexts.status, "active"),
        sql`${classpilotSupervisionContexts.endsAt} > now()`
      )
    )
    .orderBy(desc(classpilotSupervisionContexts.createdAt))
    .limit(1);
  return context;
}

/**
 * Claim scheduled coverage under the canonical student→occurrence→conflict lock order.
 * Finalization that wins first makes this a side-effect-free 409; a successful
 * claim cannot later resurrect a terminal conflict.
 */
export async function claimScheduledCoverageStudents(options: {
  schoolId: string;
  scheduledConflictId: string;
  className: string;
  assignedStaffId: string;
  actorId: string;
  studentIds: string[];
  endsAt: Date;
  note?: string | null;
}, dbInstance: typeof db = db): Promise<{
  context: ClasspilotSupervisionContext;
  assignments: ClasspilotSupervisionStudent[];
}> {
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));
  return dbInstance.transaction(async (tx) => {
    const [preExistingContext] = await tx
      .select({ id: classpilotSupervisionContexts.id })
      .from(classpilotSupervisionContexts)
      .where(and(
        eq(classpilotSupervisionContexts.schoolId, options.schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, options.assignedStaffId),
        eq(classpilotSupervisionContexts.scheduledConflictId, options.scheduledConflictId),
        eq(classpilotSupervisionContexts.status, "active")
      ))
      .orderBy(desc(classpilotSupervisionContexts.createdAt))
      .limit(1);
    const preExistingAssignments = preExistingContext
      ? await tx
          .select({ studentId: classpilotSupervisionStudents.studentId })
          .from(classpilotSupervisionStudents)
          .where(and(
            eq(classpilotSupervisionStudents.schoolId, options.schoolId),
            eq(classpilotSupervisionStudents.contextId, preExistingContext.id),
            isNull(classpilotSupervisionStudents.releasedAt)
          ))
      : [];
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      [
        ...uniqueStudentIds,
        ...preExistingAssignments.map((row) => row.studentId),
      ],
      tx as unknown as typeof db
    );
    await lockActiveSchoolStudentsForOperationalWrite(
      options.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    const [occurrence] = await tx
      .select()
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.schoolId, options.schoolId),
        eq(teachingSessions.scheduledConflictId, options.scheduledConflictId),
        eq(teachingSessions.scheduledState, "active"),
        isNull(teachingSessions.endTime)
      ))
      .limit(1)
      .for("update");
    if (!occurrence) {
      throw Object.assign(new Error("This scheduled block has ended."), {
        status: 409,
        code: "SCHEDULED_CONFLICT_EXPIRED",
      });
    }

    const [conflict] = await tx
      .select()
      .from(classpilotScheduledConflicts)
      .where(and(
        eq(classpilotScheduledConflicts.id, options.scheduledConflictId),
        eq(classpilotScheduledConflicts.schoolId, options.schoolId),
        inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
      ))
      .limit(1)
      .for("update");
    if (!conflict) {
      throw Object.assign(new Error("This scheduled block has ended."), {
        status: 409,
        code: "SCHEDULED_CONFLICT_EXPIRED",
      });
    }

    if (uniqueStudentIds.length > 0) {
      // Student rows provide a stable lock even when no current supervision
      // assignment exists, so two staff cannot both observe "claimable" and
      // let the second steal the first claim.
      await tx
        .select({ id: students.id })
        .from(students)
        .where(and(
          eq(students.schoolId, options.schoolId),
          inArray(students.id, uniqueStudentIds)
        ))
        .orderBy(students.id)
        .for("update");
    }

    const [existing] = await tx
      .select()
      .from(classpilotSupervisionContexts)
      .where(and(
        eq(classpilotSupervisionContexts.schoolId, options.schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, options.assignedStaffId),
        eq(classpilotSupervisionContexts.scheduledConflictId, conflict.id),
        eq(classpilotSupervisionContexts.status, "active")
      ))
      .orderBy(desc(classpilotSupervisionContexts.createdAt))
      .limit(1)
      .for("update");

    const activeAssignments = uniqueStudentIds.length > 0
      ? await tx
          .select({
            studentId: classpilotSupervisionStudents.studentId,
            contextId: classpilotSupervisionStudents.contextId,
          })
          .from(classpilotSupervisionStudents)
          .innerJoin(
            classpilotSupervisionContexts,
            eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId)
          )
          .where(and(
            eq(classpilotSupervisionStudents.schoolId, options.schoolId),
            inArray(classpilotSupervisionStudents.studentId, uniqueStudentIds),
            isNull(classpilotSupervisionStudents.releasedAt),
            eq(classpilotSupervisionContexts.status, "active"),
            sql`${classpilotSupervisionContexts.endsAt} > now()`
          ))
      : [];
    if (activeAssignments.some((assignment) => assignment.contextId !== existing?.id)) {
      throw Object.assign(new Error("One or more students are no longer available for scheduled coverage"), {
        status: 409,
        code: "SCHEDULED_COVERAGE_STUDENT_UNAVAILABLE",
      });
    }
    const activeOwners = await getActiveClassOwnersForStudents(
      options.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    if (activeOwners.length > 0) {
      throw Object.assign(new Error("One or more students are already active in another class"), {
        status: 409,
        code: "SCHEDULED_COVERAGE_STUDENT_UNAVAILABLE",
      });
    }

    const now = new Date();
    let context: ClasspilotSupervisionContext;
    if (existing) {
      const [updated] = await tx
        .update(classpilotSupervisionContexts)
        .set({
          endsAt: existing.endsAt < options.endsAt ? options.endsAt : existing.endsAt,
          note: options.note || existing.note || null,
          updatedAt: now,
        })
        .where(eq(classpilotSupervisionContexts.id, existing.id))
        .returning();
      context = updated || existing;
    } else {
      const [created] = await tx
        .insert(classpilotSupervisionContexts)
        .values({
          schoolId: options.schoolId,
          contextType: "scheduled_coverage",
          name: `Scheduled Supervision: ${options.className}`,
          status: "active",
          assignedStaffId: options.assignedStaffId,
          coverageGroupId: null,
          scheduledConflictId: conflict.id,
          createdBy: options.actorId,
          note: options.note || null,
          endsAt: options.endsAt,
        })
        .returning();
      if (!created) throw new Error("Failed to create scheduled supervision context");
      context = created;
    }

    if (uniqueStudentIds.length > 0) {
      await tx
        .update(classpilotSupervisionStudents)
        .set({ releasedAt: now, releaseReason: "reassigned" })
        .where(and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          inArray(classpilotSupervisionStudents.studentId, uniqueStudentIds),
          isNull(classpilotSupervisionStudents.releasedAt)
        ));
    }
    const assignments = uniqueStudentIds.length > 0
      ? await tx
          .insert(classpilotSupervisionStudents)
          .values(uniqueStudentIds.map((studentId) => ({
            schoolId: options.schoolId,
            contextId: context.id,
            studentId,
            source: "scheduled_coverage_claim",
            assignedBy: options.actorId,
          })))
          .returning()
      : [];
    const contextWasExtended = Boolean(existing && context.endsAt > existing.endsAt);
    if (contextWasExtended) {
      const activeContextAssignments = await tx
        .select({ studentId: classpilotSupervisionStudents.studentId })
        .from(classpilotSupervisionStudents)
        .where(and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          eq(classpilotSupervisionStudents.contextId, context.id),
          isNull(classpilotSupervisionStudents.releasedAt)
        ));
      await replaceClasspilotSupervisionControlSnapshots({
        schoolId: options.schoolId,
        supervisionContextId: context.id,
        studentIds: activeContextAssignments.map((assignment) => assignment.studentId),
        desiredState: (
          _studentId: string,
          current: ClasspilotStudentControlState | null
        ) => current?.supervisionContextId === context.id
          ? current.desiredState
          : { restrictions: emptyClasspilotRestrictions() },
        now,
      }, tx as unknown as typeof db);
    } else if (uniqueStudentIds.length > 0) {
      await initializeClasspilotSupervisionControlStates({
        schoolId: options.schoolId,
        supervisionContextId: context.id,
        studentIds: uniqueStudentIds,
        now,
      }, tx as unknown as typeof db);
    }

    await tx
      .update(classpilotScheduledConflicts)
      .set({ status: "claimed", lastCheckedAt: now, updatedAt: now })
      .where(and(
        eq(classpilotScheduledConflicts.id, conflict.id),
        eq(classpilotScheduledConflicts.schoolId, options.schoolId),
        inArray(classpilotScheduledConflicts.status, ACTIVE_SCHEDULED_COVERAGE_STATUSES)
      ));
    return { context, assignments };
  });
}

export async function listActiveSupervisionContextsForScheduledConflict(
  schoolId: string,
  scheduledConflictId: string,
  dbInstance: typeof db = db
): Promise<ClasspilotSupervisionContext[]> {
  return dbInstance
    .select()
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.scheduledConflictId, scheduledConflictId),
        eq(classpilotSupervisionContexts.status, "active"),
        sql`${classpilotSupervisionContexts.endsAt} > now()`
      )
    )
    .orderBy(desc(classpilotSupervisionContexts.createdAt));
}

export async function listSupervisionContexts(
  schoolId: string,
  options: { activeOnly?: boolean } = {}
): Promise<ClasspilotSupervisionContext[]> {
  const conditions: SQL[] = [eq(classpilotSupervisionContexts.schoolId, schoolId)];
  if (options.activeOnly) {
    conditions.push(eq(classpilotSupervisionContexts.status, "active"));
    conditions.push(sql`${classpilotSupervisionContexts.endsAt} > now()`);
  }
  return db
    .select()
    .from(classpilotSupervisionContexts)
    .where(and(...conditions))
    .orderBy(desc(classpilotSupervisionContexts.createdAt))
    .limit(200);
}

export async function listSupervisionStudentsForContexts(
  schoolId: string,
  contextIds: string[],
  options: { activeOnly?: boolean } = {}
): Promise<(ClasspilotSupervisionStudent & { student: Student })[]> {
  if (contextIds.length === 0) return [];
  const conditions: SQL[] = [
    eq(classpilotSupervisionStudents.schoolId, schoolId),
    inArray(classpilotSupervisionStudents.contextId, contextIds),
  ];
  if (options.activeOnly) {
    conditions.push(isNull(classpilotSupervisionStudents.releasedAt));
    conditions.push(eq(students.status, "active"));
  }

  const rows = await db
    .select({ assignment: classpilotSupervisionStudents, student: students })
    .from(classpilotSupervisionStudents)
    .innerJoin(
      students,
      and(
        eq(students.id, classpilotSupervisionStudents.studentId),
        eq(students.schoolId, schoolId)
      )
    )
    .where(and(...conditions))
    .orderBy(classpilotSupervisionStudents.assignedAt);

  return rows.map((row) => ({ ...row.assignment, student: row.student }));
}

export async function createSupervisionContextWithStudents(options: {
  context: InsertClasspilotSupervisionContext;
  studentIds: string[];
  assignedBy: string;
  source?: string;
}): Promise<ClasspilotSupervisionContext> {
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));
  return db.transaction(async (tx) => {
    await lockClasspilotStudentControlAuthorities(
      options.context.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    await lockActiveSchoolStudentsForOperationalWrite(
      options.context.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    const [context] = await tx
      .insert(classpilotSupervisionContexts)
      .values(options.context)
      .returning();
    if (!context) throw new Error("Failed to create supervision context");

    if (uniqueStudentIds.length > 0) {
      await tx
        .update(classpilotSupervisionStudents)
        .set({ releasedAt: new Date(), releaseReason: "reassigned" })
        .where(
          and(
            eq(classpilotSupervisionStudents.schoolId, context.schoolId),
            inArray(classpilotSupervisionStudents.studentId, uniqueStudentIds),
            isNull(classpilotSupervisionStudents.releasedAt)
          )
        );
      await tx.insert(classpilotSupervisionStudents).values(
        uniqueStudentIds.map((studentId) => ({
          schoolId: context.schoolId,
          contextId: context.id,
          studentId,
          source: options.source || "manual",
          assignedBy: options.assignedBy,
        }))
      );
      await initializeClasspilotSupervisionControlStates({
        schoolId: context.schoolId,
        supervisionContextId: context.id,
        studentIds: uniqueStudentIds,
      }, tx as unknown as typeof db);
    }

    return context;
  });
}

export async function assignStudentsToSupervisionContext(options: {
  schoolId: string;
  contextId: string;
  studentIds: string[];
  assignedBy: string;
  source?: string;
}): Promise<ClasspilotSupervisionStudent[]> {
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));
  if (uniqueStudentIds.length === 0) return [];

  return db.transaction(async (tx) => {
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    await lockActiveSchoolStudentsForOperationalWrite(
      options.schoolId,
      uniqueStudentIds,
      tx as unknown as typeof db
    );
    await tx
      .update(classpilotSupervisionStudents)
      .set({ releasedAt: new Date(), releaseReason: "reassigned" })
      .where(
        and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          inArray(classpilotSupervisionStudents.studentId, uniqueStudentIds),
          isNull(classpilotSupervisionStudents.releasedAt)
        )
      );

    const assignments = await tx
      .insert(classpilotSupervisionStudents)
      .values(
        uniqueStudentIds.map((studentId) => ({
          schoolId: options.schoolId,
          contextId: options.contextId,
          studentId,
          source: options.source || "reroute",
          assignedBy: options.assignedBy,
        }))
      )
      .returning();
    await initializeClasspilotSupervisionControlStates({
      schoolId: options.schoolId,
      supervisionContextId: options.contextId,
      studentIds: uniqueStudentIds,
    }, tx as unknown as typeof db);
    return assignments;
  });
}

export async function releaseSupervisionStudents(options: {
  schoolId: string;
  contextId: string;
  studentIds?: string[];
  releaseReason?: string;
}): Promise<ClasspilotSupervisionStudent[]> {
  const conditions: SQL[] = [
    eq(classpilotSupervisionStudents.schoolId, options.schoolId),
    eq(classpilotSupervisionStudents.contextId, options.contextId),
    isNull(classpilotSupervisionStudents.releasedAt),
  ];
  if (options.studentIds?.length) {
    conditions.push(inArray(classpilotSupervisionStudents.studentId, options.studentIds));
  }

  return db.transaction(async (tx) => {
    const releasedAt = new Date();
    const releasing = await tx
      .select({ studentId: classpilotSupervisionStudents.studentId })
      .from(classpilotSupervisionStudents)
      .where(and(...conditions));
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      releasing.map((row) => row.studentId),
      tx as unknown as typeof db
    );
    const released = await tx
      .update(classpilotSupervisionStudents)
      .set({
        releasedAt,
        releaseReason: options.releaseReason || "released",
      })
      .where(and(...conditions))
      .returning();

    const remaining = await tx
      .select({ id: classpilotSupervisionStudents.id })
      .from(classpilotSupervisionStudents)
      .where(
        and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          eq(classpilotSupervisionStudents.contextId, options.contextId),
          isNull(classpilotSupervisionStudents.releasedAt)
        )
      )
      .limit(1);
    if (remaining.length === 0) {
      await tx
        .update(classpilotSupervisionContexts)
        .set({ status: "ended", endedAt: releasedAt, updatedAt: releasedAt })
        .where(
          and(
            eq(classpilotSupervisionContexts.schoolId, options.schoolId),
            eq(classpilotSupervisionContexts.id, options.contextId)
          )
        );
    }

    await restoreClasspilotStudentControlStatesAfterSupervision({
      schoolId: options.schoolId,
      supervisionContextId: options.contextId,
      studentIds: released.map((row) => row.studentId),
      restoredAt: releasedAt,
    }, tx as unknown as typeof db);

    return released;
  });
}

export async function extendSupervisionContext(options: {
  schoolId: string;
  contextId: string;
  endsAt?: Date;
  note?: string | null;
  assignedStaffId?: string;
  coverageGroupId?: string | null;
  scheduledConflictId?: string | null;
}): Promise<ClasspilotSupervisionContext | undefined> {
  const data: Partial<InsertClasspilotSupervisionContext> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (options.endsAt) data.endsAt = options.endsAt;
  if (options.note !== undefined) data.note = options.note;
  if (options.assignedStaffId) data.assignedStaffId = options.assignedStaffId;
  if (options.coverageGroupId !== undefined) data.coverageGroupId = options.coverageGroupId;
  if (options.scheduledConflictId !== undefined) data.scheduledConflictId = options.scheduledConflictId;

  return db.transaction(async (tx) => {
    const assignments = await tx
      .select({ studentId: classpilotSupervisionStudents.studentId })
      .from(classpilotSupervisionStudents)
      .where(and(
        eq(classpilotSupervisionStudents.schoolId, options.schoolId),
        eq(classpilotSupervisionStudents.contextId, options.contextId),
        isNull(classpilotSupervisionStudents.releasedAt)
      ));
    const studentIds = assignments.map((assignment) => assignment.studentId);
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      studentIds,
      tx as unknown as typeof db
    );
    const [row] = await tx
      .update(classpilotSupervisionContexts)
      .set(data)
      .where(
        and(
          eq(classpilotSupervisionContexts.schoolId, options.schoolId),
          eq(classpilotSupervisionContexts.id, options.contextId),
          eq(classpilotSupervisionContexts.status, "active")
        )
      )
      .returning();
    if (!row || !options.endsAt) return row;

    if (studentIds.length > 0) {
      await replaceClasspilotSupervisionControlSnapshots({
        schoolId: options.schoolId,
        supervisionContextId: options.contextId,
        studentIds,
        desiredState: (
          _studentId: string,
          current: ClasspilotStudentControlState | null
        ) => {
          return current?.supervisionContextId === options.contextId
            ? current.desiredState
            : { restrictions: emptyClasspilotRestrictions() };
        },
      }, tx as unknown as typeof db);
    }
    return row;
  });
}

export async function releaseScheduledConflictSupervision(
  options: {
    schoolId: string;
    scheduledConflictId: string;
    releaseReason?: string;
  },
  dbInstance: typeof db = db
): Promise<ClasspilotSupervisionStudent[]> {
  return dbInstance.transaction(async (tx) => {
    const releasedAt = new Date();
    const contexts = await tx
      .select()
      .from(classpilotSupervisionContexts)
      .where(
        and(
          eq(classpilotSupervisionContexts.schoolId, options.schoolId),
          eq(classpilotSupervisionContexts.scheduledConflictId, options.scheduledConflictId),
          eq(classpilotSupervisionContexts.status, "active")
        )
      );
    if (contexts.length === 0) return [];
    const contextIds = contexts.map((context) => context.id);
    const releasing = await tx
      .select({ studentId: classpilotSupervisionStudents.studentId })
      .from(classpilotSupervisionStudents)
      .where(and(
        eq(classpilotSupervisionStudents.schoolId, options.schoolId),
        inArray(classpilotSupervisionStudents.contextId, contextIds),
        isNull(classpilotSupervisionStudents.releasedAt)
      ));
    await lockClasspilotStudentControlAuthorities(
      options.schoolId,
      releasing.map((row) => row.studentId),
      tx as unknown as typeof db
    );
    const released = await tx
      .update(classpilotSupervisionStudents)
      .set({
        releasedAt,
        releaseReason: options.releaseReason || "scheduled_teacher_started",
      })
      .where(
        and(
          eq(classpilotSupervisionStudents.schoolId, options.schoolId),
          inArray(classpilotSupervisionStudents.contextId, contextIds),
          isNull(classpilotSupervisionStudents.releasedAt)
        )
      )
      .returning();
    await tx
      .update(classpilotSupervisionContexts)
      .set({ status: "ended", endedAt: releasedAt, updatedAt: releasedAt })
      .where(
        and(
          eq(classpilotSupervisionContexts.schoolId, options.schoolId),
          inArray(classpilotSupervisionContexts.id, contextIds)
        )
      );
    for (const context of contexts) {
      await restoreClasspilotStudentControlStatesAfterSupervision({
        schoolId: options.schoolId,
        supervisionContextId: context.id,
        studentIds: released
          .filter((row) => row.contextId === context.id)
          .map((row) => row.studentId),
        restoredAt: releasedAt,
      }, tx as unknown as typeof db);
    }
    return released;
  });
}

/** End supervision contexts whose frozen window elapsed and publish a
 * higher-revision class restore (or explicit clear) for every still-assigned
 * student. The scheduler calls this independently of scheduled-class
 * conflicts so direct-pickup and ad-hoc coverage cannot leave stale authority
 * in the durable control-state row. */
export async function releaseExpiredClasspilotSupervisionContexts(
  options: { now?: Date; schoolId?: string } = {},
  dbInstance: typeof db = db
): Promise<ClasspilotSupervisionStudent[]> {
  const endedAt = options.now || new Date();
  return dbInstance.transaction(async (tx) => {
    const contextConditions: SQL[] = [
      eq(classpilotSupervisionContexts.status, "active"),
      sql`${classpilotSupervisionContexts.endsAt} <= ${endedAt}`,
    ];
    if (options.schoolId) {
      contextConditions.push(eq(classpilotSupervisionContexts.schoolId, options.schoolId));
    }
    const candidates = await tx
      .select()
      .from(classpilotSupervisionContexts)
      .where(and(...contextConditions));
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((context) => context.id);
    const candidateAssignments = await tx
      .select({
        schoolId: classpilotSupervisionStudents.schoolId,
        studentId: classpilotSupervisionStudents.studentId,
      })
      .from(classpilotSupervisionStudents)
      .where(and(
        inArray(classpilotSupervisionStudents.contextId, candidateIds),
        isNull(classpilotSupervisionStudents.releasedAt)
      ));
    const schoolIds = [...new Set(candidateAssignments.map((row) => row.schoolId))]
      .sort((a, b) => a.localeCompare(b));
    for (const schoolId of schoolIds) {
      await lockClasspilotStudentControlAuthorities(
        schoolId,
        candidateAssignments
          .filter((row) => row.schoolId === schoolId)
          .map((row) => row.studentId),
        tx as unknown as typeof db
      );
    }
    const contexts = await tx
      .select()
      .from(classpilotSupervisionContexts)
      .where(and(
        ...contextConditions,
        inArray(classpilotSupervisionContexts.id, candidateIds)
      ))
      .for("update", { skipLocked: true });
    if (contexts.length === 0) return [];
    const contextIds = contexts.map((context) => context.id);
    const released = await tx
      .update(classpilotSupervisionStudents)
      .set({ releasedAt: endedAt, releaseReason: "supervision_window_ended" })
      .where(and(
        inArray(classpilotSupervisionStudents.contextId, contextIds),
        isNull(classpilotSupervisionStudents.releasedAt)
      ))
      .returning();
    await tx
      .update(classpilotSupervisionContexts)
      .set({ status: "ended", endedAt, updatedAt: endedAt })
      .where(inArray(classpilotSupervisionContexts.id, contextIds));

    const transactionDb = tx as unknown as typeof db;
    for (const context of contexts) {
      await restoreClasspilotStudentControlStatesAfterSupervision({
        schoolId: context.schoolId,
        supervisionContextId: context.id,
        studentIds: released
          .filter((row) => row.contextId === context.id)
          .map((row) => row.studentId),
        restoredAt: endedAt,
      }, transactionDb);
    }
    return released;
  });
}

export async function getOnlineUnassignedStudents(
  schoolId: string,
  activeWithinMs = 5 * 60 * 1000
): Promise<OnlineUnassignedStudent[]> {
  const cutoff = new Date(Date.now() - activeWithinMs);
  const onlineRows = await db
    .select({ student: students, studentSession: studentSessions })
    .from(studentSessions)
    .innerJoin(students, eq(students.id, studentSessions.studentId))
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        eq(studentSessions.isActive, true),
        sql`${studentSessions.lastSeenAt} >= ${cutoff}`
      )
    )
    .orderBy(desc(studentSessions.lastSeenAt));

  if (onlineRows.length === 0) return [];
  const studentIds = onlineRows.map((row) => row.student.id);

  const activeClassRows = await db
    .select({ studentId: groupStudents.studentId })
    .from(groupStudents)
    .innerJoin(groups, eq(groups.id, groupStudents.groupId))
    .innerJoin(
      teachingSessions,
      and(
        eq(teachingSessions.groupId, groups.id),
        isNull(teachingSessions.endTime)
      )
    )
    .where(
      and(
        eq(groups.schoolId, schoolId),
        inArray(groupStudents.studentId, studentIds)
      )
    );
  const inActiveClass = new Set(activeClassRows.map((row) => row.studentId));
  const activeCoverage = await getActiveSupervisionForStudents(schoolId, studentIds);
  const inTemporaryCoverage = new Set(activeCoverage.map((row) => row.studentId));

  return onlineRows.filter(
    (row) =>
      !inActiveClass.has(row.student.id) &&
      !inTemporaryCoverage.has(row.student.id)
  );
}

// ============================================================================
// ClassPilot - Dashboard Tab operations
// ============================================================================

// Dashboard tabs are scoped by BOTH teacher and school so a multi-school teacher
// only sees the tabs for the school they're currently viewing.
export async function getDashboardTabs(
  teacherId: string,
  schoolId: string
): Promise<DashboardTab[]> {
  return db
    .select()
    .from(dashboardTabs)
    .where(and(eq(dashboardTabs.teacherId, teacherId), eq(dashboardTabs.schoolId, schoolId)))
    .orderBy(asc(dashboardTabs.order));
}

export async function createDashboardTab(
  data: InsertDashboardTab & { schoolId: string }
): Promise<DashboardTab> {
  const [tab] = await db.insert(dashboardTabs).values(data).returning();
  return tab!;
}

export async function updateDashboardTab(
  tabId: string,
  teacherId: string,
  schoolId: string,
  data: Partial<InsertDashboardTab>
): Promise<DashboardTab | undefined> {
  const [tab] = await db
    .update(dashboardTabs)
    .set(data)
    .where(and(
      eq(dashboardTabs.id, tabId),
      eq(dashboardTabs.teacherId, teacherId),
      eq(dashboardTabs.schoolId, schoolId)
    ))
    .returning();
  return tab;
}

export async function deleteDashboardTab(
  tabId: string,
  teacherId: string,
  schoolId: string
): Promise<boolean> {
  const result = await db
    .delete(dashboardTabs)
    .where(and(
      eq(dashboardTabs.id, tabId),
      eq(dashboardTabs.teacherId, teacherId),
      eq(dashboardTabs.schoolId, schoolId)
    ));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// ClassPilot - Teacher Settings operations
// ============================================================================

export async function getTeacherSettings(
  teacherId: string
): Promise<TeacherSettingRecord | undefined> {
  const [settings] = await db
    .select()
    .from(teacherSettings)
    .where(eq(teacherSettings.teacherId, teacherId))
    .limit(1);
  return settings;
}

export async function upsertTeacherSettings(
  teacherId: string,
  data: Partial<InsertTeacherSetting>
): Promise<TeacherSettingRecord> {
  const [row] = await db
    .insert(teacherSettings)
    .values({ teacherId, ...data })
    .onConflictDoUpdate({
      target: teacherSettings.teacherId,
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

// ============================================================================
// ClassPilot - Teacher Student Assignment operations
// ============================================================================

export async function getTeacherStudentAssignments(
  teacherId: string
): Promise<(TeacherStudent & { student: Student })[]> {
  const rows = await db
    .select({
      assignment: teacherStudents,
      student: students,
    })
    .from(teacherStudents)
    .innerJoin(students, eq(teacherStudents.studentId, students.id))
    .where(
      and(
        eq(teacherStudents.teacherId, teacherId),
        eq(students.status, "active")
      )
    );
  return rows.map((r) => ({ ...r.assignment, student: r.student }));
}

// Returns only the assignments whose student is in the given school, so a
// multi-school teacher's list is scoped to the active context.
export async function getTeacherStudentAssignmentsForSchool(
  teacherId: string,
  schoolId: string
): Promise<(TeacherStudent & { student: Student })[]> {
  const rows = await db
    .select({
      assignment: teacherStudents,
      student: students,
    })
    .from(teacherStudents)
    .innerJoin(students, eq(teacherStudents.studentId, students.id))
    .where(
      and(
        eq(teacherStudents.teacherId, teacherId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    );
  return rows.map((r) => ({ ...r.assignment, student: r.student }));
}

export async function assignTeacherStudent(
  teacherId: string,
  studentId: string
): Promise<TeacherStudent> {
  // teacher_students.school_id must mirror the linked student's school (RLS
  // WITH CHECK). Derive it from the student so it can never be omitted.
  return db.transaction(async (tx) => {
    const [student] = await tx
      .select({ schoolId: students.schoolId })
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.status, "active")))
      .limit(1)
      .for("update");
    if (!student) {
      throw Object.assign(new Error("Student is not active"), {
        status: 409,
        code: "STUDENT_INACTIVE",
        expose: true,
      });
    }
    const [row] = await tx
      .insert(teacherStudents)
      .values({ teacherId, studentId, schoolId: student.schoolId })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [existing] = await tx
      .select()
      .from(teacherStudents)
      .where(
        and(
          eq(teacherStudents.teacherId, teacherId),
          eq(teacherStudents.studentId, studentId)
        )
      )
      .limit(1);
    return existing!;
  });
}

export async function unassignTeacherStudent(
  teacherId: string,
  studentId: string
): Promise<boolean> {
  const result = await db
    .delete(teacherStudents)
    .where(
      and(
        eq(teacherStudents.teacherId, teacherId),
        eq(teacherStudents.studentId, studentId)
      )
    );
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// ClassPilot - Messages (legacy)
// ============================================================================

export async function getMessages(
  filters: { toStudentId?: string; fromUserId?: string }
): Promise<MessageRecord[]> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.toStudentId) {
    conditions.push(eq(messages.toStudentId, filters.toStudentId));
  }
  if (filters.fromUserId) {
    conditions.push(eq(messages.fromUserId, filters.fromUserId));
  }

  if (conditions.length === 0) {
    return db
      .select()
      .from(messages)
      .orderBy(desc(messages.timestamp));
  }

  return db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.timestamp));
}

export async function createMessage(
  data: InsertMessage,
  schoolId?: string
): Promise<MessageRecord> {
  let resolvedSchoolId = data.schoolId ?? schoolId;
  if (!resolvedSchoolId && data.toStudentId) {
    resolvedSchoolId = await getStudentSchoolIdForTenantWrite(data.toStudentId);
  }
  if (!resolvedSchoolId) {
    throw new Error("createMessage: schoolId is required when no target student is present");
  }
  const [msg] = await db.insert(messages).values({ ...data, schoolId: resolvedSchoolId }).returning();
  return msg!;
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const result = await db.delete(messages).where(eq(messages.id, messageId));
  return (result.rowCount ?? 0) > 0;
}

// messages.school_id is written from the addressed student or active school
// context. Legacy null rows remain hidden once RLS is enabled.
export async function getMessageByIdAndSchool(
  messageId: string,
  schoolId: string
): Promise<MessageRecord | undefined> {
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.schoolId, schoolId)))
    .limit(1);
  return message;
}

// School-scoped message list (replaces an unfiltered getMessages({}) that would
// return every school's messages).
export async function getMessagesBySchool(schoolId: string): Promise<MessageRecord[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.schoolId, schoolId))
    .orderBy(desc(messages.timestamp));
}

export async function getRecentMessagesForStudent(
  studentId: string,
  sinceMinutesAgo = 5
): Promise<MessageRecord[]> {
  const since = new Date(Date.now() - sinceMinutesAgo * 60 * 1000);
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.toStudentId, studentId),
        sql`${messages.timestamp} >= ${since}`
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(10);
}

const CLASSPILOT_PENDING_MESSAGE_RETENTION_DAYS = 30;
const CLASSPILOT_PENDING_MESSAGE_BATCH_LIMIT = 50;
const CLASSPILOT_PENDING_MESSAGE_EXCLUSION_LIMIT = 500;

/**
 * Returns a bounded batch from the durable teacher-message inbox.
 *
 * Unlike the legacy five-minute chat helper above, reconnect recovery must
 * survive a meaningful network outage. Both school and student are included
 * in the predicate so callers cannot rely on ambient RLS alone for identity
 * binding. Message ids already returned by this process may be excluded to
 * advance through a bounded backlog without replaying the newest page forever.
 */
export async function getPendingMessagesForStudent(options: {
  schoolId: string;
  studentId: string;
  excludeMessageIds?: string[];
}): Promise<MessageRecord[]> {
  const since = new Date(
    Date.now() - CLASSPILOT_PENDING_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const excludedIds = [...new Set(
    (options.excludeMessageIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )].slice(0, CLASSPILOT_PENDING_MESSAGE_EXCLUSION_LIMIT);
  const conditions: SQL[] = [
    eq(messages.schoolId, options.schoolId),
    eq(messages.toStudentId, options.studentId),
    sql`${messages.timestamp} >= ${since}`,
  ];
  if (excludedIds.length > 0) {
    conditions.push(notInArray(messages.id, excludedIds));
  }
  return db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.timestamp))
    .limit(CLASSPILOT_PENDING_MESSAGE_BATCH_LIMIT);
}

// ============================================================================
// ClassPilot - Check-ins
// ============================================================================

export async function createCheckIn(
  data: InsertCheckIn
): Promise<CheckIn> {
  const [ci] = await db.insert(checkIns).values(data).returning();
  return ci!;
}

// ============================================================================
// School Inquiry operations
// ============================================================================

export async function createSchoolInquiry(
  data: InsertSchoolInquiry
): Promise<SchoolInquiry> {
  const [inquiry] = await db.insert(schoolInquiries).values(data).returning();
  return inquiry!;
}

export async function getSchoolInquiries(
  filters: { status?: string; product?: string } = {}
): Promise<SchoolInquiry[]> {
  const conditions: SQL[] = [];

  if (filters.status) {
    conditions.push(eq(schoolInquiries.status, filters.status));
  }
  if (filters.product) {
    conditions.push(sql`${schoolInquiries.interestedProducts} ILIKE ${`%${filters.product}%`}`);
  }

  return db
    .select()
    .from(schoolInquiries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schoolInquiries.createdAt));
}

export async function getSchoolInquiryById(
  id: string
): Promise<SchoolInquiry | undefined> {
  const [inquiry] = await db
    .select()
    .from(schoolInquiries)
    .where(eq(schoolInquiries.id, id))
    .limit(1);
  return inquiry;
}

export async function updateSchoolInquiry(
  id: string,
  data: Partial<InsertSchoolInquiry>
): Promise<SchoolInquiry | undefined> {
  const [inquiry] = await db
    .update(schoolInquiries)
    .set(data)
    .where(eq(schoolInquiries.id, id))
    .returning();
  return inquiry;
}

export async function deleteSchoolInquiry(id: string): Promise<boolean> {
  const result = await db
    .delete(schoolInquiries)
    .where(eq(schoolInquiries.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// Google OAuth Token operations
// ============================================================================

export async function getGoogleOAuthToken(
  userId: string
): Promise<GoogleOAuthToken | undefined> {
  const [token] = await db
    .select()
    .from(googleOAuthTokens)
    .where(eq(googleOAuthTokens.userId, userId))
    .limit(1);
  return token;
}

// School-aware retrieval for Workspace/Classroom data. The token table is keyed
// per SchoolPilot user, so a multi-school user could otherwise reuse one Google
// connection against another school. Strict+shared policy: the connected Google
// account domain must equal the selected school's registered domain. Multiple
// schools may share that same district domain.
export async function getGoogleOAuthTokenForSchool(
  userId: string,
  schoolId: string
): Promise<GoogleOAuthToken | undefined> {
  const token = await getGoogleOAuthToken(userId);
  if (!token) return undefined;
  const school = await getSchoolById(schoolId);
  const schoolDomain = normalizeDomain(school?.domain);
  if (!schoolDomain) {
    throw schoolIsolationError(
      "SCHOOL_DOMAIN_REQUIRED",
      "School domain is required before connecting Google Workspace."
    );
  }

  const connectedEmail = token.connectedEmail;
  const connectedDomain = normalizeDomain(token.connectedDomain || getEmailDomain(connectedEmail));
  if (!connectedEmail || !connectedDomain) {
    throw schoolIsolationError(
      "GOOGLE_RECONNECT_REQUIRED",
      "Reconnect Google so SchoolPilot can verify the connected Workspace domain."
    );
  }

  if (connectedDomain !== schoolDomain) {
    throw schoolIsolationError(
      "GOOGLE_DOMAIN_MISMATCH",
      `Connected Google account must use the school's Workspace domain (${schoolDomain}).`
    );
  }

  return token;
}

export async function upsertGoogleOAuthToken(
  userId: string,
  data: {
    refreshToken: string;
    scope?: string;
    tokenType?: string;
    connectedEmail?: string | null;
    connectedDomain?: string | null;
    expiryDate?: Date;
  }
): Promise<GoogleOAuthToken> {
  const [token] = await db
    .insert(googleOAuthTokens)
    .values({ userId, ...data })
    .onConflictDoUpdate({
      target: googleOAuthTokens.userId,
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return token!;
}

export async function deleteGoogleOAuthToken(
  userId: string
): Promise<boolean> {
  const result = await db
    .delete(googleOAuthTokens)
    .where(eq(googleOAuthTokens.userId, userId));
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// Google Roster Connector operations
// ============================================================================

export async function getGoogleRosterConnector(
  schoolId: string
): Promise<GoogleRosterConnector | undefined> {
  const [connector] = await db
    .select()
    .from(googleRosterConnectors)
    .where(eq(googleRosterConnectors.schoolId, schoolId))
    .limit(1);
  return connector;
}

export async function upsertGoogleRosterConnector(
  schoolId: string,
  data: Omit<InsertGoogleRosterConnector, "schoolId" | "id" | "createdAt" | "updatedAt">
): Promise<GoogleRosterConnector> {
  const [connector] = await db
    .insert(googleRosterConnectors)
    .values({ schoolId, ...data })
    .onConflictDoUpdate({
      target: googleRosterConnectors.schoolId,
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return connector!;
}

export async function updateGoogleRosterConnector(
  schoolId: string,
  data: Partial<Omit<InsertGoogleRosterConnector, "schoolId" | "id" | "createdAt" | "updatedAt">>
): Promise<GoogleRosterConnector | undefined> {
  const [connector] = await db
    .update(googleRosterConnectors)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(googleRosterConnectors.schoolId, schoolId))
    .returning();
  return connector;
}

export async function markGoogleRosterConnectorSynced(
  schoolId: string
): Promise<void> {
  await db
    .update(googleRosterConnectors)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(googleRosterConnectors.schoolId, schoolId));
}

// ============================================================================
// Settings operations
// ============================================================================

export const HEARTBEAT_TRACKING_SETTINGS_CACHE_TTL_MS = 5_000;
export type HeartbeatTrackingSettings = Pick<
  Settings,
  | "enableTrackingHours"
  | "trackingStartTime"
  | "trackingEndTime"
  | "trackingDays"
  | "schoolTimezone"
  | "afterHoursMode"
>;
const heartbeatTrackingSettingsCache = new Map<
  string,
  { expiresAt: number; value: HeartbeatTrackingSettings | undefined }
>();
const heartbeatTrackingSettingsLoads = new Map<
  string,
  Promise<HeartbeatTrackingSettings | undefined>
>();
const heartbeatTrackingSettingsGenerations = new Map<string, number>();

function canUseHeartbeatTrackingSettingsCache(
  schoolId: string,
  dbInstance: typeof db
): boolean {
  if (dbInstance !== db) return false;
  if (!rlsGucEnabled()) return true;
  const tenant = getTenantStore();
  return Boolean(tenant && (tenant.isSuper || tenant.schoolId === schoolId));
}

export function invalidateHeartbeatTrackingSettingsCache(schoolId: string): void {
  heartbeatTrackingSettingsCache.delete(schoolId);
  heartbeatTrackingSettingsLoads.delete(schoolId);
  heartbeatTrackingSettingsGenerations.set(
    schoolId,
    (heartbeatTrackingSettingsGenerations.get(schoolId) ?? 0) + 1
  );
}

registerCacheInvalidationHandler((target) => {
  if (target.cache === "heartbeat-tracking-settings") {
    invalidateHeartbeatTrackingSettingsCache(target.schoolId);
  }
});

export async function getSettingsForSchool(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<Settings | undefined> {
  const [row] = await dbInstance
    .select()
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  return row;
}

export async function createCanonicalPass(
  data: Omit<InsertPass, "gradeId" | "classpilotGroupId" | "classNameSnapshot"> & {
    classId: string;
  },
  authorization: {
    actorUserId?: string | null;
    manager?: boolean;
    kiosk?: boolean;
  } = {}
): Promise<Pass> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, data.schoolId);
    const [settingsRow] = await tx
      .select({ source: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, data.schoolId))
      .limit(1)
      .for("update");
    if (settingsRow?.source !== "classpilot_groups") {
      throw passpilotClassError(
        "PASSPILOT_CLASS_SOURCE_CHANGED",
        "PassPilot class configuration changed. Reload classes before issuing a pass.",
        409
      );
    }

    if (authorization.kiosk) {
      const [school] = await tx
        .select({ kioskClasspilotGroupId: schools.kioskClasspilotGroupId })
        .from(schools)
        .where(eq(schools.id, data.schoolId))
        .limit(1)
        .for("update");
      if (!school?.kioskClasspilotGroupId || school.kioskClasspilotGroupId !== data.classId) {
        throw passpilotClassError(
          "PASSPILOT_KIOSK_CLASS_CHANGED",
          "The configured kiosk class changed. Reload the kiosk before checking out.",
          409
        );
      }
    }

    const [group] = await tx
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.id, data.classId),
          eq(groups.schoolId, data.schoolId),
          eq(groups.groupType, "admin_class"),
          eq(groups.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!group) {
      throw passpilotClassError(
        "PASSPILOT_CANONICAL_CLASS_NOT_FOUND",
        "Class not found or no longer active.",
        404
      );
    }

    const [membership] = await tx
      .select({ id: groupStudents.id })
      .from(groupStudents)
      .innerJoin(students, eq(students.id, groupStudents.studentId))
      .where(
        and(
          eq(groupStudents.groupId, group.id),
          eq(groupStudents.studentId, data.studentId),
          eq(students.schoolId, data.schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1);
    if (!membership) {
      throw passpilotClassError(
        "PASSPILOT_STUDENT_NOT_IN_CLASS",
        "Student is not enrolled in the selected class.",
        409
      );
    }

    if (!authorization.kiosk && !authorization.manager) {
      const actorUserId = authorization.actorUserId;
      if (!actorUserId) {
        throw passpilotClassError("PASSPILOT_CLASS_ACCESS_DENIED", "Class access denied.", 403);
      }
      const [relationship] = await tx
        .select({ groupId: groups.id })
        .from(groups)
        .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
        .where(
          and(
            eq(groups.id, group.id),
            or(eq(groups.teacherId, actorUserId), eq(groupTeachers.teacherId, actorUserId))
          )
        )
        .limit(1);
      if (!relationship) {
        throw passpilotClassError("PASSPILOT_CLASS_ACCESS_DENIED", "Class access denied.", 403);
      }
    }

    const { classId, ...passData } = data;
    const [pass] = await tx
      .insert(passes)
      .values({
        ...passData,
        gradeId: null,
        classpilotGroupId: classId,
        classNameSnapshot: group.name,
      })
      .returning();
    await tx
      .update(settings)
      .set({
        passpilotCanonicalWritesAt: sql`COALESCE(${settings.passpilotCanonicalWritesAt}, now())`,
      })
      .where(eq(settings.schoolId, data.schoolId));
    return pass!;
  });
}

export async function updateCanonicalKioskClass(
  schoolId: string,
  classId: string | null,
  actorUserId: string,
  manager: boolean
): Promise<School | undefined> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [settingsRow] = await tx
      .select({ source: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (settingsRow?.source !== "classpilot_groups") {
      throw passpilotClassError(
        "PASSPILOT_CLASS_SOURCE_CHANGED",
        "PassPilot class configuration changed. Reload classes before saving kiosk settings.",
        409
      );
    }

    const [currentSchool] = await tx
      .select({ kioskClasspilotGroupId: schools.kioskClasspilotGroupId })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1)
      .for("update");
    if (!currentSchool) {
      throw passpilotClassError("SCHOOL_NOT_FOUND", "School not found.", 404);
    }

    const authorizationClassId = classId ?? currentSchool.kioskClasspilotGroupId;
    // Managers must be able to clear a stale kiosk reference after its class
    // is archived. Teachers may clear only a currently active assigned class.
    if (authorizationClassId && !(manager && classId === null)) {
      const [group] = await tx
        .select({ id: groups.id })
        .from(groups)
        .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
        .where(
          and(
            eq(groups.id, authorizationClassId),
            eq(groups.schoolId, schoolId),
            eq(groups.groupType, "admin_class"),
            eq(groups.status, "active"),
            manager
              ? sql`true`
              : or(eq(groups.teacherId, actorUserId), eq(groupTeachers.teacherId, actorUserId))!
          )
        )
        .limit(1)
        .for("update", { of: groups });
      if (!group) {
        throw passpilotClassError("PASSPILOT_CLASS_ACCESS_DENIED", "Class not found or access denied.", 403);
      }
    }

    const [school] = await tx
      .update(schools)
      .set({
        kioskGradeId: null,
        kioskClasspilotGroupId: classId,
        kioskActivatedByUserId: actorUserId,
      })
      .where(eq(schools.id, schoolId))
      .returning();
    await tx
      .update(settings)
      .set({
        passpilotCanonicalWritesAt: sql`COALESCE(${settings.passpilotCanonicalWritesAt}, now())`,
      })
      .where(eq(settings.schoolId, schoolId));
    return school;
  });
}

export async function updateLegacyKioskClass(
  schoolId: string,
  gradeId: string | null,
  actorUserId: string,
  manager = false
): Promise<School | undefined> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [settingsRow] = await tx
      .select({ source: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (settingsRow?.source !== "legacy_grades") {
      throw passpilotClassError(
        "PASSPILOT_CLASS_SOURCE_CHANGED",
        "PassPilot class configuration changed. Reload classes before saving kiosk settings.",
        409
      );
    }
    const [currentSchool] = await tx
      .select({ kioskGradeId: schools.kioskGradeId })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1)
      .for("update");
    if (!currentSchool) {
      throw passpilotClassError("SCHOOL_NOT_FOUND", "School not found.", 404);
    }
    if (gradeId) {
      const [grade] = await tx
        .select({ id: grades.id, migrationState: grades.migrationState })
        .from(grades)
        .where(and(eq(grades.id, gradeId), eq(grades.schoolId, schoolId)))
        .limit(1);
      if (!grade) {
        throw passpilotClassError("PASSPILOT_LEGACY_CLASS_NOT_FOUND", "Class not found.", 404);
      }
      if (grade.migrationState === "history_only") {
        throw passpilotClassError(
          "PASSPILOT_HISTORY_CLASS_READ_ONLY",
          "This legacy class is history-only and cannot be selected for the kiosk.",
          409
        );
      }
    }
    const authorizationGradeId = gradeId ?? currentSchool.kioskGradeId;
    if (authorizationGradeId && !manager) {
      await assertLegacyPasspilotClassAuthorization(
        tx,
        schoolId,
        authorizationGradeId,
        { actorUserId, manager: false }
      );
    }
    const [school] = await tx
      .update(schools)
      .set({
        kioskGradeId: gradeId,
        kioskClasspilotGroupId: null,
        kioskActivatedByUserId: actorUserId,
      })
      .where(eq(schools.id, schoolId))
      .returning();
    return school;
  });
}

export type PasspilotClassSource = "legacy_grades" | "classpilot_groups";

export type PasspilotClassMigrationMember = {
  id: string;
  name: string;
  detail: string | null;
};

export type PasspilotClassMigrationInventory = {
  source: PasspilotClassSource;
  cutoverAt: Date | null;
  canonicalWritesAt: Date | null;
  revision: number;
  legacyGrades: Array<Grade & {
    studentIds: string[];
    teacherIds: string[];
    studentMembers: PasspilotClassMigrationMember[];
    teacherMembers: PasspilotClassMigrationMember[];
    historicalPassCount: number;
    activePassCount: number;
    suggestedClasspilotGroupId: string | null;
    autoLinkEligible: boolean;
    conflictReasons: string[];
  }>;
  canonicalClasses: Array<AdminClassSummary & {
    studentIds: string[];
    teacherIds: string[];
    studentMembers: PasspilotClassMigrationMember[];
    teacherMembers: PasspilotClassMigrationMember[];
  }>;
  kioskGradeId: string | null;
  kioskClasspilotGroupId: string | null;
};

type PasspilotMappingInput = {
  gradeId: string;
  classId?: string | null;
  state?: "pending" | "auto_linked" | "confirmed" | "history_only";
};

function passpilotClassError(
  code: string,
  message: string,
  status = 400
): Error & { code: string; status: number; expose: true; managementUrl?: string } {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: true as const,
    ...(code === "CLASSES_MANAGED_IN_CLASSPILOT"
      ? { managementUrl: "/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses" }
      : {}),
  });
}

function normalizedPasspilotClassName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = Array.from(new Set(left)).sort();
  const b = Array.from(new Set(right)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function takePasspilotClassLock(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  schoolId: string
): Promise<void> {
  await takeClasspilotScheduleConfigLock(
    tx as unknown as ScheduleChangeDb,
    schoolId
  );
}

export type PasspilotClassTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PasspilotCleanSchoolCutoverReason =
  | "settings_missing"
  | "school_missing"
  | "school_not_active"
  | "source_not_legacy"
  | "active_official_class_required"
  | "active_passpilot_license_required"
  | "active_classpilot_license_required"
  | "legacy_grades_present"
  | "passes_present"
  | "student_grade_assignments_present"
  | "teacher_grade_assignments_present"
  | "kiosk_selection_present"
  | "prior_canonical_write_present"
  | "prior_cutover_marker_present";

export type PasspilotCleanSchoolCutoverEligibility = {
  schoolId: string;
  source: PasspilotClassSource | null;
  revision: number | null;
  eligible: boolean;
  reasons: PasspilotCleanSchoolCutoverReason[];
  counts: {
    activeOfficialClasses: number;
    activePasspilotLicenses: number;
    activeClasspilotLicenses: number;
    legacyGrades: number;
    passes: number;
    studentGradeAssignments: number;
    teacherGradeAssignments: number;
    legacyKioskSelections: number;
    canonicalKioskSelections: number;
    priorCanonicalWriteMarkers: number;
    priorCutoverMarkers: number;
  };
};

async function loadPasspilotCleanSchoolCutoverEligibility(
  tx: PasspilotClassTransaction,
  schoolId: string
): Promise<PasspilotCleanSchoolCutoverEligibility> {
  const emptyCounts: PasspilotCleanSchoolCutoverEligibility["counts"] = {
    activeOfficialClasses: 0,
    activePasspilotLicenses: 0,
    activeClasspilotLicenses: 0,
    legacyGrades: 0,
    passes: 0,
    studentGradeAssignments: 0,
    teacherGradeAssignments: 0,
    legacyKioskSelections: 0,
    canonicalKioskSelections: 0,
    priorCanonicalWriteMarkers: 0,
    priorCutoverMarkers: 0,
  };
  const [settingsRow] = await tx
    .select({
      source: settings.passpilotClassSource,
      revision: settings.passpilotClassMigrationRevision,
      canonicalWritesAt: settings.passpilotCanonicalWritesAt,
      cutoverAt: settings.passpilotClassCutoverAt,
    })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1)
    .for("update");
  if (!settingsRow) {
    return {
      schoolId,
      source: null,
      revision: null,
      eligible: false,
      reasons: ["settings_missing"],
      counts: emptyCounts,
    };
  }

  const [school] = await tx
    .select({
      id: schools.id,
      status: schools.status,
      isActive: schools.isActive,
      deletedAt: schools.deletedAt,
      kioskGradeId: schools.kioskGradeId,
      kioskClasspilotGroupId: schools.kioskClasspilotGroupId,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1)
    .for("update");
  if (!school) {
    return {
      schoolId,
      source: settingsRow.source,
      revision: settingsRow.revision,
      eligible: false,
      reasons: ["school_missing"],
      counts: {
        ...emptyCounts,
        priorCanonicalWriteMarkers: settingsRow.canonicalWritesAt ? 1 : 0,
        priorCutoverMarkers: settingsRow.cutoverAt ? 1 : 0,
      },
    };
  }

  const [
    gradeRows,
    passRows,
    studentGradeRows,
    studentMembershipRows,
    teacherGradeRows,
    activeOfficialClassRows,
    activeLicenseRows,
  ] = await Promise.all([
    tx
      .select({ id: grades.id })
      .from(grades)
      .where(eq(grades.schoolId, schoolId))
      .for("update"),
    tx
      .select({ id: passes.id })
      .from(passes)
      .where(eq(passes.schoolId, schoolId))
      .for("update"),
    tx
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), isNotNull(students.gradeId)))
      .for("update"),
    tx
      .select({ id: passpilotGradeStudents.studentId })
      .from(passpilotGradeStudents)
      .where(eq(passpilotGradeStudents.schoolId, schoolId))
      .for("update"),
    tx
      .select({ id: teacherGrades.id })
      .from(teacherGrades)
      .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
      .where(eq(grades.schoolId, schoolId))
      .for("update", { of: teacherGrades }),
    tx
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.schoolId, schoolId),
          eq(groups.groupType, "admin_class"),
          eq(groups.status, "active")
        )
      )
      .orderBy(asc(groups.id))
      .for("update"),
    tx
      .select({ id: productLicenses.id, product: productLicenses.product })
      .from(productLicenses)
      .where(
        and(
          eq(productLicenses.schoolId, schoolId),
          eq(productLicenses.status, "active"),
          inArray(productLicenses.product, ["PASSPILOT", "CLASSPILOT"])
        )
      )
      .orderBy(asc(productLicenses.id))
      .for("update"),
  ]);

  const counts: PasspilotCleanSchoolCutoverEligibility["counts"] = {
    activeOfficialClasses: activeOfficialClassRows.length,
    activePasspilotLicenses: activeLicenseRows.filter((row) => row.product === "PASSPILOT").length,
    activeClasspilotLicenses: activeLicenseRows.filter((row) => row.product === "CLASSPILOT").length,
    legacyGrades: gradeRows.length,
    passes: passRows.length,
    studentGradeAssignments: new Set([
      ...studentGradeRows.map((row) => row.id),
      ...studentMembershipRows.map((row) => row.id),
    ]).size,
    teacherGradeAssignments: teacherGradeRows.length,
    legacyKioskSelections: school.kioskGradeId ? 1 : 0,
    canonicalKioskSelections: school.kioskClasspilotGroupId ? 1 : 0,
    priorCanonicalWriteMarkers: settingsRow.canonicalWritesAt ? 1 : 0,
    priorCutoverMarkers: settingsRow.cutoverAt ? 1 : 0,
  };
  const reasons: PasspilotCleanSchoolCutoverReason[] = [];
  if (!school.isActive || school.status !== "active" || school.deletedAt) reasons.push("school_not_active");
  if (settingsRow.source !== "legacy_grades") reasons.push("source_not_legacy");
  if (counts.activeOfficialClasses < 1) reasons.push("active_official_class_required");
  if (counts.activePasspilotLicenses < 1) reasons.push("active_passpilot_license_required");
  if (counts.activeClasspilotLicenses < 1) reasons.push("active_classpilot_license_required");
  if (counts.legacyGrades > 0) reasons.push("legacy_grades_present");
  if (counts.passes > 0) reasons.push("passes_present");
  if (counts.studentGradeAssignments > 0) reasons.push("student_grade_assignments_present");
  if (counts.teacherGradeAssignments > 0) reasons.push("teacher_grade_assignments_present");
  if (counts.legacyKioskSelections + counts.canonicalKioskSelections > 0) reasons.push("kiosk_selection_present");
  if (counts.priorCanonicalWriteMarkers > 0) reasons.push("prior_canonical_write_present");
  if (counts.priorCutoverMarkers > 0) reasons.push("prior_cutover_marker_present");
  return {
    schoolId,
    source: settingsRow.source,
    revision: settingsRow.revision,
    eligible: reasons.length === 0,
    reasons,
    counts,
  };
}

export async function getPasspilotCleanSchoolCutoverEligibility(
  schoolId: string
): Promise<PasspilotCleanSchoolCutoverEligibility> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    return loadPasspilotCleanSchoolCutoverEligibility(tx, schoolId);
  });
}

export async function listPasspilotLegacyClassSourceSchoolIds(): Promise<string[]> {
  const rows = await db
    .select({ schoolId: settings.schoolId })
    .from(settings)
    .where(eq(settings.passpilotClassSource, "legacy_grades"))
    .orderBy(asc(settings.schoolId));
  return rows.map((row) => row.schoolId);
}

export async function runWithPasspilotLegacyClassLock<T>(
  schoolId: string,
  operation: (tx: PasspilotClassTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [settingsRow] = await tx
      .select({ source: settings.passpilotClassSource })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (settingsRow?.source !== "legacy_grades") {
      throw passpilotClassError(
        "CLASSES_MANAGED_IN_CLASSPILOT",
        "PassPilot classes are managed in ClassPilot after migration.",
        409
      );
    }
    return operation(tx);
  });
}

async function loadPasspilotMigrationInventory(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  schoolId: string
): Promise<PasspilotClassMigrationInventory> {
  const [settingsRow] = await tx
    .select()
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  if (!settingsRow) {
    throw passpilotClassError(
      "PASSPILOT_CLASS_SETTINGS_MISSING",
      "School settings are not initialized.",
      409
    );
  }

  const [school] = await tx
    .select({
      kioskGradeId: schools.kioskGradeId,
      kioskClasspilotGroupId: schools.kioskClasspilotGroupId,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  if (!school) {
    throw passpilotClassError("SCHOOL_NOT_FOUND", "School not found.", 404);
  }

  const [legacyGrades, canonicalClasses, legacyMembershipRows, legacyFallbackStudentRows, legacyTeacherRows, legacyPassRows, groupStudentRows, groupTeacherRows, staffRows] =
    await Promise.all([
      tx.select().from(grades).where(eq(grades.schoolId, schoolId)).orderBy(grades.displayOrder, grades.name),
      tx
        .select({
          id: groups.id,
          schoolId: groups.schoolId,
          teacherId: groups.teacherId,
          name: groups.name,
          description: groups.description,
          periodLabel: groups.periodLabel,
          gradeLevel: groups.gradeLevel,
          groupType: groups.groupType,
          parentGroupId: groups.parentGroupId,
          status: groups.status,
          archivedAt: groups.archivedAt,
          schoolYear: groups.schoolYear,
          term: groups.term,
          googleClassroomCourseId: groups.googleClassroomCourseId,
          scheduleEnabled: groups.scheduleEnabled,
          blockStartTime: groups.blockStartTime,
          blockEndTime: groups.blockEndTime,
          scheduleSkippedDate: groups.scheduleSkippedDate,
          createdAt: groups.createdAt,
          studentCount: sql<number>`COUNT(DISTINCT ${groupStudents.studentId})::int`,
        })
        .from(groups)
        .leftJoin(groupStudents, eq(groupStudents.groupId, groups.id))
        .where(
          and(
            eq(groups.schoolId, schoolId),
            eq(groups.groupType, "admin_class"),
            eq(groups.status, "active")
          )
        )
        .groupBy(groups.id)
        .orderBy(groups.name),
      tx
        .select({
          gradeId: passpilotGradeStudents.gradeId,
          studentId: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
          studentIdNumber: students.studentIdNumber,
        })
        .from(passpilotGradeStudents)
        .innerJoin(students, eq(students.id, passpilotGradeStudents.studentId))
        .where(
          and(
            eq(passpilotGradeStudents.schoolId, schoolId),
            eq(students.schoolId, schoolId),
            eq(students.status, "active")
          )
        ),
      tx
        .select({
          gradeId: students.gradeId,
          studentId: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
          studentIdNumber: students.studentIdNumber,
        })
        .from(students)
        .where(
          and(
            eq(students.schoolId, schoolId),
            eq(students.status, "active"),
            isNotNull(students.gradeId)
          )
        ),
      tx
        .select({ gradeId: teacherGrades.gradeId, teacherId: teacherGrades.teacherId })
        .from(teacherGrades)
        .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
        .where(eq(grades.schoolId, schoolId)),
      tx
        .select({ gradeId: passes.gradeId, status: passes.status })
        .from(passes)
        .where(and(eq(passes.schoolId, schoolId), isNotNull(passes.gradeId))),
      tx
        .select({
          groupId: groupStudents.groupId,
          studentId: groupStudents.studentId,
          firstName: students.firstName,
          lastName: students.lastName,
          studentIdNumber: students.studentIdNumber,
        })
        .from(groupStudents)
        .innerJoin(groups, eq(groupStudents.groupId, groups.id))
        .innerJoin(students, eq(groupStudents.studentId, students.id))
        .where(
          and(
            eq(groups.schoolId, schoolId),
            eq(groups.groupType, "admin_class"),
            eq(groups.status, "active"),
            eq(students.schoolId, schoolId),
            eq(students.status, "active")
          )
        ),
      tx
        .select({
          groupId: groups.id,
          primaryTeacherId: groups.teacherId,
          coTeacherId: groupTeachers.teacherId,
        })
        .from(groups)
        .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
        .where(
          and(
            eq(groups.schoolId, schoolId),
            eq(groups.groupType, "admin_class"),
            eq(groups.status, "active")
          )
        ),
      tx
        .select({
          userId: users.id,
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(schoolMemberships)
        .innerJoin(users, eq(schoolMemberships.userId, users.id))
        .where(eq(schoolMemberships.schoolId, schoolId)),
    ]);

  const legacyStudentRows = [...legacyMembershipRows, ...legacyFallbackStudentRows];
  const studentMembers = new Map<string, PasspilotClassMigrationMember>();
  for (const row of [...legacyStudentRows, ...groupStudentRows]) {
    const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || "Student record";
    studentMembers.set(row.studentId, {
      id: row.studentId,
      name,
      detail: row.studentIdNumber || null,
    });
  }
  const teacherMembers = new Map<string, PasspilotClassMigrationMember>();
  for (const row of staffRows) {
    const name = row.displayName
      || [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
      || row.email
      || "Staff record";
    teacherMembers.set(row.userId, {
      id: row.userId,
      name,
      detail: row.email && row.email !== name ? row.email : null,
    });
  }
  const resolveMembers = (
    ids: string[],
    members: Map<string, PasspilotClassMigrationMember>,
    fallback: string
  ): PasspilotClassMigrationMember[] => Array.from(new Set(ids)).map((id) => (
    members.get(id) ?? { id, name: fallback, detail: null }
  ));

  const gradeStudents = new Map<string, string[]>();
  for (const row of legacyStudentRows) {
    if (!row.gradeId) continue;
    const ids = gradeStudents.get(row.gradeId) ?? [];
    ids.push(row.studentId);
    gradeStudents.set(row.gradeId, ids);
  }
  const gradeTeachers = new Map<string, string[]>();
  for (const row of legacyTeacherRows) {
    const ids = gradeTeachers.get(row.gradeId) ?? [];
    ids.push(row.teacherId);
    gradeTeachers.set(row.gradeId, ids);
  }
  const gradePassCounts = new Map<string, { historical: number; active: number }>();
  for (const row of legacyPassRows) {
    if (!row.gradeId) continue;
    const counts = gradePassCounts.get(row.gradeId) ?? { historical: 0, active: 0 };
    counts.historical += 1;
    if (row.status === "active") counts.active += 1;
    gradePassCounts.set(row.gradeId, counts);
  }
  const canonicalStudents = new Map<string, string[]>();
  for (const row of groupStudentRows) {
    const ids = canonicalStudents.get(row.groupId) ?? [];
    ids.push(row.studentId);
    canonicalStudents.set(row.groupId, ids);
  }
  const canonicalTeachers = new Map<string, string[]>();
  for (const row of groupTeacherRows) {
    const ids = canonicalTeachers.get(row.groupId) ?? [];
    ids.push(row.primaryTeacherId);
    if (row.coTeacherId) ids.push(row.coTeacherId);
    canonicalTeachers.set(row.groupId, Array.from(new Set(ids)));
  }

  const gradesByName = new Map<string, Grade[]>();
  for (const grade of legacyGrades) {
    const name = normalizedPasspilotClassName(grade.name);
    gradesByName.set(name, [...(gradesByName.get(name) ?? []), grade]);
  }
  const groupsByName = new Map<string, typeof canonicalClasses>();
  for (const group of canonicalClasses) {
    const name = normalizedPasspilotClassName(group.name);
    groupsByName.set(name, [...(groupsByName.get(name) ?? []), group]);
  }

  return {
    source: settingsRow.passpilotClassSource,
    cutoverAt: settingsRow.passpilotClassCutoverAt,
    canonicalWritesAt: settingsRow.passpilotCanonicalWritesAt,
    revision: settingsRow.passpilotClassMigrationRevision,
    legacyGrades: legacyGrades.map((grade) => {
      const studentIds = gradeStudents.get(grade.id) ?? [];
      const teacherIds = gradeTeachers.get(grade.id) ?? [];
      const passCounts = gradePassCounts.get(grade.id) ?? { historical: 0, active: 0 };
      const sameNameGrades = gradesByName.get(normalizedPasspilotClassName(grade.name)) ?? [];
      const sameNameGroups = groupsByName.get(normalizedPasspilotClassName(grade.name)) ?? [];
      const candidate = sameNameGrades.length === 1 && sameNameGroups.length === 1
        ? sameNameGroups[0]!
        : null;
      const conflictReasons: string[] = [];
      if (sameNameGrades.length !== 1) conflictReasons.push("duplicate_legacy_name");
      if (sameNameGroups.length === 0) conflictReasons.push("no_exact_name_match");
      if (sameNameGroups.length > 1) conflictReasons.push("duplicate_canonical_name");
      if (candidate) {
        const candidateTeacherIds = canonicalTeachers.get(candidate.id) ?? [];
        const candidateStudentIds = canonicalStudents.get(candidate.id) ?? [];
        if (teacherIds.length > 0 && !sameStringSet(teacherIds, candidateTeacherIds)) {
          conflictReasons.push("teacher_mismatch");
        }
        if (studentIds.length > 0 && !sameStringSet(studentIds, candidateStudentIds)) {
          conflictReasons.push("roster_mismatch");
        }
      }
      const uniqueStudentIds = Array.from(new Set(studentIds));
      const uniqueTeacherIds = Array.from(new Set(teacherIds));
      return {
        ...grade,
        studentIds: uniqueStudentIds,
        teacherIds: uniqueTeacherIds,
        studentMembers: resolveMembers(uniqueStudentIds, studentMembers, "Student record"),
        teacherMembers: resolveMembers(uniqueTeacherIds, teacherMembers, "Staff record"),
        historicalPassCount: passCounts.historical,
        activePassCount: passCounts.active,
        suggestedClasspilotGroupId: candidate?.id ?? null,
        autoLinkEligible: !!candidate && conflictReasons.length === 0,
        conflictReasons,
      };
    }),
    canonicalClasses: canonicalClasses.map((group) => {
      const studentIds = Array.from(new Set(canonicalStudents.get(group.id) ?? []));
      const teacherIds = Array.from(new Set(canonicalTeachers.get(group.id) ?? [group.teacherId]));
      return {
        ...group,
        studentIds,
        teacherIds,
        studentMembers: resolveMembers(studentIds, studentMembers, "Student record"),
        teacherMembers: resolveMembers(teacherIds, teacherMembers, "Staff record"),
      };
    }),
    kioskGradeId: school.kioskGradeId,
    kioskClasspilotGroupId: school.kioskClasspilotGroupId,
  };
}

export async function getPasspilotClassMigrationInventory(
  schoolId: string
): Promise<PasspilotClassMigrationInventory> {
  return db.transaction((tx) => loadPasspilotMigrationInventory(tx, schoolId));
}

export async function initializePasspilotClassMigrationInventory(
  schoolId: string,
  reviewerId: string
): Promise<PasspilotClassMigrationInventory> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [settingsRow] = await tx
      .select()
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (!settingsRow) {
      throw passpilotClassError("PASSPILOT_CLASS_SETTINGS_MISSING", "School settings are not initialized.", 409);
    }
    const inventory = await loadPasspilotMigrationInventory(tx, schoolId);
    if (inventory.source === "classpilot_groups") return inventory;

    const eligible = inventory.legacyGrades.filter(
      (grade) =>
        grade.migrationState === "pending" &&
        grade.autoLinkEligible &&
        grade.suggestedClasspilotGroupId
    );
    if (eligible.length === 0) return inventory;

    const revision = settingsRow.passpilotClassMigrationRevision + 1;
    for (const grade of eligible) {
      await tx
        .update(grades)
        .set({
          classpilotGroupId: grade.suggestedClasspilotGroupId,
          migrationState: "auto_linked",
          mappingRevision: revision,
          mappingMethod: "unique_exact_name",
          mappingReviewerId: reviewerId,
          mappedAt: new Date(),
        })
        .where(
          and(
            eq(grades.id, grade.id),
            eq(grades.schoolId, schoolId),
            eq(grades.migrationState, "pending")
          )
        );
    }
    await tx
      .update(settings)
      .set({ passpilotClassMigrationRevision: revision })
      .where(eq(settings.schoolId, schoolId));
    await tx.insert(auditLogs).values({
      schoolId,
      userId: reviewerId,
      action: "passpilot.class_migration.inventory_initialized",
      entityType: "settings",
      entityId: settingsRow.id,
      changes: {
        revision,
        autoLinkedGradeIds: eligible.map((grade) => grade.id),
      },
    });
    return loadPasspilotMigrationInventory(tx, schoolId);
  });
}

export async function updatePasspilotClassMappings(
  schoolId: string,
  reviewerId: string,
  expectedRevision: number,
  inputs: PasspilotMappingInput[],
  autoLink = false
): Promise<PasspilotClassMigrationInventory> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    const [settingsRow] = await tx
      .select()
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (!settingsRow) {
      throw passpilotClassError("PASSPILOT_CLASS_SETTINGS_MISSING", "School settings are not initialized.", 409);
    }
    if (settingsRow.passpilotClassSource === "classpilot_groups") {
      throw passpilotClassError("PASSPILOT_CLASSES_ALREADY_CANONICAL", "PassPilot already uses ClassPilot classes.", 409);
    }
    if (settingsRow.passpilotClassMigrationRevision !== expectedRevision) {
      throw passpilotClassError("PASSPILOT_CLASS_MIGRATION_CONFLICT", "The class mapping changed in another session. Reload before saving.", 409);
    }

    const inventory = await loadPasspilotMigrationInventory(tx, schoolId);
    const gradeById = new Map(inventory.legacyGrades.map((grade) => [grade.id, grade]));
    const groupById = new Map(inventory.canonicalClasses.map((group) => [group.id, group]));
    const requested = new Map(inputs.map((input) => [input.gradeId, input]));
    if (autoLink) {
      for (const grade of inventory.legacyGrades) {
        if (grade.migrationState !== "pending" || requested.has(grade.id) || !grade.autoLinkEligible) continue;
        requested.set(grade.id, {
          gradeId: grade.id,
          classId: grade.suggestedClasspilotGroupId,
          state: "auto_linked",
        });
      }
    }

    const nextRevision = expectedRevision + 1;
    for (const input of requested.values()) {
      const grade = gradeById.get(input.gradeId);
      if (!grade) {
        throw passpilotClassError("PASSPILOT_LEGACY_CLASS_NOT_FOUND", "Legacy class not found.", 404);
      }
      const state = input.state ?? (input.classId ? "confirmed" : "pending");
      if (state === "history_only") {
        if (grade.activePassCount > 0 || inventory.kioskGradeId === grade.id) {
          throw passpilotClassError(
            "PASSPILOT_HISTORY_CLASS_IN_USE",
            `Class ${grade.name} still has an active pass or kiosk selection.`,
            409
          );
        }
      } else if (state === "confirmed" || state === "auto_linked") {
        if (!input.classId || !groupById.has(input.classId)) {
          throw passpilotClassError("PASSPILOT_CANONICAL_CLASS_NOT_FOUND", "Canonical ClassPilot class not found.", 404);
        }
        if (state === "auto_linked" && (!grade.autoLinkEligible || grade.suggestedClasspilotGroupId !== input.classId)) {
          throw passpilotClassError("PASSPILOT_AUTO_LINK_CONFLICT", "This class cannot be auto-linked because its name, teacher, or roster is ambiguous.", 409);
        }
      }

      await tx
        .update(grades)
        .set({
          classpilotGroupId: state === "confirmed" || state === "auto_linked" ? input.classId! : null,
          migrationState: state,
          mappingRevision: nextRevision,
          mappingMethod: state === "auto_linked" ? "unique_exact_name" : state,
          mappingReviewerId: reviewerId,
          mappedAt: state === "pending" ? null : new Date(),
        })
        .where(and(eq(grades.id, grade.id), eq(grades.schoolId, schoolId)));
    }
    await tx
      .update(settings)
      .set({ passpilotClassMigrationRevision: nextRevision })
      .where(eq(settings.schoolId, schoolId));
    await tx.insert(auditLogs).values({
      schoolId,
      userId: reviewerId,
      action: "passpilot.class_migration.mappings_saved",
      entityType: "settings",
      entityId: settingsRow.id,
      changes: {
        revision: nextRevision,
        autoLink,
        mappings: Array.from(requested.values()).map((input) => ({
          gradeId: input.gradeId,
          classpilotGroupId: input.classId ?? null,
          state: input.state ?? (input.classId ? "confirmed" : "pending"),
        })),
      },
    });
    return loadPasspilotMigrationInventory(tx, schoolId);
  });
}

export async function completePasspilotClassMigration(
  schoolId: string,
  reviewerId: string,
  expectedRevision: number,
  classModelAcknowledged = false,
  requireClean = false
): Promise<PasspilotClassMigrationInventory> {
  return db.transaction(async (tx) => {
    await takePasspilotClassLock(tx, schoolId);
    if (!classModelAcknowledged) {
      throw passpilotClassError(
        "PASSPILOT_CLASS_MODEL_ACKNOWLEDGEMENT_REQUIRED",
        "Confirm that PassPilot web, kiosk, and installed clients support ClassPilot classes before cutover.",
        409
      );
    }
    const [settingsRow] = await tx
      .select()
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1)
      .for("update");
    if (!settingsRow) {
      throw passpilotClassError("PASSPILOT_CLASS_SETTINGS_MISSING", "School settings are not initialized.", 409);
    }
    if (requireClean) {
      const eligibility = await loadPasspilotCleanSchoolCutoverEligibility(tx, schoolId);
      if (!eligibility.eligible) {
        throw passpilotClassError(
          "PASSPILOT_CLEAN_CUTOVER_INELIGIBLE",
          `School is not eligible for guarded clean cutover (${eligibility.reasons.join(",") || "unknown"}).`,
          409
        );
      }
    }
    if (settingsRow.passpilotClassSource === "classpilot_groups") {
      return loadPasspilotMigrationInventory(tx, schoolId);
    }
    if (settingsRow.passpilotClassMigrationRevision !== expectedRevision) {
      throw passpilotClassError("PASSPILOT_CLASS_MIGRATION_CONFLICT", "The class mapping changed in another session. Reload before completing migration.", 409);
    }

    const inventory = await loadPasspilotMigrationInventory(tx, schoolId);
    const revision = expectedRevision;

    const unresolved = inventory.legacyGrades.filter(
      (grade) => grade.migrationState !== "history_only" && !grade.classpilotGroupId
    );
    if (unresolved.length > 0) {
      throw passpilotClassError(
        "PASSPILOT_CLASS_MIGRATION_INCOMPLETE",
        `${unresolved.length} legacy class${unresolved.length === 1 ? " is" : "es are"} still unresolved.`,
        409
      );
    }
    const staleAutoLinks = inventory.legacyGrades.filter(
      (grade) =>
        grade.migrationState === "auto_linked" &&
        (!grade.autoLinkEligible || grade.suggestedClasspilotGroupId !== grade.classpilotGroupId)
    );
    if (staleAutoLinks.length > 0) {
      throw passpilotClassError(
        "PASSPILOT_AUTO_LINK_REVIEW_REQUIRED",
        "One or more automatically linked classes changed after matching. Review and confirm those mappings before cutover.",
        409
      );
    }
    const [activeLegacyPassState] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(passes)
      .where(
        and(
          eq(passes.schoolId, schoolId),
          eq(passes.status, "active"),
          isNull(passes.classpilotGroupId)
        )
      );
    if ((activeLegacyPassState?.count ?? 0) > 0) {
      throw passpilotClassError(
        "PASSPILOT_ACTIVE_LEGACY_PASSES",
        "Return, cancel, or expire every active legacy pass before completing class migration.",
        409
      );
    }
    const licenses = await tx
      .select({ product: productLicenses.product })
      .from(productLicenses)
      .where(
        and(
          eq(productLicenses.schoolId, schoolId),
          eq(productLicenses.status, "active"),
          inArray(productLicenses.product, ["PASSPILOT", "CLASSPILOT"])
        )
      );
    const licensed = new Set(licenses.map((row) => row.product));
    if (!licensed.has("PASSPILOT") || !licensed.has("CLASSPILOT")) {
      throw passpilotClassError(
        "PASSPILOT_CANONICAL_LICENSE_REQUIRED",
        "Active PassPilot and ClassPilot licenses are required before cutover.",
        409
      );
    }

    let kioskClasspilotGroupId = inventory.kioskClasspilotGroupId;
    if (inventory.kioskGradeId) {
      const kioskGrade = inventory.legacyGrades.find((grade) => grade.id === inventory.kioskGradeId);
      if (!kioskGrade?.classpilotGroupId) {
        throw passpilotClassError("PASSPILOT_KIOSK_CLASS_UNRESOLVED", "The kiosk class must be mapped before cutover.", 409);
      }
      kioskClasspilotGroupId = kioskGrade.classpilotGroupId;
    }
    const mappedClassIds = inventory.legacyGrades.flatMap((grade) =>
      grade.classpilotGroupId ? [grade.classpilotGroupId] : []
    );
    const requiredClassIds = Array.from(
      new Set([
        ...mappedClassIds,
        ...(kioskClasspilotGroupId ? [kioskClasspilotGroupId] : []),
      ])
    ).sort();
    const lockedCanonicalClasses = requiredClassIds.length > 0
      ? await tx
          .select({ id: groups.id, groupType: groups.groupType, status: groups.status })
          .from(groups)
          .where(and(eq(groups.schoolId, schoolId), inArray(groups.id, requiredClassIds)))
          .orderBy(asc(groups.id))
          .for("update")
      : [];
    const activeCanonicalIds = new Set(
      lockedCanonicalClasses
        .filter((group) => group.groupType === "admin_class" && group.status === "active")
        .map((group) => group.id)
    );
    const invalidMappings = inventory.legacyGrades.filter(
      (grade) => grade.classpilotGroupId && !activeCanonicalIds.has(grade.classpilotGroupId)
    );
    if (invalidMappings.length > 0) {
      throw passpilotClassError(
        "PASSPILOT_MAPPED_CLASS_INACTIVE",
        "One or more mapped ClassPilot classes were archived or removed. Review the mappings before cutover.",
        409
      );
    }
    if (kioskClasspilotGroupId && !activeCanonicalIds.has(kioskClasspilotGroupId)) {
      throw passpilotClassError(
        "PASSPILOT_KIOSK_CLASS_INACTIVE",
        "The selected kiosk class is not an active official ClassPilot class.",
        409
      );
    }

    const completedAt = new Date();
    await tx
      .update(schools)
      .set({ kioskGradeId: null, kioskClasspilotGroupId })
      .where(eq(schools.id, schoolId));
    await tx
      .update(settings)
      .set({
        passpilotClassSource: "classpilot_groups",
        passpilotClassCutoverAt: completedAt,
        passpilotClassMigrationRevision: revision + 1,
      })
      .where(eq(settings.schoolId, schoolId));
    await tx.insert(auditLogs).values({
      schoolId,
      userId: reviewerId,
      action: "passpilot.class_migration.completed",
      entityType: "settings",
      entityId: settingsRow.id,
      changes: {
        from: "legacy_grades",
        to: "classpilot_groups",
        revision: revision + 1,
        classModelAcknowledged,
        requireClean,
      },
    });
    return loadPasspilotMigrationInventory(tx, schoolId);
  });
}

export type InstructionalCalendarMonthState = {
  month: string;
  revision: number;
  nonInstructionalDates: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export type InstructionalDateStatus = {
  instructional: boolean;
  reason: "instructional_day" | "non_instructional_day" | "weekend";
};

export type ReplaceInstructionalCalendarMonthResult =
  | {
      status: "saved";
      current: InstructionalCalendarMonthState;
      schoolTimezone: string;
      schoolLocalToday: string;
      addedDates: string[];
      removedDates: string[];
      supersededScheduleChangeIds: string[];
    }
  | {
      status: "conflict";
      current: InstructionalCalendarMonthState;
      schoolTimezone: string;
      schoolLocalToday: string;
    };

const INSTRUCTIONAL_CALENDAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const INSTRUCTIONAL_CALENDAR_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function instructionalCalendarError(
  code: string,
  message: string,
  status = 400
): Error & { code: string; status: number; expose: true } {
  return Object.assign(new Error(message), { code, status, expose: true as const });
}

export function isValidInstructionalCalendarMonth(month: string): boolean {
  return INSTRUCTIONAL_CALENDAR_MONTH_PATTERN.test(month);
}

export function isValidInstructionalCalendarDate(localDate: string): boolean {
  if (!INSTRUCTIONAL_CALENDAR_DATE_PATTERN.test(localDate)) return false;
  const parsed = new Date(`${localDate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === localDate;
}

export function isInstructionalCalendarWeekend(localDate: string): boolean {
  if (!isValidInstructionalCalendarDate(localDate)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_DATE",
      "Date must be a real calendar date in YYYY-MM-DD format."
    );
  }
  const day = new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function instructionalCalendarWeekdaysInMonth(month: string): string[] {
  if (!isValidInstructionalCalendarMonth(month)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_MONTH",
      "Month must use YYYY-MM format."
    );
  }
  const dates: string[] = [];
  for (let day = 1; day <= 31; day++) {
    const localDate = `${month}-${String(day).padStart(2, "0")}`;
    if (!isValidInstructionalCalendarDate(localDate)) continue;
    if (!isInstructionalCalendarWeekend(localDate)) dates.push(localDate);
  }
  return dates;
}

function canonicalInstructionalCalendarDates(month: string, dates: unknown): string[] {
  if (!Array.isArray(dates)) {
    throw instructionalCalendarError(
      "INVALID_NON_INSTRUCTIONAL_DATES",
      "nonInstructionalDates must be an array."
    );
  }
  if (dates.length > 31) {
    throw instructionalCalendarError(
      "TOO_MANY_NON_INSTRUCTIONAL_DATES",
      "A calendar month cannot contain more than 31 submitted dates."
    );
  }
  const canonical = dates.map((value) => {
    if (typeof value !== "string" || !isValidInstructionalCalendarDate(value)) {
      throw instructionalCalendarError(
        "INVALID_INSTRUCTIONAL_CALENDAR_DATE",
        "Each non-instructional date must be a real date in YYYY-MM-DD format."
      );
    }
    if (!value.startsWith(`${month}-`)) {
      throw instructionalCalendarError(
        "INSTRUCTIONAL_CALENDAR_DATE_OUT_OF_MONTH",
        "Every non-instructional date must be in the requested month."
      );
    }
    if (isInstructionalCalendarWeekend(value)) {
      throw instructionalCalendarError(
        "INSTRUCTIONAL_CALENDAR_WEEKEND_LOCKED",
        "Weekends are always non-instructional and cannot be edited."
      );
    }
    return value;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw instructionalCalendarError(
      "DUPLICATE_INSTRUCTIONAL_CALENDAR_DATE",
      "Non-instructional dates must be unique."
    );
  }
  return canonical.sort();
}

function normalizeStoredInstructionalCalendarMonth(
  month: string,
  value: unknown
): InstructionalCalendarMonthState {
  if (value === undefined) {
    return {
      month,
      revision: 0,
      nonInstructionalDates: [],
      updatedAt: null,
      updatedBy: null,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw instructionalCalendarError(
      "INSTRUCTIONAL_CALENDAR_CORRUPT",
      "The saved instructional calendar is invalid.",
      500
    );
  }
  const stored = value as Partial<InstructionalCalendarMonthSettings>;
  const parsedUpdatedAt = typeof stored.updatedAt === "string"
    ? new Date(stored.updatedAt)
    : null;
  if (
    !Number.isSafeInteger(stored.revision) ||
    Number(stored.revision) < 1 ||
    !parsedUpdatedAt ||
    Number.isNaN(parsedUpdatedAt.getTime()) ||
    parsedUpdatedAt.toISOString() !== stored.updatedAt ||
    !(
      stored.updatedBy === null ||
      (typeof stored.updatedBy === "string" && stored.updatedBy.length > 0)
    )
  ) {
    throw instructionalCalendarError(
      "INSTRUCTIONAL_CALENDAR_CORRUPT",
      "The saved instructional calendar is invalid.",
      500
    );
  }
  let nonInstructionalDates: string[];
  try {
    nonInstructionalDates = canonicalInstructionalCalendarDates(
      month,
      stored.nonInstructionalDates
    );
  } catch {
    throw instructionalCalendarError(
      "INSTRUCTIONAL_CALENDAR_CORRUPT",
      "The saved instructional calendar is invalid.",
      500
    );
  }
  return {
    month,
    revision: Number(stored.revision),
    nonInstructionalDates,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy ?? null,
  };
}

function normalizeStoredInstructionalCalendar(
  value: unknown
): InstructionalCalendarSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw instructionalCalendarError(
      "INSTRUCTIONAL_CALENDAR_CORRUPT",
      "The saved instructional calendar is invalid.",
      500
    );
  }
  return value as InstructionalCalendarSettings;
}

export async function getInstructionalCalendarMonth(
  schoolId: string,
  month: string,
  dbInstance: typeof db = db
): Promise<InstructionalCalendarMonthState> {
  if (!isValidInstructionalCalendarMonth(month)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_MONTH",
      "Month must use YYYY-MM format."
    );
  }
  const [row] = await dbInstance
    .select({ instructionalCalendar: settings.instructionalCalendar })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  if (!row) {
    throw instructionalCalendarError(
      "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE",
      "School calendar settings are unavailable.",
      500
    );
  }
  const calendar = normalizeStoredInstructionalCalendar(row.instructionalCalendar);
  return normalizeStoredInstructionalCalendarMonth(month, calendar[month]);
}

export async function getInstructionalDateStatus(
  schoolId: string,
  localDate: string,
  dbInstance: typeof db = db
): Promise<InstructionalDateStatus> {
  if (!isValidInstructionalCalendarDate(localDate)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_DATE",
      "Date must be a real calendar date in YYYY-MM-DD format."
    );
  }
  if (isInstructionalCalendarWeekend(localDate)) {
    return { instructional: false, reason: "weekend" };
  }
  const month = await getInstructionalCalendarMonth(schoolId, localDate.slice(0, 7), dbInstance);
  const instructional = !month.nonInstructionalDates.includes(localDate);
  return {
    instructional,
    reason: instructional ? "instructional_day" : "non_instructional_day",
  };
}

/**
 * Acquire the shared school/date transaction lock used by both calendar saves
 * and automatic scheduled-occurrence creation. The caller must already be in
 * a transaction; use withInstructionalCalendarDateLock for the common case.
 */
export async function lockInstructionalCalendarDate(
  schoolId: string,
  localDate: string,
  dbInstance: typeof db
): Promise<void> {
  if (!isValidInstructionalCalendarDate(localDate)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_DATE",
      "Date must be a real calendar date in YYYY-MM-DD format."
    );
  }
  const lockKey = `classpilot:instructional-calendar:${schoolId}:${localDate}`;
  await dbInstance.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`
  );
}

export async function withInstructionalCalendarDateLock<T>(
  schoolId: string,
  localDate: string,
  callback: (dbInstance: typeof db) => Promise<T>,
  dbInstance: typeof db = db
): Promise<T> {
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await lockInstructionalCalendarDate(schoolId, localDate, transactionDb);
    return callback(transactionDb);
  });
}

export async function replaceInstructionalCalendarMonth(
  options: {
    schoolId: string;
    month: string;
    expectedRevision: number;
    nonInstructionalDates: string[];
    updatedBy: string | null;
    now?: Date;
  },
  dbInstance: typeof db = db
): Promise<ReplaceInstructionalCalendarMonthResult> {
  const month = options.month;
  if (!isValidInstructionalCalendarMonth(month)) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_MONTH",
      "Month must use YYYY-MM format."
    );
  }
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw instructionalCalendarError(
      "INVALID_INSTRUCTIONAL_CALENDAR_REVISION",
      "expectedRevision must be a non-negative integer."
    );
  }
  const nextDates = canonicalInstructionalCalendarDates(month, options.nonInstructionalDates);
  const now = options.now || new Date();

  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    // Date locks are always taken first and in stable order. Scheduler-created
    // occurrences use the same lock for their single local date, so either the
    // closure save or occurrence creation wins deterministically.
    for (const localDate of instructionalCalendarWeekdaysInMonth(month)) {
      await lockInstructionalCalendarDate(options.schoolId, localDate, transactionDb);
    }

    const [school] = await tx
      .select({ schoolTimezone: schools.schoolTimezone })
      .from(schools)
      .where(eq(schools.id, options.schoolId))
      .limit(1)
      .for("update");
    if (!school) {
      throw instructionalCalendarError("SCHOOL_NOT_FOUND", "School not found.", 404);
    }
    const schoolTimezone = school.schoolTimezone || "America/New_York";
    const schoolLocalToday = localDateInTimeZone(now, schoolTimezone);
    await takeClasspilotScheduleConfigLock(
      transactionDb as unknown as ScheduleChangeDb,
      options.schoolId
    );

    const [row] = await tx
      .select({ instructionalCalendar: settings.instructionalCalendar })
      .from(settings)
      .where(eq(settings.schoolId, options.schoolId))
      .limit(1)
      .for("update");
    if (!row) {
      throw instructionalCalendarError(
        "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE",
        "School calendar settings are unavailable.",
        500
      );
    }

    const calendar = normalizeStoredInstructionalCalendar(row.instructionalCalendar);
    const current = normalizeStoredInstructionalCalendarMonth(month, calendar[month]);
    if (current.revision !== options.expectedRevision) {
      return {
        status: "conflict" as const,
        current,
        schoolTimezone,
        schoolLocalToday,
      };
    }

    const currentSet = new Set(current.nonInstructionalDates);
    const nextSet = new Set(nextDates);
    const pastDates = new Set(
      [...currentSet, ...nextSet].filter((localDate) => localDate < schoolLocalToday)
    );
    for (const localDate of pastDates) {
      if (currentSet.has(localDate) !== nextSet.has(localDate)) {
        throw instructionalCalendarError(
          "INSTRUCTIONAL_CALENDAR_PAST_DATE_IMMUTABLE",
          "Past instructional-calendar dates cannot be changed."
        );
      }
    }

    const addedDates = nextDates.filter((localDate) => !currentSet.has(localDate));
    const closingChanges = addedDates.length
      ? await tx
          .select()
          .from(classpilotScheduleChanges)
          .where(
            and(
              eq(classpilotScheduleChanges.schoolId, options.schoolId),
              inArray(classpilotScheduleChanges.scheduledDate, addedDates),
              inArray(classpilotScheduleChanges.status, [
                ...CP_SCHEDULE_CHANGE_ACTIVE_STATUSES,
              ]),
              eq(classpilotScheduleChanges.reservationActive, true)
            )
          )
          .orderBy(asc(classpilotScheduleChanges.id))
          .for("update")
      : [];
    if (closingChanges.some((change) => change.status === "approved")) {
      throw instructionalCalendarError(
        "APPROVED_SCHEDULE_CHANGE_EXISTS",
        "Cancel approved schedule changes before closing this instructional date.",
        409
      );
    }
    const supersededScheduleChangeIds = closingChanges
      .filter((change) =>
        CP_SCHEDULE_CHANGE_PENDING_STATUSES.includes(
          change.status as (typeof CP_SCHEDULE_CHANGE_PENDING_STATUSES)[number]
        )
      )
      .map((change) => change.id)
      .sort();
    if (supersededScheduleChangeIds.length > 0) {
      await tx
        .update(classpilotScheduleChanges)
        .set({
          status: "superseded",
          reservationActive: false,
          terminalByUserId: options.updatedBy,
          terminalReason: "instructional_date_closed",
          terminalAt: now,
          revision: sql`${classpilotScheduleChanges.revision} + 1`,
          updatedAt: now,
        })
        .where(inArray(classpilotScheduleChanges.id, supersededScheduleChangeIds));
      await releaseScheduleChangeReservations(
        supersededScheduleChangeIds,
        transactionDb as unknown as ScheduleChangeDb
      );
      for (const id of supersededScheduleChangeIds) {
        await tx.insert(auditLogs).values({
          schoolId: options.schoolId,
          userId: options.updatedBy,
          action: "classpilot.schedule_change.superseded",
          entityType: "classpilot_schedule_change",
          entityId: id,
          changes: { status: "superseded" },
          metadata: { reasonCode: "instructional_date_closed" },
        });
      }
      recordScheduleChangePostCommitNotice(
        transactionDb as unknown as ScheduleChangeDb,
        options.schoolId,
        supersededScheduleChangeIds
      );
    }

    const updatedAt = now.toISOString();
    const savedMonth: InstructionalCalendarMonthSettings = {
      revision: current.revision + 1,
      nonInstructionalDates: nextDates,
      updatedAt,
      updatedBy: options.updatedBy,
    };
    const nextCalendar: InstructionalCalendarSettings = {
      ...calendar,
      [month]: savedMonth,
    };
    await tx
      .update(settings)
      .set({ instructionalCalendar: nextCalendar })
      .where(eq(settings.schoolId, options.schoolId));

    const removedDates = current.nonInstructionalDates.filter(
      (localDate) => !nextSet.has(localDate)
    );
    return {
      status: "saved" as const,
      current: normalizeStoredInstructionalCalendarMonth(month, savedMonth),
      schoolTimezone,
      schoolLocalToday,
      addedDates,
      removedDates,
      supersededScheduleChangeIds,
    };
  }, dbInstance);
}

// Heartbeats only need the tracking-window fields. Cache that deliberately
// narrow, non-secret projection; Redis invalidates healthy peer API tasks and
// the short TTL bounds staleness if pub/sub is temporarily unavailable.
export async function getHeartbeatTrackingSettingsForSchool(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<HeartbeatTrackingSettings | undefined> {
  const cacheAllowed = canUseHeartbeatTrackingSettingsCache(schoolId, dbInstance);
  if (cacheAllowed) {
    const cached = heartbeatTrackingSettingsCache.get(schoolId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) heartbeatTrackingSettingsCache.delete(schoolId);
    const loading = heartbeatTrackingSettingsLoads.get(schoolId);
    if (loading) return loading;
  }

  const load = async (): Promise<HeartbeatTrackingSettings | undefined> => {
    const [row] = await dbInstance
      .select({
        enableTrackingHours: settings.enableTrackingHours,
        trackingStartTime: settings.trackingStartTime,
        trackingEndTime: settings.trackingEndTime,
        trackingDays: settings.trackingDays,
        schoolTimezone: settings.schoolTimezone,
        afterHoursMode: settings.afterHoursMode,
      })
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1);
    return row;
  };

  if (!cacheAllowed) return load();

  const generation = heartbeatTrackingSettingsGenerations.get(schoolId) ?? 0;
  let pending!: Promise<HeartbeatTrackingSettings | undefined>;
  pending = load()
    .then((row) => {
      if ((heartbeatTrackingSettingsGenerations.get(schoolId) ?? 0) === generation) {
        heartbeatTrackingSettingsCache.set(schoolId, {
          expiresAt: Date.now() + HEARTBEAT_TRACKING_SETTINGS_CACHE_TTL_MS,
          value: row,
        });
      }
      return row;
    })
    .finally(() => {
      if (heartbeatTrackingSettingsLoads.get(schoolId) === pending) {
        heartbeatTrackingSettingsLoads.delete(schoolId);
      }
    });
  heartbeatTrackingSettingsLoads.set(schoolId, pending);
  return pending;
}

export async function upsertSettings(
  schoolId: string,
  data: Partial<InsertSettings>
): Promise<Settings> {
  invalidateHeartbeatTrackingSettingsCache(schoolId);
  const settingsData: Partial<InsertSettings> = {
    ...data,
  };

  if (
    data.sharedChromebookSignInEnabled === true &&
    data.sharedChromebookLoginMethod === undefined &&
    data.sharedChromebookPinLoginEnabled === undefined
  ) {
    settingsData.sharedChromebookLoginMethod = "name_pin";
    settingsData.sharedChromebookPinLoginEnabled = true;
  }

  const [row] = await db
    .insert(settings)
    .values({
      schoolId,
      schoolName: settingsData.schoolName || "",
      wsSharedKey: settingsData.wsSharedKey || "",
      sharedChromebookLoginMethod: "name_pin",
      ...settingsData,
    })
    .onConflictDoUpdate({
      target: settings.schoolId,
      set: settingsData,
    })
    .returning();
  invalidateHeartbeatTrackingSettingsCache(schoolId);
  await publishCacheInvalidation({
    kind: "cache-invalidation",
    schoolId,
    cache: "heartbeat-tracking-settings",
  });
  return row!;
}

// Update only the device-enrollment / auto-enroll fields on an existing settings row.
export async function updateEnrollmentSettings(
  schoolId: string,
  data: { enrollmentKey?: string; enrollmentKeyRequired?: boolean; autoEnrollStudents?: boolean }
): Promise<Settings> {
  invalidateHeartbeatTrackingSettingsCache(schoolId);
  const school = await getSchoolById(schoolId);
  const [row] = await db
    .insert(settings)
    .values({
      schoolId,
      schoolName: school?.name || "",
      wsSharedKey: "",
      sharedChromebookLoginMethod: "name_pin",
      ...data,
    })
    .onConflictDoUpdate({
      target: settings.schoolId,
      set: data,
    })
    .returning();
  invalidateHeartbeatTrackingSettingsCache(schoolId);
  return row!;
}

// ============================================================================
// Classroom Course operations
// ============================================================================

export async function getClassroomCoursesBySchool(
  schoolId: string
): Promise<ClassroomCourse[]> {
  return db
    .select()
    .from(classroomCourses)
    .where(eq(classroomCourses.schoolId, schoolId))
    .orderBy(classroomCourses.name);
}

export async function upsertClassroomCourse(
  data: InsertClassroomCourse
): Promise<ClassroomCourse> {
  const [course] = await db
    .insert(classroomCourses)
    .values(data)
    .onConflictDoUpdate({
      target: [classroomCourses.schoolId, classroomCourses.googleCourseId],
      set: {
        name: data.name,
        section: data.section,
        room: data.room,
        descriptionHeading: data.descriptionHeading,
        ownerId: data.ownerId,
        gradeId: data.gradeId,
        lastSyncedAt: data.lastSyncedAt || new Date(),
      },
    })
    .returning();
  return course!;
}

export async function getClassroomCourseStudents(
  courseId: string
): Promise<ClassroomCourseStudent[]> {
  return db
    .select()
    .from(classroomCourseStudents)
    .where(eq(classroomCourseStudents.courseId, courseId));
}

export async function upsertClassroomCourseStudents(
  rows: InsertClassroomCourseStudent[]
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(classroomCourseStudents)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        classroomCourseStudents.schoolId,
        classroomCourseStudents.courseId,
        classroomCourseStudents.studentId,
      ],
      set: {
        googleUserId: sql`excluded.google_user_id`,
        studentEmailLc: sql`excluded.student_email_lc`,
        lastSeenAt: new Date(),
      },
    });
}


// ============================================================================
// Student Attendance
// ============================================================================

/** Returns a Set of student IDs unavailable for dismissal/movement on a given date. */
export async function getAbsentStudentIds(
  schoolId: string,
  date: string
): Promise<Set<string>> {
  const rows = await db
    .select({ studentId: studentAttendance.studentId })
    .from(studentAttendance)
    .where(
      and(
        eq(studentAttendance.schoolId, schoolId),
        eq(studentAttendance.date, date),
        inArray(studentAttendance.status, ["absent", "early_dismissal"])
      )
    );
  return new Set(rows.map((r) => r.studentId));
}

/** Full attendance records for a school on a given date, joined with student name */
export async function getAttendanceBySchool(schoolId: string, date: string) {
  const rows = await db
    .select({
      attendance: studentAttendance,
      student: {
        id: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        gradeLevel: students.gradeLevel,
        gradeId: students.gradeId,
        homeroomId: students.homeroomId,
      },
    })
    .from(studentAttendance)
    .innerJoin(students, eq(studentAttendance.studentId, students.id))
    .where(
      and(
        eq(studentAttendance.schoolId, schoolId),
        eq(studentAttendance.date, date)
      )
    )
    .orderBy(students.lastName, students.firstName);
  return rows;
}

/** Attendance history for a single student within a date range */
export async function getStudentAttendance(
  studentId: string,
  startDate: string,
  endDate: string
) {
  const rows = await db
    .select()
    .from(studentAttendance)
    .where(
      and(
        eq(studentAttendance.studentId, studentId),
        sql`${studentAttendance.date} >= ${startDate}`,
        sql`${studentAttendance.date} <= ${endDate}`
      )
    )
    .orderBy(desc(studentAttendance.date));
  return rows;
}

export async function getAttendanceRecordById(
  id: string,
  schoolId: string
): Promise<StudentAttendance | undefined> {
  const [row] = await db
    .select()
    .from(studentAttendance)
    .where(and(eq(studentAttendance.id, id), eq(studentAttendance.schoolId, schoolId)))
    .limit(1);
  return row;
}

/** Mark a student absent (upsert — updates if already marked for that date) */
export async function markStudentAbsent(data: {
  schoolId: string;
  studentId: string;
  date: string;
  status: string;
  reason?: string | null;
  notes?: string | null;
  markedBy: string;
  source?: string;
}) {
  const [row] = await db
    .insert(studentAttendance)
    .values({
      schoolId: data.schoolId,
      studentId: data.studentId,
      date: data.date,
      status: data.status,
      reason: data.reason || null,
      notes: data.notes || null,
      markedBy: data.markedBy,
      source: data.source || "manual",
    })
    .onConflictDoUpdate({
      target: [studentAttendance.studentId, studentAttendance.date],
      set: {
        status: sql`EXCLUDED.status`,
        reason: sql`EXCLUDED.reason`,
        notes: sql`EXCLUDED.notes`,
        markedBy: sql`EXCLUDED.marked_by`,
        source: sql`EXCLUDED.source`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

/** Bulk mark students absent for a given date (atomic transaction) */
export async function markStudentsAbsentBulk(
  schoolId: string,
  studentIds: string[],
  data: {
    date: string;
    status: string;
    reason?: string | null;
    notes?: string | null;
    markedBy: string;
    source?: string;
  }
) {
  return await db.transaction(async (tx) => {
    const results: StudentAttendance[] = [];
    for (const studentId of studentIds) {
      const [row] = await tx
        .insert(studentAttendance)
        .values({
          schoolId,
          studentId,
          date: data.date,
          status: data.status,
          reason: data.reason || null,
          notes: data.notes || null,
          markedBy: data.markedBy,
          source: data.source || "manual",
        })
        .onConflictDoUpdate({
          target: [studentAttendance.studentId, studentAttendance.date],
          set: {
            status: sql`EXCLUDED.status`,
            reason: sql`EXCLUDED.reason`,
            notes: sql`EXCLUDED.notes`,
            markedBy: sql`EXCLUDED.marked_by`,
            source: sql`EXCLUDED.source`,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      results.push(row!);
    }
    return results;
  });
}

/** Remove an absence record (student showed up) */
export async function removeAbsence(id: string, schoolId: string): Promise<boolean> {
  const result = await db
    .delete(studentAttendance)
    .where(and(eq(studentAttendance.id, id), eq(studentAttendance.schoolId, schoolId)));
  return (result.rowCount ?? 0) > 0;
}

/** Attendance stats for a school over a date range */
export async function getAttendanceStats(
  schoolId: string,
  startDate: string,
  endDate: string
) {
  const rows = await db
    .select({
      date: studentAttendance.date,
      status: studentAttendance.status,
      count: sql<number>`count(*)::int`,
    })
    .from(studentAttendance)
    .where(
      and(
        eq(studentAttendance.schoolId, schoolId),
        sql`${studentAttendance.date} >= ${startDate}`,
        sql`${studentAttendance.date} <= ${endDate}`
      )
    )
    .groupBy(studentAttendance.date, studentAttendance.status)
    .orderBy(desc(studentAttendance.date));
  return rows;
}

// ============================================================================
// Dismissal Overrides
// ============================================================================

export async function upsertDismissalOverride(data: {
  schoolId?: string;
  sessionId: string;
  studentId: string;
  originalType: string;
  overrideType: string;
  busRoute?: string | null;
  reason?: string | null;
  changedBy: string;
  changedByRole: string;
}): Promise<DismissalOverride> {
  const schoolId = await getSessionSchoolIdForTenantWrite(data.sessionId, data.schoolId);
  const student = await getStudentById(data.studentId);
  if (!student || student.schoolId !== schoolId || student.status !== "active") {
    throw new Error("Student does not belong to the dismissal session school");
  }
  const [row] = await db
    .insert(dismissalOverrides)
    .values({ ...data, schoolId })
    .onConflictDoUpdate({
      target: [dismissalOverrides.sessionId, dismissalOverrides.studentId],
      set: {
        overrideType: sql`EXCLUDED.override_type`,
        busRoute: sql`EXCLUDED.bus_route`,
        reason: sql`EXCLUDED.reason`,
        changedBy: sql`EXCLUDED.changed_by`,
        changedByRole: sql`EXCLUDED.changed_by_role`,
        createdAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

export async function deleteDismissalOverride(
  sessionId: string,
  studentId: string
): Promise<boolean> {
  const result = await db
    .delete(dismissalOverrides)
    .where(
      and(
        eq(dismissalOverrides.sessionId, sessionId),
        eq(dismissalOverrides.studentId, studentId)
      )
    )
    .returning();
  return result.length > 0;
}

export async function getOverridesForSession(
  sessionId: string
): Promise<DismissalOverride[]> {
  return db
    .select()
    .from(dismissalOverrides)
    .where(eq(dismissalOverrides.sessionId, sessionId))
    .orderBy(desc(dismissalOverrides.createdAt));
}

export async function getOverrideForStudent(
  sessionId: string,
  studentId: string
): Promise<DismissalOverride | undefined> {
  const [row] = await db
    .select()
    .from(dismissalOverrides)
    .where(
      and(
        eq(dismissalOverrides.sessionId, sessionId),
        eq(dismissalOverrides.studentId, studentId)
      )
    )
    .limit(1);
  return row;
}

export async function getEffectiveDismissalType(
  studentId: string,
  sessionId: string
): Promise<string> {
  const override = await getOverrideForStudent(sessionId, studentId);
  if (override) return override.overrideType;
  const student = await getStudentById(studentId);
  return student?.dismissalType ?? "car";
}

export async function getEffectiveDismissalTypes(
  studentIds: string[],
  sessionId: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (studentIds.length === 0) return result;

  // Get all overrides for this session in one query
  const overrides = await db
    .select()
    .from(dismissalOverrides)
    .where(
      and(
        eq(dismissalOverrides.sessionId, sessionId),
        inArray(dismissalOverrides.studentId, studentIds)
      )
    );

  const overrideMap = new Map(overrides.map((o) => [o.studentId, o.overrideType]));

  // Get all students in one query
  const studentRows = await db
    .select({ id: students.id, dismissalType: students.dismissalType })
    .from(students)
    .where(inArray(students.id, studentIds));

  for (const s of studentRows) {
    result.set(s.id, overrideMap.get(s.id) ?? s.dismissalType ?? "car");
  }

  return result;
}


// ============================================================================
// MailPilot — Gmail watch + email alert queries
// ============================================================================

export async function upsertMailpilotWatch(
  data: InsertMailpilotWatch,
  dbInstance: typeof db = db
): Promise<MailpilotWatch> {
  const existing = await dbInstance
    .select()
    .from(mailpilotWatches)
    .where(eq(mailpilotWatches.studentEmail, data.studentEmail))
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await dbInstance
      .update(mailpilotWatches)
      .set({
        historyId: data.historyId ?? existing[0]!.historyId,
        expiresAt: data.expiresAt,
        lastRenewedAt: new Date(),
        status: data.status ?? "active",
        lastError: null,
      })
      .where(eq(mailpilotWatches.id, existing[0]!.id))
      .returning();
    return updated!;
  }

  const [inserted] = await dbInstance
    .insert(mailpilotWatches)
    .values(data)
    .returning();
  return inserted!;
}

export async function getMailpilotWatchByEmail(
  studentEmail: string,
  dbInstance: typeof db = db
): Promise<MailpilotWatch | undefined> {
  const [row] = await dbInstance
    .select()
    .from(mailpilotWatches)
    .where(eq(mailpilotWatches.studentEmail, studentEmail.toLowerCase()))
    .limit(1);
  return row;
}

/**
 * Run `fn` inside a transaction that holds a row-level lock on the watch row.
 * Serializes concurrent Pub/Sub notifications for the same mailbox — without
 * this, two simultaneous pushes can read the same historyId, process
 * overlapping ranges, and race on the write-back (missed or duplicated alerts).
 */
export async function withMailpilotWatchLock<T>(
  studentEmail: string,
  fn: (watch: MailpilotWatch, tx: typeof db) => Promise<T>
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const [watch] = await tx
      .select()
      .from(mailpilotWatches)
      .where(eq(mailpilotWatches.studentEmail, studentEmail.toLowerCase()))
      .limit(1)
      .for("update");
    if (!watch) return undefined;
    return fn(watch, tx as unknown as typeof db);
  });
}

export async function getMailpilotWatchesBySchool(
  schoolId: string
): Promise<MailpilotWatch[]> {
  return db
    .select()
    .from(mailpilotWatches)
    .where(eq(mailpilotWatches.schoolId, schoolId))
    .orderBy(asc(mailpilotWatches.studentEmail));
}

export async function getWatchesDueForRenewal(
  withinMs: number,
  dbInstance: typeof db = db
): Promise<MailpilotWatch[]> {
  const cutoff = new Date(Date.now() + withinMs);
  return dbInstance
    .select()
    .from(mailpilotWatches)
    .where(
      and(
        eq(mailpilotWatches.status, "active"),
        sql`${mailpilotWatches.expiresAt} <= ${cutoff}`
      )
    );
}

export async function updateMailpilotWatchHistoryId(
  id: string,
  historyId: string,
  lastPollAt: Date
): Promise<void> {
  await db
    .update(mailpilotWatches)
    .set({ historyId, lastPollAt })
    .where(eq(mailpilotWatches.id, id));
}

export async function updateMailpilotWatchError(
  id: string,
  errorMessage: string,
  status: "active" | "stopped" | "error" = "error",
  dbInstance: typeof db = db
): Promise<void> {
  await dbInstance
    .update(mailpilotWatches)
    .set({ status, lastError: errorMessage.slice(0, 500) })
    .where(eq(mailpilotWatches.id, id));
}

export async function deleteMailpilotWatch(
  studentEmail: string
): Promise<void> {
  await db
    .delete(mailpilotWatches)
    .where(eq(mailpilotWatches.studentEmail, studentEmail.toLowerCase()));
}

export async function createEmailAlert(
  data: InsertEmailAlert
): Promise<EmailAlert | undefined> {
  try {
    const [inserted] = await db
      .insert(emailAlerts)
      .values(data)
      .returning();
    return inserted;
  } catch (err: any) {
    // Duplicate gmail_message_id — already processed, ignore silently
    if (err?.code === "23505" || /unique/i.test(err?.message || "")) return undefined;
    throw err;
  }
}

export async function listEmailAlertsForSchool(
  schoolId: string,
  options: {
    limit?: number;
    offset?: number;
    reviewStatus?: "unreviewed" | "confirmed" | "dismissed" | "escalated" | "all";
    severity?: string;
    safetyAlert?: string;
    studentId?: string;
    since?: Date;
  } = {}
): Promise<EmailAlert[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  const conditions = [eq(emailAlerts.schoolId, schoolId)];
  if (options.reviewStatus === "unreviewed") {
    conditions.push(isNull(emailAlerts.reviewStatus));
  } else if (options.reviewStatus && options.reviewStatus !== "all") {
    conditions.push(eq(emailAlerts.reviewStatus, options.reviewStatus));
  }
  if (options.severity) conditions.push(eq(emailAlerts.severity, options.severity));
  if (options.safetyAlert) conditions.push(eq(emailAlerts.safetyAlert, options.safetyAlert));
  if (options.studentId) conditions.push(eq(emailAlerts.studentId, options.studentId));
  if (options.since) conditions.push(sql`${emailAlerts.alertedAt} >= ${options.since}`);

  return db
    .select()
    .from(emailAlerts)
    .where(and(...conditions))
    .orderBy(desc(emailAlerts.alertedAt))
    .limit(limit)
    .offset(offset);
}

export async function getEmailAlertById(id: string): Promise<EmailAlert | undefined> {
  const [row] = await db
    .select()
    .from(emailAlerts)
    .where(eq(emailAlerts.id, id))
    .limit(1);
  return row;
}

export async function updateEmailAlertReview(
  id: string,
  data: {
    reviewStatus: "confirmed" | "dismissed" | "escalated";
    reviewedBy: string;
    reviewNote?: string;
  }
): Promise<EmailAlert | undefined> {
  const [updated] = await db
    .update(emailAlerts)
    .set({
      reviewStatus: data.reviewStatus,
      reviewedBy: data.reviewedBy,
      reviewNote: data.reviewNote || null,
      reviewedAt: new Date(),
    })
    .where(eq(emailAlerts.id, id))
    .returning();
  return updated;
}

export async function getEmailAlertStats(schoolId: string, sinceDate: Date): Promise<{
  total: number;
  unreviewed: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
}> {
  const rows = await db
    .select({
      safetyAlert: emailAlerts.safetyAlert,
      severity: emailAlerts.severity,
      reviewStatus: emailAlerts.reviewStatus,
    })
    .from(emailAlerts)
    .where(
      and(
        eq(emailAlerts.schoolId, schoolId),
        sql`${emailAlerts.alertedAt} >= ${sinceDate}`
      )
    );

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let unreviewed = 0;
  for (const r of rows) {
    if (r.safetyAlert) byCategory[r.safetyAlert] = (byCategory[r.safetyAlert] || 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    if (!r.reviewStatus) unreviewed++;
  }
  return { total: rows.length, unreviewed, byCategory, bySeverity };
}

export async function upsertEmailScanLog(
  data: InsertEmailScanLogEntry
): Promise<void> {
  await db
    .insert(emailScanLog)
    .values(data)
    .onConflictDoUpdate({
      target: [emailScanLog.schoolId, emailScanLog.date],
      set: {
        messagesScanned: sql`${emailScanLog.messagesScanned} + ${data.messagesScanned ?? 0}`,
        alertsRaised: sql`${emailScanLog.alertsRaised} + ${data.alertsRaised ?? 0}`,
        errors: sql`${emailScanLog.errors} + ${data.errors ?? 0}`,
        updatedAt: new Date(),
      },
    });
}

export async function getStudentByEmailAnySchool(
  email: string
): Promise<Student | undefined> {
  const [row] = await db
    .select()
    .from(students)
    .where(eq(students.emailLc, email.toLowerCase()))
    .limit(1);
  return row;
}

export async function getSchoolAdminAndLeadershipEmails(
  schoolId: string
): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(schoolMemberships)
    .innerJoin(users, eq(schoolMemberships.userId, users.id))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin"])
      )
    );
  // Deduplicate in case the same user holds multiple role rows
  return Array.from(new Set(rows.map((r) => r.email)));
}

// ============================================================================
// ClassPilot competitive safety spine
// ============================================================================

export async function createStudentSafetyCase(
  data: InsertStudentSafetyCase
): Promise<StudentSafetyCase> {
  const [row] = await db.insert(studentSafetyCases).values(data).returning();
  return row!;
}

export async function getOpenSafetyCaseForStudent(
  schoolId: string,
  studentId: string
): Promise<StudentSafetyCase | undefined> {
  const [row] = await db
    .select()
    .from(studentSafetyCases)
    .where(
      and(
        eq(studentSafetyCases.schoolId, schoolId),
        eq(studentSafetyCases.studentId, studentId),
        eq(studentSafetyCases.status, "open")
      )
    )
    .orderBy(desc(studentSafetyCases.openedAt))
    .limit(1);
  return row;
}

export async function getOrCreateSafetyCaseForStudent(options: {
  schoolId: string;
  studentId: string;
  title: string;
  severity?: string;
  summary?: string | null;
  openedBy?: string | null;
  metadata?: unknown;
}): Promise<StudentSafetyCase> {
  const existing = await getOpenSafetyCaseForStudent(options.schoolId, options.studentId);
  if (existing) return existing;
  return createStudentSafetyCase({
    schoolId: options.schoolId,
    studentId: options.studentId,
    title: options.title,
    severity: options.severity || "medium",
    summary: options.summary || null,
    openedBy: options.openedBy || null,
    metadata: options.metadata as any,
  });
}

export async function listOpenSafetyCasesForSchool(
  schoolId: string,
  limit = 100
): Promise<StudentSafetyCase[]> {
  return db
    .select()
    .from(studentSafetyCases)
    .where(and(eq(studentSafetyCases.schoolId, schoolId), eq(studentSafetyCases.status, "open")))
    .orderBy(desc(studentSafetyCases.openedAt))
    .limit(limit);
}

export async function createStudentTimelineEvent(
  data: InsertStudentTimelineEvent
): Promise<StudentTimelineEvent> {
  const [row] = await db.insert(studentTimelineEvents).values(data).returning();
  return row!;
}

export async function listStudentTimelineEvents(options: {
  schoolId: string;
  studentId: string;
  caseId?: string;
  from?: Date;
  to?: Date;
  types?: string[];
  limit?: number;
}): Promise<StudentTimelineEvent[]> {
  const conditions: SQL[] = [
    eq(studentTimelineEvents.schoolId, options.schoolId),
    eq(studentTimelineEvents.studentId, options.studentId),
  ];
  if (options.caseId) conditions.push(eq(studentTimelineEvents.caseId, options.caseId));
  if (options.from) conditions.push(sql`${studentTimelineEvents.occurredAt} >= ${options.from}`);
  if (options.to) conditions.push(sql`${studentTimelineEvents.occurredAt} <= ${options.to}`);
  if (options.types?.length) conditions.push(inArray(studentTimelineEvents.eventType, options.types));

  return db
    .select()
    .from(studentTimelineEvents)
    .where(and(...conditions))
    .orderBy(desc(studentTimelineEvents.occurredAt))
    .limit(Math.min(options.limit || 200, 500));
}

export async function createClasspilotAiDecision(
  data: InsertClasspilotAiDecision
): Promise<ClasspilotAiDecision> {
  const [row] = await db.insert(classpilotAiDecisions).values(data).returning();
  return row!;
}

export async function listClasspilotAiDecisions(options: {
  schoolId: string;
  studentId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<ClasspilotAiDecision[]> {
  const conditions: SQL[] = [eq(classpilotAiDecisions.schoolId, options.schoolId)];
  if (options.studentId) conditions.push(eq(classpilotAiDecisions.studentId, options.studentId));
  if (options.from) conditions.push(sql`${classpilotAiDecisions.createdAt} >= ${options.from}`);
  if (options.to) conditions.push(sql`${classpilotAiDecisions.createdAt} <= ${options.to}`);

  return db
    .select()
    .from(classpilotAiDecisions)
    .where(and(...conditions))
    .orderBy(desc(classpilotAiDecisions.createdAt))
    .limit(Math.min(options.limit || 100, 500));
}

export async function getClasspilotAiDecisionById(
  id: string,
  schoolId: string
): Promise<ClasspilotAiDecision | undefined> {
  const [row] = await db
    .select()
    .from(classpilotAiDecisions)
    .where(and(eq(classpilotAiDecisions.id, id), eq(classpilotAiDecisions.schoolId, schoolId)))
    .limit(1);
  return row;
}

export async function updateClasspilotAiDecisionReview(
  id: string,
  schoolId: string,
  data: {
    reviewStatus: string;
    reviewNote?: string | null;
    reviewedBy: string;
  }
): Promise<ClasspilotAiDecision | undefined> {
  const [row] = await db
    .update(classpilotAiDecisions)
    .set({
      reviewStatus: data.reviewStatus,
      reviewNote: data.reviewNote || null,
      reviewedBy: data.reviewedBy,
      reviewedAt: new Date(),
    })
    .where(and(eq(classpilotAiDecisions.id, id), eq(classpilotAiDecisions.schoolId, schoolId)))
    .returning();
  return row;
}

export async function createEvidenceArtifact(
  data: InsertEvidenceArtifact
): Promise<EvidenceArtifact> {
  const [row] = await db.insert(evidenceArtifacts).values(data).returning();
  return row!;
}

export async function getEvidenceArtifactById(
  id: string,
  schoolId: string
): Promise<EvidenceArtifact | undefined> {
  const [row] = await db
    .select()
    .from(evidenceArtifacts)
    .where(and(eq(evidenceArtifacts.id, id), eq(evidenceArtifacts.schoolId, schoolId)))
    .limit(1);
  return row;
}

export async function listEvidenceArtifactsForStudent(options: {
  schoolId: string;
  studentId: string;
  caseId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<EvidenceArtifact[]> {
  const conditions: SQL[] = [
    eq(evidenceArtifacts.schoolId, options.schoolId),
    eq(evidenceArtifacts.studentId, options.studentId),
  ];
  if (options.caseId) conditions.push(eq(evidenceArtifacts.caseId, options.caseId));
  if (options.from) conditions.push(sql`${evidenceArtifacts.capturedAt} >= ${options.from}`);
  if (options.to) conditions.push(sql`${evidenceArtifacts.capturedAt} <= ${options.to}`);

  return db
    .select()
    .from(evidenceArtifacts)
    .where(and(...conditions))
    .orderBy(desc(evidenceArtifacts.capturedAt))
    .limit(Math.min(options.limit || 100, 500));
}

// ============================================================================
// ClassPilot - One-day schedule changes
// ============================================================================

export type ClasspilotScheduleChangeStatus =
  | "pending_counterpart"
  | "pending_admin"
  | "approved"
  | "declined"
  | "denied"
  | "cancelled"
  | "expired"
  | "superseded";

export type ClasspilotScheduleChangeActor = {
  userId: string;
  role: "admin" | "school_admin" | "teacher" | "office_staff";
  userEmail?: string;
};

export type ClasspilotScheduleWindowDto = {
  startTime: string;
  endTime: string;
};

export type ClasspilotScheduleChangeClassDto = {
  id: string;
  name: string;
  primaryTeacher: { id: string; name: string };
  normalWindow: ClasspilotScheduleWindowDto;
};

export type ClasspilotScheduleChangePairDto = {
  id: string;
  status: "active" | "archived";
  revision: number;
  firstClass: ClasspilotScheduleChangeClassDto;
  secondClass: ClasspilotScheduleChangeClassDto;
  createdAt: string;
  updatedAt: string;
};

export type ClasspilotScheduleChangePolicyDto = {
  teacherRequestsEnabled: boolean;
  adminApprovalRequired: boolean;
  sameDayCutoff: string;
  sameDayCutoffEnforced: boolean;
  reasonRequired: boolean;
  schoolTimezone: string;
  revision: number;
};

export type ClasspilotScheduleChangeAllowedAction =
  | "accept"
  | "decline"
  | "approve"
  | "deny"
  | "withdraw"
  | "cancel";

export type ClasspilotScheduleChangeDto = {
  id: string;
  pairId: string;
  scheduledDate: string;
  schoolTimezone: string;
  status: ClasspilotScheduleChangeStatus;
  reason: string;
  revision: number;
  requestedBy: { id: string; name: string };
  nextActor: "counterpart_teacher" | "administrator" | null;
  legs: Array<{
    class: { id: string; name: string };
    primaryTeacher: { id: string; name: string };
    normalWindow: ClasspilotScheduleWindowDto;
    effectiveWindow: ClasspilotScheduleWindowDto;
  }>;
  allowedActions: ClasspilotScheduleChangeAllowedAction[];
  createdAt: string;
  updatedAt: string;
};

export type ClasspilotScheduleChangeBlocker = {
  code: string;
  message: string;
};

type ScheduleChangeDb = typeof db;
type StorageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScheduleChangePostCommitNotice = {
  schoolId: string;
  changeIds: string[];
};

const scheduleChangePostCommitCollectors = new WeakMap<
  object,
  Map<string, Set<string>>
>();

function recordScheduleChangePostCommitNotice(
  dbInstance: ScheduleChangeDb,
  schoolId: string,
  changeIds: string[]
): void {
  if (changeIds.length === 0) return;
  const collector = scheduleChangePostCommitCollectors.get(dbInstance as unknown as object);
  if (!collector) return;
  const ids = collector.get(schoolId) ?? new Set<string>();
  for (const id of changeIds) ids.add(id);
  collector.set(schoolId, ids);
}

function dispatchScheduleChangePostCommitNotices(
  notices: ScheduleChangePostCommitNotice[]
): void {
  for (const notice of notices) {
    void import("./classpilotScheduleChanges.js")
      .then(({ announceClasspilotScheduleChangeIds }) =>
        announceClasspilotScheduleChangeIds(notice)
      )
      .catch((error) => {
        console.warn(
          "[ClassPilot schedule changes] Post-commit notification failed:",
          (error as Error).message
        );
      });
  }
}

/**
 * Runs a configuration mutation and publishes automatic workflow transitions
 * only after PostgreSQL confirms the commit. Helpers called inside the
 * transaction register IDs against the transaction object; ordinary workflow
 * actions do not use this wrapper because their routes announce explicitly.
 */
export async function withClasspilotSchedulePostCommitTransaction<T>(
  operation: (tx: StorageTransaction) => Promise<T>,
  dbInstance: typeof db = db
): Promise<T> {
  const committed = await dbInstance.transaction(async (rawTx) => {
    const tx = rawTx as unknown as StorageTransaction;
    const key = rawTx as unknown as object;
    const collector = new Map<string, Set<string>>();
    scheduleChangePostCommitCollectors.set(key, collector);
    try {
      const value = await operation(tx);
      const notices = [...collector.entries()].map(([schoolId, ids]) => ({
        schoolId,
        changeIds: [...ids].sort(),
      }));
      return { value, notices };
    } finally {
      scheduleChangePostCommitCollectors.delete(key);
    }
  });
  dispatchScheduleChangePostCommitNotices(committed.notices);
  return committed.value;
}

/**
 * Called by alternate school-settings writers after they lock the school row.
 * It acquires the shared class-configuration lock, rejects a timezone change
 * while an approved occurrence remains outstanding, and supersedes pending
 * requests atomically with the caller's school update.
 */
export async function guardClasspilotScheduleChangesForSchoolTimezoneChange(
  options: {
    schoolId: string;
    currentTimezone: string;
    nextTimezone: string;
    actorId?: string | null;
    now?: Date;
    dbInstance: ScheduleChangeDb;
  }
): Promise<string[]> {
  await takeClasspilotScheduleConfigLock(options.dbInstance, options.schoolId);
  if (options.currentTimezone === options.nextTimezone) return [];
  const now = options.now ?? new Date();
  return reconcileClasspilotScheduleChangesForEntitlementRemoval({
    schoolId: options.schoolId,
    actorId: options.actorId,
    validUntil: now,
    affectedWhen: "ends_after",
    reasonCode: "school_timezone_changed",
    approvedMessage:
      "Cancel approved future schedule changes before changing the school timezone.",
    now,
    dbInstance: options.dbInstance,
  });
}

const CP_SCHEDULE_CHANGE_PENDING_STATUSES = [
  "pending_counterpart",
  "pending_admin",
] as const;
const CP_SCHEDULE_CHANGE_ACTIVE_STATUSES = [
  ...CP_SCHEDULE_CHANGE_PENDING_STATUSES,
  "approved",
] as const;
const CP_SCHEDULE_CHANGE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CP_SCHEDULE_CHANGE_NO_REASON = "No reason provided.";

/**
 * Serializes every school-scoped class configuration, assignment, and
 * schedule-change approval write. Keeping the established PassPilot lock key
 * avoids introducing a second lock domain around the same official classes.
 */
async function takeClasspilotScheduleConfigLock(
  dbInstance: ScheduleChangeDb,
  schoolId: string
): Promise<void> {
  await dbInstance.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${schoolId}`}))`
  );
}

async function lockClasspilotScheduleChangeSchool(
  schoolId: string,
  dbInstance: ScheduleChangeDb
): Promise<string> {
  const [school] = await dbInstance
    .select({ schoolTimezone: schools.schoolTimezone })
    .from(schools)
    .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
    .limit(1)
    .for("update");
  if (!school) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SCHOOL_UNAVAILABLE",
      "School settings are unavailable.",
      404
    );
  }
  return school.schoolTimezone || "America/New_York";
}

export async function assertActiveClasspilotScheduleChangeEntitlement(options: {
  schoolId: string;
  now?: Date;
  /** Entitlement must remain valid strictly beyond this event instant. */
  through?: Date;
  dbInstance?: ScheduleChangeDb;
}): Promise<void> {
  const dbInstance = options.dbInstance ?? db;
  const now = options.now ?? new Date();
  const requiredThrough = options.through && options.through > now
    ? options.through
    : now;
  const [school] = await dbInstance
    .select({
      status: schools.status,
      isActive: schools.isActive,
      planStatus: schools.planStatus,
      activeUntil: schools.activeUntil,
      disabledAt: schools.disabledAt,
    })
    .from(schools)
    .where(and(eq(schools.id, options.schoolId), isNull(schools.deletedAt)))
    .limit(1)
    .for("update");
  const schoolEntitled = Boolean(
    school &&
      school.status === "active" &&
      school.isActive &&
      school.planStatus !== "canceled" &&
      !school.disabledAt &&
      (!school.activeUntil || school.activeUntil.getTime() > requiredThrough.getTime())
  );
  if (!schoolEntitled) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SCHOOL_INACTIVE",
      "This school is not active for ClassPilot schedule changes.",
      409
    );
  }
  const [license] = await dbInstance
    .select({ id: productLicenses.id })
    .from(productLicenses)
    .where(
      and(
        eq(productLicenses.schoolId, options.schoolId),
        eq(productLicenses.product, "CLASSPILOT"),
        eq(productLicenses.status, "active"),
        or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, requiredThrough))!
      )
    )
    .limit(1)
    .for("update");
  if (!license) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_LICENSE_REQUIRED",
      "An active ClassPilot license is required for schedule changes.",
      409
    );
  }
}

async function reconcileClasspilotScheduleChangesForEntitlementRemoval(options: {
  schoolId: string;
  actorId?: string | null;
  validUntil?: Date | null;
  affectedWhen?: "starts_at_or_after" | "ends_after" | "ends_at_or_after";
  reasonCode?: string;
  approvedMessage?: string;
  now?: Date;
  dbInstance: ScheduleChangeDb;
}): Promise<string[]> {
  const now = options.now ?? new Date();
  const policy = await getClasspilotScheduleChangeSettings(
    options.schoolId,
    options.dbInstance
  );
  const timezone = policy?.schoolTimezone || "America/New_York";
  const rows = await options.dbInstance
    .select({
      id: classpilotScheduleChanges.id,
      status: classpilotScheduleChanges.status,
      scheduledDate: classpilotScheduleChanges.scheduledDate,
      effectiveStartTime: classpilotScheduleChangeLegs.effectiveStartTime,
      effectiveEndTime: classpilotScheduleChangeLegs.effectiveEndTime,
    })
    .from(classpilotScheduleChanges)
    .innerJoin(
      classpilotScheduleChangeLegs,
      and(
        eq(classpilotScheduleChangeLegs.schoolId, classpilotScheduleChanges.schoolId),
        eq(classpilotScheduleChangeLegs.scheduleChangeId, classpilotScheduleChanges.id)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_ACTIVE_STATUSES]),
        eq(classpilotScheduleChanges.reservationActive, true),
        eq(classpilotScheduleChangeLegs.reservationActive, true)
      )
    )
    .orderBy(asc(classpilotScheduleChanges.id))
    .for("update");
  const byId = new Map<string, typeof rows>();
  for (const row of rows) {
    const values = byId.get(row.id) ?? [];
    values.push(row);
    byId.set(row.id, values);
  }
  const affected = [...byId.entries()].filter(([, legs]) => {
    const cutoff = options.validUntil ?? now;
    const affectedWhen = options.affectedWhen ?? "ends_at_or_after";
    if (affectedWhen === "ends_after" || affectedWhen === "ends_at_or_after") {
      const latest = legs.map((leg) => leg.effectiveEndTime).sort().at(-1);
      if (!latest) return true;
      const endsAt = localDateTimeUtc(legs[0]!.scheduledDate, latest, timezone);
      return affectedWhen === "ends_after"
        ? endsAt.getTime() > cutoff.getTime()
        : endsAt.getTime() >= cutoff.getTime();
    }
    const earliest = legs.map((leg) => leg.effectiveStartTime).sort()[0];
    if (!earliest) return true;
    return localDateTimeUtc(legs[0]!.scheduledDate, earliest, timezone).getTime() >=
      cutoff.getTime();
  });
  if (affected.some(([, legs]) => legs[0]?.status === "approved")) {
    throw scheduleChangeError(
      "APPROVED_SCHEDULE_CHANGE_EXISTS",
      options.approvedMessage ||
        "Cancel approved future schedule changes before removing ClassPilot access.",
      409
    );
  }
  const reasonCode = options.reasonCode && /^[a-z0-9_]{1,100}$/.test(options.reasonCode)
    ? options.reasonCode
    : "classpilot_entitlement_removed";
  const pendingIds = affected
    .filter(([, legs]) =>
      CP_SCHEDULE_CHANGE_PENDING_STATUSES.includes(
        legs[0]?.status as (typeof CP_SCHEDULE_CHANGE_PENDING_STATUSES)[number]
      )
    )
    .map(([id]) => id)
    .sort();
  if (pendingIds.length === 0) return [];
  await options.dbInstance
    .update(classpilotScheduleChanges)
    .set({
      status: "superseded",
      reservationActive: false,
      terminalByUserId: options.actorId ?? null,
      terminalReason: reasonCode,
      terminalAt: now,
      revision: sql`${classpilotScheduleChanges.revision} + 1`,
      updatedAt: now,
    })
    .where(inArray(classpilotScheduleChanges.id, pendingIds));
  await releaseScheduleChangeReservations(pendingIds, options.dbInstance);
  for (const id of pendingIds) {
    await options.dbInstance.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actorId ?? null,
      action: "classpilot.schedule_change.superseded",
      entityType: "classpilot_schedule_change",
      entityId: id,
      changes: { status: "superseded" },
      metadata: { reasonCode },
    });
  }
  recordScheduleChangePostCommitNotice(
    options.dbInstance,
    options.schoolId,
    pendingIds
  );
  return pendingIds;
}

function scheduleChangeError(
  code: string,
  message: string,
  status = 400
): Error & { code: string; status: number; expose: true } {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: true as const,
  });
}

function isClasspilotScheduleChangeEntitlementError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "SCHEDULE_CHANGE_SCHOOL_INACTIVE" ||
    code === "SCHEDULE_CHANGE_LICENSE_REQUIRED";
}

function scheduleChangeDisplayName(value: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
} | undefined): string {
  if (!value) return "Staff member";
  const direct = value.displayName?.trim();
  if (direct) return direct;
  const composed = [value.firstName, value.lastName].filter(Boolean).join(" ").trim();
  return composed || value.email?.trim() || "Staff member";
}

function scheduleChangeMinutes(value: string): number {
  if (!CP_SCHEDULE_CHANGE_TIME_PATTERN.test(value)) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_TIME",
      "Class schedules must use HH:MM times."
    );
  }
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function windowsOverlap(
  first: ClasspilotScheduleWindowDto,
  second: ClasspilotScheduleWindowDto
): boolean {
  return first.startTime < second.endTime && first.endTime > second.startTime;
}

function normalizePairGroupIds(firstGroupId: string, secondGroupId: string): [string, string] {
  if (!firstGroupId || !secondGroupId || firstGroupId === secondGroupId) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_PAIR",
      "Select two different classes."
    );
  }
  return firstGroupId < secondGroupId
    ? [firstGroupId, secondGroupId]
    : [secondGroupId, firstGroupId];
}

export async function getClasspilotScheduleChangeSettings(
  schoolId: string,
  dbInstance: ScheduleChangeDb = db
): Promise<ClasspilotScheduleChangePolicyDto | undefined> {
  const [row] = await dbInstance
    .select({
      teacherRequestsEnabled:
        settings.classpilotScheduleChangesTeacherRequestsEnabled,
      adminApprovalRequired:
        settings.classpilotScheduleChangesAdminApprovalRequired,
      sameDayCutoff: settings.classpilotScheduleChangesSameDayCutoff,
      sameDayCutoffEnforced:
        settings.classpilotScheduleChangesSameDayCutoffEnforced,
      reasonRequired: settings.classpilotScheduleChangesReasonRequired,
      revision: settings.classpilotScheduleChangesRevision,
      schoolTimezone: schools.schoolTimezone,
    })
    .from(settings)
    .innerJoin(schools, eq(schools.id, settings.schoolId))
    .where(and(eq(settings.schoolId, schoolId), isNull(schools.deletedAt)))
    .limit(1);
  return row
    ? {
        teacherRequestsEnabled: row.teacherRequestsEnabled,
        adminApprovalRequired: row.adminApprovalRequired,
        sameDayCutoff: row.sameDayCutoff,
        sameDayCutoffEnforced: row.sameDayCutoffEnforced,
        reasonRequired: row.reasonRequired,
        schoolTimezone: row.schoolTimezone || "America/New_York",
        revision: row.revision,
      }
    : undefined;
}

async function lockClasspilotScheduleChangeSettingsRow(
  schoolId: string,
  dbInstance: ScheduleChangeDb
): Promise<string> {
  const [locked] = await dbInstance
    .select({ id: settings.id })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1)
    .for("update");
  if (!locked) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
      "Schedule-change settings are unavailable.",
      500
    );
  }
  return locked.id;
}

export type UpdateClasspilotScheduleChangeSettingsResult =
  | { status: "saved"; current: ClasspilotScheduleChangePolicyDto; changedFields: string[] }
  | { status: "conflict"; current: ClasspilotScheduleChangePolicyDto };

export async function updateClasspilotScheduleChangeSettings(options: {
  schoolId: string;
  expectedRevision: number;
  patch: {
    teacherRequestsEnabled?: boolean;
    adminApprovalRequired?: boolean;
    sameDayCutoff?: string;
    sameDayCutoffEnforced?: boolean;
    reasonRequired?: boolean;
  };
  actor: ClasspilotScheduleChangeActor;
}): Promise<UpdateClasspilotScheduleChangeSettingsResult> {
  if (
    options.patch.sameDayCutoffEnforced !== undefined &&
    typeof options.patch.sameDayCutoffEnforced !== "boolean"
  ) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_CUTOFF_POLICY",
      "sameDayCutoffEnforced must be boolean."
    );
  }
  if (
    options.patch.reasonRequired !== undefined &&
    typeof options.patch.reasonRequired !== "boolean"
  ) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_REASON_POLICY",
      "reasonRequired must be boolean."
    );
  }
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as ScheduleChangeDb;
    await lockClasspilotScheduleChangeSchool(options.schoolId, transactionDb);
    await takeClasspilotScheduleConfigLock(transactionDb, options.schoolId);
    const lockedSettingsId = await lockClasspilotScheduleChangeSettingsRow(
      options.schoolId,
      transactionDb
    );
    const current = await getClasspilotScheduleChangeSettings(
      options.schoolId,
      transactionDb
    );
    if (!current) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
        "Schedule-change settings are unavailable.",
        500
      );
    }
    if (current.revision !== options.expectedRevision) {
      return { status: "conflict" as const, current };
    }
    const nextTeacherRequests =
      options.patch.teacherRequestsEnabled ?? current.teacherRequestsEnabled;
    const nextAdminApproval =
      options.patch.adminApprovalRequired ?? current.adminApprovalRequired;
    const nextCutoff = options.patch.sameDayCutoff ?? current.sameDayCutoff;
    const nextCutoffEnforced =
      options.patch.sameDayCutoffEnforced ?? current.sameDayCutoffEnforced;
    const nextReasonRequired =
      options.patch.reasonRequired ?? current.reasonRequired;
    if (!CP_SCHEDULE_CHANGE_TIME_PATTERN.test(nextCutoff)) {
      throw scheduleChangeError(
        "INVALID_SCHEDULE_CHANGE_CUTOFF",
        "The same-day cutoff must use HH:MM format."
      );
    }
    const changedFields: string[] = [];
    if (nextTeacherRequests !== current.teacherRequestsEnabled) {
      changedFields.push("teacherRequestsEnabled");
    }
    if (nextAdminApproval !== current.adminApprovalRequired) {
      changedFields.push("adminApprovalRequired");
    }
    if (nextCutoff !== current.sameDayCutoff) changedFields.push("sameDayCutoff");
    if (nextCutoffEnforced !== current.sameDayCutoffEnforced) {
      changedFields.push("sameDayCutoffEnforced");
    }
    if (nextReasonRequired !== current.reasonRequired) {
      changedFields.push("reasonRequired");
    }
    const nextRevision = current.revision + 1;
    await tx
      .update(settings)
      .set({
        classpilotScheduleChangesTeacherRequestsEnabled: nextTeacherRequests,
        classpilotScheduleChangesAdminApprovalRequired: nextAdminApproval,
        classpilotScheduleChangesSameDayCutoff: nextCutoff,
        classpilotScheduleChangesSameDayCutoffEnforced: nextCutoffEnforced,
        classpilotScheduleChangesReasonRequired: nextReasonRequired,
        classpilotScheduleChangesRevision: nextRevision,
      })
      .where(eq(settings.schoolId, options.schoolId));
    await tx.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actor.userId,
      userEmail: options.actor.userEmail ?? null,
      userRole: options.actor.role,
      action: "classpilot.schedule_change.settings_updated",
      entityType: "settings",
      entityId: lockedSettingsId,
      changes: { fields: changedFields },
      metadata: { revision: nextRevision },
    });
    return {
      status: "saved" as const,
      changedFields,
      current: {
        teacherRequestsEnabled: nextTeacherRequests,
        adminApprovalRequired: nextAdminApproval,
        sameDayCutoff: nextCutoff,
        sameDayCutoffEnforced: nextCutoffEnforced,
        reasonRequired: nextReasonRequired,
        schoolTimezone: current.schoolTimezone,
        revision: nextRevision,
      },
    };
  });
}

type LockedScheduleChangeGroup = Pick<
  Group,
  | "id"
  | "schoolId"
  | "teacherId"
  | "name"
  | "groupType"
  | "status"
  | "scheduleEnabled"
  | "blockStartTime"
  | "blockEndTime"
>;

async function lockScheduleChangeGroups(
  schoolId: string,
  groupIds: string[],
  dbInstance: ScheduleChangeDb
): Promise<LockedScheduleChangeGroup[]> {
  const uniqueIds = Array.from(new Set(groupIds)).sort();
  if (uniqueIds.length === 0) return [];
  return dbInstance
    .select({
      id: groups.id,
      schoolId: groups.schoolId,
      teacherId: groups.teacherId,
      name: groups.name,
      groupType: groups.groupType,
      status: groups.status,
      scheduleEnabled: groups.scheduleEnabled,
      blockStartTime: groups.blockStartTime,
      blockEndTime: groups.blockEndTime,
    })
    .from(groups)
    .where(and(eq(groups.schoolId, schoolId), inArray(groups.id, uniqueIds)))
    .orderBy(asc(groups.id))
    .for("update");
}

async function assertScheduleChangePairGroups(
  schoolId: string,
  pairGroups: LockedScheduleChangeGroup[],
  dbInstance: ScheduleChangeDb
): Promise<void> {
  if (pairGroups.length !== 2 || pairGroups.some((group) => group.schoolId !== schoolId)) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_CLASS_NOT_FOUND",
      "One or more classes are unavailable.",
      404
    );
  }
  for (const group of pairGroups) {
    if (
      group.status !== "active" ||
      group.groupType !== "admin_class" ||
      !group.scheduleEnabled ||
      !group.blockStartTime ||
      !group.blockEndTime
    ) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_CLASS_INELIGIBLE",
        "Both classes must be active, scheduled official classes.",
        409
      );
    }
  }
  if (pairGroups[0]!.teacherId === pairGroups[1]!.teacherId) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_DISTINCT_TEACHERS_REQUIRED",
      "The classes must have different primary teachers.",
      409
    );
  }
  const firstWindow = {
    startTime: pairGroups[0]!.blockStartTime!,
    endTime: pairGroups[0]!.blockEndTime!,
  };
  const secondWindow = {
    startTime: pairGroups[1]!.blockStartTime!,
    endTime: pairGroups[1]!.blockEndTime!,
  };
  const firstDuration =
    scheduleChangeMinutes(firstWindow.endTime) - scheduleChangeMinutes(firstWindow.startTime);
  const secondDuration =
    scheduleChangeMinutes(secondWindow.endTime) - scheduleChangeMinutes(secondWindow.startTime);
  if (firstDuration <= 0 || firstDuration !== secondDuration) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_DURATION_MISMATCH",
      "The two class periods must have the same duration.",
      409
    );
  }
  if (windowsOverlap(firstWindow, secondWindow)) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_WINDOWS_OVERLAP",
      "The two regular class periods must not overlap.",
      409
    );
  }
  const teacherIds = pairGroups.map((group) => group.teacherId);
  const memberships = await dbInstance
    .select({ userId: schoolMemberships.userId, role: schoolMemberships.role })
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.userId, teacherIds),
        inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"])
      )
    );
  if (new Set(memberships.map((membership) => membership.userId)).size !== 2) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_TEACHER_INELIGIBLE",
      "Both primary teachers must have active staff memberships.",
      409
    );
  }
}

async function loadScheduleChangePairDto(
  pair: ClasspilotScheduleChangePair,
  dbInstance: ScheduleChangeDb
): Promise<ClasspilotScheduleChangePairDto | undefined> {
  const groupRows = await dbInstance
    .select({
      id: groups.id,
      name: groups.name,
      teacherId: groups.teacherId,
      startTime: groups.blockStartTime,
      endTime: groups.blockEndTime,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(groups)
    .innerJoin(users, eq(users.id, groups.teacherId))
    .where(
      and(
        eq(groups.schoolId, pair.schoolId),
        inArray(groups.id, [pair.firstGroupId, pair.secondGroupId])
      )
    );
  const byId = new Map(groupRows.map((row) => [row.id, row]));
  const first = byId.get(pair.firstGroupId);
  const second = byId.get(pair.secondGroupId);
  if (!first?.startTime || !first.endTime || !second?.startTime || !second.endTime) {
    return undefined;
  }
  const toClass = (group: typeof first): ClasspilotScheduleChangeClassDto => ({
    id: group.id,
    name: group.name,
    primaryTeacher: {
      id: group.teacherId,
      name: scheduleChangeDisplayName(group),
    },
    normalWindow: { startTime: group.startTime!, endTime: group.endTime! },
  });
  return {
    id: pair.id,
    status: pair.status as "active" | "archived",
    revision: pair.revision,
    firstClass: toClass(first),
    secondClass: toClass(second),
    createdAt: pair.createdAt.toISOString(),
    updatedAt: pair.updatedAt.toISOString(),
  };
}

async function scheduleChangeVisibleGroupIds(
  schoolId: string,
  actor: ClasspilotScheduleChangeActor,
  dbInstance: ScheduleChangeDb
): Promise<Set<string> | null> {
  if (actor.role === "admin" || actor.role === "school_admin" || actor.role === "office_staff") {
    return null;
  }
  const rows = await dbInstance
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        or(eq(groups.teacherId, actor.userId), eq(groupTeachers.teacherId, actor.userId))!
      )
    );
  return new Set(rows.map((row) => row.id));
}

export async function listClasspilotScheduleChangePairs(options: {
  schoolId: string;
  actor: ClasspilotScheduleChangeActor;
  includeArchived?: boolean;
  dbInstance?: ScheduleChangeDb;
}): Promise<ClasspilotScheduleChangePairDto[]> {
  const dbInstance = options.dbInstance ?? db;
  const conditions: SQL[] = [eq(classpilotScheduleChangePairs.schoolId, options.schoolId)];
  if (!options.includeArchived) {
    conditions.push(eq(classpilotScheduleChangePairs.status, "active"));
  }
  const [pairs, visibleGroups] = await Promise.all([
    dbInstance
      .select()
      .from(classpilotScheduleChangePairs)
      .where(and(...conditions))
      .orderBy(asc(classpilotScheduleChangePairs.createdAt)),
    scheduleChangeVisibleGroupIds(options.schoolId, options.actor, dbInstance),
  ]);
  const visiblePairs = visibleGroups
    ? pairs.filter(
        (pair) =>
          visibleGroups.has(pair.firstGroupId) || visibleGroups.has(pair.secondGroupId)
      )
    : pairs;
  const hydrated = await Promise.all(
    visiblePairs.map((pair) => loadScheduleChangePairDto(pair, dbInstance))
  );
  return hydrated.filter((pair): pair is ClasspilotScheduleChangePairDto => Boolean(pair));
}

export async function createClasspilotScheduleChangePair(options: {
  schoolId: string;
  firstGroupId: string;
  secondGroupId: string;
  actor: ClasspilotScheduleChangeActor;
}): Promise<ClasspilotScheduleChangePair> {
  const [firstGroupId, secondGroupId] = normalizePairGroupIds(
    options.firstGroupId,
    options.secondGroupId
  );
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as ScheduleChangeDb;
    await lockClasspilotScheduleChangeSchool(options.schoolId, transactionDb);
    await takeClasspilotScheduleConfigLock(transactionDb, options.schoolId);
    await assertActiveClasspilotScheduleChangeEntitlement({
      schoolId: options.schoolId,
      dbInstance: transactionDb,
    });
    const pairGroups = await lockScheduleChangeGroups(
      options.schoolId,
      [firstGroupId, secondGroupId],
      transactionDb
    );
    await assertScheduleChangePairGroups(options.schoolId, pairGroups, transactionDb);
    const [existing] = await tx
      .select()
      .from(classpilotScheduleChangePairs)
      .where(
        and(
          eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
          eq(classpilotScheduleChangePairs.firstGroupId, firstGroupId),
          eq(classpilotScheduleChangePairs.secondGroupId, secondGroupId)
        )
      )
      .limit(1)
      .for("update");
    const now = new Date();
    let saved: ClasspilotScheduleChangePair;
    if (existing?.status === "active") {
      return existing;
    }
    if (existing) {
      const [reactivated] = await tx
        .update(classpilotScheduleChangePairs)
        .set({
          status: "active",
          revision: existing.revision + 1,
          archivedAt: null,
          archivedBy: null,
          updatedAt: now,
        })
        .where(eq(classpilotScheduleChangePairs.id, existing.id))
        .returning();
      saved = reactivated!;
    } else {
      const [created] = await tx
        .insert(classpilotScheduleChangePairs)
        .values({
          schoolId: options.schoolId,
          firstGroupId,
          secondGroupId,
          createdBy: options.actor.userId,
        })
        .returning();
      saved = created!;
    }
    await tx.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actor.userId,
      userEmail: options.actor.userEmail ?? null,
      userRole: options.actor.role,
      action: "classpilot.schedule_change.pair_enabled",
      entityType: "classpilot_schedule_change_pair",
      entityId: saved.id,
      changes: { status: "active" },
      metadata: { revision: saved.revision },
    });
    return saved;
  });
}

async function releaseScheduleChangeReservations(
  scheduleChangeIds: string[],
  dbInstance: ScheduleChangeDb
): Promise<void> {
  if (scheduleChangeIds.length === 0) return;
  await dbInstance
    .update(classpilotScheduleChangeLegs)
    .set({ reservationActive: false })
    .where(
      and(
        inArray(classpilotScheduleChangeLegs.scheduleChangeId, scheduleChangeIds),
        eq(classpilotScheduleChangeLegs.reservationActive, true)
      )
    );
}

export type ArchiveClasspilotScheduleChangePairResult =
  | { status: "saved"; pair: ClasspilotScheduleChangePair }
  | { status: "conflict"; pair: ClasspilotScheduleChangePair }
  | { status: "not_found" };

export async function archiveClasspilotScheduleChangePair(options: {
  schoolId: string;
  pairId: string;
  expectedRevision: number;
  actor: ClasspilotScheduleChangeActor;
}): Promise<ArchiveClasspilotScheduleChangePairResult> {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    await lockClasspilotScheduleChangeSchool(
      options.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    await takeClasspilotScheduleConfigLock(
      tx as unknown as ScheduleChangeDb,
      options.schoolId
    );
    const [pair] = await tx
      .select()
      .from(classpilotScheduleChangePairs)
      .where(
        and(
          eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
          eq(classpilotScheduleChangePairs.id, options.pairId)
        )
      )
      .limit(1)
      .for("update");
    if (!pair) return { status: "not_found" as const };
    if (pair.revision !== options.expectedRevision) {
      return { status: "conflict" as const, pair };
    }
    if (pair.status === "archived") return { status: "saved" as const, pair };
    const approvedRows = await tx
      .select({
        scheduledDate: classpilotScheduleChanges.scheduledDate,
        effectiveEndTime: classpilotScheduleChangeLegs.effectiveEndTime,
      })
      .from(classpilotScheduleChanges)
      .innerJoin(
        classpilotScheduleChangeLegs,
        and(
          eq(classpilotScheduleChangeLegs.scheduleChangeId, classpilotScheduleChanges.id),
          eq(classpilotScheduleChangeLegs.schoolId, classpilotScheduleChanges.schoolId)
        )
      )
      .where(
        and(
          eq(classpilotScheduleChanges.schoolId, options.schoolId),
          eq(classpilotScheduleChanges.pairId, pair.id),
          eq(classpilotScheduleChanges.status, "approved")
        )
      );
    const currentPolicy = await getClasspilotScheduleChangeSettings(
      options.schoolId,
      tx as unknown as ScheduleChangeDb
    );
    const currentTimezone = currentPolicy?.schoolTimezone || "America/New_York";
    if (
      approvedRows.some(
        (row) =>
          localDateTimeUtc(row.scheduledDate, row.effectiveEndTime, currentTimezone).getTime() >
          Date.now()
      )
    ) {
      throw scheduleChangeError(
        "APPROVED_SCHEDULE_CHANGE_EXISTS",
        "Cancel approved future schedule changes before removing this eligible pair.",
        409
      );
    }
    const now = new Date();
    const pending = await tx
      .select({ id: classpilotScheduleChanges.id })
      .from(classpilotScheduleChanges)
      .where(
        and(
          eq(classpilotScheduleChanges.schoolId, options.schoolId),
          eq(classpilotScheduleChanges.pairId, pair.id),
          inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES])
        )
      )
      .for("update");
    const pendingIds = pending.map((change) => change.id);
    if (pendingIds.length > 0) {
      await tx
        .update(classpilotScheduleChanges)
        .set({
          status: "superseded",
          reservationActive: false,
          terminalByUserId: options.actor.userId,
          terminalReason: "eligible_pair_removed",
          terminalAt: now,
          revision: sql`${classpilotScheduleChanges.revision} + 1`,
          updatedAt: now,
        })
        .where(inArray(classpilotScheduleChanges.id, pendingIds));
      await releaseScheduleChangeReservations(
        pendingIds,
        tx as unknown as ScheduleChangeDb
      );
      await tx.insert(auditLogs).values(
        pendingIds.map((changeId) => ({
          schoolId: options.schoolId,
          userId: options.actor.userId,
          userEmail: options.actor.userEmail ?? null,
          userRole: options.actor.role,
          action: "classpilot.schedule_change.superseded",
          entityType: "classpilot_schedule_change",
          entityId: changeId,
          changes: { status: "superseded" },
          metadata: { reasonCode: "eligible_pair_removed" },
        }))
      );
      recordScheduleChangePostCommitNotice(
        tx as unknown as ScheduleChangeDb,
        options.schoolId,
        pendingIds
      );
    }
    const [saved] = await tx
      .update(classpilotScheduleChangePairs)
      .set({
        status: "archived",
        archivedBy: options.actor.userId,
        archivedAt: now,
        revision: pair.revision + 1,
        updatedAt: now,
      })
      .where(eq(classpilotScheduleChangePairs.id, pair.id))
      .returning();
    await tx.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actor.userId,
      userEmail: options.actor.userEmail ?? null,
      userRole: options.actor.role,
      action: "classpilot.schedule_change.pair_archived",
      entityType: "classpilot_schedule_change_pair",
      entityId: pair.id,
      changes: { status: "archived" },
      metadata: {
        revision: saved!.revision,
        supersededRequestCount: pendingIds.length,
      },
    });
    return { status: "saved" as const, pair: saved! };
  });
}

export type ApprovedClasspilotScheduleChangeLeg = {
  swapId: string;
  groupId: string;
  effectiveStartTime: string;
  effectiveEndTime: string;
};

export async function loadApprovedScheduleChangeLegsForSchoolDate(options: {
  schoolId: string;
  scheduledDate: string;
  dbInstance?: ScheduleChangeDb;
}): Promise<ApprovedClasspilotScheduleChangeLeg[]> {
  const dbInstance = options.dbInstance ?? db;
  const approvedChanges = await dbInstance
    .select({
      swapId: classpilotScheduleChanges.id,
      pairId: classpilotScheduleChanges.pairId,
      firstGroupId: classpilotScheduleChangePairs.firstGroupId,
      secondGroupId: classpilotScheduleChangePairs.secondGroupId,
      pairStatus: classpilotScheduleChangePairs.status,
    })
    .from(classpilotScheduleChanges)
    .leftJoin(
      classpilotScheduleChangePairs,
      and(
        eq(classpilotScheduleChangePairs.id, classpilotScheduleChanges.pairId),
        eq(classpilotScheduleChangePairs.schoolId, classpilotScheduleChanges.schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.scheduledDate, options.scheduledDate),
        eq(classpilotScheduleChanges.status, "approved"),
        eq(classpilotScheduleChanges.reservationActive, true)
      )
    )
    .orderBy(asc(classpilotScheduleChanges.id));
  if (approvedChanges.length === 0) return [];
  const legs = await dbInstance
    .select()
    .from(classpilotScheduleChangeLegs)
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.scheduledDate, options.scheduledDate),
        inArray(
          classpilotScheduleChangeLegs.scheduleChangeId,
          approvedChanges.map((change) => change.swapId)
        )
      )
    )
    .orderBy(
      asc(classpilotScheduleChangeLegs.scheduleChangeId),
      asc(classpilotScheduleChangeLegs.legOrder)
    );
  const reservedGroupIds = new Set<string>();
  for (const change of approvedChanges) {
    const changeLegs = legs.filter((leg) => leg.scheduleChangeId === change.swapId);
    const expectedGroupIds = [change.firstGroupId, change.secondGroupId]
      .filter((id): id is string => Boolean(id))
      .sort();
    const actualGroupIds = changeLegs.map((leg) => leg.groupId).sort();
    if (
      change.pairStatus !== "active" ||
      expectedGroupIds.length !== 2 ||
      changeLegs.length !== 2 ||
      changeLegs.some((leg) => !leg.reservationActive) ||
      expectedGroupIds.some((id, index) => actualGroupIds[index] !== id)
    ) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_EXECUTION_INVALID",
        "The approved schedule change is no longer safe to execute.",
        409
      );
    }
    for (const groupId of actualGroupIds) {
      if (reservedGroupIds.has(groupId)) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_EXECUTION_INVALID",
          "The approved schedule change is no longer safe to execute.",
          409
        );
      }
      reservedGroupIds.add(groupId);
    }
  }
  return legs.map((leg) => ({
    swapId: leg.scheduleChangeId,
    groupId: leg.groupId,
    effectiveStartTime: leg.effectiveStartTime,
    effectiveEndTime: leg.effectiveEndTime,
  }));
}

export async function lockAndLoadEffectiveClasspilotScheduleContext(options: {
  schoolId: string;
  groupId: string;
  scheduledDate: string;
  dbInstance: ScheduleChangeDb;
}): Promise<{
  group: Group;
  schoolTimezone: string;
  effectiveLeg?: {
    swapId: string;
    effectiveStartTime: string;
    effectiveEndTime: string;
  };
  lockedGroupIds: string[];
} | null> {
  const schoolTimezone = await lockClasspilotScheduleChangeSchool(
    options.schoolId,
    options.dbInstance
  );
  await takeClasspilotScheduleConfigLock(options.dbInstance, options.schoolId);
  try {
    await assertActiveClasspilotScheduleChangeEntitlement({
      schoolId: options.schoolId,
      dbInstance: options.dbInstance,
    });
  } catch {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_EXECUTION_INVALID",
      "The approved schedule change is no longer safe to execute.",
      409
    );
  }
  const [candidateChange] = await options.dbInstance
    .select({
      swapId: classpilotScheduleChanges.id,
      firstGroupId: classpilotScheduleChangePairs.firstGroupId,
      secondGroupId: classpilotScheduleChangePairs.secondGroupId,
    })
    .from(classpilotScheduleChanges)
    .leftJoin(
      classpilotScheduleChangePairs,
      and(
        eq(classpilotScheduleChangePairs.id, classpilotScheduleChanges.pairId),
        eq(classpilotScheduleChangePairs.schoolId, classpilotScheduleChanges.schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.scheduledDate, options.scheduledDate),
        eq(classpilotScheduleChanges.status, "approved"),
        eq(classpilotScheduleChanges.reservationActive, true),
        or(
          eq(classpilotScheduleChangePairs.firstGroupId, options.groupId),
          eq(classpilotScheduleChangePairs.secondGroupId, options.groupId)
        )!
      )
    )
    .limit(1);
  const groupIds = candidateChange
    ? [candidateChange.firstGroupId, candidateChange.secondGroupId].filter(
        (id): id is string => Boolean(id)
      )
    : [options.groupId];
  const lockedGroupIds = Array.from(new Set(groupIds)).sort();
  const lockedGroups = await options.dbInstance
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, options.schoolId),
        inArray(groups.id, lockedGroupIds)
      )
    )
    .orderBy(asc(groups.id))
    .for("update");
  const group = lockedGroups.find((row) => row.id === options.groupId);
  if (!group) return null;
  // Approval/cancellation shares the caller's school/date lock, while class
  // configuration writes share these group locks. Re-read after waiting so a
  // stale pre-lock candidate can never create an occurrence at the old window.
  const approved = await loadApprovedScheduleChangeLegsForSchoolDate({
    schoolId: options.schoolId,
    scheduledDate: options.scheduledDate,
    dbInstance: options.dbInstance,
  });
  const authoritative = approved.find((leg) => leg.groupId === options.groupId);
  if (authoritative) {
    try {
      const [approvedChange] = await options.dbInstance
        .select()
        .from(classpilotScheduleChanges)
        .where(
          and(
            eq(classpilotScheduleChanges.schoolId, options.schoolId),
            eq(classpilotScheduleChanges.id, authoritative.swapId),
            eq(classpilotScheduleChanges.scheduledDate, options.scheduledDate),
            eq(classpilotScheduleChanges.status, "approved"),
            eq(classpilotScheduleChanges.reservationActive, true)
          )
        )
        .limit(1);
      const [pair, legs] = approvedChange
        ? await Promise.all([
            options.dbInstance
              .select()
              .from(classpilotScheduleChangePairs)
              .where(
                and(
                  eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
                  eq(classpilotScheduleChangePairs.id, approvedChange.pairId),
                  eq(classpilotScheduleChangePairs.status, "active")
                )
              )
              .limit(1)
              .then((rows) => rows[0]),
            options.dbInstance
              .select()
              .from(classpilotScheduleChangeLegs)
              .where(
                and(
                  eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
                  eq(classpilotScheduleChangeLegs.scheduleChangeId, approvedChange.id),
                  eq(classpilotScheduleChangeLegs.reservationActive, true)
                )
              )
              .orderBy(asc(classpilotScheduleChangeLegs.legOrder)),
          ])
        : [undefined, [] as ClasspilotScheduleChangeLeg[]];
      const groupsById = new Map(lockedGroups.map((row) => [row.id, row]));
      const expectedGroupIds = pair
        ? [pair.firstGroupId, pair.secondGroupId].sort()
        : [];
      if (
        !approvedChange ||
        !pair ||
        legs.length !== 2 ||
        expectedGroupIds.length !== lockedGroupIds.length ||
        expectedGroupIds.some((id, index) => id !== lockedGroupIds[index]) ||
        !scheduleChangeSnapshotMatches(groupsById, legs)
      ) {
        throw new Error("invalid approved schedule-change snapshot");
      }
      await assertScheduleChangePairGroups(
        options.schoolId,
        lockedGroups as LockedScheduleChangeGroup[],
        options.dbInstance
      );
      const dateStatus = await getInstructionalDateStatus(
        options.schoolId,
        options.scheduledDate,
        options.dbInstance
      );
      if (!dateStatus.instructional) {
        throw new Error("approved schedule change is not on an instructional date");
      }
      const pairGroups: [LockedScheduleChangeGroup, LockedScheduleChangeGroup] = [
        lockedGroups[0]!,
        lockedGroups[1]!,
      ];
      const blockers = await scheduleChangeConflictsForPair({
        schoolId: options.schoolId,
        scheduledDate: options.scheduledDate,
        pairGroups,
        dbInstance: options.dbInstance,
      });
      if (blockers.length > 0) {
        throw new Error("approved schedule change has an execution conflict");
      }
    } catch {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_EXECUTION_INVALID",
        "The approved schedule change is no longer safe to execute.",
        409
      );
    }
  }
  return {
    group,
    schoolTimezone,
    ...(authoritative
      ? {
          effectiveLeg: {
            swapId: authoritative.swapId,
            effectiveStartTime: authoritative.effectiveStartTime,
            effectiveEndTime: authoritative.effectiveEndTime,
          },
        }
      : {}),
    lockedGroupIds,
  };
}

export async function expirePendingClasspilotScheduleChangesForSchool(options: {
  schoolId: string;
  scheduledDate: string;
  now: Date;
  dbInstance?: ScheduleChangeDb;
}): Promise<{ expiredIds: string[] }> {
  if (!isValidInstructionalCalendarDate(options.scheduledDate)) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_DATE",
      "Choose a real date in YYYY-MM-DD format."
    );
  }
  const rootDb = options.dbInstance ?? db;
  return withInstructionalCalendarDateLock(
    options.schoolId,
    options.scheduledDate,
    async (lockedDb) => {
      await lockClasspilotScheduleChangeSchool(options.schoolId, lockedDb);
      await takeClasspilotScheduleConfigLock(lockedDb, options.schoolId);
      const policy = await getClasspilotScheduleChangeSettings(options.schoolId, lockedDb);
      if (!policy) return { expiredIds: [] };
      const pending = await lockedDb
        .select()
        .from(classpilotScheduleChanges)
        .where(
          and(
            eq(classpilotScheduleChanges.schoolId, options.schoolId),
            eq(classpilotScheduleChanges.scheduledDate, options.scheduledDate),
            inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES])
          )
        )
        .orderBy(asc(classpilotScheduleChanges.id));
      if (pending.length === 0) return { expiredIds: [] };
      const pendingIds = pending.map((change) => change.id);
      const legs = await lockedDb
        .select()
        .from(classpilotScheduleChangeLegs)
        .where(
          and(
            eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
            inArray(classpilotScheduleChangeLegs.scheduleChangeId, pendingIds)
          )
        )
        .orderBy(asc(classpilotScheduleChangeLegs.groupId));
      const dueIds = pending
        .filter((change) => {
          const changeLegs = legs.filter((leg) => leg.scheduleChangeId === change.id);
          const earliestStart = changeLegs.map((leg) => leg.effectiveStartTime).sort()[0];
          return Boolean(
            earliestStart &&
              options.now.getTime() >=
                localDateTimeUtc(
                  change.scheduledDate,
                  earliestStart,
                  policy.schoolTimezone
                ).getTime()
          );
        })
        .map((change) => change.id)
        .sort();
      if (dueIds.length === 0) return { expiredIds: [] };
      const dueGroupIds = Array.from(
        new Set(
          legs
            .filter((leg) => dueIds.includes(leg.scheduleChangeId))
            .map((leg) => leg.groupId)
        )
      ).sort();
      await lockedDb
        .select({ id: groups.id })
        .from(groups)
        .where(
          and(eq(groups.schoolId, options.schoolId), inArray(groups.id, dueGroupIds))
        )
        .orderBy(asc(groups.id))
        .for("update");
      const lockedChanges = await lockedDb
        .select()
        .from(classpilotScheduleChanges)
        .where(
          and(
            eq(classpilotScheduleChanges.schoolId, options.schoolId),
            inArray(classpilotScheduleChanges.id, dueIds),
            inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES])
          )
        )
        .orderBy(asc(classpilotScheduleChanges.id))
        .for("update");
      const authoritativeIds = lockedChanges.map((change) => change.id);
      if (authoritativeIds.length === 0) return { expiredIds: [] };
      await lockedDb
        .update(classpilotScheduleChanges)
        .set({
          status: "expired",
          reservationActive: false,
          terminalReason: "approval_incomplete_at_bell",
          terminalAt: options.now,
          revision: sql`${classpilotScheduleChanges.revision} + 1`,
          updatedAt: options.now,
        })
        .where(inArray(classpilotScheduleChanges.id, authoritativeIds));
      await releaseScheduleChangeReservations(authoritativeIds, lockedDb);
      for (const id of authoritativeIds) {
        await lockedDb.insert(auditLogs).values({
          schoolId: options.schoolId,
          userId: null,
          action: "classpilot.schedule_change.expired",
          entityType: "classpilot_schedule_change",
          entityId: id,
          changes: { status: "expired" },
          metadata: { reasonCode: "approval_incomplete_at_bell" },
        });
      }
      return { expiredIds: authoritativeIds };
    },
    rootDb
  );
}

export async function listPendingClasspilotScheduleChangeDatesForSchool(options: {
  schoolId: string;
  throughDate: string;
  limit?: number;
  dbInstance?: ScheduleChangeDb;
}): Promise<string[]> {
  if (!isValidInstructionalCalendarDate(options.throughDate)) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_DATE",
      "Choose a real date in YYYY-MM-DD format."
    );
  }
  const dbInstance = options.dbInstance ?? db;
  const limit = Math.min(Math.max(options.limit ?? 31, 1), 366);
  const rows = await dbInstance
    .selectDistinct({ scheduledDate: classpilotScheduleChanges.scheduledDate })
    .from(classpilotScheduleChanges)
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES]),
        eq(classpilotScheduleChanges.reservationActive, true),
        sql`${classpilotScheduleChanges.scheduledDate} <= ${options.throughDate}`
      )
    )
    .orderBy(asc(classpilotScheduleChanges.scheduledDate))
    .limit(limit);
  return rows
    .map((row) => row.scheduledDate)
    .filter(isValidInstructionalCalendarDate);
}

export async function assertNoApprovedFutureScheduleChange(options: {
  schoolId: string;
  groupId: string;
  now?: Date;
  dbInstance?: ScheduleChangeDb;
  prospectiveGroup?: {
    teacherId: string;
    scheduleEnabled: boolean;
    blockStartTime: string | null;
    blockEndTime: string | null;
    status: string;
  };
  prospectiveTeacherIds?: string[];
  prospectiveStudentIds?: string[];
  actorId?: string | null;
}): Promise<void> {
  const dbInstance = options.dbInstance ?? db;
  const now = options.now ?? new Date();
  const rows = await dbInstance
    .select({
      scheduledDate: classpilotScheduleChanges.scheduledDate,
      effectiveEndTime: classpilotScheduleChangeLegs.effectiveEndTime,
    })
    .from(classpilotScheduleChangeLegs)
    .innerJoin(
      classpilotScheduleChanges,
      and(
        eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId),
        eq(classpilotScheduleChanges.schoolId, classpilotScheduleChangeLegs.schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.groupId, options.groupId),
        eq(classpilotScheduleChanges.status, "approved"),
        eq(classpilotScheduleChanges.reservationActive, true)
      )
    );
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId, dbInstance);
  const currentTimezone = policy?.schoolTimezone || "America/New_York";
  if (
    rows.some(
      (row) =>
        localDateTimeUtc(row.scheduledDate, row.effectiveEndTime, currentTimezone).getTime() >
        now.getTime()
    )
  ) {
    throw scheduleChangeError(
      "APPROVED_SCHEDULE_CHANGE_EXISTS",
      "Cancel the approved schedule change before changing this class.",
      409
    );
  }
  if (options.prospectiveGroup) {
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: options.schoolId,
      groupId: options.groupId,
      prospectiveGroup: options.prospectiveGroup,
      prospectiveTeacherIds: options.prospectiveTeacherIds,
      prospectiveStudentIds: options.prospectiveStudentIds,
      actorId: options.actorId,
      now,
      dbInstance,
    });
  }
}

export async function supersedePendingScheduleChangesForGroup(options: {
  schoolId: string;
  groupId: string;
  actorId?: string | null;
  reason: string;
  dbInstance?: ScheduleChangeDb;
}): Promise<string[]> {
  const dbInstance = options.dbInstance ?? db;
  const reasonCode = /^[a-z0-9_]{1,100}$/.test(options.reason)
    ? options.reason
    : "class_configuration_changed";
  const rows = await dbInstance
    .select({ id: classpilotScheduleChanges.id })
    .from(classpilotScheduleChangeLegs)
    .innerJoin(
      classpilotScheduleChanges,
      and(
        eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId),
        eq(classpilotScheduleChanges.schoolId, classpilotScheduleChangeLegs.schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.groupId, options.groupId),
        inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES])
      )
    )
    .for("update");
  const ids = Array.from(new Set(rows.map((row) => row.id))).sort();
  if (ids.length === 0) return ids;
  const now = new Date();
  await dbInstance
    .update(classpilotScheduleChanges)
    .set({
      status: "superseded",
      reservationActive: false,
      terminalByUserId: options.actorId ?? null,
      terminalReason: reasonCode,
      terminalAt: now,
      revision: sql`${classpilotScheduleChanges.revision} + 1`,
      updatedAt: now,
    })
    .where(inArray(classpilotScheduleChanges.id, ids));
  await releaseScheduleChangeReservations(ids, dbInstance);
  for (const id of ids) {
    await dbInstance.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actorId ?? null,
      action: "classpilot.schedule_change.superseded",
      entityType: "classpilot_schedule_change",
      entityId: id,
      changes: { status: "superseded" },
      metadata: { reasonCode },
    });
  }
  recordScheduleChangePostCommitNotice(dbInstance, options.schoolId, ids);
  return ids;
}

async function assertProspectiveApprovedScheduleChangeAssignmentsSafe(options: {
  schoolId: string;
  groupId: string;
  addedTeacherIds?: string[];
  addedStudentIds?: string[];
  prospectiveTeacherIds?: string[];
  prospectiveStudentIds?: string[];
  includeInactiveProspectiveStudents?: boolean;
  prospectiveGroup?: {
    teacherId: string;
    scheduleEnabled: boolean;
    blockStartTime: string | null;
    blockEndTime: string | null;
    status: string;
  };
  actorId?: string | null;
  now?: Date;
  dbInstance: ScheduleChangeDb;
}): Promise<void> {
  const addedTeachers = new Set((options.addedTeacherIds ?? []).filter(Boolean));
  const addedStudents = new Set((options.addedStudentIds ?? []).filter(Boolean));
  if (
    addedTeachers.size === 0 &&
    addedStudents.size === 0 &&
    !options.prospectiveGroup
  ) return;
  const [target] = await options.dbInstance
    .select({
      id: groups.id,
      status: groups.status,
      groupType: groups.groupType,
      scheduleEnabled: groups.scheduleEnabled,
      startTime: groups.blockStartTime,
      endTime: groups.blockEndTime,
    })
    .from(groups)
    .where(and(eq(groups.schoolId, options.schoolId), eq(groups.id, options.groupId)))
    .limit(1);
  const targetStatus = options.prospectiveGroup?.status ?? target?.status;
  const targetScheduleEnabled =
    options.prospectiveGroup?.scheduleEnabled ?? target?.scheduleEnabled;
  const targetStartTime = options.prospectiveGroup
    ? options.prospectiveGroup.blockStartTime
    : target?.startTime ?? null;
  const targetEndTime = options.prospectiveGroup
    ? options.prospectiveGroup.blockEndTime
    : target?.endTime ?? null;
  if (
    !target ||
    targetStatus !== "active" ||
    !targetScheduleEnabled ||
    !targetStartTime ||
    !targetEndTime
  ) {
    return;
  }
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId, options.dbInstance);
  const currentTimezone = policy?.schoolTimezone || "America/New_York";
  const now = options.now ?? new Date();
  const activeRows = await options.dbInstance
    .select({
      changeId: classpilotScheduleChanges.id,
      status: classpilotScheduleChanges.status,
      scheduledDate: classpilotScheduleChanges.scheduledDate,
      groupId: classpilotScheduleChangeLegs.groupId,
      effectiveStartTime: classpilotScheduleChangeLegs.effectiveStartTime,
      effectiveEndTime: classpilotScheduleChangeLegs.effectiveEndTime,
    })
    .from(classpilotScheduleChangeLegs)
    .innerJoin(
      classpilotScheduleChanges,
      and(
        eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId),
        eq(classpilotScheduleChanges.schoolId, classpilotScheduleChangeLegs.schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_ACTIVE_STATUSES]),
        eq(classpilotScheduleChanges.reservationActive, true),
        eq(classpilotScheduleChangeLegs.reservationActive, true)
      )
    );
  const futureActive = activeRows.filter(
    (row) =>
      localDateTimeUtc(
        row.scheduledDate,
        row.effectiveEndTime,
        currentTimezone
      ).getTime() > now.getTime()
  );
  if (futureActive.length === 0) return;
  const dates = Array.from(new Set(futureActive.map((row) => row.scheduledDate)));
  const targetTeacherIds = options.prospectiveGroup
    ? new Set(
        options.prospectiveTeacherIds ?? [
          options.prospectiveGroup.teacherId,
          ...(
            await options.dbInstance
              .select({ teacherId: groupTeachers.teacherId })
              .from(groupTeachers)
              .where(eq(groupTeachers.groupId, options.groupId))
          ).map((row) => row.teacherId),
        ]
      )
    : addedTeachers;
  const targetStudentIds = options.prospectiveGroup
    ? new Set(
        options.prospectiveStudentIds ?? (
          await options.dbInstance
            .select({ studentId: groupStudents.studentId })
            .from(groupStudents)
            .innerJoin(students, eq(students.id, groupStudents.studentId))
            .where(
              and(
                eq(groupStudents.groupId, options.groupId),
                eq(students.schoolId, options.schoolId),
                eq(students.status, "active")
              )
            )
        ).map((row) => row.studentId)
      )
    : addedStudents;
  const schoolGroups = await options.dbInstance
    .select({
      id: groups.id,
      teacherId: groups.teacherId,
      startTime: groups.blockStartTime,
      endTime: groups.blockEndTime,
    })
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, options.schoolId),
        eq(groups.status, "active"),
        eq(groups.scheduleEnabled, true),
        isNotNull(groups.blockStartTime),
        isNotNull(groups.blockEndTime)
      )
    );
  const schoolGroupIds = schoolGroups.map((group) => group.id);
  const teacherRows = targetTeacherIds.size && schoolGroupIds.length
    ? await options.dbInstance
        .select({ groupId: groupTeachers.groupId, teacherId: groupTeachers.teacherId })
        .from(groupTeachers)
        .where(
          and(
            inArray(groupTeachers.groupId, schoolGroupIds),
            inArray(groupTeachers.teacherId, [...targetTeacherIds])
          )
        )
    : [];
  const studentRows = targetStudentIds.size && schoolGroupIds.length
    ? await options.dbInstance
        .select({ groupId: groupStudents.groupId, studentId: groupStudents.studentId })
        .from(groupStudents)
        .innerJoin(students, eq(students.id, groupStudents.studentId))
        .innerJoin(groups, eq(groups.id, groupStudents.groupId))
        .where(
          and(
            eq(groups.schoolId, options.schoolId),
            eq(students.schoolId, options.schoolId),
            options.includeInactiveProspectiveStudents
              ? undefined
              : eq(students.status, "active"),
            inArray(groupStudents.groupId, schoolGroupIds),
            inArray(groupStudents.studentId, [...targetStudentIds])
          )
        )
    : [];
  const teacherConflicts = new Map<string, Set<string>>();
  for (const row of teacherRows) {
    const values = teacherConflicts.get(row.groupId) ?? new Set<string>();
    values.add(row.teacherId);
    teacherConflicts.set(row.groupId, values);
  }
  for (const group of schoolGroups) {
    if (targetTeacherIds.has(group.teacherId)) {
      const values = teacherConflicts.get(group.id) ?? new Set<string>();
      values.add(group.teacherId);
      teacherConflicts.set(group.id, values);
    }
  }
  const studentConflicts = new Map<string, Set<string>>();
  for (const row of studentRows) {
    const values = studentConflicts.get(row.groupId) ?? new Set<string>();
    values.add(row.studentId);
    studentConflicts.set(row.groupId, values);
  }
  const pendingConflictIds = new Set<string>();
  for (const scheduledDate of dates) {
    const activeForDate = futureActive.filter((row) => row.scheduledDate === scheduledDate);
    const effectiveByGroup = new Map(activeForDate.map((row) => [row.groupId, row]));
    const targetApproved = effectiveByGroup.get(options.groupId);
    const targetWindow = targetApproved
      ? {
          startTime: targetApproved.effectiveStartTime,
          endTime: targetApproved.effectiveEndTime,
        }
      : { startTime: targetStartTime, endTime: targetEndTime };
    for (const other of schoolGroups) {
      if (other.id === options.groupId || !other.startTime || !other.endTime) continue;
      const otherApproved = effectiveByGroup.get(other.id);
      // Only conflicts introduced around an approved exception are guarded.
      if (!targetApproved && !otherApproved) continue;
      const otherWindow = otherApproved
        ? {
            startTime: otherApproved.effectiveStartTime,
            endTime: otherApproved.effectiveEndTime,
          }
        : { startTime: other.startTime, endTime: other.endTime };
      if (!windowsOverlap(targetWindow, otherWindow)) continue;
      const teacherConflict = (teacherConflicts.get(other.id)?.size ?? 0) > 0;
      const studentConflict = (studentConflicts.get(other.id)?.size ?? 0) > 0;
      if (!teacherConflict && !studentConflict) continue;
      const involved = [targetApproved, otherApproved].filter(
        (row): row is (typeof activeForDate)[number] => Boolean(row)
      );
      if (involved.some((row) => row.status === "approved")) {
        throw scheduleChangeError(
          "APPROVED_SCHEDULE_CHANGE_ASSIGNMENT_CONFLICT",
          teacherConflict
            ? "Cancel the approved schedule change before changing this class or co-teacher assignment."
            : "Cancel the approved schedule change before changing this class roster.",
          409
        );
      }
      for (const row of involved) pendingConflictIds.add(row.changeId);
    }
  }
  if (pendingConflictIds.size > 0) {
    const ids = [...pendingConflictIds].sort();
    const now = options.now ?? new Date();
    await options.dbInstance
      .update(classpilotScheduleChanges)
      .set({
        status: "superseded",
        reservationActive: false,
        terminalByUserId: options.actorId ?? null,
        terminalReason: "assignment_conflict_introduced",
        terminalAt: now,
        revision: sql`${classpilotScheduleChanges.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          inArray(classpilotScheduleChanges.id, ids),
          inArray(classpilotScheduleChanges.status, [...CP_SCHEDULE_CHANGE_PENDING_STATUSES])
        )
      );
    await releaseScheduleChangeReservations(ids, options.dbInstance);
    for (const id of ids) {
      await options.dbInstance.insert(auditLogs).values({
        schoolId: options.schoolId,
        userId: options.actorId ?? null,
        action: "classpilot.schedule_change.superseded",
        entityType: "classpilot_schedule_change",
        entityId: id,
        changes: { status: "superseded" },
        metadata: { reasonCode: "assignment_conflict_introduced" },
      });
    }
    recordScheduleChangePostCommitNotice(
      options.dbInstance,
      options.schoolId,
      ids
    );
  }
}

type ValidatedScheduleChangeContext = {
  pair: ClasspilotScheduleChangePair;
  groups: [LockedScheduleChangeGroup, LockedScheduleChangeGroup];
  policy: ClasspilotScheduleChangePolicyDto;
  firstWindow: ClasspilotScheduleWindowDto;
  secondWindow: ClasspilotScheduleWindowDto;
};

async function scheduleChangeConflictsForPair(options: {
  schoolId: string;
  scheduledDate: string;
  pairGroups: [LockedScheduleChangeGroup, LockedScheduleChangeGroup];
  dbInstance: ScheduleChangeDb;
}): Promise<ClasspilotScheduleChangeBlocker[]> {
  const blockers: ClasspilotScheduleChangeBlocker[] = [];
  const pairIds = new Set(options.pairGroups.map((group) => group.id));
  const allScheduledGroups = await options.dbInstance
    .select({
      id: groups.id,
      name: groups.name,
      teacherId: groups.teacherId,
      startTime: groups.blockStartTime,
      endTime: groups.blockEndTime,
    })
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, options.schoolId),
        eq(groups.status, "active"),
        eq(groups.scheduleEnabled, true),
        isNotNull(groups.blockStartTime),
        isNotNull(groups.blockEndTime)
      )
    );
  const approvedLegs = await loadApprovedScheduleChangeLegsForSchoolDate({
    schoolId: options.schoolId,
    scheduledDate: options.scheduledDate,
    dbInstance: options.dbInstance,
  });
  const approvedByGroup = new Map(approvedLegs.map((leg) => [leg.groupId, leg]));
  const scheduledIds = allScheduledGroups.map((group) => group.id);
  const teacherRows = scheduledIds.length
    ? await options.dbInstance
        .select({ groupId: groupTeachers.groupId, teacherId: groupTeachers.teacherId })
        .from(groupTeachers)
        .where(inArray(groupTeachers.groupId, scheduledIds))
    : [];
  const staffByGroup = new Map<string, Set<string>>();
  for (const group of allScheduledGroups) {
    staffByGroup.set(group.id, new Set([group.teacherId]));
  }
  for (const row of teacherRows) {
    const staff = staffByGroup.get(row.groupId) ?? new Set<string>();
    staff.add(row.teacherId);
    staffByGroup.set(row.groupId, staff);
  }
  const studentRows = scheduledIds.length
    ? await options.dbInstance
        .select({ groupId: groupStudents.groupId, studentId: groupStudents.studentId })
        .from(groupStudents)
        .innerJoin(students, eq(students.id, groupStudents.studentId))
        .innerJoin(groups, eq(groups.id, groupStudents.groupId))
        .where(
          and(
            eq(groups.schoolId, options.schoolId),
            eq(students.schoolId, options.schoolId),
            eq(students.status, "active"),
            inArray(groupStudents.groupId, scheduledIds)
          )
        )
    : [];
  const studentsByGroup = new Map<string, Set<string>>();
  for (const row of studentRows) {
    const roster = studentsByGroup.get(row.groupId) ?? new Set<string>();
    roster.add(row.studentId);
    studentsByGroup.set(row.groupId, roster);
  }

  const [first, second] = options.pairGroups;
  const moving = [
    {
      group: first,
      destination: {
        startTime: second.blockStartTime!,
        endTime: second.blockEndTime!,
      },
    },
    {
      group: second,
      destination: {
        startTime: first.blockStartTime!,
        endTime: first.blockEndTime!,
      },
    },
  ];
  const seen = new Set<string>();
  for (const candidate of moving) {
    const candidateStaff = staffByGroup.get(candidate.group.id) ?? new Set([candidate.group.teacherId]);
    const candidateStudents = studentsByGroup.get(candidate.group.id) ?? new Set<string>();
    for (const other of allScheduledGroups) {
      if (pairIds.has(other.id) || !other.startTime || !other.endTime) continue;
      const approved = approvedByGroup.get(other.id);
      const otherWindow = approved
        ? {
            startTime: approved.effectiveStartTime,
            endTime: approved.effectiveEndTime,
          }
        : { startTime: other.startTime, endTime: other.endTime };
      if (!windowsOverlap(candidate.destination, otherWindow)) continue;
      const otherStaff = staffByGroup.get(other.id) ?? new Set([other.teacherId]);
      const teacherConflict = [...candidateStaff].some((id) => otherStaff.has(id));
      if (teacherConflict) {
        const key = `teacher:${candidate.group.id}:${other.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          blockers.push({
            code: "SCHEDULE_CHANGE_TEACHER_CONFLICT",
            message: `${candidate.group.name} conflicts with ${other.name} for an assigned teacher.`,
          });
        }
      }
      const otherStudents = studentsByGroup.get(other.id) ?? new Set<string>();
      const studentConflict = [...candidateStudents].some((id) => otherStudents.has(id));
      if (studentConflict) {
        const key = `student:${candidate.group.id}:${other.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          blockers.push({
            code: "SCHEDULE_CHANGE_STUDENT_CONFLICT",
            message: `${candidate.group.name} conflicts with ${other.name} for one or more students.`,
          });
        }
      }
    }
  }
  return blockers;
}

async function validateScheduleChangeForDate(options: {
  schoolId: string;
  pair: ClasspilotScheduleChangePair;
  scheduledDate: string;
  actor: ClasspilotScheduleChangeActor;
  mode: "teacher_request" | "admin_create" | "approval" | "preview";
  now: Date;
  dbInstance: ScheduleChangeDb;
  lockGroups?: boolean;
}): Promise<{ context?: ValidatedScheduleChangeContext; blockers: ClasspilotScheduleChangeBlocker[] }> {
  const blockers: ClasspilotScheduleChangeBlocker[] = [];
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId, options.dbInstance);
  if (!policy) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
      "Schedule-change settings are unavailable.",
      500
    );
  }
  if (options.pair.status !== "active") {
    blockers.push({
      code: "SCHEDULE_CHANGE_PAIR_INACTIVE",
      message: "This eligible class pair is no longer active.",
    });
  }
  let pairGroups: LockedScheduleChangeGroup[];
  if (options.lockGroups) {
    pairGroups = await lockScheduleChangeGroups(
      options.schoolId,
      [options.pair.firstGroupId, options.pair.secondGroupId],
      options.dbInstance
    );
  } else {
    pairGroups = await options.dbInstance
      .select({
        id: groups.id,
        schoolId: groups.schoolId,
        teacherId: groups.teacherId,
        name: groups.name,
        groupType: groups.groupType,
        status: groups.status,
        scheduleEnabled: groups.scheduleEnabled,
        blockStartTime: groups.blockStartTime,
        blockEndTime: groups.blockEndTime,
      })
      .from(groups)
      .where(
        and(
          eq(groups.schoolId, options.schoolId),
          inArray(groups.id, [options.pair.firstGroupId, options.pair.secondGroupId])
        )
      )
      .orderBy(asc(groups.id));
  }
  try {
    await assertScheduleChangePairGroups(options.schoolId, pairGroups, options.dbInstance);
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    blockers.push({
      code: typed.code || "SCHEDULE_CHANGE_CLASS_INELIGIBLE",
      message: typed.message || "One or more classes are no longer eligible.",
    });
  }
  if (pairGroups.length !== 2) return { blockers };
  const tuple = pairGroups as [LockedScheduleChangeGroup, LockedScheduleChangeGroup];
  const firstWindow = {
    startTime: tuple[0].blockStartTime || "",
    endTime: tuple[0].blockEndTime || "",
  };
  const secondWindow = {
    startTime: tuple[1].blockStartTime || "",
    endTime: tuple[1].blockEndTime || "",
  };

  if (!isValidInstructionalCalendarDate(options.scheduledDate)) {
    blockers.push({
      code: "INVALID_SCHEDULE_CHANGE_DATE",
      message: "Choose a real date in YYYY-MM-DD format.",
    });
  } else {
    const dateStatus = await getInstructionalDateStatus(
      options.schoolId,
      options.scheduledDate,
      options.dbInstance
    );
    if (!dateStatus.instructional) {
      blockers.push({
        code: "SCHEDULE_CHANGE_NON_INSTRUCTIONAL_DATE",
        message: "Schedule changes can only be created for instructional days.",
      });
    }
    const localToday = localDateInTimeZone(options.now, policy.schoolTimezone);
    if (options.scheduledDate < localToday) {
      blockers.push({
        code: "SCHEDULE_CHANGE_DATE_PASSED",
        message: "Past schedule dates cannot be changed.",
      });
    }
    const earliestStart = [firstWindow.startTime, secondWindow.startTime].sort()[0]!;
    if (
      options.scheduledDate === localToday &&
      options.now.getTime() >=
        localDateTimeUtc(options.scheduledDate, earliestStart, policy.schoolTimezone).getTime()
    ) {
      blockers.push({
        code: "SCHEDULE_CHANGE_ALREADY_STARTED",
        message: "A schedule change cannot be made after either class period begins.",
      });
    }
    if (
      options.mode === "teacher_request" &&
      policy.sameDayCutoffEnforced &&
      options.scheduledDate === localToday &&
      options.now.getTime() >=
        localDateTimeUtc(
          options.scheduledDate,
          policy.sameDayCutoff,
          policy.schoolTimezone
        ).getTime()
    ) {
      blockers.push({
        code: "SCHEDULE_CHANGE_CUTOFF_PASSED",
        message: `Teacher requests close at ${policy.sameDayCutoff} school time.`,
      });
    }
  }
  if (options.mode === "teacher_request" && !policy.teacherRequestsEnabled) {
    blockers.push({
      code: "SCHEDULE_CHANGE_TEACHER_REQUESTS_DISABLED",
      message: "Teacher schedule-change requests are not enabled.",
    });
  }
  if (options.actor.role === "teacher") {
    const ownsFirst = tuple[0].teacherId === options.actor.userId;
    const ownsSecond = tuple[1].teacherId === options.actor.userId;
    if (!ownsFirst && !ownsSecond) {
      blockers.push({
        code: "SCHEDULE_CHANGE_PRIMARY_TEACHER_REQUIRED",
        message: "Only an affected primary teacher may request this change.",
      });
    }
  }
  if (options.actor.role === "office_staff") {
    blockers.push({
      code: "SCHEDULE_CHANGE_VIEW_ONLY",
      message: "Office staff have view-only access to schedule changes.",
    });
  }
  const occurrences = await options.dbInstance
    .select({ id: teachingSessions.id })
    .from(teachingSessions)
    .where(
      and(
        eq(teachingSessions.schoolId, options.schoolId),
        eq(teachingSessions.scheduledDate, options.scheduledDate),
        inArray(teachingSessions.groupId, tuple.map((group) => group.id))
      )
    )
    .limit(1);
  if (occurrences.length > 0) {
    blockers.push({
      code: "SCHEDULE_CHANGE_OCCURRENCE_EXISTS",
      message: "A class occurrence already exists for this date.",
    });
  }
  if (blockers.length === 0 || options.mode === "preview") {
    blockers.push(
      ...(await scheduleChangeConflictsForPair({
        schoolId: options.schoolId,
        scheduledDate: options.scheduledDate,
        pairGroups: tuple,
        dbInstance: options.dbInstance,
      }))
    );
  }
  return {
    blockers,
    context: {
      pair: options.pair,
      groups: tuple,
      policy,
      firstWindow,
      secondWindow,
    },
  };
}

function throwFirstScheduleChangeBlocker(blockers: ClasspilotScheduleChangeBlocker[]): never {
  const first = blockers[0] ?? {
    code: "SCHEDULE_CHANGE_INELIGIBLE",
    message: "This schedule change is no longer eligible.",
  };
  throw scheduleChangeError(first.code, first.message, 409);
}

export async function getClasspilotScheduleChangeEligibility(options: {
  schoolId: string;
  scheduledDate: string;
  actor: ClasspilotScheduleChangeActor;
  now?: Date;
}): Promise<{
  scheduledDate: string;
  schoolTimezone: string;
  policy: ClasspilotScheduleChangePolicyDto;
  pairs: Array<{
    pairId: string;
    firstClass: ClasspilotScheduleChangeClassDto;
    secondClass: ClasspilotScheduleChangeClassDto;
    preview: {
      legs: Array<{
        classId: string;
        className: string;
        normalWindow: ClasspilotScheduleWindowDto;
        effectiveWindow: ClasspilotScheduleWindowDto;
      }>;
    };
    eligible: boolean;
    blockers: ClasspilotScheduleChangeBlocker[];
  }>;
  capabilities: { canRequest: boolean; canCreateDirect: boolean };
}> {
  const now = options.now ?? new Date();
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId);
  if (!policy) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
      "Schedule-change settings are unavailable.",
      500
    );
  }
  const pairDtos = await listClasspilotScheduleChangePairs({
    schoolId: options.schoolId,
    actor: options.actor,
  });
  const pairRows = pairDtos.length
    ? await db
        .select()
        .from(classpilotScheduleChangePairs)
        .where(
          and(
            eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
            inArray(
              classpilotScheduleChangePairs.id,
              pairDtos.map((pair) => pair.id)
            )
          )
        )
    : [];
  const rowById = new Map(pairRows.map((pair) => [pair.id, pair]));
  const pairs = await Promise.all(
    pairDtos.map(async (pairDto) => {
      const pair = rowById.get(pairDto.id)!;
      const mode =
        options.actor.role === "admin" || options.actor.role === "school_admin"
          ? "admin_create" as const
          : "teacher_request" as const;
      const validation = await validateScheduleChangeForDate({
        schoolId: options.schoolId,
        pair,
        scheduledDate: options.scheduledDate,
        actor: options.actor,
        mode,
        now,
        dbInstance: db,
      });
      return {
        pairId: pairDto.id,
        firstClass: pairDto.firstClass,
        secondClass: pairDto.secondClass,
        preview: {
          legs: [
            {
              classId: pairDto.firstClass.id,
              className: pairDto.firstClass.name,
              normalWindow: pairDto.firstClass.normalWindow,
              effectiveWindow: pairDto.secondClass.normalWindow,
            },
            {
              classId: pairDto.secondClass.id,
              className: pairDto.secondClass.name,
              normalWindow: pairDto.secondClass.normalWindow,
              effectiveWindow: pairDto.firstClass.normalWindow,
            },
          ],
        },
        eligible: validation.blockers.length === 0,
        blockers: validation.blockers,
      };
    })
  );
  return {
    scheduledDate: options.scheduledDate,
    schoolTimezone: policy.schoolTimezone,
    policy,
    pairs,
    capabilities: {
      canRequest: options.actor.role === "teacher" && policy.teacherRequestsEnabled,
      canCreateDirect:
        options.actor.role === "admin" || options.actor.role === "school_admin",
    },
  };
}

export async function createClasspilotScheduleChange(options: {
  schoolId: string;
  pairId: string;
  scheduledDate: string;
  reason?: unknown;
  actor: ClasspilotScheduleChangeActor;
  directApprove?: boolean;
  now?: Date;
}): Promise<ClasspilotScheduleChange> {
  if (options.reason !== undefined && typeof options.reason !== "string") {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_REASON",
      "The schedule-change reason must be text."
    );
  }
  if (typeof options.reason === "string" && options.reason.length > 500) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_REASON",
      "The schedule-change reason must be at most 500 characters."
    );
  }
  const submittedReason = typeof options.reason === "string"
    ? options.reason.trim()
    : "";
  const isAdmin = options.actor.role === "admin" || options.actor.role === "school_admin";
  if (options.actor.role === "office_staff") {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_VIEW_ONLY",
      "Office staff have view-only access to schedule changes.",
      403
    );
  }
  if (options.directApprove && !isAdmin) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_ADMIN_REQUIRED",
      "Only administrators may directly approve a schedule change.",
      403
    );
  }
  const now = options.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as ScheduleChangeDb;
      const [candidatePair] = await tx
        .select()
        .from(classpilotScheduleChangePairs)
        .where(
          and(
            eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
            eq(classpilotScheduleChangePairs.id, options.pairId)
          )
        )
        .limit(1);
      if (!candidatePair) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_PAIR_NOT_FOUND",
          "Eligible class pair not found.",
          404
        );
      }
      if (!isValidInstructionalCalendarDate(options.scheduledDate)) {
        throw scheduleChangeError(
          "INVALID_SCHEDULE_CHANGE_DATE",
          "Choose a real date in YYYY-MM-DD format."
        );
      }
      await lockInstructionalCalendarDate(
        options.schoolId,
        options.scheduledDate,
        transactionDb
      );
      await lockClasspilotScheduleChangeSchool(options.schoolId, transactionDb);
      await takeClasspilotScheduleConfigLock(transactionDb, options.schoolId);
      // Lock entitlement before policy settings. License-removal transactions
      // use school -> config -> license -> settings, so matching that order
      // prevents create/approval from deadlocking with a concurrent removal.
      await assertActiveClasspilotScheduleChangeEntitlement({
        schoolId: options.schoolId,
        now,
        dbInstance: transactionDb,
      });
      await lockClasspilotScheduleChangeSettingsRow(
        options.schoolId,
        transactionDb
      );
      // Group rows are always locked before the pair/change rows. Class-edit
      // transactions use the same ordering, preventing a teacher/schedule edit
      // from racing approval or session creation.
      await lockScheduleChangeGroups(
        options.schoolId,
        [candidatePair.firstGroupId, candidatePair.secondGroupId],
        transactionDb
      );
      const [pair] = await tx
        .select()
        .from(classpilotScheduleChangePairs)
        .where(
          and(
            eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
            eq(classpilotScheduleChangePairs.id, options.pairId)
          )
        )
        .limit(1)
        .for("update");
      if (!pair) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_PAIR_NOT_FOUND",
          "Eligible class pair not found.",
          404
        );
      }
      const validation = await validateScheduleChangeForDate({
        schoolId: options.schoolId,
        pair,
        scheduledDate: options.scheduledDate,
        actor: options.actor,
        mode: isAdmin ? "admin_create" : "teacher_request",
        now,
        dbInstance: transactionDb,
      });
      if (!validation.context || validation.blockers.length > 0) {
        throwFirstScheduleChangeBlocker(validation.blockers);
      }
      const reasonRequired = isAdmin || validation.context.policy.reasonRequired;
      if (reasonRequired && !submittedReason) {
        throw scheduleChangeError(
          "INVALID_SCHEDULE_CHANGE_REASON",
          "Provide a reason between 1 and 500 characters."
        );
      }
      const reason = submittedReason || CP_SCHEDULE_CHANGE_NO_REASON;
      const entitlementThrough = localDateTimeUtc(
        options.scheduledDate,
        [
          validation.context.firstWindow.endTime,
          validation.context.secondWindow.endTime,
        ].sort().at(-1)!,
        validation.context.policy.schoolTimezone
      );
      await assertActiveClasspilotScheduleChangeEntitlement({
        schoolId: options.schoolId,
        now,
        through: entitlementThrough,
        dbInstance: transactionDb,
      });
      const [firstGroup, secondGroup] = validation.context.groups;
      const requesterGroupId = isAdmin
        ? null
        : firstGroup.teacherId === options.actor.userId
          ? firstGroup.id
          : secondGroup.id;
      const counterpartTeacherId = isAdmin
        ? null
        : requesterGroupId === firstGroup.id
          ? secondGroup.teacherId
          : firstGroup.teacherId;
      const directApproved = isAdmin;
      const [change] = await tx
        .insert(classpilotScheduleChanges)
        .values({
          schoolId: options.schoolId,
          pairId: pair.id,
          scheduledDate: options.scheduledDate,
          timezoneSnapshot: validation.context.policy.schoolTimezone,
          status: directApproved ? "approved" : "pending_counterpart",
          reason,
          requestedByUserId: options.actor.userId,
          requesterGroupId,
          counterpartTeacherId,
          requestedByRole: options.actor.role,
          requiresAdminApproval: validation.context.policy.adminApprovalRequired,
          approvedByUserId: directApproved ? options.actor.userId : null,
          approvedAt: directApproved ? now : null,
        })
        .returning();
      const firstWindow = validation.context.firstWindow;
      const secondWindow = validation.context.secondWindow;
      await tx.insert(classpilotScheduleChangeLegs).values([
        {
          schoolId: options.schoolId,
          scheduleChangeId: change!.id,
          scheduledDate: options.scheduledDate,
          legOrder: 1,
          groupId: firstGroup.id,
          primaryTeacherIdSnapshot: firstGroup.teacherId,
          classNameSnapshot: firstGroup.name,
          originalStartTime: firstWindow.startTime,
          originalEndTime: firstWindow.endTime,
          effectiveStartTime: secondWindow.startTime,
          effectiveEndTime: secondWindow.endTime,
        },
        {
          schoolId: options.schoolId,
          scheduleChangeId: change!.id,
          scheduledDate: options.scheduledDate,
          legOrder: 2,
          groupId: secondGroup.id,
          primaryTeacherIdSnapshot: secondGroup.teacherId,
          classNameSnapshot: secondGroup.name,
          originalStartTime: secondWindow.startTime,
          originalEndTime: secondWindow.endTime,
          effectiveStartTime: firstWindow.startTime,
          effectiveEndTime: firstWindow.endTime,
        },
      ]);
      await tx.insert(auditLogs).values({
        schoolId: options.schoolId,
        userId: options.actor.userId,
        userEmail: options.actor.userEmail ?? null,
        userRole: options.actor.role,
        action: directApproved
          ? "classpilot.schedule_change.admin_created"
          : "classpilot.schedule_change.requested",
        entityType: "classpilot_schedule_change",
        entityId: change!.id,
        changes: { status: change!.status },
        metadata: {
          scheduledDate: options.scheduledDate,
          revision: change!.revision,
          classCount: 2,
        },
      });
      return change!;
    });
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    if (
      pgError.code === "23505" &&
      pgError.constraint === "cp_schedule_change_legs_active_group_date_unique"
    ) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_CLASS_ALREADY_RESERVED",
        "One of these classes already has a pending or approved change for this date.",
        409
      );
    }
    throw error;
  }
}

async function loadLockedScheduleChangeWithLegs(options: {
  schoolId: string;
  changeId: string;
  dbInstance: ScheduleChangeDb;
}): Promise<{
  change: ClasspilotScheduleChange;
  legs: ClasspilotScheduleChangeLeg[];
} | undefined> {
  const [change] = await options.dbInstance
    .select()
    .from(classpilotScheduleChanges)
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.id, options.changeId)
      )
    )
    .limit(1)
    .for("update");
  if (!change) return undefined;
  const legs = await options.dbInstance
    .select()
    .from(classpilotScheduleChangeLegs)
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.scheduleChangeId, options.changeId)
      )
    )
    .orderBy(asc(classpilotScheduleChangeLegs.legOrder))
    .for("update");
  if (legs.length !== 2) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_CORRUPT",
      "The saved schedule change is incomplete.",
      500
    );
  }
  return { change, legs };
}

async function markScheduleChangeTerminal(options: {
  schoolId: string;
  change: ClasspilotScheduleChange;
  status: "declined" | "denied" | "cancelled" | "expired" | "superseded";
  actor: ClasspilotScheduleChangeActor;
  reason: string;
  now: Date;
  dbInstance: ScheduleChangeDb;
}): Promise<ClasspilotScheduleChange> {
  const [saved] = await options.dbInstance
    .update(classpilotScheduleChanges)
    .set({
      status: options.status,
      reservationActive: false,
      terminalByUserId: options.actor.userId,
      terminalReason: options.reason,
      terminalAt: options.now,
      revision: options.change.revision + 1,
      updatedAt: options.now,
    })
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.id, options.change.id),
        eq(classpilotScheduleChanges.revision, options.change.revision)
      )
    )
    .returning();
  if (!saved) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_REVISION_CONFLICT",
      "This schedule change was updated in another session.",
      409
    );
  }
  await releaseScheduleChangeReservations([options.change.id], options.dbInstance);
  return saved;
}

export type ClasspilotScheduleChangeAction =
  | "accept"
  | "decline"
  | "approve"
  | "deny"
  | "withdraw"
  | "cancel";

export type ApplyClasspilotScheduleChangeActionResult =
  | { status: "saved"; change: ClasspilotScheduleChange }
  | { status: "revision_conflict"; change: ClasspilotScheduleChange }
  | { status: "superseded"; change: ClasspilotScheduleChange }
  | { status: "expired"; change: ClasspilotScheduleChange };

function terminalActionReason(
  action: ClasspilotScheduleChangeAction,
  submitted: string | undefined
): string {
  if (action === "withdraw") return "withdrawn_by_requester";
  const defaultReasons: Partial<Record<ClasspilotScheduleChangeAction, string>> = {
    decline: "declined_by_counterpart",
    deny: "denied_by_admin",
    cancel: "cancelled_by_admin",
  };
  const reason = submitted?.trim() || defaultReasons[action] || "status_changed";
  if (reason.length > 500) {
    throw scheduleChangeError(
      "INVALID_SCHEDULE_CHANGE_ACTION_REASON",
      "The action reason must be at most 500 characters."
    );
  }
  return reason;
}

function scheduleChangeSnapshotMatches(
  groupsById: Map<string, LockedScheduleChangeGroup>,
  legs: ClasspilotScheduleChangeLeg[]
): boolean {
  return legs.every((leg) => {
    const group = groupsById.get(leg.groupId);
    return Boolean(
      group &&
        group.status === "active" &&
        group.groupType === "admin_class" &&
        group.scheduleEnabled &&
        group.teacherId === leg.primaryTeacherIdSnapshot &&
        group.blockStartTime === leg.originalStartTime &&
        group.blockEndTime === leg.originalEndTime
    );
  });
}

export async function applyClasspilotScheduleChangeAction(options: {
  schoolId: string;
  changeId: string;
  action: ClasspilotScheduleChangeAction;
  expectedRevision: number;
  reason?: string;
  actor: ClasspilotScheduleChangeActor;
  now?: Date;
}): Promise<ApplyClasspilotScheduleChangeActionResult> {
  const now = options.now ?? new Date();
  const isAdmin = options.actor.role === "admin" || options.actor.role === "school_admin";
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as ScheduleChangeDb;
    const [candidate] = await tx
      .select()
      .from(classpilotScheduleChanges)
      .where(
        and(
          eq(classpilotScheduleChanges.schoolId, options.schoolId),
          eq(classpilotScheduleChanges.id, options.changeId)
        )
      )
      .limit(1);
    if (!candidate) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_NOT_FOUND",
        "Schedule change not found.",
        404
      );
    }
    const candidateLegs = await tx
      .select({ groupId: classpilotScheduleChangeLegs.groupId })
      .from(classpilotScheduleChangeLegs)
      .where(
        and(
          eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
          eq(classpilotScheduleChangeLegs.scheduleChangeId, candidate.id)
        )
      )
      .orderBy(asc(classpilotScheduleChangeLegs.groupId));
    if (candidateLegs.length !== 2) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_CORRUPT",
        "The saved schedule change is incomplete.",
        500
      );
    }
    await lockInstructionalCalendarDate(
      options.schoolId,
      candidate.scheduledDate,
      transactionDb
    );
    await lockClasspilotScheduleChangeSchool(options.schoolId, transactionDb);
    await takeClasspilotScheduleConfigLock(transactionDb, options.schoolId);
    let entitlementUnavailable = false;
    if (options.action === "accept" || options.action === "approve") {
      try {
        await assertActiveClasspilotScheduleChangeEntitlement({
          schoolId: options.schoolId,
          now,
          dbInstance: transactionDb,
        });
      } catch (error) {
        if (!isClasspilotScheduleChangeEntitlementError(error)) throw error;
        entitlementUnavailable = true;
      }
    }
    await lockClasspilotScheduleChangeSettingsRow(
      options.schoolId,
      transactionDb
    );
    const lockedGroups = await lockScheduleChangeGroups(
      options.schoolId,
      candidateLegs.map((leg) => leg.groupId),
      transactionDb
    );
    const [pair] = await tx
      .select()
      .from(classpilotScheduleChangePairs)
      .where(
        and(
          eq(classpilotScheduleChangePairs.schoolId, options.schoolId),
          eq(classpilotScheduleChangePairs.id, candidate.pairId)
        )
      )
      .limit(1)
      .for("update");
    const locked = await loadLockedScheduleChangeWithLegs({
      schoolId: options.schoolId,
      changeId: options.changeId,
      dbInstance: transactionDb,
    });
    if (!locked) {
      throw scheduleChangeError(
        "SCHEDULE_CHANGE_NOT_FOUND",
        "Schedule change not found.",
        404
      );
    }
    if (locked.change.revision !== options.expectedRevision) {
      return { status: "revision_conflict" as const, change: locked.change };
    }
    const groupsById = new Map(lockedGroups.map((group) => [group.id, group]));
    if (options.actor.role === "teacher") {
      const groupIds = lockedGroups.map((group) => group.id);
      const assignments = await tx
        .select({ teacherId: groupTeachers.teacherId })
        .from(groupTeachers)
        .where(
          and(
            inArray(groupTeachers.groupId, groupIds),
            eq(groupTeachers.teacherId, options.actor.userId)
          )
        )
        .limit(1);
      const relevant =
        lockedGroups.some((group) => group.teacherId === options.actor.userId) ||
        assignments.length > 0 ||
        locked.change.requestedByUserId === options.actor.userId ||
        locked.change.counterpartTeacherId === options.actor.userId;
      if (!relevant) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_NOT_FOUND",
          "Schedule change not found.",
          404
        );
      }
    }

    const terminalizeDrift = async (
      status: "superseded" | "expired",
      reasonCode: string
    ): Promise<ApplyClasspilotScheduleChangeActionResult> => {
      const saved = await markScheduleChangeTerminal({
        schoolId: options.schoolId,
        change: locked.change,
        status,
        actor: options.actor,
        reason: reasonCode,
        now,
        dbInstance: transactionDb,
      });
      await tx.insert(auditLogs).values({
        schoolId: options.schoolId,
        userId: options.actor.userId,
        userEmail: options.actor.userEmail ?? null,
        userRole: options.actor.role,
        action: `classpilot.schedule_change.${status}`,
        entityType: "classpilot_schedule_change",
        entityId: saved.id,
        changes: { status },
        metadata: { reasonCode, revision: saved.revision },
      });
      return { status, change: saved };
    };

    let saved: ClasspilotScheduleChange;
    if (options.action === "accept") {
      if (
        locked.change.status !== "pending_counterpart" ||
        locked.change.counterpartTeacherId !== options.actor.userId ||
        options.actor.role === "office_staff"
      ) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "You cannot accept this schedule change.",
          403
        );
      }
      if (entitlementUnavailable) {
        return terminalizeDrift("superseded", "classpilot_entitlement_unavailable");
      }
      if (!pair || pair.status !== "active" || !scheduleChangeSnapshotMatches(groupsById, locked.legs)) {
        return terminalizeDrift("superseded", "class_configuration_changed");
      }
      const validation = await validateScheduleChangeForDate({
        schoolId: options.schoolId,
        pair,
        scheduledDate: locked.change.scheduledDate,
        actor: options.actor,
        mode: "approval",
        now,
        dbInstance: transactionDb,
      });
      if (validation.blockers.length > 0) {
        const first = validation.blockers[0]!;
        const expirationCodes = new Set([
          "SCHEDULE_CHANGE_DATE_PASSED",
          "SCHEDULE_CHANGE_ALREADY_STARTED",
          "SCHEDULE_CHANGE_OCCURRENCE_EXISTS",
        ]);
        return terminalizeDrift(
          expirationCodes.has(first.code) ? "expired" : "superseded",
          first.code.toLowerCase().slice(0, 100)
        );
      }
      try {
        await assertActiveClasspilotScheduleChangeEntitlement({
          schoolId: options.schoolId,
          now,
          through: localDateTimeUtc(
            locked.change.scheduledDate,
            locked.legs.map((leg) => leg.effectiveEndTime).sort().at(-1)!,
            validation.context?.policy.schoolTimezone || locked.change.timezoneSnapshot
          ),
          dbInstance: transactionDb,
        });
      } catch (error) {
        if (!isClasspilotScheduleChangeEntitlementError(error)) throw error;
        return terminalizeDrift("superseded", "classpilot_entitlement_ends_before_event");
      }
      const nextStatus = locked.change.requiresAdminApproval ? "pending_admin" : "approved";
      const [accepted] = await tx
        .update(classpilotScheduleChanges)
        .set({
          status: nextStatus,
          acceptedByUserId: options.actor.userId,
          acceptedAt: now,
          approvedByUserId: nextStatus === "approved" ? options.actor.userId : null,
          approvedAt: nextStatus === "approved" ? now : null,
          revision: locked.change.revision + 1,
          updatedAt: now,
        })
        .where(eq(classpilotScheduleChanges.id, locked.change.id))
        .returning();
      saved = accepted!;
    } else if (options.action === "approve") {
      if (!isAdmin || locked.change.status !== "pending_admin") {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "Only an administrator may approve this schedule change.",
          403
        );
      }
      if (entitlementUnavailable) {
        return terminalizeDrift("superseded", "classpilot_entitlement_unavailable");
      }
      if (!pair || pair.status !== "active" || !scheduleChangeSnapshotMatches(groupsById, locked.legs)) {
        return terminalizeDrift("superseded", "class_configuration_changed");
      }
      const validation = await validateScheduleChangeForDate({
        schoolId: options.schoolId,
        pair,
        scheduledDate: locked.change.scheduledDate,
        actor: options.actor,
        mode: "approval",
        now,
        dbInstance: transactionDb,
      });
      if (validation.blockers.length > 0) {
        const first = validation.blockers[0]!;
        const expirationCodes = new Set([
          "SCHEDULE_CHANGE_DATE_PASSED",
          "SCHEDULE_CHANGE_ALREADY_STARTED",
          "SCHEDULE_CHANGE_OCCURRENCE_EXISTS",
        ]);
        return terminalizeDrift(
          expirationCodes.has(first.code) ? "expired" : "superseded",
          first.code.toLowerCase().slice(0, 100)
        );
      }
      try {
        await assertActiveClasspilotScheduleChangeEntitlement({
          schoolId: options.schoolId,
          now,
          through: localDateTimeUtc(
            locked.change.scheduledDate,
            locked.legs.map((leg) => leg.effectiveEndTime).sort().at(-1)!,
            validation.context?.policy.schoolTimezone || locked.change.timezoneSnapshot
          ),
          dbInstance: transactionDb,
        });
      } catch (error) {
        if (!isClasspilotScheduleChangeEntitlementError(error)) throw error;
        return terminalizeDrift("superseded", "classpilot_entitlement_ends_before_event");
      }
      const [approved] = await tx
        .update(classpilotScheduleChanges)
        .set({
          status: "approved",
          approvedByUserId: options.actor.userId,
          approvedAt: now,
          revision: locked.change.revision + 1,
          updatedAt: now,
        })
        .where(eq(classpilotScheduleChanges.id, locked.change.id))
        .returning();
      saved = approved!;
    } else if (options.action === "withdraw") {
      if (
        locked.change.requestedByUserId !== options.actor.userId ||
        !CP_SCHEDULE_CHANGE_PENDING_STATUSES.includes(
          locked.change.status as (typeof CP_SCHEDULE_CHANGE_PENDING_STATUSES)[number]
        )
      ) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "Only the requester may withdraw a pending schedule change.",
          403
        );
      }
      saved = await markScheduleChangeTerminal({
        schoolId: options.schoolId,
        change: locked.change,
        status: "cancelled",
        actor: options.actor,
        reason: terminalActionReason(options.action, options.reason),
        now,
        dbInstance: transactionDb,
      });
    } else if (options.action === "decline") {
      if (
        locked.change.status !== "pending_counterpart" ||
        locked.change.counterpartTeacherId !== options.actor.userId ||
        options.actor.role === "office_staff"
      ) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "You cannot decline this schedule change.",
          403
        );
      }
      saved = await markScheduleChangeTerminal({
        schoolId: options.schoolId,
        change: locked.change,
        status: "declined",
        actor: options.actor,
        reason: terminalActionReason(options.action, options.reason),
        now,
        dbInstance: transactionDb,
      });
    } else if (options.action === "deny") {
      if (!isAdmin || locked.change.status !== "pending_admin") {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "Only an administrator may deny this schedule change.",
          403
        );
      }
      saved = await markScheduleChangeTerminal({
        schoolId: options.schoolId,
        change: locked.change,
        status: "denied",
        actor: options.actor,
        reason: terminalActionReason(options.action, options.reason),
        now,
        dbInstance: transactionDb,
      });
    } else {
      if (!isAdmin || locked.change.status !== "approved") {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ACTION_FORBIDDEN",
          "Only an administrator may cancel an approved schedule change.",
          403
        );
      }
      const earliestStart = locked.legs
        .map((leg) => leg.effectiveStartTime)
        .sort()[0]!;
      const currentPolicy = await getClasspilotScheduleChangeSettings(
        options.schoolId,
        transactionDb
      );
      const currentTimezone = currentPolicy?.schoolTimezone || "America/New_York";
      if (
        now.getTime() >=
        localDateTimeUtc(
          locked.change.scheduledDate,
          earliestStart,
          currentTimezone
        ).getTime()
      ) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_ALREADY_STARTED",
          "Approved changes cannot be cancelled after either class period begins.",
          409
        );
      }
      const [occurrence] = await tx
        .select({ id: teachingSessions.id })
        .from(teachingSessions)
        .where(
          and(
            eq(teachingSessions.schoolId, options.schoolId),
            eq(teachingSessions.scheduledDate, locked.change.scheduledDate),
            inArray(
              teachingSessions.groupId,
              locked.legs.map((leg) => leg.groupId)
            )
          )
        )
        .limit(1);
      if (occurrence) {
        throw scheduleChangeError(
          "SCHEDULE_CHANGE_OCCURRENCE_EXISTS",
          "This schedule change has already created a class occurrence.",
          409
        );
      }
      saved = await markScheduleChangeTerminal({
        schoolId: options.schoolId,
        change: locked.change,
        status: "cancelled",
        actor: options.actor,
        reason: terminalActionReason(options.action, options.reason),
        now,
        dbInstance: transactionDb,
      });
    }
    await tx.insert(auditLogs).values({
      schoolId: options.schoolId,
      userId: options.actor.userId,
      userEmail: options.actor.userEmail ?? null,
      userRole: options.actor.role,
      action: `classpilot.schedule_change.${options.action}`,
      entityType: "classpilot_schedule_change",
      entityId: saved.id,
      changes: { from: locked.change.status, to: saved.status },
      metadata: { revision: saved.revision, scheduledDate: saved.scheduledDate },
    });
    return { status: "saved" as const, change: saved };
  });
}

function scheduleChangeAllowedActions(options: {
  change: ClasspilotScheduleChange;
  legs: ClasspilotScheduleChangeLeg[];
  actor: ClasspilotScheduleChangeActor;
  now: Date;
  currentTimezone: string;
}): ClasspilotScheduleChangeAllowedAction[] {
  const actions: ClasspilotScheduleChangeAllowedAction[] = [];
  const isAdmin = options.actor.role === "admin" || options.actor.role === "school_admin";
  if (
    options.change.status === "pending_counterpart" &&
    options.change.counterpartTeacherId === options.actor.userId &&
    options.actor.role !== "office_staff"
  ) {
    actions.push("accept", "decline");
  }
  if (
    CP_SCHEDULE_CHANGE_PENDING_STATUSES.includes(
      options.change.status as (typeof CP_SCHEDULE_CHANGE_PENDING_STATUSES)[number]
    ) &&
    options.change.requestedByUserId === options.actor.userId
  ) {
    actions.push("withdraw");
  }
  if (options.change.status === "pending_admin" && isAdmin) {
    actions.push("approve", "deny");
  }
  if (options.change.status === "approved" && isAdmin) {
    const earliestStart = options.legs.map((leg) => leg.effectiveStartTime).sort()[0];
    if (
      earliestStart &&
      options.now.getTime() <
        localDateTimeUtc(
          options.change.scheduledDate,
          earliestStart,
          options.currentTimezone
        ).getTime()
    ) {
      actions.push("cancel");
    }
  }
  return actions;
}

async function hydrateClasspilotScheduleChanges(options: {
  schoolId: string;
  changes: ClasspilotScheduleChange[];
  actor: ClasspilotScheduleChangeActor;
  now: Date;
  schoolTimezone: string;
  dbInstance: ScheduleChangeDb;
}): Promise<ClasspilotScheduleChangeDto[]> {
  if (options.changes.length === 0) return [];
  const changeIds = options.changes.map((change) => change.id);
  const legs = await options.dbInstance
    .select()
    .from(classpilotScheduleChangeLegs)
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        inArray(classpilotScheduleChangeLegs.scheduleChangeId, changeIds)
      )
    )
    .orderBy(
      asc(classpilotScheduleChangeLegs.scheduleChangeId),
      asc(classpilotScheduleChangeLegs.legOrder)
    );
  const userIds = Array.from(
    new Set([
      ...options.changes.map((change) => change.requestedByUserId),
      ...legs.map((leg) => leg.primaryTeacherIdSnapshot),
    ])
  );
  const userRows = userIds.length
    ? await options.dbInstance
        .select({
          id: users.id,
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const usersById = new Map(userRows.map((user) => [user.id, user]));
  const legsByChange = new Map<string, ClasspilotScheduleChangeLeg[]>();
  for (const leg of legs) {
    const existing = legsByChange.get(leg.scheduleChangeId) ?? [];
    existing.push(leg);
    legsByChange.set(leg.scheduleChangeId, existing);
  }
  return options.changes.flatMap((change) => {
    const changeLegs = legsByChange.get(change.id) ?? [];
    if (changeLegs.length !== 2) return [];
    const requester = usersById.get(change.requestedByUserId);
    return [{
      id: change.id,
      pairId: change.pairId,
      scheduledDate: change.scheduledDate,
      schoolTimezone: options.schoolTimezone,
      status: change.status as ClasspilotScheduleChangeStatus,
      reason: change.reason,
      revision: change.revision,
      requestedBy: {
        id: change.requestedByUserId,
        name: scheduleChangeDisplayName(requester),
      },
      nextActor:
        change.status === "pending_counterpart"
          ? "counterpart_teacher"
          : change.status === "pending_admin"
            ? "administrator"
            : null,
      legs: changeLegs.map((leg) => ({
        class: { id: leg.groupId, name: leg.classNameSnapshot },
        primaryTeacher: {
          id: leg.primaryTeacherIdSnapshot,
          name: scheduleChangeDisplayName(usersById.get(leg.primaryTeacherIdSnapshot)),
        },
        normalWindow: {
          startTime: leg.originalStartTime,
          endTime: leg.originalEndTime,
        },
        effectiveWindow: {
          startTime: leg.effectiveStartTime,
          endTime: leg.effectiveEndTime,
        },
      })),
      allowedActions: scheduleChangeAllowedActions({
        change,
        legs: changeLegs,
        actor: options.actor,
        now: options.now,
        currentTimezone: options.schoolTimezone,
      }),
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    }];
  });
}

export async function listClasspilotScheduleChanges(options: {
  schoolId: string;
  actor: ClasspilotScheduleChangeActor;
  scope?: "needs_action" | "upcoming" | "history" | "all";
  now?: Date;
  limit?: number;
}): Promise<{ changes: ClasspilotScheduleChangeDto[]; schoolTimezone: string }> {
  const now = options.now ?? new Date();
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId);
  if (!policy) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
      "Schedule-change settings are unavailable.",
      500
    );
  }
  const visibleGroups = await scheduleChangeVisibleGroupIds(
    options.schoolId,
    options.actor,
    db
  );
  const queryConditions: SQL[] = [
    eq(classpilotScheduleChanges.schoolId, options.schoolId),
  ];
  if (visibleGroups) {
    const visibleIds = [...visibleGroups];
    queryConditions.push(
      or(
        eq(classpilotScheduleChanges.requestedByUserId, options.actor.userId),
        eq(classpilotScheduleChanges.counterpartTeacherId, options.actor.userId),
        visibleIds.length > 0
          ? sql`EXISTS (
              SELECT 1
              FROM classpilot_schedule_change_legs visible_leg
              WHERE visible_leg.school_id = ${options.schoolId}
                AND visible_leg.schedule_change_id = ${classpilotScheduleChanges.id}
                AND visible_leg.group_id IN (${sql.join(
                  visibleIds.map((id) => sql`${id}`),
                  sql`, `
                )})
            )`
          : sql`false`
      )!
    );
  }
  const localToday = localDateInTimeZone(now, policy.schoolTimezone);
  const terminalStatuses: ClasspilotScheduleChangeStatus[] = [
    "declined",
    "denied",
    "cancelled",
    "expired",
    "superseded",
  ];
  const scope = options.scope ?? "upcoming";
  if (scope === "needs_action") {
    queryConditions.push(
      or(
        and(
          eq(classpilotScheduleChanges.status, "pending_counterpart"),
          eq(classpilotScheduleChanges.counterpartTeacherId, options.actor.userId)
        ),
        options.actor.role === "admin" || options.actor.role === "school_admin"
          ? eq(classpilotScheduleChanges.status, "pending_admin")
          : sql`false`
      )!
    );
  } else if (scope === "history") {
    queryConditions.push(
      or(
        inArray(classpilotScheduleChanges.status, terminalStatuses),
        lt(classpilotScheduleChanges.scheduledDate, localToday)
      )!
    );
  } else if (scope === "upcoming") {
    queryConditions.push(
      and(
        inArray(classpilotScheduleChanges.status, [
          ...CP_SCHEDULE_CHANGE_ACTIVE_STATUSES,
        ]),
        sql`${classpilotScheduleChanges.scheduledDate} >= ${localToday}`
      )!
    );
  }
  const rows = await db
    .select()
    .from(classpilotScheduleChanges)
    .where(and(...queryConditions))
    .orderBy(desc(classpilotScheduleChanges.scheduledDate), desc(classpilotScheduleChanges.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 250, 1), 500));
  const hydrated = await hydrateClasspilotScheduleChanges({
    schoolId: options.schoolId,
    changes: rows,
    actor: options.actor,
    now,
    schoolTimezone: policy.schoolTimezone,
    dbInstance: db,
  });
  const terminal = new Set<ClasspilotScheduleChangeStatus>([
    "declined",
    "denied",
    "cancelled",
    "expired",
    "superseded",
  ]);
  const filtered = hydrated.filter((change) => {
    if (scope === "all") return true;
    if (scope === "needs_action") {
      return change.allowedActions.some((action) =>
        ["accept", "decline", "approve", "deny"].includes(action)
      );
    }
    if (scope === "history") {
      return terminal.has(change.status) || change.scheduledDate < localToday;
    }
    return !terminal.has(change.status) && change.scheduledDate >= localToday;
  });
  return { changes: filtered, schoolTimezone: policy.schoolTimezone };
}

export async function getClasspilotScheduleChangeById(options: {
  schoolId: string;
  changeId: string;
  actor: ClasspilotScheduleChangeActor;
  now?: Date;
}): Promise<ClasspilotScheduleChangeDto | undefined> {
  const [row] = await db
    .select()
    .from(classpilotScheduleChanges)
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.id, options.changeId)
      )
    )
    .limit(1);
  if (!row) return undefined;
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId);
  if (!policy) return undefined;
  const [dto] = await hydrateClasspilotScheduleChanges({
    schoolId: options.schoolId,
    changes: [row],
    actor: options.actor,
    now: options.now ?? new Date(),
    schoolTimezone: policy.schoolTimezone,
    dbInstance: db,
  });
  if (!dto) return undefined;
  if (options.actor.role === "teacher") {
    const visible = await scheduleChangeVisibleGroupIds(options.schoolId, options.actor, db);
    const involved = dto.legs.some((leg) => visible?.has(leg.class.id));
    if (
      !involved &&
      dto.requestedBy.id !== options.actor.userId &&
      row.counterpartTeacherId !== options.actor.userId
    ) {
      return undefined;
    }
  }
  return dto;
}

export async function getClasspilotScheduleChangesToday(options: {
  schoolId: string;
  actor: ClasspilotScheduleChangeActor;
  now?: Date;
}): Promise<{
  scheduledDate: string;
  schoolTimezone: string;
  changes: Array<{
    id: string;
    class: { id: string; name: string };
    normalWindow: ClasspilotScheduleWindowDto;
    effectiveWindow: ClasspilotScheduleWindowDto;
  }>;
  lastAffectedEndAt: string | null;
}> {
  const now = options.now ?? new Date();
  const policy = await getClasspilotScheduleChangeSettings(options.schoolId);
  if (!policy) {
    throw scheduleChangeError(
      "SCHEDULE_CHANGE_SETTINGS_UNAVAILABLE",
      "Schedule-change settings are unavailable.",
      500
    );
  }
  const scheduledDate = localDateInTimeZone(now, policy.schoolTimezone);
  const visibleGroups = await scheduleChangeVisibleGroupIds(
    options.schoolId,
    options.actor,
    db
  );
  const todayConditions: SQL[] = [
    eq(classpilotScheduleChanges.schoolId, options.schoolId),
    eq(classpilotScheduleChanges.scheduledDate, scheduledDate),
    eq(classpilotScheduleChanges.status, "approved"),
    eq(classpilotScheduleChanges.reservationActive, true),
  ];
  if (visibleGroups) {
    const visibleIds = [...visibleGroups];
    todayConditions.push(
      visibleIds.length > 0
        ? sql`EXISTS (
            SELECT 1
            FROM classpilot_schedule_change_legs visible_leg
            WHERE visible_leg.school_id = ${options.schoolId}
              AND visible_leg.schedule_change_id = ${classpilotScheduleChanges.id}
              AND visible_leg.group_id IN (${sql.join(
                visibleIds.map((id) => sql`${id}`),
                sql`, `
              )})
          )`
        : sql`false`
    );
  }
  const todayRows = await db
    .select()
    .from(classpilotScheduleChanges)
    .where(and(...todayConditions))
    .orderBy(asc(classpilotScheduleChanges.id));
  const approved = await hydrateClasspilotScheduleChanges({
    schoolId: options.schoolId,
    changes: todayRows,
    actor: options.actor,
    now,
    schoolTimezone: policy.schoolTimezone,
    dbInstance: db,
  });
  let projected = approved.flatMap((change) =>
    change.legs.map((leg) => ({
      id: change.id,
      class: leg.class,
      normalWindow: leg.normalWindow,
      effectiveWindow: leg.effectiveWindow,
    }))
  );
  if (options.actor.role === "teacher") {
    const visibleGroups = await scheduleChangeVisibleGroupIds(
      options.schoolId,
      options.actor,
      db
    );
    projected = projected.filter((item) => visibleGroups?.has(item.class.id));
  }
  const endInstants = projected.map((item) =>
    localDateTimeUtc(
      scheduledDate,
      item.effectiveWindow.endTime,
      policy.schoolTimezone
    )
  );
  const lastEnd = endInstants.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    scheduledDate,
    schoolTimezone: policy.schoolTimezone,
    changes: lastEnd && lastEnd.getTime() > now.getTime() ? projected : [],
    lastAffectedEndAt: lastEnd?.toISOString() ?? null,
  };
}

export async function getClasspilotScheduleChangeNotificationContext(options: {
  schoolId: string;
  changeId: string;
  dbInstance?: ScheduleChangeDb;
}): Promise<{
  scheduledDate: string;
  status: string;
  classNames: string[];
  recipientEmails: string[];
} | undefined> {
  const dbInstance = options.dbInstance ?? db;
  const [change] = await dbInstance
    .select({
      scheduledDate: classpilotScheduleChanges.scheduledDate,
      status: classpilotScheduleChanges.status,
    })
    .from(classpilotScheduleChanges)
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, options.schoolId),
        eq(classpilotScheduleChanges.id, options.changeId)
      )
    )
    .limit(1);
  if (!change) return undefined;
  const legRows = await dbInstance
    .select({
      className: classpilotScheduleChangeLegs.classNameSnapshot,
      teacherId: classpilotScheduleChangeLegs.primaryTeacherIdSnapshot,
    })
    .from(classpilotScheduleChangeLegs)
    .where(
      and(
        eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.scheduleChangeId, options.changeId)
      )
    );
  const adminRows = await dbInstance
    .select({ userId: schoolMemberships.userId })
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.schoolId, options.schoolId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin"])
      )
    );
  const recipientIds = Array.from(
    new Set([
      ...legRows.map((leg) => leg.teacherId),
      ...adminRows.map((membership) => membership.userId),
    ])
  );
  const recipientRows = recipientIds.length
    ? await dbInstance
        .select({ email: users.email })
        .from(users)
        .where(inArray(users.id, recipientIds))
    : [];
  return {
    scheduledDate: change.scheduledDate,
    status: change.status,
    classNames: legRows.map((leg) => leg.className),
    recipientEmails: Array.from(
      new Set(recipientRows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))
    ),
  };
}
