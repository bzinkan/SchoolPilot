import { eq, and, desc, asc, ilike, or, isNull, inArray, sql, ne, type SQL } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
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
  polls,
  pollResponses,
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
  type Poll,
  type InsertPoll,
  type PollResponse,
  type InsertPollResponse,
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
  groupTeachers,
  type GroupTeacher,
  type InsertGroupTeacher,
} from "../schema/classpilot.js";
import {
  settings,
  googleOAuthTokens,
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
  type GoogleOAuthToken,
  type InsertGoogleOAuthToken,
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

export async function getUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
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
  id: string
): Promise<School | undefined> {
  const [school] = await db
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
      const existing = await getSchoolBySlug(slug);
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
        eq(schoolMemberships.status, "active")
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

export async function deleteStudent(id: string): Promise<boolean> {
  const result = await db.delete(students).where(eq(students.id, id));
  return (result.rowCount ?? 0) > 0;
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
    conditions.push(eq(students.gradeId, options.gradeId));
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

export async function updateSchool(
  id: string,
  data: Partial<InsertSchool>
): Promise<School | undefined> {
  const [school] = await db
    .update(schools)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schools.id, id))
    .returning();
  return school;
}

export async function softDeleteSchool(
  id: string
): Promise<School | undefined> {
  const [school] = await db
    .update(schools)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schools.id, id))
    .returning();
  return school;
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

export async function getMembershipByUserAndSchool(
  userId: string,
  schoolId: string
): Promise<SchoolMembership | undefined> {
  const [membership] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);
  return membership;
}

export async function updateMembership(
  id: string,
  data: Partial<InsertSchoolMembership>
): Promise<SchoolMembership | undefined> {
  const [existing] = await db.select().from(schoolMemberships).where(eq(schoolMemberships.id, id)).limit(1);
  if (existing) {
    await assertStaffMembershipEmailDomain({
      userId: data.userId || existing.userId,
      schoolId: data.schoolId || existing.schoolId,
      role: data.role || existing.role,
    });
  }
  const [membership] = await db
    .update(schoolMemberships)
    .set(data)
    .where(eq(schoolMemberships.id, id))
    .returning();
  return membership;
}

export async function deleteMembership(id: string): Promise<boolean> {
  const result = await db
    .update(schoolMemberships)
    .set({ status: "inactive" })
    .where(eq(schoolMemberships.id, id));
  return (result.rowCount ?? 0) > 0;
}

// School-scoped variants — for school-admin (non-super-admin) handlers, so an
// admin can never update/deactivate another school's staff membership by id.
export async function updateMembershipForSchool(
  id: string,
  schoolId: string,
  data: Partial<InsertSchoolMembership>
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
  const [membership] = await db
    .update(schoolMemberships)
    .set(data)
    .where(and(eq(schoolMemberships.id, id), eq(schoolMemberships.schoolId, schoolId)))
    .returning();
  return membership;
}

export async function deleteMembershipForSchool(id: string, schoolId: string): Promise<boolean> {
  const result = await db
    .update(schoolMemberships)
    .set({ status: "inactive" })
    .where(and(eq(schoolMemberships.id, id), eq(schoolMemberships.schoolId, schoolId)));
  return (result.rowCount ?? 0) > 0;
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
  const [grade] = await db.insert(grades).values(data).returning();
  return grade!;
}

export async function updateGrade(
  id: string,
  data: Partial<InsertGrade>
): Promise<Grade | undefined> {
  const [grade] = await db
    .update(grades)
    .set(data)
    .where(eq(grades.id, id))
    .returning();
  return grade;
}

export async function deleteGrade(id: string): Promise<boolean> {
  const result = await db.delete(grades).where(eq(grades.id, id));
  return (result.rowCount ?? 0) > 0;
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
  const [assignment] = await db
    .insert(teacherGrades)
    .values({ teacherId, gradeId })
    .onConflictDoNothing()
    .returning();
  return assignment;
}

