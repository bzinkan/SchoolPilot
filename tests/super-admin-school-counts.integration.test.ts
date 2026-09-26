import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import db, { pool, sessionPool } from "../src/db.js";
import { drainTenantContextReleases, runWithTenantContext } from "../src/middleware/tenantContext.js";
import superAdminRouter from "../src/routes/admin/superAdmin.js";
import { productLicenses, schoolMemberships, schools, users, type School } from "../src/schema/core.js";
import { auditLogs, settings } from "../src/schema/shared.js";
import { students } from "../src/schema/students.js";
import { signUserToken } from "../src/services/jwt.js";
import {
  createSchool,
  createUser,
  getSchoolCounts,
  softDeleteSchool,
  updateSchool,
} from "../src/services/storage.js";

const TAG = `school-counts-${randomUUID()}`;
const schoolIds: string[] = [];
const staffIds: string[] = [];
let superUserId: string | undefined;
let authorization: string;
let server: Server | undefined;
let baseUrl: string;

const statsSchema = z.object({
  totalSchools: z.number().int().nonnegative(),
  activeSchools: z.number().int().nonnegative(),
  suspendedSchools: z.number().int().nonnegative(),
  totalStudents: z.number().int().nonnegative(),
  pendingInquiries: z.number().int().nonnegative(),
});
const schoolListSchema = z.object({
  schools: z.array(z.object({
    id: z.string(),
    status: z.string(),
    adminCount: z.number().int().nonnegative(),
    teacherCount: z.number().int().nonnegative(),
    studentCount: z.number().int().nonnegative(),
  })),
});
type DashboardStats = z.infer<typeof statsSchema>;

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

async function dashboard() {
  const statsResponse = await fetch(`${baseUrl}/stats`, { headers: { authorization } });
  assert.equal(statsResponse.status, 200, await statsResponse.clone().text());
  const stats = statsSchema.parse(await statsResponse.json());
  const schoolsResponse = await fetch(`${baseUrl}/schools`, { headers: { authorization } });
  assert.equal(schoolsResponse.status, 200, await schoolsResponse.clone().text());
  const list = schoolListSchema.parse(await schoolsResponse.json()).schools;
  assert.equal(stats.totalSchools, list.length);
  assert.equal(
    stats.totalStudents,
    list.reduce((total, school) => total + school.studentCount, 0),
    "the dashboard total must equal the student counts of all non-deleted schools"
  );
  return { stats, schools: list };
}

function assertStatsAdded(
  actual: DashboardStats,
  baseline: DashboardStats,
  added: { active: number; suspended: number; students: number }
): void {
  assert.deepEqual(actual, {
    ...baseline,
    totalSchools: baseline.totalSchools + added.active + added.suspended,
    activeSchools: baseline.activeSchools + added.active,
    suspendedSchools: baseline.suspendedSchools + added.suspended,
    totalStudents: baseline.totalStudents + added.students,
  });
}

async function schoolFixture(
  name: string,
  activeStudents: number,
  inactiveStudents = 0,
  status = "active"
): Promise<School> {
  return asSystem(async () => {
    const school = await createSchool({
      name: `${TAG} ${name}`,
      domain: `${randomUUID()}.example.invalid`,
      slug: `${TAG}-${name}`,
      status,
    });
    schoolIds.push(school.id);
    if (activeStudents + inactiveStudents > 0) {
      await db.insert(students).values(Array.from(
        { length: activeStudents + inactiveStudents },
        (_, index) => ({
          schoolId: school.id,
          firstName: "Count",
          lastName: `Student ${index}`,
          status: index < activeStudents ? "active" : "inactive",
        })
      ));
    }
    return school;
  });
}

async function staffFixture(school: School, role: string, status = "active"): Promise<void> {
  await asSystem(async () => {
    const user = await createUser({
      email: `${randomUUID()}@${school.domain}`,
      firstName: "Count",
      lastName: "Staff",
    });
    staffIds.push(user.id);
    await db.insert(schoolMemberships).values({ schoolId: school.id, userId: user.id, role, status });
  });
}

async function cleanupFixtures(): Promise<void> {
  await asSystem(async () => {
    if (schoolIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.schoolId, schoolIds));
      await db.delete(students).where(inArray(students.schoolId, schoolIds));
      await db.delete(settings).where(inArray(settings.schoolId, schoolIds));
      await db.delete(productLicenses).where(inArray(productLicenses.schoolId, schoolIds));
      await db.delete(schoolMemberships).where(inArray(schoolMemberships.schoolId, schoolIds));
      await db.delete(schools).where(inArray(schools.id, schoolIds));
      schoolIds.length = 0;
    }
    if (staffIds.length > 0) {
      await db.delete(users).where(inArray(users.id, staffIds));
      staffIds.length = 0;
    }
  });
}

