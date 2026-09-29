import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import type { School, User } from "../src/schema/core.js";
import type { FlightPath } from "../src/schema/classpilot.js";
import type { ToolContext } from "../src/services/chatToolExecutor.js";

// Security fix: the AI assistant's list_flight_paths tool read
// getFlightPathsBySchool, so any teacher could list every other teacher's
// private Flight Paths (names and allowed domains). Teachers now see only the
// Flight Paths they own in the current school; school administrators keep the
// school-wide view the Flight Path routes already give them
// (canManageOwnedResource in src/routes/classpilot/flightPaths.ts).

const TAG = `ai_chat_fp_scope_${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.REDIS_URL = "";

let db: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool | undefined;
let sessionPool: typeof import("../src/db.js").sessionPool | undefined;
let schedulerPool: typeof import("../src/services/schedulerDb.js").schedulerPool | undefined;
let schedulerLockPool: typeof import("../src/services/schedulerDb.js").schedulerLockPool | undefined;
let storage: typeof import("../src/services/storage.js");
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let executeTool: typeof import("../src/services/chatToolExecutor.js").executeTool;

let school: School;
let otherSchool: School;
let teacherA: User;
let teacherB: User;
let admin: User;
let schoolAdmin: User;
let pathA: FlightPath;
let pathB: FlightPath;
let ownerlessPath: FlightPath;
let otherSchoolPathA: FlightPath;

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function contextFor(user: User, role: string, schoolId: string = school.id): ToolContext {
  return {
    userId: user.id,
    schoolId,
    schoolName: "current school",
    userName: "current user",
    userRole: role,
    licensedProducts: ["CLASSPILOT"],
    getTranscript: () => "",
  };
}

async function listedFlightPathIds(ctx: ToolContext): Promise<string[]> {
  // Production runs every tool inside the caller's tenant context
  // (executeToolWithFreshTenant); mirror that here.
  const result = await runWithTenantContext(
    { schoolId: ctx.schoolId },
    () => executeTool("list_flight_paths", {}, ctx)
  );
  assert.equal(result.success, true, JSON.stringify(result));
  const listed: Array<{ id: string }> = result.data.flightPaths;
  assert.equal(result.data.count, listed.length);
  return listed.map((flightPath) => flightPath.id).sort();
}

function sortedIds(...paths: FlightPath[]): string[] {
  return paths.map((flightPath) => flightPath.id).sort();
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ executeTool } = await import("../dist/services/chatToolExecutor.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  school = await asSystem(() => storage.createSchool({
    name: `${TAG} School`,
    domain: DOMAIN,
    slug: `${TAG}-school`,
  }));
  otherSchool = await asSystem(() => storage.createSchool({
    name: `${TAG} Other School`,
    domain: DOMAIN,
    slug: `${TAG}-other`,
  }));
  [teacherA, teacherB, admin, schoolAdmin] = await asSystem(() => Promise.all([
    storage.createUser({ email: `teacher-a@${DOMAIN}`, firstName: "Avery", lastName: "Teacher" }),
    storage.createUser({ email: `teacher-b@${DOMAIN}`, firstName: "Blake", lastName: "Teacher" }),
    storage.createUser({ email: `admin@${DOMAIN}`, firstName: "Alex", lastName: "Admin" }),
    storage.createUser({ email: `school-admin@${DOMAIN}`, firstName: "Sam", lastName: "SchoolAdmin" }),
  ]));
  for (const [user, role, schoolId] of [
    [teacherA, "teacher", school.id],
    [teacherB, "teacher", school.id],
    [admin, "admin", school.id],
    [schoolAdmin, "school_admin", school.id],
    // Teacher A also teaches at a second school with the same staff domain.
    [teacherA, "teacher", otherSchool.id],
  ] as const) {
    await asSystem(() => storage.createMembership({ userId: user.id, schoolId, role, status: "active" }));
  }

  const inSchool = <T>(schoolId: string, fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);
  pathA = await inSchool(school.id, () => storage.createFlightPath({
    schoolId: school.id,
    teacherId: teacherA.id,
    flightPathName: `${TAG} Teacher A private`,
    allowedDomains: ["teacher-a.example.com"],
  }));
  pathB = await inSchool(school.id, () => storage.createFlightPath({
    schoolId: school.id,
    teacherId: teacherB.id,
    flightPathName: `${TAG} Teacher B private`,
    allowedDomains: ["teacher-b.example.com"],
  }));
  // Staff offboarding can leave a Flight Path without an owner.
  ownerlessPath = await inSchool(school.id, () => storage.createFlightPath({
    schoolId: school.id,
    teacherId: null,
    flightPathName: `${TAG} Ownerless`,
    allowedDomains: ["ownerless.example.com"],
  }));
  otherSchoolPathA = await inSchool(otherSchool.id, () => storage.createFlightPath({
    schoolId: otherSchool.id,
    teacherId: teacherA.id,
    flightPathName: `${TAG} Teacher A other school`,
    allowedDomains: ["other-school.example.com"],
  }));
});

after(async () => {
  try {
    await asSystem(async () => {
      for (const schoolId of [school?.id, otherSchool?.id].filter(Boolean)) {
        await db.execute(sql`DELETE FROM flight_paths WHERE school_id = ${schoolId}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${schoolId}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${schoolId}`);
      }
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`}`);
    });
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

describe("AI chat list_flight_paths scope", { concurrency: false }, () => {
  it("lists only the teacher's own Flight Paths, never another teacher's private paths", async () => {
    assert.deepEqual(await listedFlightPathIds(contextFor(teacherA, "teacher")), sortedIds(pathA));
    assert.deepEqual(await listedFlightPathIds(contextFor(teacherB, "teacher")), sortedIds(pathB));
  });

  it("keeps a multi-school teacher's list inside the current school", async () => {
    assert.deepEqual(
      await listedFlightPathIds(contextFor(teacherA, "teacher", otherSchool.id)),
      sortedIds(otherSchoolPathA)
    );
  });

  it("keeps the school-wide view for school administrators, including ownerless paths", async () => {
    const schoolWide = sortedIds(pathA, pathB, ownerlessPath);
    assert.deepEqual(await listedFlightPathIds(contextFor(admin, "admin")), schoolWide);
    assert.deepEqual(await listedFlightPathIds(contextFor(schoolAdmin, "school_admin")), schoolWide);
  });

  it("returns only the summary fields the assistant already exposed", async () => {
    const result = await runWithTenantContext(
      { schoolId: school.id },
      () => executeTool("list_flight_paths", {}, contextFor(teacherA, "teacher"))
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.data, {
      count: 1,
      flightPaths: [{
        id: pathA.id,
        name: pathA.flightPathName,
        allowedDomains: ["teacher-a.example.com"],
        isDefault: false,
      }],
    });
  });

  it("creates assistant Flight Paths owned by the caller, so they list for that caller only", async () => {
    const created = await runWithTenantContext(
      { schoolId: school.id },
      () => executeTool(
        "create_flight_path",
        { name: `${TAG} Assistant created`, allowedDomains: ["assistant.example.com"] },
        contextFor(teacherB, "teacher")
      )
    );
    assert.equal(created.success, true, JSON.stringify(created));
    const createdId: string = created.data.id;
    assert.deepEqual(
      await listedFlightPathIds(contextFor(teacherB, "teacher")),
      [pathB.id, createdId].sort()
    );
    assert.deepEqual(await listedFlightPathIds(contextFor(teacherA, "teacher")), sortedIds(pathA));
  });
});