export async function removeTeacherGrade(
  teacherId: string,
  gradeId: string
): Promise<boolean> {
  const result = await db
    .delete(teacherGrades)
    .where(
      and(
        eq(teacherGrades.teacherId, teacherId),
        eq(teacherGrades.gradeId, gradeId)
      )
    );
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// Product License operations (extended)
// ============================================================================

export async function updateProductLicense(
  id: string,
  data: Partial<InsertProductLicense>
): Promise<ProductLicense | undefined> {
  const [license] = await db
    .update(productLicenses)
    .set(data)
    .where(eq(productLicenses.id, id))
    .returning();
  return license;
}

export async function deleteProductLicense(id: string): Promise<boolean> {
  const result = await db
    .delete(productLicenses)
    .where(eq(productLicenses.id, id));
  return (result.rowCount ?? 0) > 0;
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
  return db
    .select()
    .from(passes)
    .where(and(eq(passes.schoolId, schoolId), eq(passes.status, "active")))
    .orderBy(desc(passes.issuedAt));
}

export async function getActivePassesByGrade(
  schoolId: string,
  gradeId: string
): Promise<Pass[]> {
  return db
    .select()
    .from(passes)
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.gradeId, gradeId),
        eq(passes.status, "active")
      )
    )
    .orderBy(desc(passes.issuedAt));
}

export async function getActivePassForStudent(
  studentId: string,
  schoolId: string
): Promise<Pass | undefined> {
  const [pass] = await db
    .select()
    .from(passes)
    .where(
      and(
        eq(passes.studentId, studentId),
        eq(passes.schoolId, schoolId),
        eq(passes.status, "active")
      )
    )
    .limit(1);
  return pass;
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

export async function getPassHistory(
  schoolId: string,
  filters: {
    gradeId?: string;
    studentId?: string;
    teacherId?: string;
    startDate?: Date;
    endDate?: Date;
  } = {}
): Promise<Pass[]> {
  const conditions = [eq(passes.schoolId, schoolId)];

  if (filters.gradeId) {
    conditions.push(eq(passes.gradeId, filters.gradeId));
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

  return db
    .select()
    .from(passes)
    .where(and(...conditions))
    .orderBy(desc(passes.issuedAt))
    .limit(2000);
}

export async function createPass(data: InsertPass): Promise<Pass> {
  const [pass] = await db.insert(passes).values(data).returning();
  return pass!;
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
        eq(students.gradeId, gradeId),
        eq(students.status, "active")
      )
    )
    .orderBy(students.lastName, students.firstName);
}

// ============================================================================
// GoPilot - Homeroom operations
// ============================================================================

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
  const [hr] = await db.insert(homerooms).values(data).returning();
  return hr!;
}

export async function updateHomeroom(
  id: string,
  data: Partial<InsertHomeroom>
): Promise<Homeroom | undefined> {
  const [hr] = await db
    .update(homerooms)
    .set(data)
    .where(eq(homerooms.id, id))
    .returning();
  return hr;
}