before(async () => {
  assert.ok(
    ["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname),
    "School count tests require a local fixture database."
  );
  const superUser = await createUser({
    email: `${TAG}@example.invalid`,
    firstName: "Count",
    lastName: "Super Admin",
    isSuperAdmin: true,
  });
  superUserId = superUser.id;
  authorization = `Bearer ${signUserToken({
    userId: superUser.id,
    email: superUser.email,
    isSuperAdmin: true,
    authVersion: superUser.authVersion,
  })}`;
  const app = express();
  app.use("/api/super-admin", superAdminRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}/api/super-admin`;
});

afterEach(cleanupFixtures);

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    await drainTenantContextReleases();
    await cleanupFixtures();
    if (superUserId) {
      await db.delete(users).where(eq(users.id, superUserId));
    }
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});

describe("super-admin school counts", () => {
  it("removes retained deleted-school students and staff from counts, then includes them on restore", async () => {
    const baseline = (await dashboard()).stats;
    const operatingSchool = await schoolFixture("operating", 133, 3);
    const testSchool = await schoolFixture("test", 1018, 2);
    for (const school of [operatingSchool, testSchool]) {
      await staffFixture(school, "admin");
      await staffFixture(school, "teacher");
      await staffFixture(school, "admin", "inactive");
      await staffFixture(school, "teacher", "inactive");
    }
    assertStatsAdded((await dashboard()).stats, baseline, { active: 2, suspended: 0, students: 1151 });

    const deleted = await asSystem(() => softDeleteSchool(testSchool.id, superUserId));
    assert.ok(deleted?.deletedAt);
    const counts = await asSystem(getSchoolCounts);
    assert.deepEqual(counts.get(operatingSchool.id), { adminCount: 1, teacherCount: 1, studentCount: 133 });
    assert.equal(counts.has(testSchool.id), false, "neither retained memberships nor students may reintroduce a deleted school");
    const afterDeletion = await dashboard();
    assertStatsAdded(afterDeletion.stats, baseline, { active: 1, suspended: 0, students: 133 });
    assert.equal(afterDeletion.schools.some((school) => school.id === testSchool.id), false);
    assert.equal(afterDeletion.schools.find((school) => school.id === operatingSchool.id)?.studentCount, 133);

    const retainedStudents = await asSystem(() => db.select({ status: students.status })
      .from(students).where(eq(students.schoolId, testSchool.id)));
    assert.equal(retainedStudents.filter((student) => student.status === "active").length, 1018);
    assert.equal(retainedStudents.filter((student) => student.status === "inactive").length, 2);
    const retainedStaff = await asSystem(() => db.select({ id: schoolMemberships.id })
      .from(schoolMemberships).where(eq(schoolMemberships.schoolId, testSchool.id)));
    assert.equal(retainedStaff.length, 4, "fixing counts must not destroy restorable school records");

    const restored = await asSystem(() => updateSchool(testSchool.id, { status: "active", deletedAt: null }));
    assert.equal(restored?.deletedAt, null);
    assert.deepEqual((await asSystem(getSchoolCounts)).get(testSchool.id), {
      adminCount: 1, teacherCount: 1, studentCount: 1018,
    });
    const afterRestore = await dashboard();
    assertStatsAdded(afterRestore.stats, baseline, { active: 2, suspended: 0, students: 1151 });
    assert.equal(afterRestore.schools.find((school) => school.id === testSchool.id)?.studentCount, 1018);
  });

  it("includes suspended schools while empty schools and inactive students contribute zero", async () => {
    const baseline = (await dashboard()).stats;
    const suspended = await schoolFixture("suspended", 7, 2, "suspended");
    const empty = await schoolFixture("empty", 0);
    const inactiveOnly = await schoolFixture("inactive-only", 0, 5);
    await staffFixture(suspended, "teacher");

    const counts = await asSystem(getSchoolCounts);
    assert.deepEqual(counts.get(suspended.id), { adminCount: 0, teacherCount: 1, studentCount: 7 });
    const current = await dashboard();
    assertStatsAdded(current.stats, baseline, { active: 2, suspended: 1, students: 7 });
    assert.equal(current.schools.find((school) => school.id === suspended.id)?.studentCount, 7);
    for (const school of [empty, inactiveOnly]) {
      const row = current.schools.find((candidate) => candidate.id === school.id);
      assert.ok(row, "undeleted schools without active students must remain listed");
      assert.equal(row.studentCount, 0);
      assert.equal(row.adminCount, 0);
      assert.equal(row.teacherCount, 0);
    }
  });

  it("returns to the baseline when all fixture schools are deleted even though students remain", async () => {
    const baseline = (await dashboard()).stats;
    const onlySchool = await schoolFixture("last-school", 4);
    assertStatsAdded((await dashboard()).stats, baseline, { active: 1, suspended: 0, students: 4 });

    await asSystem(() => softDeleteSchool(onlySchool.id, superUserId));
    assert.equal((await asSystem(getSchoolCounts)).has(onlySchool.id), false);
    const afterDeletion = await dashboard();
    assert.deepEqual(afterDeletion.stats, baseline);
    assert.equal(afterDeletion.schools.some((school) => school.id === onlySchool.id), false);
  });
});
