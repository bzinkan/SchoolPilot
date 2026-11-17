import { createHash } from "node:crypto";
import { CLASSROOM_FOCUS_BASE_DOMAINS, isGoogleSearchHostname, normalizeClassroomFocusScope, type ClassroomFocusScope } from "./classroomFocusScope.js";
import { canonicalRestrictionHostname, normalizeAllowedResource, restrictionResourceIdentityKey, type PreciseAllowedResource } from "./restrictionResources.js";

export type ClassroomFocusAuthority = { teachingSessionId?: string; supervisionContextId?: string; contextAuthorityRevision?: string };
export type ClassroomFocusSourceRequest = { schoolId: string; actorId: string; authority: ClassroomFocusAuthority; courseId?: string };
export type ClassroomFocusSource = { course: { id: string; name: string }; itemCount: number; linkCount: number; scope: ClassroomFocusScope; blockedSearchLinkCount?: number };
export type ClassroomFocusSourceClient = {
  course: (courseId: string) => Promise<{ data: unknown }>;
  courses: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  work: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  materials: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
};
const MAX_PAGES = 20;
const MAX_ITEMS = 1000;
const MAX_LINKS = 2000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export function classroomFocusSourceError(message: string, code = "CLASSROOM_FOCUS_SOURCE_UNAVAILABLE", status = 400) {
  return Object.assign(new Error(message), { status, code, expose: true });
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw classroomFocusSourceError("A Classroom link is invalid.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw classroomFocusSourceError("A Classroom link is invalid."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !canonicalRestrictionHostname(url.hostname))
    throw classroomFocusSourceError("A Classroom link is not a supported public website.");
  return url.href;
}

/** Only teacher-published post content is read. No student submissions or destination pages are fetched. */
export function buildClassroomFocusSource(course: { id: string; name: string }, items: readonly unknown[], options: { excludeGoogleSearch?: boolean } = {}): ClassroomFocusSource {
  if (!course.id || !course.name || items.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(items)) > MAX_SOURCE_BYTES)
    throw classroomFocusSourceError("This course source is too large to review completely.");
  const urls = new Set<string>();
  const identities = new Set<string>();
  const add = (value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    urls.add(sourceUrl(value));
    if (urls.size > MAX_LINKS) throw classroomFocusSourceError("This course has too many linked items to review completely.");
  };
  for (const raw of items) {
    const item = object(raw);
    if (item.state !== "PUBLISHED") throw classroomFocusSourceError("Only published Classroom items can be reviewed.");
    if (typeof item.id !== "string" || !/^(work|material):[^\s:]{1,128}$/.test(item.id) || identities.has(item.id))
      throw classroomFocusSourceError("The published course source is incomplete or has duplicate item identities.");
    identities.add(item.id);
    add(item.alternateLink);
    if (typeof item.description === "string") {
      for (const match of item.description.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) add(match[0].replace(/[.,;!?)\]}]+$/, ""));
    }
    if (item.materials !== undefined && !Array.isArray(item.materials)) throw classroomFocusSourceError("A published Classroom attachment is incomplete.");
    for (const rawMaterial of Array.isArray(item.materials) ? item.materials : []) {
      const material = object(rawMaterial);
      let recognized = false;
      for (const [key, field] of [["link", "url"], ["form", "formUrl"], ["gem", "url"], ["notebook", "url"]] as const) {
        if (material[key] !== undefined) { recognized = true; const value = object(material[key])[field]; if (!value) throw classroomFocusSourceError("A published Classroom attachment link is incomplete."); add(value); }
      }
      if (material.driveFile !== undefined) {
        recognized = true;
        const file = object(object(material.driveFile).driveFile);
        add(file.alternateLink || (typeof file.id === "string" ? `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` : undefined));
        if (!file.alternateLink && !file.id) throw classroomFocusSourceError("A published Drive attachment link is incomplete.");
      }
      if (material.youtubeVideo !== undefined) {
        recognized = true;
        const video = object(material.youtubeVideo);
        add(typeof video.id === "string" ? `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}` : video.alternateLink);
        if (!video.id && !video.alternateLink) throw classroomFocusSourceError("A published YouTube attachment link is incomplete.");
      }
      if (!recognized) throw classroomFocusSourceError("A published attachment type cannot be included safely. Review the course materials again.");
    }
  }
  const hosts = new Set<string>(CLASSROOM_FOCUS_BASE_DOMAINS);
  const resources = new Map<string, PreciseAllowedResource>();
  let blockedSearchLinkCount = 0;
  for (const value of [...urls].sort()) {
    const url = new URL(value);
    const host = canonicalRestrictionHostname(url.hostname)!;
    if (options.excludeGoogleSearch === true && isGoogleSearchHostname(host)) {
      blockedSearchLinkCount++;
      continue;
    }
    if (["youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be"].includes(host)) {
      const entry = normalizeAllowedResource({ url: value });
      if (entry.type !== "resource" || entry.provider !== "youtube") throw classroomFocusSourceError("A YouTube link must identify one assigned video.");
      resources.set(restrictionResourceIdentityKey(entry), entry);
    } else hosts.add(host);
  }
  const allowedDomains = [...hosts].sort();
  const preciseResources = [...resources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const sourceRevision = createHash("sha256").update(JSON.stringify({ courseId: course.id, itemIds: [...identities].sort(), urls: [...urls].sort(), allowedDomains, resources: preciseResources,
    ...(options.excludeGoogleSearch === true ? { blockedSearchLinkCount } : {}) })).digest("hex");
  return { course, itemCount: identities.size, linkCount: urls.size, ...(blockedSearchLinkCount ? { blockedSearchLinkCount } : {}),
    scope: normalizeClassroomFocusScope({ schemaVersion: 1, sourceRevision, allowedDomains, resources: preciseResources }) };
}

