import { createHash } from "node:crypto";
import { buildClassroomFocusSource } from "./classpilotClassroomFocusSource.js";
import { CLASSROOM_FOCUS_BASE_DOMAINS, normalizeClassroomFocusScope, type ClassroomFocusScope } from "./classroomFocusScope.js";
import { restrictionResourceIdentityKey, type PreciseAllowedResource } from "./restrictionResources.js";

export type StudentClassroomAccessSource = {
  studentId: string;
  approvalKey: string;
  scope: ClassroomFocusScope;
  courseCount: number;
  itemCount: number;
  linkCount: number;
  blockedSearchLinkCount?: number;
};
export type StudentClassroomAccessStudent = {
  id: string; schoolId: string; status: string; email: string | null; googleUserId: string | null;
};
export type StudentClassroomAccessClient = {
  profile: () => Promise<{ data: unknown }>;
  courses: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  work: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  materials: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  announcements: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
};
export type StudentClassroomAccessSourceDependencies = {
  getApprovalKey: (schoolId: string) => Promise<string | null>;
  getSchoolDomain: (schoolId: string) => Promise<string | null>;
  getStudent: (studentId: string, schoolId: string) => Promise<StudentClassroomAccessStudent | undefined>;
  createClient: (student: StudentClassroomAccessStudent, options: { signal: AbortSignal; timeoutMs: number }) => Promise<StudentClassroomAccessClient>;
  studentTimeoutMs?: number;
  batchTimeoutMs?: number;
};
const MAX_PAGES = 20;
const MAX_COURSES = 100;
const MAX_POSTS = 1000;
const MAX_LINKS = 2000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const STUDENT_CLASSROOM_REQUEST_TIMEOUT_MS = 8000;
export const STUDENT_CLASSROOM_SOURCE_TIMEOUT_MS = 12000;
export const STUDENT_CLASSROOM_BATCH_TIMEOUT_MS = 30000;

export function studentClassroomAccessError(message = "Student Classroom work could not be read completely.", code = "STUDENT_CLASSROOM_SOURCE_UNAVAILABLE", status = 503) {
  return Object.assign(new Error(message), { code, status, expose: true });
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}
function domainForEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.split("@").length !== 2) return null;
  const [local, domain] = value.toLowerCase().split("@");
  return local && domain && /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw studentClassroomAccessError("The student Classroom source deadline expired.");
}

/** Includes credential acquisition and ignores no provider's unfinished promise. */
export async function withStudentClassroomAccessDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let rejectDeadline: (reason: unknown) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => {
    controller.abort();
    rejectDeadline(studentClassroomAccessError("The student Classroom source deadline expired."));
  };
  const timer = setTimeout(abort, timeoutMs);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  try { return await Promise.race([Promise.resolve().then(() => { assertNotAborted(controller.signal); return read(controller.signal); }), deadline]); }
  finally { clearTimeout(timer); parentSignal?.removeEventListener("abort", abort); controller.abort(); }
}

async function boundedMap<T, R>(items: readonly T[], concurrency: number, read: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      assertNotAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await read(items[index]!); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}

type SourceBudget = { bytes: number; posts: number };
type Lane = "courses" | "work" | "materials" | "announcements";
async function pages(client: StudentClassroomAccessClient, lane: Lane, courseId: string | undefined, budget: SourceBudget, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const seenTokens = new Set<string>();
  const seenIds = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    assertNotAborted(signal);
    const params = lane === "courses"
      ? { studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"], pageSize: 100, pageToken }
      : { courseId, pageSize: 100, pageToken, ...(lane === "work" ? { courseWorkStates: ["PUBLISHED"] }
        : lane === "materials" ? { courseWorkMaterialStates: ["PUBLISHED"] } : { announcementStates: ["PUBLISHED"] }) };
    let response;
    try { response = await client[lane](params); }
    catch { throw studentClassroomAccessError(); }
    assertNotAborted(signal);
    if (!response?.data || typeof response.data !== "object" || Array.isArray(response.data))
      throw studentClassroomAccessError("The student Classroom source response is incomplete.");
    const data = object(response.data);
    const key = lane === "courses" ? "courses" : lane === "work" ? "courseWork" : lane === "materials" ? "courseWorkMaterial" : "announcements";
    if (data[key] !== undefined && !Array.isArray(data[key])) throw studentClassroomAccessError("The student Classroom source response is incomplete.");
    for (const raw of Array.isArray(data[key]) ? data[key] : []) {
      const row = object(raw);
      if (!identifier(row.id) || seenIds.has(row.id)) throw studentClassroomAccessError("The student Classroom source has incomplete or duplicate identities.");
      seenIds.add(row.id);
      budget.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (budget.bytes > MAX_SOURCE_BYTES) throw studentClassroomAccessError("The student Classroom source is too large to read completely.");
      if (lane === "courses") {
        if (!["ACTIVE", "ARCHIVED"].includes(String(row.courseState))) throw studentClassroomAccessError("The student Classroom course source is incomplete.");
        if (items.length >= MAX_COURSES) throw studentClassroomAccessError("The student has too many Classroom courses to read completely.");
      } else {
        if (row.state !== "PUBLISHED") throw studentClassroomAccessError("Only published Classroom work can grant access.");
        const text = lane === "announcements" ? row.text : row.description;
        if (text !== undefined && typeof text !== "string") throw studentClassroomAccessError("The student Classroom post text is incomplete.");
        if (++budget.posts > MAX_POSTS) throw studentClassroomAccessError("The student's Classroom posts exceed the source limit.");
      }
      items.push(row);
    }
    if (data.nextPageToken === undefined || data.nextPageToken === "") return items;
    if (typeof data.nextPageToken !== "string" || data.nextPageToken.length > 2048 || seenTokens.has(data.nextPageToken))
      throw studentClassroomAccessError("Student Classroom pagination did not complete.");
    seenTokens.add(data.nextPageToken); pageToken = data.nextPageToken;
  }
  throw studentClassroomAccessError("Student Classroom pagination did not complete within the source limit.");
}