export async function deleteHomeroom(id: string): Promise<boolean> {
  // Unassign students first
  await db
    .update(students)
    .set({ homeroomId: null })
    .where(eq(students.homeroomId, id));
  const result = await db.delete(homerooms).where(eq(homerooms.id, id));
  return (result.rowCount ?? 0) > 0;
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

  if (existing && existing.status === "completed") {
    // Reset completed session so admin can start a new dismissal today
    // Clear old queue entries first
    await dbInstance
      .delete(dismissalQueue)
      .where(eq(dismissalQueue.sessionId, existing.id));
    const [reset] = await dbInstance
      .update(dismissalSessions)
      .set({ status: "pending", endedAt: null, startedAt: null })
      .where(eq(dismissalSessions.id, existing.id))
      .returning();
    return reset!;
  }
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

// ============================================================================
// GoPilot - Dismissal Queue operations
// ============================================================================

export async function getQueueBySession(
  sessionId: string,
  filterStatus?: string
): Promise<DismissalQueueEntry[]> {
  const conditions = [eq(dismissalQueue.sessionId, sessionId)];
  if (filterStatus) {
    conditions.push(eq(dismissalQueue.status, filterStatus));
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
  data: InsertDismissalQueueEntry
): Promise<DismissalQueueEntry> {
  const [entry] = await db.insert(dismissalQueue).values(data).returning();
  return entry!;
}

export async function updateQueueEntry(
  id: string,
  data: Partial<DismissalQueueEntry>
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .update(dismissalQueue)
    .set(data)
    .where(eq(dismissalQueue.id, id))
    .returning();
  return entry;
}

export async function callQueueEntry(
  id: string,
  zone: string | null
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
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
        inArray(dismissalQueue.status, ["waiting", "called", "held", "delayed"])
      )
    )
    .returning();
  return entry;
}

export async function callNextBatch(
  sessionId: string,
  count: number,
  zone: string | null
): Promise<DismissalQueueEntry[]> {
  // Get IDs of next waiting entries, plus delayed entries whose delay expired.
  const waiting = await db
    .select({ id: dismissalQueue.id })
    .from(dismissalQueue)
    .where(
      and(
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
    .orderBy(dismissalQueue.position)
    .limit(count);

  if (waiting.length === 0) return [];

  const ids = waiting.map((w) => w.id);
  return db
    .update(dismissalQueue)
    .set({
      status: "called",
      zone,
      calledAt: new Date(),
      holdReason: null,
      delayedUntil: null,
    })
    .where(inArray(dismissalQueue.id, ids))
    .returning();
}

export async function releaseQueueEntry(
  id: string
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .update(dismissalQueue)
    .set({ status: "released", releasedAt: new Date() })
    .where(
      and(
        eq(dismissalQueue.id, id),
        eq(dismissalQueue.status, "called")
      )
    )
    .returning();
  return entry;
}

export async function dismissQueueEntry(
  id: string
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .update(dismissalQueue)
    .set({ status: "dismissed", dismissedAt: new Date() })
    .where(
      and(
        eq(dismissalQueue.id, id),
        eq(dismissalQueue.status, "released")
      )
    )
    .returning();
  return entry;
}

export async function batchDismiss(
  queueIds: string[]
): Promise<DismissalQueueEntry[]> {
  return db
    .update(dismissalQueue)
    .set({ status: "dismissed", dismissedAt: new Date() })
    .where(
      and(
        inArray(dismissalQueue.id, queueIds),
        eq(dismissalQueue.status, "released")
      )
    )
    .returning();
}

export async function batchRelease(
  queueIds: string[]
): Promise<DismissalQueueEntry[]> {
  return db
    .update(dismissalQueue)
    .set({ status: "released", releasedAt: new Date() })
    .where(
      and(
        inArray(dismissalQueue.id, queueIds),
        eq(dismissalQueue.status, "called")
      )
    )
    .returning();
}

export async function holdQueueEntry(
  id: string,
  reason: string
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .update(dismissalQueue)
    .set({ status: "held", holdReason: reason })
    .where(eq(dismissalQueue.id, id))
    .returning();
  return entry;
}

export async function delayQueueEntry(
  id: string
): Promise<DismissalQueueEntry | undefined> {
  const [entry] = await db
    .update(dismissalQueue)
    .set({
      status: "delayed",
      delayedUntil: sql`NOW() + INTERVAL '2 minutes'`,
    })
    .where(eq(dismissalQueue.id, id))
    .returning();
  return entry;
}

export async function getSessionStats(sessionId: string) {
  const [stats] = await db
    .select({
      waiting: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'waiting')::int`,
      called: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'called')::int`,
      released: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'released')::int`,
      dismissed: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'dismissed')::int`,
      held: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'held')::int`,
      delayed: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} = 'delayed')::int`,
      total: sql<number>`COUNT(*)::int`,
      avgWaitSeconds: sql<number | null>`AVG(EXTRACT(EPOCH FROM (${dismissalQueue.dismissedAt} - ${dismissalQueue.checkInTime}))) FILTER (WHERE ${dismissalQueue.dismissedAt} IS NOT NULL)`,
    })
    .from(dismissalQueue)
    .where(eq(dismissalQueue.sessionId, sessionId));
  return stats;
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
  data: InsertDismissalChange
): Promise<DismissalChange> {
  const [change] = await db.insert(dismissalChanges).values(data).returning();
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
  data: InsertAuthorizedPickup
): Promise<AuthorizedPickup> {
  const [p] = await db.insert(authorizedPickups).values(data).returning();
  return p!;
}

