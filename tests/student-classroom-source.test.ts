import assert from "node:assert/strict";
import test from "node:test";

const source = await import("../src/services/classpilotStudentClassroomAccessSource.js").catch(() => ({}));
function reader() {
  const value = Reflect.get(source, "fetchStudentClassroomAccessSource");
  assert.equal(typeof value, "function", "student-specific Classroom source reader must exist");
  return value as (client: any, identity: any) => Promise<any>;
}
function resolver() {
  const value = Reflect.get(source, "resolveStudentClassroomAccessSources");
  assert.equal(typeof value, "function", "student-specific bounded batch resolver must exist");
  return value as (options: any, dependencies: any) => Promise<any[]>;
}
const identity = { studentId: "student-a", googleUserId: "google-a", schoolDomain: "school.example" };
function clientFor(id = "a") {
  return {
    profile: async () => ({ data: { id: `google-${id}`, emailAddress: `${id}@school.example` } }),
    courses: async (_params: any) => ({ data: { courses: [{ id: `active-${id}`, courseState: "ACTIVE" }, { id: `archived-${id}`, courseState: "ARCHIVED" }] } }),
    work: async (params: any) => ({ data: { courseWork: [{ id: "work", state: "PUBLISHED", materials: [{ link: { url: `https://work-${params.courseId}.example/read` } }] }] } }),
    materials: async (params: any) => ({ data: { courseWorkMaterial: [{ id: "material", state: "PUBLISHED", materials: [{ driveFile: { driveFile: { alternateLink: "https://docs.google.com/document/d/copy/edit" } } }] }] } }),
    announcements: async (params: any) => ({ data: { announcements: [{ id: "announcement", state: "PUBLISHED", text: `Read https://stream-${params.courseId}.example/page`, materials: [{ youtubeVideo: { id: "dQw4w9WgXcQ" } }] }] } }),
  };
}

test("each student's active and archived courses include published work, materials and Stream links without leaking titles", async () => {
  const calls: any[] = [];
  const client = clientFor();
  const originalCourses = client.courses;
  client.courses = async params => { calls.push(params); return originalCourses(params); };
  const result = await reader()(client, identity);
  assert.equal(result.studentId, "student-a");
  assert.equal(result.courseCount, 2);
  assert.equal(result.itemCount, 6);
  assert.deepEqual(calls[0].courseStates, ["ACTIVE", "ARCHIVED"]);
  assert.equal(calls[0].studentId, "me");
  for (const host of ["work-active-a.example", "work-archived-a.example", "stream-active-a.example", "stream-archived-a.example", "docs.google.com"])
    assert.ok(result.scope.allowedDomains.includes(host), host);
  assert.equal(result.scope.allowedDomains.includes("google.com"), false);
  assert.equal(result.scope.allowedDomains.includes("youtube.com"), false);
  assert.equal(result.scope.resources.length, 1, "assigned video identity is deduplicated across courses");
  assert.deepEqual(Object.keys(result).sort(), ["courseCount", "itemCount", "linkCount", "scope", "studentId"]);
});

test("Google subject and school domain are checked before any course content read", async () => {
  for (const profile of [{ id: "another-student", emailAddress: "a@school.example" }, { id: "google-a", emailAddress: "a@foreign.example" }]) {
    let reads = 0;
    const client = { ...clientFor(), profile: async () => ({ data: profile }), courses: async () => { reads++; return { data: {} }; } };
    await assert.rejects(reader()(client, identity), /identity|student|domain/i);
    assert.equal(reads, 0);
  }
});

test("pagination, post identities and final combined scope budgets cannot silently truncate", async () => {
  const client = clientFor();
  await assert.rejects(reader()({ ...client, work: async () => ({ data: { courseWork: [], nextPageToken: "repeat" } }) }, identity), /pagination|complete/i);
  await assert.rejects(reader()({ ...client, work: async () => ({ data: { courseWork: [], nextPageToken: 0 } }) }, identity), /pagination|complete/i);
  await assert.rejects(reader()({ ...client, materials: async () => ({ data: null }) }, identity), /incomplete/i);
  await assert.rejects(reader()({ ...client, announcements: async () => ({ data: { announcements: [{ id: "draft", state: "DRAFT" }] } }) }, identity), /published|source/i);
  await assert.rejects(reader()({ ...client, work: async () => ({ data: { courseWork: [{ id: "duplicate", state: "PUBLISHED" }, { id: "duplicate", state: "PUBLISHED" }] } }) }, identity), /duplicate|identit/i);
  await assert.rejects(reader()({ ...client, courses: async () => ({ data: { courses: Array.from({ length: 101 }, (_, i) => ({ id: `course-${i}`, courseState: "ACTIVE" })) } }) }, identity), /limit|many|large/i);
  await assert.rejects(reader()({ ...client, work: async (params: any) => ({ data: { courseWork: Array.from({ length: 110 }, (_, i) => ({ id: `work-${i}`, state: "PUBLISHED", materials: [{ link: { url: `https://h-${i}-${params.courseId}.example/work` } }] })) } }) }, identity), /limit|large|scope/i);
});