function visibleToStudent(post: Record<string, unknown>, googleUserId: string): boolean {
  if (post.assigneeMode === undefined || post.assigneeMode === "ALL_STUDENTS") return true;
  if (post.assigneeMode !== "INDIVIDUAL_STUDENTS") throw studentClassroomAccessError("The student Classroom audience is incomplete.");
  const recipients = object(post.individualStudentsOptions).studentIds;
  if (!Array.isArray(recipients) || !recipients.length || recipients.some(value => !identifier(value)))
    throw studentClassroomAccessError("The student Classroom audience is incomplete.");
  return recipients.includes(googleUserId);
}

/** All authorization is the exact student subject, never a teacher or browser-profile account. */
export async function fetchStudentClassroomAccessSource(client: StudentClassroomAccessClient,
  identity: { studentId: string; googleUserId: string; schoolDomain: string; email?: string; signal?: AbortSignal }): Promise<Omit<StudentClassroomAccessSource, "approvalKey">> {
  assertNotAborted(identity.signal);
  let profile;
  try { profile = object((await client.profile())?.data); }
  catch { throw studentClassroomAccessError(); }
  assertNotAborted(identity.signal);
  if (!identifier(identity.googleUserId) || profile.id !== identity.googleUserId
    || domainForEmail(profile.emailAddress) !== identity.schoolDomain)
    throw studentClassroomAccessError("The Google identity does not match this school's student.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
  const budget = { bytes: 0, posts: 0 };
  const courses = await pages(client, "courses", undefined, budget, identity.signal);
  const perCourse = await boundedMap(courses, 2, async course => {
    const posts: Record<string, unknown>[] = [];
    for (const lane of ["work", "materials", "announcements"] as const) {
      for (const post of await pages(client, lane, String(course.id), budget, identity.signal)) {
        if (!visibleToStudent(post, identity.googleUserId)) continue;
        const id = createHash("sha256").update(JSON.stringify([lane, post.id])).digest("hex");
        posts.push({ ...post, id: `${lane === "work" ? "work" : "material"}:${id}`,
          ...(lane === "announcements" ? { description: post.text ?? "" } : {}) });
      }
    }
    const source = buildClassroomFocusSource({ id: String(course.id), name: "Student Classroom course" }, posts, { excludeGoogleSearch: true });
    return { id: String(course.id), state: String(course.courseState), source };
  }, identity.signal);
  assertNotAborted(identity.signal);
  const hosts = new Set<string>(CLASSROOM_FOCUS_BASE_DOMAINS);
  const resources = new Map<string, PreciseAllowedResource>();
  let itemCount = 0;
  let linkCount = 0;
  let blockedSearchLinkCount = 0;
  for (const course of perCourse) {
    itemCount += course.source.itemCount;
    linkCount += course.source.linkCount;
    blockedSearchLinkCount += course.source.blockedSearchLinkCount ?? 0;
    if (linkCount > MAX_LINKS) throw studentClassroomAccessError("The student's Classroom links exceed the source limit.");
    for (const host of course.source.scope.allowedDomains) hosts.add(host);
    for (const resource of course.source.scope.resources) resources.set(restrictionResourceIdentityKey(resource), resource);
  }
  const allowedDomains = [...hosts].sort();
  const preciseResources = [...resources.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
  const sourceRevision = createHash("sha256").update(JSON.stringify({ googleUserId: identity.googleUserId, email: identity.email?.toLowerCase(),
    courses: perCourse.map(course => ({ id: course.id, state: course.state, revision: course.source.scope.sourceRevision }))
      .sort((left, right) => left.id.localeCompare(right.id)), allowedDomains, resources: preciseResources })).digest("hex");
  return { studentId: identity.studentId, courseCount: courses.length, itemCount, linkCount,
    ...(blockedSearchLinkCount ? { blockedSearchLinkCount } : {}),
    scope: normalizeClassroomFocusScope({ schemaVersion: 1, sourceRevision, allowedDomains, resources: preciseResources }) };
}

async function defaultDependencies(schoolId: string): Promise<StudentClassroomAccessSourceDependencies> {
  const [storage, tenant, access] = await Promise.all([import("./storage.js"), import("../middleware/tenantContext.js"), import("./googleClassroomAccess.js")]);
  return {
    getApprovalKey: access.studentClassroomAccessApprovalKeyForSchool,
    getSchoolDomain: id => tenant.runWithTenantContext({ schoolId: id }, async () => storage.normalizeDomain((await storage.getSchoolById(id))?.domain)),
    getStudent: (id, school) => tenant.runWithTenantContext({ schoolId: school }, async () => storage.getStudentForGoogleClassroomAccess(school, id)),
    createClient: (student, options) => access.createStudentClassroomAccessClient(schoolId, student, options),
  };
}

/** No provider results are cached across students or requests. Partial batches never grant permissions. */
export async function resolveStudentClassroomAccessSources(options: { schoolId: string; studentIds: string[] },
  dependencies?: StudentClassroomAccessSourceDependencies): Promise<StudentClassroomAccessSource[]> {
  if (!identifier(options.schoolId) || !Array.isArray(options.studentIds) || !options.studentIds.length
    || options.studentIds.length > 1000 || options.studentIds.some(id => !identifier(id))
    || new Set(options.studentIds).size !== options.studentIds.length)
    throw studentClassroomAccessError("Choose an exact nonempty set of students from the current school.", "STUDENT_CLASSROOM_TARGETS_INVALID", 400);
  const deps = dependencies ?? await defaultDependencies(options.schoolId);
  try { return await withStudentClassroomAccessDeadline(async batchSignal => {
    const approvalKey = await deps.getApprovalKey(options.schoolId);
    if (!approvalKey || !/^[a-f0-9]{64}$/.test(approvalKey)) throw studentClassroomAccessError("A school administrator must authorize student Classroom access first.", "STUDENT_CLASSROOM_APPROVAL_REQUIRED", 409);
    const schoolDomain = await deps.getSchoolDomain(options.schoolId);
    if (!schoolDomain) throw studentClassroomAccessError("This school has no verified Google domain.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
    const googleSubjects = new Set<string>();
    const results = await boundedMap(options.studentIds, 4, id => withStudentClassroomAccessDeadline(async signal => {
      const student = await deps.getStudent(id, options.schoolId);
      assertNotAborted(signal);
      if (!student || student.id !== id || student.schoolId !== options.schoolId || student.status !== "active"
        || !identifier(student.googleUserId) || domainForEmail(student.email) !== schoolDomain)
        throw studentClassroomAccessError("A current-school student needs a verified Google identity before Classroom access can be read.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
      const captured = { ...student, googleUserId: student.googleUserId, email: student.email! };
      if (googleSubjects.has(captured.googleUserId)) throw studentClassroomAccessError("Two student records have the same Google identity. Review the school roster.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
      googleSubjects.add(captured.googleUserId);
      const client = await deps.createClient(captured, { signal, timeoutMs: STUDENT_CLASSROOM_REQUEST_TIMEOUT_MS });
      assertNotAborted(signal);
      const result = await fetchStudentClassroomAccessSource(client, { studentId: id, googleUserId: captured.googleUserId, email: captured.email, schoolDomain, signal });
      const current = await deps.getStudent(id, options.schoolId);
      assertNotAborted(signal);
      if (!current || current.id !== captured.id || current.schoolId !== captured.schoolId || current.status !== "active"
        || current.googleUserId !== captured.googleUserId || current.email?.toLowerCase() !== captured.email.toLowerCase())
        throw studentClassroomAccessError("The student's Google identity changed while Classroom work was being read.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
      return { ...result, approvalKey };
    }, deps.studentTimeoutMs ?? STUDENT_CLASSROOM_SOURCE_TIMEOUT_MS, batchSignal), batchSignal);
    if (await deps.getApprovalKey(options.schoolId) !== approvalKey) throw studentClassroomAccessError("Student Classroom approval changed during the source read.", "STUDENT_CLASSROOM_APPROVAL_REQUIRED", 409);
    if (await deps.getSchoolDomain(options.schoolId) !== schoolDomain) throw studentClassroomAccessError("The school Google domain changed while Classroom work was being read.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
    assertNotAborted(batchSignal);
    return results;
  }, deps.batchTimeoutMs ?? STUDENT_CLASSROOM_BATCH_TIMEOUT_MS); }
  catch (error) {
    if (error instanceof Error && "expose" in error && error.expose === true && "code" in error
      && typeof error.code === "string" && /^(STUDENT_CLASSROOM_|CLASSROOM_FOCUS_)/.test(error.code)) throw error;
    throw studentClassroomAccessError();
  }
}