export async function updatePickupStatus(
  id: string,
  status: string
): Promise<AuthorizedPickup | undefined> {
  const [p] = await db
    .update(authorizedPickups)
    .set({ status })
    .where(eq(authorizedPickups.id, id))
    .returning();
  return p;
}

export async function revokePickup(id: string): Promise<void> {
  await db
    .update(authorizedPickups)
    .set({ status: "revoked" })
    .where(eq(authorizedPickups.id, id));
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
      studentId: custodyAlerts.studentId,
      personName: custodyAlerts.personName,
      alertType: custodyAlerts.alertType,
      notes: custodyAlerts.notes,
      courtOrder: custodyAlerts.courtOrder,
      createdBy: custodyAlerts.createdBy,
      active: custodyAlerts.active,
      createdAt: custodyAlerts.createdAt,
    })
    .from(custodyAlerts)
    .innerJoin(students, eq(students.id, custodyAlerts.studentId))
    .where(
      and(eq(students.schoolId, schoolId), eq(custodyAlerts.active, true))
    )
    .orderBy(desc(custodyAlerts.createdAt));
  return rows as CustodyAlert[];
}

export async function createCustodyAlert(
  data: InsertCustodyAlert
): Promise<CustodyAlert> {
  const [alert] = await db.insert(custodyAlerts).values(data).returning();
  return alert!;
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

export async function deleteFamilyGroup(id: string): Promise<void> {
  await db
    .delete(familyGroupStudents)
    .where(eq(familyGroupStudents.familyGroupId, id));
  await db.delete(familyGroups).where(eq(familyGroups.id, id));
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

export async function addStudentsToFamilyGroup(
  familyGroupId: string,
  studentIds: string[]
): Promise<void> {
  for (const sid of studentIds) {
    await db
      .insert(familyGroupStudents)
      .values({ familyGroupId, studentId: sid })
      .onConflictDoNothing();
  }
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
  await db
    .delete(familyGroupStudents)
    .where(eq(familyGroupStudents.familyGroupId, familyGroupId));
  for (const sid of studentIds) {
    await db
      .insert(familyGroupStudents)
      .values({ familyGroupId, studentId: sid })
      .onConflictDoNothing();
  }
}

export async function getUnassignedStudents(
  schoolId: string
): Promise<Student[]> {
  const assigned = db
    .select({ studentId: familyGroupStudents.studentId })
    .from(familyGroupStudents);

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
  const crypto = await import("crypto");

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
      const inviteToken = crypto.randomBytes(32).toString("hex");
      const group = await createFamilyGroup({
        schoolId,
        carNumber: carNum,
        familyName,
        inviteToken,
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
  const [row] = await db
    .insert(familyGroupStudents)
    .values({ familyGroupId, studentId })
    .onConflictDoNothing()
    .returning();
  return row!;
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
  data: InsertDismissalQueueEntry[]
): Promise<DismissalQueueEntry[]> {
  if (data.length === 0) return [];
  return db.insert(dismissalQueue).values(data).returning();
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
    .where(eq(studentDevices.deviceId, deviceId));
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
        eq(studentSessions.isActive, true)
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
  // End any active session for this device
  await db
    .update(studentSessions)
    .set({ isActive: false, endedAt: new Date() })
    .where(
      and(
        eq(studentSessions.deviceId, deviceId),
        eq(studentSessions.isActive, true)
      )
    );
  // Start new session
  const [session] = await db
    .insert(studentSessions)
    .values({ studentId, deviceId })
    .returning();
  return session!;
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

export async function updateHeartbeatClassification(
  heartbeatId: string,
  aiCategory: string,
  safetyAlert: string | null
): Promise<void> {
  await db.update(heartbeats).set({ aiCategory, safetyAlert }).where(eq(heartbeats.id, heartbeatId));
}

export async function getHeartbeatsByDevice(
  deviceId: string,
  limit = 50
): Promise<Heartbeat[]> {
  return db
    .select()
    .from(heartbeats)
    .where(eq(heartbeats.deviceId, deviceId))
    .orderBy(desc(heartbeats.timestamp))
    .limit(limit);
}

export async function getHeartbeatsByDeviceInRange(
  deviceId: string,
  startTime: Date,
  endTime: Date
): Promise<Heartbeat[]> {
  return db
    .select()
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.deviceId, deviceId),
        sql`${heartbeats.timestamp} >= ${startTime}`,
        sql`${heartbeats.timestamp} <= ${endTime}`
      )
    )
    .orderBy(desc(heartbeats.timestamp));
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
        inArray(heartbeats.studentId, studentIds),
        sql`${heartbeats.timestamp} >= ${startTime}`,
        sql`${heartbeats.timestamp} <= ${endTime}`
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
  studentId: string,
  deviceId: string
): Promise<StudentSession> {
  // End any active sessions for this student OR this device
  await db
    .update(studentSessions)
    .set({ isActive: false, endedAt: new Date() })
    .where(
      and(
        or(
          eq(studentSessions.studentId, studentId),
          eq(studentSessions.deviceId, deviceId)
        ),
        eq(studentSessions.isActive, true)
      )
    );

  const [session] = await db
    .insert(studentSessions)
    .values({ studentId, deviceId })
    .returning();
  return session!;
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
  const [session] = await db
    .select()
    .from(studentSessions)
    .where(
      and(
        eq(studentSessions.studentId, studentId),
        eq(studentSessions.isActive, true)
      )
    )
    .limit(1);
  return session;
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
        eq(studentSessions.isActive, true)
      )
    );
  return rows.map((r) => ({ ...r.session, student: r.student }));
}

