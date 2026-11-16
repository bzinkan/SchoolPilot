import assert from "node:assert/strict";
import test from "node:test";
import { buildClassroomFocusSource, fetchPublishedClassroomFocusSource } from "../src/services/classpilotClassroomFocusSource.js";

const course = { id: "course-one", name: "Synthetic coursework" };
test("published coursework and materials include outside sites, descriptions and all Google attachment variants", () => {
  const result = buildClassroomFocusSource(course, [{ id: "work:1", state: "PUBLISHED",
    description: "Read https://reading.example.org/unit?exercise=2 and https://www.youtube.com/watch?v=dQw4w9WgXcQ.",
    alternateLink: "https://classroom.google.com/c/course-one/a/work-one",
    materials: [{ link: { url: "https://practice.example.org/unit" } },
      { driveFile: { driveFile: { alternateLink: "https://docs.google.com/document/d/synthetic/edit" } } },
      { form: { formUrl: "https://forms.gle/synthetic" } },
      { gem: { url: "https://gemini.google.com/gem/synthetic" } },
      { notebook: { url: "https://notebooklm.google.com/notebook/synthetic" } }],
  }]);
  for (const host of ["classroom.google.com", "docs.google.com", "forms.gle", "practice.example.org", "reading.example.org", "gemini.google.com", "notebooklm.google.com"])
    assert.ok(result.scope.allowedDomains.includes(host), host);
  assert.equal(result.scope.allowedDomains.includes("youtube.com"), false, "known videos never widen to all YouTube");
  assert.ok(result.scope.resources[0]?.type === "resource" && result.scope.resources[0].provider === "youtube");
  assert.equal(result.itemCount, 1);
  assert.match(result.scope.sourceRevision, /^[a-f0-9]{64}$/);
});

test("source snapshots are deterministic and reject invalid, unpublished and oversized source sets", () => {
  const items = [{ id: "work:b", state: "PUBLISHED", materials: [{ link: { url: "https://b.example.org/read" } }] },
    { id: "material:a", state: "PUBLISHED", materials: [{ link: { url: "https://a.example.org/read" } }] }];
  assert.deepEqual(buildClassroomFocusSource(course, items).scope, buildClassroomFocusSource(course, [...items].reverse()).scope);
  assert.throws(() => buildClassroomFocusSource(course, [{ ...items[0], state: "DRAFT" }]), /published/i);
  assert.throws(() => buildClassroomFocusSource(course, [{ id: "work:unsafe", state: "PUBLISHED", materials: [{ link: { url: "https://secret:credential@example.org/" } }] }]), /link/i);
  assert.throws(() => buildClassroomFocusSource(course, Array.from({ length: 201 }, (_, i) => ({ id: `work:${i}`, state: "PUBLISHED", materials: [{ link: { url: `https://host${i}.example.org/` } }] }))), /limit|large|many/i);
});

test("source listing pages both published lanes and fails rather than silently truncating repeated pagination", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    course: async () => ({ data: course }),
    courses: async () => ({ data: { courses: [course] } }),
    work: async (params: Record<string, unknown>) => { calls.push(params); return { data: params.pageToken
      ? { courseWork: [{ id: "w2", state: "PUBLISHED" }] }
      : { courseWork: [{ id: "w1", state: "PUBLISHED" }], nextPageToken: "next-work" } }; },
    materials: async (params: Record<string, unknown>) => { calls.push(params); return { data: { courseWorkMaterial: [{ id: "m1", state: "PUBLISHED" }] } }; },
  };
  const result = await fetchPublishedClassroomFocusSource(client, course.id);
  assert.equal(result.itemCount, 3);
  assert.deepEqual(calls[0]?.courseWorkStates, ["PUBLISHED"]);
  assert.deepEqual(calls.at(-1)?.courseWorkMaterialStates, ["PUBLISHED"]);
  await assert.rejects(fetchPublishedClassroomFocusSource({ ...client,
    work: async () => ({ data: { courseWork: [], nextPageToken: "loop" } }),
  }, course.id), /complete|pagination/i);
  await assert.rejects(fetchPublishedClassroomFocusSource({ ...client,
    courses: async () => ({ data: { courses: [{ id: "another-course" }] } }),
  }, course.id), /course you teach/i);
  await assert.rejects(fetchPublishedClassroomFocusSource({ ...client,
    materials: async () => ({ data: null }),
  }, course.id), /incomplete/i);
});
test("provider authentication that ignores cancellation still has a bounded read deadline", async () => {
  const sourceModule = await import("../src/services/classpilotClassroomFocusSource.js");
  const bounded = Object.getOwnPropertyDescriptor(sourceModule, "withClassroomFocusSourceDeadline")?.value;
  assert.equal(typeof bounded, "function", "the whole source read needs its own deadline, including OAuth refresh");
  let signal: AbortSignal | undefined;
  await assert.rejects(bounded(async (value: AbortSignal) => {
    signal = value;
    return new Promise(() => {});
  }, 5), /completely|source|deadline/i);
  assert.equal(signal?.aborted, true);
});
test("authorized scheduled coverage inherits only its same-school original class course mapping", async () => {
  const sourceModule = await import("../src/services/classpilotClassroomFocusSource.js");
  const mapping = Object.getOwnPropertyDescriptor(sourceModule, "mappedSupervisionClassroomCourse")?.value;
  assert.equal(typeof mapping, "function", "scheduled coverage needs its original class's mapping");
  const context = { schoolId: "school", scheduledConflictId: "conflict" };
  const reads: string[] = [];
  const dependencies = {
    getConflict: async (id: string, school: string) => { reads.push(`conflict:${id}:${school}`); return { schoolId: school, groupId: "group" }; },
    getGroup: async (id: string, school: string) => { reads.push(`group:${id}:${school}`); return { schoolId: school, googleClassroomCourseId: "mapped-course" }; },
  };
  assert.equal(await mapping("school", context, dependencies), "mapped-course");
  assert.deepEqual(reads, ["conflict:conflict:school", "group:group:school"]);
  assert.equal(await mapping("school", { schoolId: "school", scheduledConflictId: null }, dependencies), undefined,
    "testing and temporary-room scope groups cannot be mistaken for official classes");
  await assert.rejects(mapping("foreign", context, dependencies), /school|source/i);
  await assert.rejects(mapping("school", context, { ...dependencies,
    getConflict: async () => ({ schoolId: "foreign", groupId: "group" }),
  }), /school|source/i);
});
test("the source byte budget stops pagination before retaining an oversized course", async () => {
  let workPages = 0;
  const client = {
    course: async () => ({ data: course }), courses: async () => ({ data: { courses: [course] } }),
    work: async () => {
      workPages += 1;
      assert.ok(workPages <= 2, "an oversized source must stop before fetching another page");
      return { data: { courseWork: [{ id: String(workPages), state: "PUBLISHED", description: "x".repeat(1_100_000) }], nextPageToken: String(workPages) } };
    },
    materials: async () => ({ data: {} }),
  };
  await assert.rejects(fetchPublishedClassroomFocusSource(client, course.id), /large|limit/i);
  assert.equal(workPages, 2);
});