test("posts assigned to a different student grant no outside website access", async () => {
  const client = clientFor();
  const result = await reader()({ ...client, work: async () => ({ data: { courseWork: [{ id: "private", state: "PUBLISHED", assigneeMode: "INDIVIDUAL_STUDENTS", individualStudentsOptions: { studentIds: ["google-b"] }, materials: [{ link: { url: "https://private-b.example/" } }] }] } }) }, identity);
  assert.equal(result.scope.allowedDomains.includes("private-b.example"), false);
});

test("source revision is stable across course order and binds the exact student's Google identity", async () => {
  const client = clientFor();
  const first = await reader()(client, identity);
  const reordered = await reader()({ ...client, courses: async () => ({ data: { courses: [{ id: "archived-a", courseState: "ARCHIVED" }, { id: "active-a", courseState: "ACTIVE" }] } }) }, identity);
  assert.equal(first.scope.sourceRevision, reordered.scope.sourceRevision);
  const alternate = await reader()({ ...client, profile: async () => ({ data: { id: "google-b", emailAddress: "b@school.example" } }) }, { ...identity, googleUserId: "google-b" });
  assert.notEqual(first.scope.sourceRevision, alternate.scope.sourceRevision);
});

test("batch scopes remain separate, current-school identity is required, and one incomplete student rejects the batch", async () => {
  const dependencies = {
    getApprovalKey: async () => "a".repeat(64),
    getSchoolDomain: async () => "school.example",
    getStudent: async (id: string, schoolId: string) => ({ id, schoolId, status: "active", email: `${id.at(-1)}@school.example`, googleUserId: `google-${id.at(-1)}` }),
    createClient: async (student: any) => clientFor(student.id.at(-1)),
  };
  const results = await resolver()({ schoolId: "school", studentIds: ["student-a", "student-b"] }, dependencies);
  assert.ok(results[0].scope.allowedDomains.includes("work-active-a.example"));
  assert.equal(results[0].scope.allowedDomains.includes("work-active-b.example"), false);
  assert.ok(results[1].scope.allowedDomains.includes("work-active-b.example"));
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a"] }, { ...dependencies, getApprovalKey: async () => null }), /authoriz|approv|connect/i);
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a"] }, { ...dependencies, getStudent: async () => ({ id: "student-a", schoolId: "foreign", status: "active", email: "a@school.example", googleUserId: "google-a" }) }), /school|student/i);
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a", "student-b"] }, { ...dependencies, createClient: async (student: any) => student.id === "student-b" ? { ...clientFor("b"), materials: async () => ({ data: null }) } : clientFor("a") }), /incomplete/i);
});

test("whole student reads and batches remain bounded even when a provider ignores cancellation", async () => {
  let providerSignal: AbortSignal | undefined;
  const dependencies = {
    getApprovalKey: async () => "a".repeat(64), getSchoolDomain: async () => "school.example",
    getStudent: async (id: string, schoolId: string) => ({ id, schoolId, status: "active", email: "a@school.example", googleUserId: "google-a" }),
    createClient: async (_student: any, options: any) => { providerSignal = options.signal; return { ...clientFor(), profile: async () => new Promise(() => {}) }; },
    studentTimeoutMs: 10, batchTimeoutMs: 30,
  };
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a"] }, dependencies), /deadline|complete|tim/i);
  assert.equal(providerSignal?.aborted, true);
});