// ============================================================================
// ClassPilot - Teaching Session operations
// ============================================================================

export async function createTeachingSession(
  data: { groupId: string; teacherId: string },
  dbInstance: typeof db = db
): Promise<TeachingSession> {
  // teaching_sessions.school_id must mirror the parent group's school (RLS
  // WITH CHECK requires it). Derive it from the group rather than trusting the
  // caller, so it can never be omitted or mismatched. Under a request GUC the
  // group lookup only resolves the caller's own school; the scheduler passes
  // schedulerDb (is_super) so it resolves across schools.
  const [group] = await dbInstance
    .select({ schoolId: groups.schoolId })
    .from(groups)
    .where(eq(groups.id, data.groupId))
    .limit(1);
  if (!group) {
    throw new Error(`createTeachingSession: group ${data.groupId} not found`);
  }
  const [session] = await dbInstance
    .insert(teachingSessions)
    .values({ ...data, schoolId: group.schoolId })
    .returning();
  return session!;
}

export async function endTeachingSession(
  sessionId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [session] = await dbInstance
    .update(teachingSessions)
    .set({ endTime: new Date() })
    .where(eq(teachingSessions.id, sessionId))
    .returning();
  return session;
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
      endTime: teachingSessions.endTime,
      createdAt: teachingSessions.createdAt,
    })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(
      and(
        eq(groups.schoolId, schoolId),
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
        isNull(teachingSessions.endTime)
      )
    )
    .limit(1);
  return session;
}

