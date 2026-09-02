import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLASSROOM_COURSE_PREVIEW_LIMIT,
  CLASSROOM_FANOUT_CONCURRENCY,
  classroomCourseStaffFromTeachers,
  listClassroomCourseTeachers,
  listClassroomCourses,
  type ClassroomCourseListClient,
  type ClassroomCoursesListParams,
  type ClassroomTeachersListParams,
} from "../src/services/googleClassroomCourses.js";
import { mapWithConcurrency } from "../src/util/concurrency.js";

type FakeOptions = {
  coursePages: any[][];
  teacherPages?: Record<string, any[][]>;
};

function pageOf(pages: any[][], token: string | undefined) {
  const index = token ? Number(token.replace("page-", "")) : 0;
  const next = index + 1 < pages.length ? `page-${index + 1}` : undefined;
  return { index, next };
}

function fakeClassroom(options: FakeOptions) {
  const listCalls: ClassroomCoursesListParams[] = [];
  const teacherCalls: ClassroomTeachersListParams[] = [];
  const classroom: ClassroomCourseListClient = {
    courses: {
      async list(params) {
        listCalls.push({ ...params });
        const { index, next } = pageOf(options.coursePages, params.pageToken);
        return { data: { courses: options.coursePages[index] ?? [], nextPageToken: next } };
      },
      teachers: {
        async list(params) {
          teacherCalls.push({ ...params });
          const pages = options.teacherPages?.[params.courseId] ?? [[]];
          const { index, next } = pageOf(pages, params.pageToken);
          return { data: { teachers: pages[index] ?? [], nextPageToken: next } };
        },
      },
    },
  };
  return { classroom, listCalls, teacherCalls };
}

const course = (id: string, ownerId?: string) => ({ id, name: `Course ${id}`, ownerId: ownerId ?? `owner-${id}` });
const teacher = (userId: string, emailAddress: string) => ({ userId, profile: { id: userId, emailAddress } });

describe("Google Classroom course listing", () => {
  it("exports the preview cap and fan-out concurrency used by the admin import", () => {
    assert.equal(CLASSROOM_COURSE_PREVIEW_LIMIT, 300);
    assert.equal(CLASSROOM_FANOUT_CONCURRENCY, 6);
  });

  it("omits teacherId entirely on the delegated-admin (domain-wide) listing", async () => {
    const { classroom, listCalls } = fakeClassroom({ coursePages: [[course("a"), course("b")]] });
    const result = await listClassroomCourses(classroom);
    assert.equal(listCalls.length, 1);
    assert.equal("teacherId" in listCalls[0]!, false);
    assert.equal("pageToken" in listCalls[0]!, false);
    assert.deepEqual(listCalls[0], { courseStates: ["ACTIVE"], pageSize: 100 });
    assert.deepEqual(result.courses.map((entry) => entry.id), ["a", "b"]);
    assert.equal(result.truncated, false);
  });

  it("forwards teacherId when a caller's own OAuth client asks for its courses", async () => {
    const { classroom, listCalls } = fakeClassroom({ coursePages: [[course("a")]] });
    await listClassroomCourses(classroom, { teacherId: "me", courseStates: ["ACTIVE", "PROVISIONED"] });
    assert.deepEqual(listCalls[0], { teacherId: "me", courseStates: ["ACTIVE", "PROVISIONED"], pageSize: 100 });
  });

  it("follows nextPageToken until the listing is exhausted", async () => {
    const { classroom, listCalls } = fakeClassroom({
      coursePages: [[course("a"), course("b")], [course("c"), course("d")], [course("e")]],
    });
    const result = await listClassroomCourses(classroom);
    assert.deepEqual(result.courses.map((entry) => entry.id), ["a", "b", "c", "d", "e"]);
    assert.equal(result.truncated, false);
    assert.deepEqual(listCalls.map((call) => call.pageToken), [undefined, "page-1", "page-2"]);
  });

  it("stops paging once maxCourses is reached and reports truncation", async () => {
    const pages = [[course("a"), course("b")], [course("c"), course("d")], [course("e")]];

    const early = fakeClassroom({ coursePages: pages });
    const capped = await listClassroomCourses(early.classroom, { maxCourses: 2 });
    assert.deepEqual(capped.courses.map((entry) => entry.id), ["a", "b"]);
    assert.equal(capped.truncated, true);
    assert.equal(early.listCalls.length, 1, "must not fetch pages beyond the cap");

    const sliced = fakeClassroom({ coursePages: pages });
    const three = await listClassroomCourses(sliced.classroom, { maxCourses: 3 });
    assert.deepEqual(three.courses.map((entry) => entry.id), ["a", "b", "c"]);
    assert.equal(three.truncated, true);
    assert.equal(sliced.listCalls.length, 2);

    const exact = fakeClassroom({ coursePages: [[course("a"), course("b")]] });
    const fits = await listClassroomCourses(exact.classroom, { maxCourses: 2 });
    assert.deepEqual(fits.courses.map((entry) => entry.id), ["a", "b"]);
    assert.equal(fits.truncated, false, "a listing that fits exactly is not truncated");

    const unlimited = fakeClassroom({ coursePages: pages });
    const all = await listClassroomCourses(unlimited.classroom, { maxCourses: 0 });
    assert.equal(all.courses.length, 5, "non-positive maxCourses means unlimited");
  });

  it("paginates the per-course teacher roster", async () => {
    const { classroom, teacherCalls } = fakeClassroom({
      coursePages: [[]],
      teacherPages: {
        c1: [[teacher("1", "one@school.org"), teacher("2", "two@school.org")], [teacher("3", "three@school.org")]],
      },
    });
    const teachers = await listClassroomCourseTeachers(classroom, "c1");
    assert.deepEqual(teachers.map((entry) => entry.userId), ["1", "2", "3"]);
    assert.deepEqual(teacherCalls, [
      { courseId: "c1", pageSize: 100 },
      { courseId: "c1", pageSize: 100, pageToken: "page-1" },
    ]);
    assert.deepEqual(await listClassroomCourseTeachers(classroom, "unknown"), []);
  });
});