test("duplicate canonical Google identities and identity changes during a read reject the batch", async () => {
  const student = { id: "student-a", schoolId: "school", status: "active", email: "a@school.example", googleUserId: "google-a" };
  const deps = { getApprovalKey: async () => "a".repeat(64), getSchoolDomain: async () => "school.example",
    getStudent: async (id: string) => ({ ...student, id }), createClient: async () => clientFor() };
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a", "student-b"] }, deps), /identit|student/i);
  let reads = 0;
  await assert.rejects(resolver()({ schoolId: "school", studentIds: ["student-a"] }, { ...deps,
    getStudent: async () => ({ ...student, googleUserId: ++reads === 1 ? "google-a" : "google-changed" }) }), /changed|identit|student/i);
});

test("no more than four students and two courses per student read at once", async () => {
  let activeProfiles = 0;
  let peakProfiles = 0;
  const coursePeaks: number[] = [];
  const deps = { getApprovalKey: async () => "a".repeat(64), getSchoolDomain: async () => "school.example",
    getStudent: async (id: string) => ({ id, schoolId: "school", status: "active", email: `${id}@school.example`, googleUserId: `google-${id}` }),
    createClient: async (student: any) => {
      let activeCourses = 0; let peakCourses = 0;
      const client = clientFor(student.id);
      return { ...client,
        profile: async () => { activeProfiles++; peakProfiles = Math.max(peakProfiles, activeProfiles); await new Promise(resolve => setTimeout(resolve, 3)); activeProfiles--; return { data: { id: student.googleUserId, emailAddress: student.email } }; },
        courses: async () => ({ data: { courses: Array.from({ length: 4 }, (_, i) => ({ id: `c-${i}`, courseState: "ACTIVE" })) } }),
        work: async () => { activeCourses++; peakCourses = Math.max(peakCourses, activeCourses); await new Promise(resolve => setTimeout(resolve, 3)); activeCourses--; coursePeaks.push(peakCourses); return { data: {} }; },
      };
    } };
  await resolver()({ schoolId: "school", studentIds: Array.from({ length: 8 }, (_, i) => `s${i}`) }, deps);
  assert.equal(peakProfiles, 4);
  assert.ok(coursePeaks.length > 0 && coursePeaks.every(value => value <= 2));
});

test("published Google Search links are excluded and counted while legitimate Classroom assignments remain usable", async () => {
  const client = clientFor();
  const withSearch = (query: string) => ({ ...client,
    work: async () => ({ data: { courseWork: [{ id: "mixed-work", state: "PUBLISHED", materials: [
      { link: { url: `https://www.google.co.uk/search?q=${query}` } },
      { link: { url: "https://legitimate-assignment.example/unit" } },
    ] }] } }),
  });
  const first = await reader()(withSearch("private-classroom-search"), identity);
  assert.equal(first.blockedSearchLinkCount, 2);
  assert.ok(first.scope.allowedDomains.includes("legitimate-assignment.example"));
  assert.equal(first.scope.allowedDomains.includes("google.co.uk"), false);
  assert.equal(JSON.stringify(first).includes("private-classroom-search"), false);
  const changed = await reader()(withSearch("changed-private-search"), identity);
  assert.notEqual(first.scope.sourceRevision, changed.scope.sourceRevision, "excluded source changes still invalidate a review");
  await assert.rejects(reader()({ ...client, work: async () => ({ data: { courseWork: [{ id: "bad", state: "PUBLISHED", materials: [{ link: { url: "javascript:invalid" } }] }] } }) }, identity), /link|website|source/i);
});

test("published Google Images Search is excluded while assigned Google Docs and ordinary brand sites remain usable", async () => {
  const client = clientFor();
  const result = await reader()({ ...client,
    work: async () => ({ data: { courseWork: [{ id: "images-and-document", state: "PUBLISHED", materials: [
      { link: { url: "https://www.images.google.com/search?q=private-image-query" } },
      { link: { url: "https://docs.google.com/document/d/assigned-document/edit" } },
      { link: { url: "https://google.org/assigned-material" } },
      { link: { url: "https://google.dev/assigned-material" } },
    ] }] } }),
  }, identity);
  assert.equal(result.blockedSearchLinkCount, 2);
  assert.equal(result.scope.allowedDomains.some((hostname: string) => hostname.includes("images.google")), false);
  for (const hostname of ["docs.google.com", "google.org", "google.dev"]) assert.ok(result.scope.allowedDomains.includes(hostname));
  assert.equal(JSON.stringify(result).includes("private-image-query"), false);
});