// School-scoped active session. This returns the teacher's active session only
// in the given school, which is the correct multi-tenant semantics.
export async function getActiveTeachingSessionForSchool(
  teacherId: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<TeachingSession | undefined> {
  const [row] = await dbInstance
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(
      and(
        eq(teachingSessions.teacherId, teacherId),
        eq(groups.schoolId, schoolId),
        isNull(teachingSessions.endTime)
      )
    )
    .limit(1);
  return row?.session;
}

export async function getTeachingSessionById(
  sessionId: string
): Promise<TeachingSession | undefined> {
  const [session] = await db
    .select()
    .from(teachingSessions)
    .where(eq(teachingSessions.id, sessionId))
    .limit(1);
  return session;
}

// Returns the session only if it belongs to the given school.
export async function getTeachingSessionByIdAndSchool(
  sessionId: string,
  schoolId: string
): Promise<TeachingSession | undefined> {
  const [row] = await db
    .select({ session: teachingSessions })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .where(and(eq(teachingSessions.id, sessionId), eq(groups.schoolId, schoolId)))
    .limit(1);
  return row?.session;
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
    );
}

export async function getScheduledGroupsReadyToEnd(
  schoolId: string,
  currentTimeHHMM: string,
  dbInstance: typeof db = db
): Promise<(Group & { sessionId: string })[]> {
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
  return rows as (Group & { sessionId: string })[];
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
      studentCount: sql<number>`COUNT(DISTINCT ${groupStudents.studentId})::int`,
    })
    .from(groups)
    .leftJoin(groupStudents, eq(groupStudents.groupId, groups.id))
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
  role: string = "co-teacher"
): Promise<GroupTeacher> {
  const [row] = await db
    .insert(groupTeachers)
    .values({ groupId, teacherId, role })
    .onConflictDoNothing()
    .returning();
  return row!;
}