async function pages(client: ClassroomFocusSourceClient, lane: "courses" | "work" | "materials", courseId: string, budget = { bytes: 0 }) {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = lane === "courses" ? { teacherId: "me", courseStates: ["ACTIVE"], pageSize: 100, pageToken }
      : { courseId, pageSize: 100, pageToken, ...(lane === "work" ? { courseWorkStates: ["PUBLISHED"] } : { courseWorkMaterialStates: ["PUBLISHED"] }) };
    const rawData = (await client[lane](params)).data;
    if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) throw classroomFocusSourceError("The Classroom source response is incomplete.");
    const data = object(rawData);
    const rows = data[lane === "courses" ? "courses" : lane === "work" ? "courseWork" : "courseWorkMaterial"];
    if (rows !== undefined && !Array.isArray(rows)) throw classroomFocusSourceError("The Classroom source response is incomplete.");
    for (const row of Array.isArray(rows) ? rows : []) {
      const serialized = JSON.stringify(row);
      if (typeof serialized !== "string") throw classroomFocusSourceError("The Classroom source response is incomplete.");
      budget.bytes += Buffer.byteLength(serialized) + 1;
      if (budget.bytes > MAX_SOURCE_BYTES) throw classroomFocusSourceError("This course source is too large to review completely.");
      items.push(row);
    }
    if (items.length > MAX_ITEMS) throw classroomFocusSourceError("This course source exceeds the review limit.");
    if (!data.nextPageToken) return items;
    if (typeof data.nextPageToken !== "string" || seen.has(data.nextPageToken)) throw classroomFocusSourceError("Classroom pagination did not complete.");
    seen.add(data.nextPageToken); pageToken = data.nextPageToken;
  }
  throw classroomFocusSourceError("Classroom pagination did not complete within the review limit.");
}
export async function fetchPublishedClassroomFocusSource(client: ClassroomFocusSourceClient, courseId: string): Promise<ClassroomFocusSource> {
  const courses = await pages(client, "courses", courseId);
  if (!courses.some(value => object(value).id === courseId)) throw classroomFocusSourceError("Choose a course you teach using this school's connected Google account.", "CLASSROOM_FOCUS_COURSE_FORBIDDEN", 403);
  const metadata = object((await client.course(courseId)).data);
  if (metadata.id !== courseId || metadata.courseState && metadata.courseState !== "ACTIVE") throw classroomFocusSourceError("This Classroom course is no longer active.");
  const sourceBudget = { bytes: 0 };
  const work = await pages(client, "work", courseId, sourceBudget);
  const materials = await pages(client, "materials", courseId, sourceBudget);
  return buildClassroomFocusSource({ id: courseId, name: typeof metadata.name === "string" ? metadata.name : courseId }, [
    ...work.map(value => ({ ...object(value), id: `work:${String(object(value).id || "")}` })),
    ...materials.map(value => ({ ...object(value), id: `material:${String(object(value).id || "")}` })),
  ]);
}

/** Bounds OAuth refresh as well as API transport. Late reads have no mutation authority. */
export async function withClassroomFocusSourceDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(classroomFocusSourceError("Google Classroom could not be read completely before the source deadline.", "CLASSROOM_FOCUS_SOURCE_UNAVAILABLE", 503));
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => read(controller.signal)), timeout]); }
  finally { clearTimeout(timer); }
}

