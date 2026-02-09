import { eq, and, desc, asc, ilike, or, isNull, inArray, sql, ne, type SQL } from "drizzle-orm";
import db from "../db.js";
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
  type Student,
  type InsertStudent,
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
} from "../schema/classpilot.js";
import {
  settings,
  googleOAuthTokens,
  classroomCourses,
  classroomCourseStudents,
  auditLogs,
  trialRequests,
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
  type TrialRequest,
  type InsertTrialRequest,
} from "../schema/shared.js";

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

export async function createSchool(data: InsertSchool): Promise<School> {
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

export async function createMembership(
  data: InsertSchoolMembership
): Promise<SchoolMembership> {
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
// Student operations (basic - Phase 3 will expand)
// ============================================================================

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

export async function createStudent(data: InsertStudent): Promise<Student> {
  const [student] = await db.insert(students).values(data).returning();
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

export async function updateStudent(
  id: string,
  data: Partial<InsertStudent>
): Promise<Student | undefined> {
  const [student] = await db
    .update(students)
    .set({ ...data, updatedAt: new Date() })
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

export async function bulkCreateStudents(
  data: InsertStudent[]
): Promise<Student[]> {
  if (data.length === 0) return [];
  return db.insert(students).values(data).returning();
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
        or(
          eq(schoolMemberships.role, "admin"),
          eq(schoolMemberships.role, "teacher"),
          eq(schoolMemberships.role, "office_staff")
        )
      )
    )
    .orderBy(users.lastName, users.firstName);

  return rows.map((r) => ({ ...r.membership, user: r.user }));
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
    .limit(500);
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
  date: string
): Promise<DismissalSession> {
  // Try to find existing
  const [existing] = await db
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
  const [session] = await db
    .insert(dismissalSessions)
    .values({ schoolId, date, status: "pending" })
    .onConflictDoNothing()
    .returning();

  if (session) return session;

  // Race condition: fetch again
  const [raced] = await db
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
  status: string
): Promise<DismissalSession | undefined> {
  const updates: Record<string, unknown> = { status };
  if (status === "active") {
    updates.startedAt = sql`COALESCE(${dismissalSessions.startedAt}, NOW())`;
  }
  if (status === "completed") {
    updates.endedAt = new Date();
  }

  const [s] = await db
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
    .set({ status: "called", zone, calledAt: new Date() })
    .where(eq(dismissalQueue.id, id))
    .returning();
  return entry;
}

export async function callNextBatch(
  sessionId: string,
  count: number,
  zone: string | null
): Promise<DismissalQueueEntry[]> {
  // Get IDs of next waiting entries
  const waiting = await db
    .select({ id: dismissalQueue.id })
    .from(dismissalQueue)
    .where(
      and(
        eq(dismissalQueue.sessionId, sessionId),
        eq(dismissalQueue.status, "waiting")
      )
    )
    .orderBy(dismissalQueue.position)
    .limit(count);

  if (waiting.length === 0) return [];

  const ids = waiting.map((w) => w.id);
  return db
    .update(dismissalQueue)
    .set({ status: "called", zone, calledAt: new Date() })
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
        or(
          eq(dismissalQueue.status, "called"),
          eq(dismissalQueue.status, "waiting")
        )
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
        inArray(dismissalQueue.status, [
          "waiting",
          "called",
          "released",
          "delayed",
          "held",
        ])
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
        inArray(dismissalQueue.status, [
          "waiting",
          "called",
          "released",
          "delayed",
          "held",
        ])
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
        or(
          eq(dismissalQueue.status, "waiting"),
          eq(dismissalQueue.status, "called")
        )
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

export async function updateParentStudentLink(
  id: string,
  data: Partial<InsertParentStudent>
): Promise<ParentStudent | undefined> {
  const [row] = await db
    .update(parentStudent)
    .set(data)
    .where(eq(parentStudent.id, id))
    .returning();
  return row;
}

export async function createParentStudentLink(
  data: InsertParentStudent
): Promise<ParentStudent> {
  const [row] = await db
    .insert(parentStudent)
    .values(data)
    .onConflictDoNothing()
    .returning();
  return row!;
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

// ============================================================================
// ClassPilot - Heartbeat operations
// ============================================================================

export async function createHeartbeat(
  data: InsertHeartbeat
): Promise<Heartbeat> {
  const [hb] = await db.insert(heartbeats).values(data).returning();
  return hb!;
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

export async function getHeartbeatsByStudent(
  studentId: string,
  limit = 50
): Promise<Heartbeat[]> {
  return db
    .select()
    .from(heartbeats)
    .where(eq(heartbeats.studentId, studentId))
    .orderBy(desc(heartbeats.timestamp))
    .limit(limit);
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
  // End any active sessions for this student
  await db
    .update(studentSessions)
    .set({ isActive: false, endedAt: new Date() })
    .where(
      and(
        eq(studentSessions.studentId, studentId),
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
  data: { groupId: string; teacherId: string }
): Promise<TeachingSession> {
  const [session] = await db
    .insert(teachingSessions)
    .values(data)
    .returning();
  return session!;
}

export async function endTeachingSession(
  sessionId: string
): Promise<TeachingSession | undefined> {
  const [session] = await db
    .update(teachingSessions)
    .set({ endTime: new Date() })
    .where(eq(teachingSessions.id, sessionId))
    .returning();
  return session;
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

export async function getGroupsByTeacher(
  teacherId: string
): Promise<Group[]> {
  return db
    .select()
    .from(groups)
    .where(eq(groups.teacherId, teacherId))
    .orderBy(groups.name);
}

export async function getGroupById(
  groupId: string
): Promise<Group | undefined> {
  const [group] = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  return group;
}

export async function createGroup(
  data: InsertGroup
): Promise<Group> {
  const [group] = await db.insert(groups).values(data).returning();
  return group!;
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

export async function deleteGroup(groupId: string): Promise<boolean> {
  await db
    .delete(groupStudents)
    .where(eq(groupStudents.groupId, groupId));
  const result = await db.delete(groups).where(eq(groups.id, groupId));
  return (result.rowCount ?? 0) > 0;
}

export async function getGroupStudents(
  groupId: string
): Promise<(GroupStudent & { student: Student })[]> {
  const rows = await db
    .select({
      groupStudent: groupStudents,
      student: students,
    })
    .from(groupStudents)
    .innerJoin(students, eq(groupStudents.studentId, students.id))
    .where(eq(groupStudents.groupId, groupId));
  return rows.map((r) => ({ ...r.groupStudent, student: r.student }));
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
  const [sg] = await db.insert(subgroups).values(data).returning();
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

export async function getFlightPathById(
  flightPathId: string
): Promise<FlightPath | undefined> {
  const [fp] = await db
    .select()
    .from(flightPaths)
    .where(eq(flightPaths.id, flightPathId))
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
  data: Partial<InsertFlightPath>
): Promise<FlightPath | undefined> {
  const [fp] = await db
    .update(flightPaths)
    .set(data)
    .where(eq(flightPaths.id, id))
    .returning();
  return fp;
}

export async function deleteFlightPath(id: string): Promise<boolean> {
  const result = await db.delete(flightPaths).where(eq(flightPaths.id, id));
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

export async function getBlockListById(
  id: string
): Promise<BlockList | undefined> {
  const [bl] = await db
    .select()
    .from(blockLists)
    .where(eq(blockLists.id, id))
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
  data: Partial<InsertBlockList>
): Promise<BlockList | undefined> {
  const [bl] = await db
    .update(blockLists)
    .set(data)
    .where(eq(blockLists.id, id))
    .returning();
  return bl;
}

export async function deleteBlockList(id: string): Promise<boolean> {
  const result = await db.delete(blockLists).where(eq(blockLists.id, id));
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

export async function getDashboardTabs(
  teacherId: string
): Promise<DashboardTab[]> {
  return db
    .select()
    .from(dashboardTabs)
    .where(eq(dashboardTabs.teacherId, teacherId))
    .orderBy(asc(dashboardTabs.order));
}

export async function createDashboardTab(
  data: InsertDashboardTab
): Promise<DashboardTab> {
  const [tab] = await db.insert(dashboardTabs).values(data).returning();
  return tab!;
}

export async function updateDashboardTab(
  tabId: string,
  data: Partial<InsertDashboardTab>
): Promise<DashboardTab | undefined> {
  const [tab] = await db
    .update(dashboardTabs)
    .set(data)
    .where(eq(dashboardTabs.id, tabId))
    .returning();
  return tab;
}

export async function deleteDashboardTab(tabId: string): Promise<boolean> {
  const result = await db
    .delete(dashboardTabs)
    .where(eq(dashboardTabs.id, tabId));
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

export async function assignTeacherStudent(
  teacherId: string,
  studentId: string
): Promise<TeacherStudent> {
  const [row] = await db
    .insert(teacherStudents)
    .values({ teacherId, studentId })
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
  data: InsertMessage
): Promise<MessageRecord> {
  const [msg] = await db.insert(messages).values(data).returning();
  return msg!;
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const result = await db.delete(messages).where(eq(messages.id, messageId));
  return (result.rowCount ?? 0) > 0;
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
// Trial Request operations
// ============================================================================

export async function createTrialRequest(
  data: InsertTrialRequest
): Promise<TrialRequest> {
  const [request] = await db.insert(trialRequests).values(data).returning();
  return request!;
}

export async function getTrialRequests(
  filters: { status?: string; product?: string } = {}
): Promise<TrialRequest[]> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.status) {
    conditions.push(eq(trialRequests.status, filters.status));
  }
  if (filters.product) {
    conditions.push(eq(trialRequests.product, filters.product));
  }

  return db
    .select()
    .from(trialRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(trialRequests.createdAt));
}

export async function getTrialRequestById(
  id: string
): Promise<TrialRequest | undefined> {
  const [request] = await db
    .select()
    .from(trialRequests)
    .where(eq(trialRequests.id, id))
    .limit(1);
  return request;
}

export async function updateTrialRequest(
  id: string,
  data: Partial<InsertTrialRequest>
): Promise<TrialRequest | undefined> {
  const [request] = await db
    .update(trialRequests)
    .set(data)
    .where(eq(trialRequests.id, id))
    .returning();
  return request;
}

export async function deleteTrialRequest(id: string): Promise<boolean> {
  const result = await db
    .delete(trialRequests)
    .where(eq(trialRequests.id, id));
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

export async function upsertGoogleOAuthToken(
  userId: string,
  data: {
    refreshToken: string;
    scope?: string;
    tokenType?: string;
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
  schoolId: string
): Promise<Settings | undefined> {
  const [row] = await db
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
  const [row] = await db
    .insert(settings)
    .values({ schoolId, schoolName: data.schoolName || "", wsSharedKey: data.wsSharedKey || "", ...data })
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