export async function replaceGroupTeachers(
  groupId: string,
  primaryTeacherId: string,
  coTeacherIds: string[]
): Promise<void> {
  const uniqueCoTeachers = Array.from(
    new Set(coTeacherIds.filter((id) => id && id !== primaryTeacherId))
  );
  await db.transaction(async (tx) => {
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
  const result = await db
    .delete(groupTeachers)
    .where(
      and(eq(groupTeachers.groupId, groupId), eq(groupTeachers.teacherId, teacherId))
    );
  return (result.rowCount ?? 0) > 0;
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
  const [row] = await db
    .insert(homeroomTeachers)
    .values({ homeroomId, teacherId, role })
    .onConflictDoNothing()
    .returning();
  return row!;
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
  schoolId: string
): Promise<Group | undefined> {
  const [group] = await db
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

export async function createGroup(
  data: InsertGroup
): Promise<Group> {
  const [group] = await db.insert(groups).values(data).returning();
  return group!;
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
  data: Partial<InsertGroup>
): Promise<Group | undefined> {
  const [group] = await db
    .update(groups)
    .set(data)
    .where(eq(groups.id, groupId))
    .returning();
  return group;
}

export async function updateAdminClassWithTeachers(options: {
  groupId: string;
  data: Partial<InsertGroup>;
  primaryTeacherId: string;
  coTeacherIds: string[];
}): Promise<Group | undefined> {
  const uniqueCoTeachers = Array.from(
    new Set(options.coTeacherIds.filter((id) => id && id !== options.primaryTeacherId))
  );
  return db.transaction(async (tx) => {
    const [group] = await tx
      .update(groups)
      .set({
        ...options.data,
        teacherId: options.primaryTeacherId,
      })
      .where(eq(groups.id, options.groupId))
      .returning();
    if (!group) return undefined;

    await tx
      .delete(groupTeachers)
      .where(eq(groupTeachers.groupId, options.groupId));
    await tx.insert(groupTeachers).values([
      {
        groupId: options.groupId,
        teacherId: options.primaryTeacherId,
        role: "primary",
      },
      ...uniqueCoTeachers.map((teacherId) => ({
        groupId: options.groupId,
        teacherId,
        role: "co-teacher",
      })),
    ]);
    return group;
  });
}

export async function upsertAdminClassroomClass(options: {
  schoolId: string;
  existingGroupId?: string | null;
  data: Partial<InsertGroup> & Pick<InsertGroup, "name" | "schoolId" | "groupType">;
  primaryTeacherId: string;
  coTeacherIds: string[];
  studentIds: string[];
}): Promise<{
  group: Group;
  roster: {
    added: string[];
    alreadyPresent: string[];
  };
}> {
  const uniqueCoTeachers = Array.from(
    new Set(options.coTeacherIds.filter((id) => id && id !== options.primaryTeacherId))
  );
  const uniqueStudentIds = Array.from(new Set(options.studentIds.filter(Boolean)));

  return db.transaction(async (tx) => {
    const groupValues = {
      ...options.data,
      schoolId: options.schoolId,
      teacherId: options.primaryTeacherId,
    };
    const [group] = options.existingGroupId
      ? await tx
          .update(groups)
          .set(groupValues)
          .where(
            and(
              eq(groups.id, options.existingGroupId),
              eq(groups.schoolId, options.schoolId),
              eq(groups.groupType, "admin_class")
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

    await tx.delete(groupTeachers).where(eq(groupTeachers.groupId, group.id));
    await tx.insert(groupTeachers).values([
      {
        groupId: group.id,
        teacherId: options.primaryTeacherId,
        role: "primary",
      },
      ...uniqueCoTeachers.map((teacherId) => ({
        groupId: group.id,
        teacherId,
        role: "co-teacher",
      })),
    ]);

    let roster = { added: [] as string[], alreadyPresent: [] as string[] };
    if (uniqueStudentIds.length > 0) {
      const beforeRows = await tx
        .select({ studentId: groupStudents.studentId })
        .from(groupStudents)
        .where(eq(groupStudents.groupId, group.id));
      const before = new Set(beforeRows.map((row) => row.studentId));
      const inserted = await tx
        .insert(groupStudents)
        .values(uniqueStudentIds.map((studentId) => ({ groupId: group.id, studentId })))
        .onConflictDoNothing()
        .returning({ studentId: groupStudents.studentId });
      const added = inserted.map((row) => row.studentId);
      const addedSet = new Set(added);
      roster = {
        added,
        alreadyPresent: uniqueStudentIds.filter((id) => before.has(id) && !addedSet.has(id)),
      };
    }

    return { group, roster };
  });
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  await db
    .delete(groupStudents)
    .where(eq(groupStudents.groupId, groupId));
  const result = await db.delete(groups).where(eq(groups.id, groupId));
  return (result.rowCount ?? 0) > 0;
}

export async function archiveGroup(groupId: string): Promise<Group | undefined> {
  const [group] = await db
    .update(groups)
    .set({ status: "archived", archivedAt: new Date(), scheduleEnabled: false })
    .where(eq(groups.id, groupId))
    .returning();
  return group;
}

export async function groupHasTeachingHistory(groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: sql<number>`COUNT(*)::int` })
    .from(teachingSessions)
    .where(eq(teachingSessions.groupId, groupId));
  return (row?.value ?? 0) > 0;
}

export async function hardDeleteGroupWithCleanup(groupId: string): Promise<boolean> {
  await db.transaction(async (tx) => {
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
    await tx.delete(groupTeachers).where(eq(groupTeachers.groupId, groupId));
    await tx.delete(groupStudents).where(eq(groupStudents.groupId, groupId));
    await tx.delete(groups).where(eq(groups.id, groupId));
  });
  return true;
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
    .where(eq(groupStudents.groupId, groupId));
  return rows.map((r) => ({ ...r.groupStudent, student: r.student }));
}

export async function getGroupStudentIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ studentId: groupStudents.studentId })
    .from(groupStudents)
    .where(eq(groupStudents.groupId, groupId));
  return rows.map((row) => row.studentId);
}