/** The caller has already verified current context ownership and its revision. */
export async function mappedSupervisionClassroomCourse(schoolId: string,
  context: { schoolId: string; scheduledConflictId: string | null }, dependencies: {
    getConflict: (id: string, schoolId: string) => Promise<{ schoolId: string; groupId: string } | undefined>;
    getGroup: (id: string, schoolId: string) => Promise<{ schoolId: string; googleClassroomCourseId: string | null } | undefined>;
  }): Promise<string | undefined> {
  if (context.schoolId !== schoolId) throw classroomFocusSourceError("The classroom source belongs to another school.");
  if (!context.scheduledConflictId) return undefined;
  const conflict = await dependencies.getConflict(context.scheduledConflictId, schoolId);
  if (!conflict || conflict.schoolId !== schoolId) throw classroomFocusSourceError("The scheduled classroom source is unavailable for this school.");
  const group = await dependencies.getGroup(conflict.groupId, schoolId);
  if (!group || group.schoolId !== schoolId) throw classroomFocusSourceError("The original classroom source is unavailable for this school.");
  return group.googleClassroomCourseId?.trim() || undefined;
}

export async function resolveClassroomFocusSource(options: ClassroomFocusSourceRequest): Promise<ClassroomFocusSource> {
  const storage = await import("./storage.js");
  let courseId = options.courseId?.trim();
  if (options.authority.teachingSessionId) {
    const session = await storage.getTeachingSessionByIdAndSchool(options.authority.teachingSessionId, options.schoolId);
    if (!session || session.endTime || !await storage.isAuthorizedClasspilotSessionStaff(options.schoolId, session.id, options.actorId))
      throw classroomFocusSourceError("Review the current class before setting Classroom Focus.", "CLASSROOM_FOCUS_REVIEW_STALE", 409);
    const group = await storage.getGroupByIdAndSchool(session.groupId, options.schoolId);
    courseId ||= group?.googleClassroomCourseId?.trim();
  } else if (options.authority.supervisionContextId) {
    const { requireScheduledClassroomContext } = await import("./classpilotActivityAuthority.js");
    const context = await requireScheduledClassroomContext({ schoolId: options.schoolId, actorId: options.actorId,
      supervisionContextId: options.authority.supervisionContextId, contextAuthorityRevision: options.authority.contextAuthorityRevision });
    if (!courseId) courseId = await mappedSupervisionClassroomCourse(options.schoolId, context, {
      getConflict: storage.getScheduledClassConflictByIdAndSchool,
      getGroup: storage.getGroupByIdAndSchool,
    });
  } else throw classroomFocusSourceError("Exactly one active classroom authority is required.");
  if (!courseId) throw classroomFocusSourceError("Choose the Google Classroom course to review.", "CLASSROOM_FOCUS_COURSE_REQUIRED", 409);
  if (courseId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(courseId)) throw classroomFocusSourceError("Choose a valid Classroom course.");
  const token = await storage.getGoogleOAuthTokenForSchool(options.actorId, options.schoolId);
  if (!token) throw classroomFocusSourceError("NO_TOKENS: Connect your Google account for this school.", "NO_TOKENS");
  const { CLASSROOM_RESOURCE_SCOPES, missingGoogleOAuthScopes } = await import("../util/googleOAuthScopes.js");
  if (missingGoogleOAuthScopes(token.scope, CLASSROOM_RESOURCE_SCOPES).length)
    throw classroomFocusSourceError("MISSING_GOOGLE_SCOPE: Reconnect Google to read Classroom assignments and materials.", "MISSING_GOOGLE_SCOPE");
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: token.refreshToken });
  const classroom = google.classroom({ version: "v1", auth });
  const pageToken = (params: Record<string, unknown>) => typeof params.pageToken === "string" ? params.pageToken : undefined;
  try {
    return await withClassroomFocusSourceDeadline(signal => {
      const requestOptions = { timeout: 8000, signal };
      return fetchPublishedClassroomFocusSource({
        course: id => classroom.courses.get({ id }, requestOptions),
        courses: params => classroom.courses.list({ teacherId: "me", courseStates: ["ACTIVE"], pageSize: 100, pageToken: pageToken(params) }, requestOptions),
        work: params => classroom.courses.courseWork.list({ courseId: courseId!, courseWorkStates: ["PUBLISHED"], pageSize: 100, pageToken: pageToken(params) }, requestOptions),
        materials: params => classroom.courses.courseWorkMaterials.list({ courseId: courseId!, courseWorkMaterialStates: ["PUBLISHED"], pageSize: 100, pageToken: pageToken(params) }, requestOptions),
      }, courseId!);
    });
  } catch (error) {
    if (error && typeof error === "object" && "expose" in error) throw error;
    throw classroomFocusSourceError("Google Classroom could not be read completely. Reconnect or retry before setting Focus.", "CLASSROOM_FOCUS_SOURCE_UNAVAILABLE", 503);
  }
}