describe("Google Classroom course staff matching", () => {
  it("splits owner and co-teachers per course, lowercased and de-duplicated", () => {
    const shared = teacher("333", "Shared@School.org");
    const courseA = course("A", "111");
    const courseB = course("B", "222");

    const staffA = classroomCourseStaffFromTeachers(courseA, [
      teacher("111", "Alice@School.org"),
      shared,
      teacher("222", "bob@school.org"),
    ]);
    assert.deepEqual(staffA, {
      ownerEmail: "alice@school.org",
      ownerGoogleId: "111",
      coTeacherEmails: ["shared@school.org", "bob@school.org"],
    });

    const staffB = classroomCourseStaffFromTeachers(courseB, [
      shared,
      teacher("222", "Bob@school.org"),
      teacher("333", "shared@school.org"),
    ]);
    assert.deepEqual(staffB, {
      ownerEmail: "bob@school.org",
      ownerGoogleId: "222",
      coTeacherEmails: ["shared@school.org"],
    });
  });

  it("reports a null owner when the owner is not on the teacher roster", () => {
    const staff = classroomCourseStaffFromTeachers(course("C", "999"), [
      teacher("111", "alice@school.org"),
      teacher("222", "bob@school.org"),
    ]);
    assert.deepEqual(staff, {
      ownerEmail: null,
      ownerGoogleId: "999",
      coTeacherEmails: ["alice@school.org", "bob@school.org"],
    });
    assert.deepEqual(classroomCourseStaffFromTeachers({ ownerId: null }, []), {
      ownerEmail: null,
      ownerGoogleId: null,
      coTeacherEmails: [],
    });
  });

  it("resolves an admin-owned course's owner exactly like a teacher-owned one", () => {
    const staff = classroomCourseStaffFromTeachers(course("D", "555"), [
      teacher("111", "alice@school.org"),
      teacher("555", "Principal@School.org"),
    ]);
    assert.equal(staff.ownerEmail, "principal@school.org");
    assert.equal(staff.ownerGoogleId, "555");
    assert.deepEqual(staff.coTeacherEmails, ["alice@school.org"]);
  });

  it("ignores teachers without an email and never lists the owner as a co-teacher", () => {
    const staff = classroomCourseStaffFromTeachers(course("E", "111"), [
      { userId: "111", profile: { emailAddress: "Owner@school.org" } },
      { userId: "444", profile: { emailAddress: null } },
      { userId: "555", profile: null },
      { userId: "666", profile: { emailAddress: "owner@school.org" } },
    ]);
    assert.deepEqual(staff, { ownerEmail: "owner@school.org", ownerGoogleId: "111", coTeacherEmails: [] });
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order and bounds in-flight work", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, index) => index);
    const results = await mapWithConcurrency(items, CLASSROOM_FANOUT_CONCURRENCY, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (20 - item) % 3));
      inFlight--;
      return item * 2;
    });
    assert.deepEqual(results, items.map((item) => item * 2));
    assert.ok(peak <= CLASSROOM_FANOUT_CONCURRENCY, `peak concurrency ${peak} exceeded the cap`);
    assert.deepEqual(await mapWithConcurrency([], 6, async () => 1), []);
  });
});
