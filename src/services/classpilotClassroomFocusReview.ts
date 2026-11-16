import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalUrlForResource } from "./restrictionResources.js";
import { CLASSROOM_FOCUS_BASE_DOMAINS, type ClassroomFocusScope } from "./classroomFocusScope.js";
import { classroomFocusSourceError, resolveClassroomFocusSource, type ClassroomFocusSourceRequest, type ClassroomFocusSource } from "./classpilotClassroomFocusSource.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export type ClassroomFocusReviewRequest = ClassroomFocusSourceRequest & { targetStudentIds: string[] };
type Dependencies = { enabled?: boolean; resolveSource?: (request: ClassroomFocusSourceRequest) => Promise<ClassroomFocusSource>; now?: () => number; signingSecret?: string };
function requireEnabled(request: ClassroomFocusReviewRequest, dependencies: Dependencies) {
  if (!(dependencies.enabled ?? isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId: request.schoolId })))
    throw classroomFocusSourceError("Classroom Focus is not enabled for this school.", "CLASSROOM_FOCUS_DISABLED", 409);
}
function fail(): never { throw classroomFocusSourceError("This Classroom Focus review expired or changed. Review the exact course and students again.", "CLASSROOM_FOCUS_REVIEW_STALE", 409); }
function secret(dependencies: Dependencies) {
  const value = dependencies.signingSecret || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production")
    throw classroomFocusSourceError("Classroom Focus review is unavailable.", "CLASSROOM_FOCUS_REVIEW_UNAVAILABLE", 503);
  return "classroom-focus-development-only";
}
function signed(payload: string, dependencies: Dependencies) { return createHmac("sha256", secret(dependencies)).update(`classpilot-classroom-focus-v1:${payload}`).digest("base64url"); }
function requestIdentity(request: ClassroomFocusReviewRequest) {
  const { authority } = request;
  if (!request.schoolId || !request.actorId || !authority || Boolean(authority.teachingSessionId) === Boolean(authority.supervisionContextId)) fail();
  if (authority.supervisionContextId && (typeof authority.contextAuthorityRevision !== "string" || !authority.contextAuthorityRevision)) fail();
  if (Object.keys(authority).some(key => !["teachingSessionId", "supervisionContextId", "contextAuthorityRevision"].includes(key))
    || authority.teachingSessionId && authority.contextAuthorityRevision !== undefined) fail();
  const normalizedAuthority = authority.teachingSessionId ? { teachingSessionId: authority.teachingSessionId }
    : { supervisionContextId: authority.supervisionContextId!, contextAuthorityRevision: authority.contextAuthorityRevision! };
  if (!Array.isArray(request.targetStudentIds) || request.targetStudentIds.length === 0 || request.targetStudentIds.length > 500
    || request.targetStudentIds.some(id => typeof id !== "string" || !id || id.length > 128)
    || new Set(request.targetStudentIds).size !== request.targetStudentIds.length)
    throw classroomFocusSourceError("Review a nonempty exact set of student targets.", "CLASSROOM_FOCUS_TARGETS_REQUIRED");
  const targetsHash = createHash("sha256").update(JSON.stringify([...request.targetStudentIds].sort())).digest("hex");
  return { schoolId: request.schoolId, actorId: request.actorId, authority: normalizedAuthority, targetsHash };
}
export async function previewClassroomFocusReview(request: ClassroomFocusReviewRequest, dependencies: Dependencies = {}) {
  const identity = requestIdentity(request);
  requireEnabled(request, dependencies);
  const source = await (dependencies.resolveSource ?? resolveClassroomFocusSource)(request);
  const expiresAt = (dependencies.now ?? Date.now)() + 2 * 60_000;
  const claims = { schemaVersion: 1, ...identity, courseId: source.course.id, sourceRevision: source.scope.sourceRevision, expiresAt };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const reviewToken = `${payload}.${signed(payload, dependencies)}`;
  const base = new Set<string>(CLASSROOM_FOCUS_BASE_DOMAINS);
  return {
    schemaVersion: 1 as const, purpose: "classroom" as const, boundary: "website" as const,
    course: source.course, itemCount: source.itemCount, linkCount: source.linkCount, reviewToken, expiresAt,
    scopes: [
      ...source.scope.allowedDomains.map(hostname => ({ type: "website" as const, hostname, url: `https://${hostname}`, label: "Entire website",
        description: base.has(hostname) ? `All files and pages on ${hostname} are allowed, including personal copies of assigned Google work.` : `Every page on ${hostname} and its subdomains is allowed, including pages outside this assignment.` })),
      ...source.scope.resources.map(resource => ({ type: resource.type, hostname: resource.hostname, url: canonicalUrlForResource(resource),
        label: "Assigned video", description: "Only this assigned YouTube video is included; other videos remain outside this Focus." })),
    ],
    effectiveAllowedDomains: source.scope.allowedDomains,
    warnings: source.scope.allowedDomains.filter(hostname => !base.has(hostname)).map(hostname => ({ code: "BROADER_WEBSITE" as const, hostname,
      message: `${hostname} permits the entire website and its subdomains, not just the assigned link. School and teacher blocks remain in effect.` })),
    skipped: [] as Array<{ url: string; code: string }>,
    authoring: { allowedDomains: source.scope.allowedDomains, resources: source.scope.resources.map(resource => ({ url: canonicalUrlForResource(resource) })) },
  };
}
export async function confirmClassroomFocusReview(request: ClassroomFocusReviewRequest & { courseId: string; reviewToken: string }, dependencies: Dependencies = {}): Promise<ClassroomFocusScope> {
  const identity = requestIdentity(request);
  requireEnabled(request, dependencies);
  if (typeof request.reviewToken !== "string" || request.reviewToken.length > 4096) fail();
  const [payload, mac, extra] = request.reviewToken.split(".");
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || !mac || !/^[A-Za-z0-9_-]{43}$/.test(mac) || extra !== undefined) fail();
  const expected = signed(payload, dependencies);
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail();
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { fail(); }
  if (claims.schemaVersion !== 1 || claims.schoolId !== identity.schoolId || claims.actorId !== identity.actorId
    || JSON.stringify(claims.authority) !== JSON.stringify(identity.authority) || claims.targetsHash !== identity.targetsHash
    || claims.courseId !== request.courseId || typeof claims.expiresAt !== "number" || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= (dependencies.now ?? Date.now)()) fail();
  const source = await (dependencies.resolveSource ?? resolveClassroomFocusSource)(request);
  if (source.course.id !== request.courseId || source.scope.sourceRevision !== claims.sourceRevision
    || claims.expiresAt <= (dependencies.now ?? Date.now)()) fail();
  return source.scope;
}
