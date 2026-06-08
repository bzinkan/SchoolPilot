import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Uses Node's built-in test runner (run via `tsx` loader — no extra deps, so no
// added audit surface). Imports the COMPILED output so we exercise exactly what
// ships and avoid .js-extension ESM resolution of source .ts. CI builds first.
import {
  createSchool,
  createUser,
  createGroup,
  getGroupByIdAndSchool,
  getGroupsByTeacherAndSchool,
  createFlightPath,
  getFlightPathById,
  createBlockList,
  getBlockListById,
  createStudent,
  createGrade,
  getGradeById,
  createDashboardTab,
  getDashboardTabs,
} from "../dist/services/storage.js";
import { pool } from "../dist/db.js";

// Cross-tenant isolation regression suite. Seeds two schools and asserts the
// school-scoped storage helpers never return one school's resource to the other,
// and that legitimate same-school access still works (no over-blocking). Durable
// guard against the IDOR class fixed in the 2026-06 isolation sweep.

const TAG = `xtest_${Date.now()}`;
let schoolA: any;
let schoolB: any;
let teacher: any;

before(async () => {
  schoolA = await createSchool({ name: `${TAG}_A`, domain: `${TAG}-a.example.edu`, slug: `${TAG}-a` } as any);
  schoolB = await createSchool({ name: `${TAG}_B`, domain: `${TAG}-b.example.edu`, slug: `${TAG}-b` } as any);
  teacher = await createUser({ email: `${TAG}-teacher@example.edu`, firstName: "T", lastName: "Teacher" } as any);
});

after(async () => {
  try {
    await pool.query(`DELETE FROM schools WHERE name LIKE 'xtest_%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'xtest_%@example.edu'`);
  } catch {
    /* ignore */
  }
  await pool.end();
});

describe("cross-school isolation", () => {
  it("getGroupByIdAndSchool: own school yes, other school no", async () => {
    const g = await createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA` } as any);
    assert.equal((await getGroupByIdAndSchool(g.id, schoolA.id))?.id, g.id);
    assert.equal(await getGroupByIdAndSchool(g.id, schoolB.id), undefined);
  });

  it("getGroupsByTeacherAndSchool partitions a teacher's groups by school", async () => {
    await createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA2` } as any);
    await createGroup({ schoolId: schoolB.id, teacherId: teacher.id, name: `${TAG}_grpB` } as any);
    const inA = await getGroupsByTeacherAndSchool(teacher.id, schoolA.id);
    const inB = await getGroupsByTeacherAndSchool(teacher.id, schoolB.id);
    assert.ok(inA.every((x: any) => x.schoolId === schoolA.id));
    assert.ok(inB.every((x: any) => x.schoolId === schoolB.id));
    assert.ok(!inA.some((x: any) => x.schoolId === schoolB.id));
  });

  it("getFlightPathById is school-scoped", async () => {
    const fp = await createFlightPath({ schoolId: schoolA.id, teacherId: teacher.id, flightPathName: `${TAG}_fp` } as any);
    assert.equal((await getFlightPathById(fp.id, schoolA.id))?.id, fp.id);
    assert.equal(await getFlightPathById(fp.id, schoolB.id), undefined);
  });

  it("getBlockListById is school-scoped", async () => {
    const bl = await createBlockList({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_bl` } as any);
    assert.equal((await getBlockListById(bl.id, schoolA.id))?.id, bl.id);
    assert.equal(await getBlockListById(bl.id, schoolB.id), undefined);
  });

  it("getGradeById exposes the schoolId handlers gate on", async () => {
    const grade = await createGrade({ schoolId: schoolA.id, name: `${TAG}_grade` } as any);
    const fetched = await getGradeById(grade.id);
    assert.equal(fetched?.schoolId, schoolA.id);
    assert.notEqual(fetched?.schoolId, schoolB.id);
  });

  it("getDashboardTabs partitions a teacher's tabs by school", async () => {
    await createDashboardTab({ teacherId: teacher.id, schoolId: schoolA.id, label: `${TAG}_tabA`, filterType: "all" } as any);
    await createDashboardTab({ teacherId: teacher.id, schoolId: schoolB.id, label: `${TAG}_tabB`, filterType: "all" } as any);
    const inA = await getDashboardTabs(teacher.id, schoolA.id);
    const inB = await getDashboardTabs(teacher.id, schoolB.id);
    assert.ok(inA.every((t: any) => t.schoolId === schoolA.id));
    assert.ok(inB.every((t: any) => t.schoolId === schoolB.id));
    assert.ok(!inA.some((t: any) => t.schoolId === schoolB.id));
  });

  it("a student created in School A carries School A's id, not B's", async () => {
    const s = await createStudent({
      schoolId: schoolA.id,
      firstName: "S",
      lastName: "One",
      email: `${TAG}-s1@example.edu`,
      emailLc: `${TAG}-s1@example.edu`,
      status: "active",
    } as any);
    assert.equal(s.schoolId, schoolA.id);
    assert.notEqual(s.schoolId, schoolB.id);
  });
});