export async function addGroupStudentsDetailed(
  groupId: string,
  studentIds: string[]
): Promise<{
  added: string[];
  alreadyPresent: string[];
}> {
  const uniqueIds = Array.from(new Set(studentIds));
  if (uniqueIds.length === 0) return { added: [], alreadyPresent: [] };
  const before = new Set(await getGroupStudentIds(groupId));
  const inserted = await db
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
}

export async function addGroupStudents(
  groupId: string,
  studentIds: string[]
): Promise<void> {
  if (studentIds.length === 0) return;
  const values = studentIds.map((studentId) => ({ groupId, studentId }));
  await db.insert(groupStudents).values(values).onConflictDoNothing();
}

export async function removeGroupStudent(
  groupId: string,
  studentId: string
): Promise<void> {
  await db
    .delete(groupStudents)
    .where(
      and(
        eq(groupStudents.groupId, groupId),
        eq(groupStudents.studentId, studentId)
      )
    );
}

export async function setGroupStudents(
  groupId: string,
  studentIds: string[]
): Promise<void> {
  await db
    .delete(groupStudents)
    .where(eq(groupStudents.groupId, groupId));
  if (studentIds.length === 0) return;
  const values = studentIds.map((studentId) => ({ groupId, studentId }));
  await db.insert(groupStudents).values(values).onConflictDoNothing();
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
    .where(eq(subgroupMembers.subgroupId, subgroupId));
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
  sessionId: string
): Promise<ChatMessage[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt));
}

export async function createChatMessage(
  data: InsertChatMessage
): Promise<ChatMessage> {
  const [msg] = await db.insert(chatMessages).values(data).returning();
  return msg!;
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
    .where(eq(teacherStudents.teacherId, teacherId));
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
    .where(and(eq(teacherStudents.teacherId, teacherId), eq(students.schoolId, schoolId)));
  return rows.map((r) => ({ ...r.assignment, student: r.student }));
}

export async function assignTeacherStudent(
  teacherId: string,
  studentId: string
): Promise<TeacherStudent> {
  // teacher_students.school_id must mirror the linked student's school (RLS
  // WITH CHECK). Derive it from the student so it can never be omitted.
  const [student] = await db
    .select({ schoolId: students.schoolId })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student) {
    throw new Error(`assignTeacherStudent: student ${studentId} not found`);
  }
  const [row] = await db
    .insert(teacherStudents)
    .values({ teacherId, studentId, schoolId: student.schoolId })
    .onConflictDoNothing()
    .returning();
  return row!;
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
// Settings operations
// ============================================================================

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

export async function upsertSettings(
  schoolId: string,
  data: Partial<InsertSettings>
): Promise<Settings> {
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
  return row!;
}

// Update only the device-enrollment / auto-enroll fields on an existing settings row.
export async function updateEnrollmentSettings(
  schoolId: string,
  data: { enrollmentKey?: string; enrollmentKeyRequired?: boolean; autoEnrollStudents?: boolean }
): Promise<Settings> {
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

/** Returns a Set of student IDs marked absent (or tardy/early_dismissal) for a given date */
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
        eq(studentAttendance.date, date)
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
  sessionId: string;
  studentId: string;
  originalType: string;
  overrideType: string;
  busRoute?: string | null;
  reason?: string | null;
  changedBy: string;
  changedByRole: string;
}): Promise<DismissalOverride> {
  const [row] = await db
    .insert(dismissalOverrides)
    .values(data)
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
