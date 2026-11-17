import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CLASSROOM_FOCUS_BASE_DOMAINS, isClassroomFocusWebsiteUrl, isGoogleSearchHostname, normalizeClassroomFocusScope,
  validateClassroomFocusScope, type ClassroomFocusScope } from "./classroomFocusScope.js";
import { assertRestrictionResourceLimits, canonicalRestrictionHostname, canonicalUrlForResource,
  restrictionResourceIdentityKey, validateAllowedResourceList, type PreciseAllowedResource } from "./restrictionResources.js";
import { effectiveFlightPathAllowedDomains } from "./classpilotFlightPathDomains.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export type StudentClassroomAccessSource = { studentId: string; scope: ClassroomFocusScope; courseCount: number; itemCount: number; linkCount: number; approvalKey: string; blockedSearchLinkCount?: number };
export type StudentClassroomAccessMode = "focus" | "flight-path" | "automatic-flight-path";
export type StudentClassroomFlightPath = { id: string; flightPathName: string; allowedDomains: string[] | null; resources?: unknown; updatedAt?: Date | string };
type ReviewDependencies = { now?: () => number; signingSecret?: string };
type ReviewIdentity = Record<string, unknown>;
type Payload = Record<string, unknown>;
function record(value: unknown): Payload { return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : {}; }
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(record(value)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function studentClassroomAccessProjectionsEqual(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function fail(code = "STUDENT_CLASSROOM_ACCESS_REVIEW_STALE", message = "Classroom access changed or this review expired. Review the selected students again."): never {
  throw Object.assign(new Error(message), { status: 409, code, expose: true });
}
function secret(deps: ReviewDependencies): string {
  const configured = deps.signingSecret || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") fail("STUDENT_CLASSROOM_ACCESS_REVIEW_UNAVAILABLE");
  return "student-classroom-access-development-only";
}
function sign(payload: string, deps: ReviewDependencies): string {
  return createHmac("sha256", secret(deps)).update(`student-classroom-access-v1:${payload}`).digest("base64url");
}
export function studentClassroomAccessSourcesHash(sources: readonly StudentClassroomAccessSource[]): string {
  if (!sources.length || sources.length > 500 || new Set(sources.map(source => source.studentId)).size !== sources.length) fail();
  return hash(sources.map(source => {
    if (!source.studentId || source.studentId.length > 128 || !/^[a-f0-9]{64}$/.test(source.approvalKey)) fail();
    return [source.studentId, normalizeClassroomFocusScope(source.scope).sourceRevision, source.approvalKey,
      source.courseCount, source.itemCount, source.linkCount, source.blockedSearchLinkCount ?? 0] as const;
  }).sort((left, right) => left[0].localeCompare(right[0])));
}
export function createStudentClassroomAccessReview(options: { identity: ReviewIdentity; mode: StudentClassroomAccessMode; sources: readonly StudentClassroomAccessSource[] }, deps: ReviewDependencies = {}) {
  const expiresAt = (deps.now ?? Date.now)() + 120_000;
  const claims = { schemaVersion: 1, mode: options.mode, identityHash: hash(options.identity), sourceMapHash: studentClassroomAccessSourcesHash(options.sources), expiresAt };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const domains = [...new Set(options.sources.flatMap(source => source.scope.allowedDomains))].sort();
  const resourceMap = new Map(options.sources.flatMap(source => source.scope.resources).map(resource => [restrictionResourceIdentityKey(resource), resource]));
  const base = new Set<string>(CLASSROOM_FOCUS_BASE_DOMAINS);
  const blockedSearchLinkCount = options.sources.reduce((total, source) => total + (source.blockedSearchLinkCount ?? 0), 0);
  return { schemaVersion: 1 as const, purpose: "student-classroom-access" as const, mode: options.mode,
    studentCount: options.sources.length, courseCount: options.sources.reduce((total, source) => total + source.courseCount, 0),
    itemCount: options.sources.reduce((total, source) => total + source.itemCount, 0), linkCount: options.sources.reduce((total, source) => total + source.linkCount, 0),
    scopes: [...domains.map(hostname => ({ type: "website" as const, hostname, url: `https://${hostname}`, label: "Entire website",
      description: "The website and its subdomains are available only to students whose own Classroom work includes it." })),
      ...[...resourceMap.values()].map(resource => ({ type: resource.type, hostname: resource.hostname, url: canonicalUrlForResource(resource), label: "Assigned video",
        description: "Only the assigned video is included for its own student recipients." }))],
    warnings: [...domains.filter(hostname => !base.has(hostname)).map(hostname => ({ code: "BROADER_WEBSITE" as const, hostname,
      message: `${hostname} permits its whole website and subdomains. Students can find other content within an approved website. School and teacher blocks remain in effect.` })),
      ...(blockedSearchLinkCount ? [{ code: "GOOGLE_SEARCH_BLOCKED" as const, count: blockedSearchLinkCount,
        message: `${blockedSearchLinkCount} published Google Search link${blockedSearchLinkCount === 1 ? " stays" : "s stay"} blocked. Classroom assignments and other approved materials remain available.` }] : [])],
    reviewToken: `${payload}.${sign(payload, deps)}`, expiresAt };
}
export function verifyStudentClassroomAccessReview(options: { identity: ReviewIdentity; mode: StudentClassroomAccessMode; reviewToken: string; sources?: readonly StudentClassroomAccessSource[] }, deps: ReviewDependencies = {}): { sourceMapHash: string; expiresAt: number } {
  if (typeof options.reviewToken !== "string" || options.reviewToken.length > 8192) fail();
  const [payload, mac, extra] = options.reviewToken.split(".");
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || !mac || !/^[A-Za-z0-9_-]{43}$/.test(mac) || extra !== undefined) fail();
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload, deps)))) fail();
  let claims: Payload;
  try { claims = record(JSON.parse(Buffer.from(payload, "base64url").toString())); } catch { fail(); }
  if (claims.schemaVersion !== 1 || claims.mode !== options.mode || claims.identityHash !== hash(options.identity)
    || typeof claims.sourceMapHash !== "string" || !/^[a-f0-9]{64}$/.test(claims.sourceMapHash)
    || typeof claims.expiresAt !== "number" || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= (deps.now ?? Date.now)()
    || options.sources && claims.sourceMapHash !== studentClassroomAccessSourcesHash(options.sources)) fail();
  return { sourceMapHash: claims.sourceMapHash, expiresAt: claims.expiresAt };
}
function basePolicy(path: StudentClassroomFlightPath) {
  const resources = validateAllowedResourceList(path.resources ?? []);
  if (!resources || !path.id || path.allowedDomains !== null && !Array.isArray(path.allowedDomains)) fail("FLIGHT_PATH_RESOURCES_INVALID");
  const domains = (path.allowedDomains ?? []).map(raw => {
    const hostname = canonicalRestrictionHostname(raw);
    if (!hostname) fail("FLIGHT_PATH_RESOURCES_INVALID");
    return hostname;
  });
  for (const resource of resources) if (resource.type === "website" && !domains.includes(resource.hostname)) domains.push(resource.hostname);
  if (!domains.includes("classroom.google.com")) fail("STUDENT_CLASSROOM_FLIGHT_PATH_REQUIRED", "Choose a Flight Path containing classroom.google.com.");
  if (domains.some(isGoogleSearchHostname) || resources.some(resource => isGoogleSearchHostname(resource.hostname)))
    fail("STUDENT_CLASSROOM_GOOGLE_SEARCH_CONFLICT", "Remove Google Search from this Flight Path before using Classroom access.");
  return { id: path.id, flightPathName: path.flightPathName, allowedDomains: [...new Set(domains)], resources,
    updatedAt: path.updatedAt instanceof Date ? path.updatedAt.toISOString() : path.updatedAt ?? "" };
}
export function classroomFlightPathBasePolicyHash(path: StudentClassroomFlightPath): string { return hash(basePolicy(path)); }
function compiledProjection(path: StudentClassroomFlightPath, scope: ClassroomFocusScope) {
  const base = basePolicy(path);
  const allowedDomains = [...new Set([...effectiveFlightPathAllowedDomains(base.allowedDomains), ...scope.allowedDomains])];
  const resourceMap = new Map([...base.resources, ...scope.resources].filter(resource => resource.type !== "website")
    .map(resource => [restrictionResourceIdentityKey(resource), resource as PreciseAllowedResource]));
  const resources = [...resourceMap.values()];
  for (const resource of base.resources) if (resource.type === "website" && !allowedDomains.includes(resource.hostname)) allowedDomains.push(resource.hostname);
  assertRestrictionResourceLimits([...allowedDomains.map(hostname => ({ type: "website" as const, hostname, includeSubdomains: true as const })), ...resources]);
  return { base, allowedDomains, resources };
}
export function compileStudentClassroomFlightPath(options: { schoolId: string; flightPath: StudentClassroomFlightPath; source: StudentClassroomAccessSource }) {
  if (!/^[a-f0-9]{64}$/.test(options.source.approvalKey)) fail();
  const scope = normalizeClassroomFocusScope(options.source.scope);
  const { base, allowedDomains, resources } = compiledProjection(options.flightPath, scope);
  const classroomMaterials = { schemaVersion: 1, schoolId: options.schoolId, studentId: options.source.studentId,
    sourceRevision: scope.sourceRevision, approvalKey: options.source.approvalKey, sourceScope: scope, basePolicy: base, basePolicyHash: hash(base), projectionHash: hash({ allowedDomains, resources }) };
  return { flightPathId: options.flightPath.id, flightPathName: options.flightPath.flightPathName, allowedDomains,
    ...(resources.length ? { resources } : {}), classroomMaterials };
}
export function validateStudentClassroomFlightPath(value: unknown): boolean {
  const payload = record(value), marker = record(payload.classroomMaterials);
  if (marker.schemaVersion !== 1 || typeof marker.schoolId !== "string" || typeof marker.studentId !== "string"
    || !marker.schoolId || !marker.studentId || typeof marker.approvalKey !== "string" || !/^[a-f0-9]{64}$/.test(marker.approvalKey) || !validateClassroomFocusScope(marker.sourceScope)) return false;
  const base = record(marker.basePolicy);
  if (typeof base.id !== "string" || typeof base.flightPathName !== "string" || !Array.isArray(base.allowedDomains)) return false;
  try {
    const normalizedBase = basePolicy(base as unknown as StudentClassroomFlightPath);
    const scope = normalizeClassroomFocusScope(marker.sourceScope);
    const projected = compiledProjection(normalizedBase, scope);
    return marker.sourceRevision === scope.sourceRevision && marker.basePolicyHash === hash(normalizedBase)
      && marker.projectionHash === hash({ allowedDomains: projected.allowedDomains, resources: projected.resources })
      && canonical(payload.allowedDomains) === canonical(projected.allowedDomains)
      && canonical(payload.resources ?? []) === canonical(projected.resources);
  } catch { return false; }
}
export function createStudentClassroomFocusPayload(schoolId: string, source: StudentClassroomAccessSource) {
  if (!/^[a-f0-9]{64}$/.test(source.approvalKey)) fail();
  const classroomScope = normalizeClassroomFocusScope(source.scope);
  return { url: "https://classroom.google.com/", classroomScope,
    classroomMaterials: { schemaVersion: 1, schoolId, studentId: source.studentId, sourceRevision: classroomScope.sourceRevision, approvalKey: source.approvalKey, projectionHash: hash(classroomScope) } };
}
export function hasStudentClassroomAccessProvenance(value: unknown): boolean {
  const desired = record(value), restrictions = record(desired.restrictions ?? desired);
  return [record(restrictions.screenLock), record(restrictions.flightPath)].some(item => Object.hasOwn(item, "classroomMaterials"));
}
export function studentClassroomRestrictionsValidForStudent(value: unknown, schoolId: string, studentId: string): boolean {
  const desired = record(value), restrictions = record(desired.restrictions ?? desired);
  for (const [kind, restriction] of [["focus", record(restrictions.screenLock)], ["flight-path", record(restrictions.flightPath)]] as const) {
    if (!Object.hasOwn(restriction, "classroomMaterials")) continue;
    const marker = record(restriction.classroomMaterials);
    if (marker.schoolId !== schoolId || marker.studentId !== studentId || restriction.active !== true
      || typeof marker.approvalKey !== "string" || !/^[a-f0-9]{64}$/.test(marker.approvalKey)) return false;
    if (kind === "flight-path") { if (!validateStudentClassroomFlightPath(restriction)) return false; }
    else if (marker.schemaVersion !== 1 || !isClassroomFocusWebsiteUrl(restriction.url) || !validateClassroomFocusScope(restriction.classroomScope)
      || marker.sourceRevision !== record(restriction.classroomScope).sourceRevision || marker.projectionHash !== hash(restriction.classroomScope)) return false;
  }
  return true;
}
export function stripStudentClassroomProvenance(value: unknown): Payload {
  const restrictions = record(value);
  return { ...restrictions, ...Object.fromEntries(["screenLock", "flightPath"].map(key => {
    const { classroomMaterials: _private, ...visible } = record(restrictions[key]);
    return [key, visible];
  })) };
}
let approvalCacheReader: ((schoolId: string) => string | null) | undefined;
function approvalMatches(value: unknown, key: string | null): boolean {
  const desired = record(value), restrictions = record(desired.restrictions ?? desired);
  const marked = [record(restrictions.screenLock), record(restrictions.flightPath)].filter(item => Object.hasOwn(item, "classroomMaterials"));
  return !!key && marked.length > 0 && marked.every(item => record(item.classroomMaterials).approvalKey === key);
}
export function studentClassroomAccessApprovalFromCache(schoolId: string, desiredState: unknown): boolean {
  return approvalMatches(desiredState, approvalCacheReader?.(schoolId) ?? null);
}
export function studentClassroomAccessApprovalKeyForState(state: { schoolId: string; desiredState: unknown;
  scheduledEndAt?: Date | null; hardExpiresAt?: Date | null }): string | null {
  if ([state.scheduledEndAt, state.hardExpiresAt].some(deadline => !!deadline && deadline.getTime() <= Date.now())) return null;
  const desired = record(state.desiredState), restrictions = record(desired.restrictions ?? desired);
  const markers = [record(restrictions.screenLock), record(restrictions.flightPath)]
    .filter(item => Object.hasOwn(item, "classroomMaterials")).map(item => record(item.classroomMaterials));
  const key = markers[0]?.approvalKey;
  return typeof key === "string" && /^[a-f0-9]{64}$/.test(key)
    && markers.every(marker => marker.approvalKey === key && marker.schoolId === state.schoolId) ? key : null;
}
export function studentClassroomAccessPublicationApprovedFromCache(schoolId: string, requiredKey?: unknown): boolean {
  return requiredKey === undefined || typeof requiredKey === "string" && /^[a-f0-9]{64}$/.test(requiredKey)
    && isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId }) && approvalCacheReader?.(schoolId) === requiredKey;
}
export async function studentClassroomAccessPublicationApproved(schoolId: string, requiredKey?: unknown): Promise<boolean> {
  if (requiredKey === undefined) return true;
  if (typeof requiredKey !== "string" || !/^[a-f0-9]{64}$/.test(requiredKey)
    || !isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId })) return false;
  try {
    const modulePath = "./googleClassroomAccess.js";
    const source = await import(modulePath);
    approvalCacheReader = source.studentClassroomAccessApprovalKeyFromCache;
    return await source.studentClassroomAccessApprovalKeyForSchool(schoolId) === requiredKey
      && isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId });
  } catch { return false; }
}
export async function studentClassroomAccessApprovalForState(state: { schoolId: string; desiredState: unknown }): Promise<boolean> {
  if (!hasStudentClassroomAccessProvenance(state.desiredState)) return false;
  try {
    const modulePath = "./googleClassroomAccess.js";
    const source = await import(modulePath);
    approvalCacheReader = source.studentClassroomAccessApprovalKeyFromCache;
    return approvalMatches(state.desiredState, await source.studentClassroomAccessApprovalKeyForSchool(state.schoolId));
  } catch { return false; }
}
export function createStudentClassroomAccessEnvelope(options: { mode: "focus" | "flight-path"; payloadByStudent: Record<string, Payload> }) {
  const entries = Object.entries(options.payloadByStudent);
  if (!entries.length || entries.length > 500 || entries.some(([id, payload]) => !id || id.length > 128 || !payload || typeof payload !== "object")) fail();
  const envelope = { schemaVersion: 1, mode: options.mode, payloadByStudent: options.payloadByStudent };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 512 * 1024) fail("STUDENT_CLASSROOM_ACCESS_TOO_LARGE", "Review fewer students at once; their combined Classroom permissions exceed the safe command limit.");
  return envelope;
}
export function studentClassroomCommandPayloadForTarget(payload: Payload, studentId: string): Payload | null {
  if (!Object.hasOwn(payload, "classroomAccessV1")) return payload;
  const envelope = record(payload.classroomAccessV1), map = record(envelope.payloadByStudent);
  if (envelope.schemaVersion !== 1 || !["focus", "flight-path"].includes(String(envelope.mode)) || !Object.hasOwn(map, studentId)) return null;
  const chosen = record(map[studentId]);
  if (!Object.keys(chosen).length || Object.hasOwn(chosen, "classroomAccessV1")) return null;
  return chosen;
}

export type StudentClassroomManualReviewRequest = {
  schoolId: string; actorId: string; mode: "focus" | "flight-path";
  authority: { teachingSessionId?: string; supervisionContextId?: string; contextAuthorityRevision?: string };
  targetStudentIds: string[]; flightPathId?: string; expectedFlightPathUpdatedAt?: string;
};
type ManualDependencies = ReviewDependencies & { enabled?: boolean;
  resolveSources?: (request: { schoolId: string; studentIds: string[] }) => Promise<StudentClassroomAccessSource[]>;
  loadFlightPath?: (id: string, schoolId: string, actorId: string) => Promise<StudentClassroomFlightPath | undefined> };
function requireEnabled(schoolId: string, deps: ManualDependencies) {
  if (!(deps.enabled ?? isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId }))) fail("CLASSROOM_FOCUS_DISABLED", "Classroom access is not enabled for this school.");
}
async function manualIdentity(request: StudentClassroomManualReviewRequest, deps: ManualDependencies) {
  requireEnabled(request.schoolId, deps);
  const authority = request.authority;
  if (!request.schoolId || !request.actorId || !authority || Boolean(authority.teachingSessionId) === Boolean(authority.supervisionContextId)
    || authority.supervisionContextId && !authority.contextAuthorityRevision || authority.teachingSessionId && authority.contextAuthorityRevision !== undefined
    || Object.keys(authority).some(key => !["teachingSessionId", "supervisionContextId", "contextAuthorityRevision"].includes(key))
    || !Array.isArray(request.targetStudentIds) || !request.targetStudentIds.length || request.targetStudentIds.length > 500
    || request.targetStudentIds.some(id => typeof id !== "string" || !id || id.length > 128)
    || new Set(request.targetStudentIds).size !== request.targetStudentIds.length || !["focus", "flight-path"].includes(request.mode)) fail();
  let flightPath: StudentClassroomFlightPath | undefined;
  if (request.mode === "flight-path") {
    if (typeof request.flightPathId !== "string" || !request.flightPathId || request.flightPathId.length > 128
      || typeof request.expectedFlightPathUpdatedAt !== "string" || !request.expectedFlightPathUpdatedAt
      || request.expectedFlightPathUpdatedAt.length > 128 || !Number.isFinite(Date.parse(request.expectedFlightPathUpdatedAt))) fail("FLIGHT_PATH_REVIEW_STALE");
    const load = deps.loadFlightPath ?? (async (id, schoolId, actorId) => {
      const storage = await import("./storage.js");
      const { isSharedTeachingResourcesEnabled } = await import("../config/sharedTeachingResources.js");
      return (isSharedTeachingResourcesEnabled(schoolId) ? storage.getApplicableFlightPathById : storage.getFlightPathById)(id, schoolId, actorId);
    });
    flightPath = await load(request.flightPathId, request.schoolId, request.actorId);
    if (!flightPath) fail("FLIGHT_PATH_NOT_FOUND");
    const updatedAt = flightPath.updatedAt instanceof Date ? flightPath.updatedAt.getTime() : Date.parse(flightPath.updatedAt ?? "");
    if (updatedAt !== Date.parse(request.expectedFlightPathUpdatedAt)) fail("FLIGHT_PATH_REVIEW_STALE");
    basePolicy(flightPath);
  } else if (request.flightPathId !== undefined || request.expectedFlightPathUpdatedAt !== undefined) fail();
  return { flightPath, identity: { schoolId: request.schoolId, actorId: request.actorId, authority,
    targetStudentIds: [...request.targetStudentIds].sort(), ...(flightPath ? { flightPathId: flightPath.id,
      expectedFlightPathUpdatedAt: new Date(request.expectedFlightPathUpdatedAt!).toISOString(), basePolicyHash: classroomFlightPathBasePolicyHash(flightPath) } : {}) } };
}
async function manualSources(request: StudentClassroomManualReviewRequest, deps: ManualDependencies) {
  const resolve = deps.resolveSources ?? (await import("./classpilotStudentClassroomAccessSource.js")).resolveStudentClassroomAccessSources;
  const sources = await resolve({ schoolId: request.schoolId, studentIds: request.targetStudentIds });
  if (sources.length !== request.targetStudentIds.length || canonical(sources.map(source => source.studentId).sort()) !== canonical([...request.targetStudentIds].sort())) fail();
  studentClassroomAccessSourcesHash(sources);
  return sources;
}
export async function previewStudentClassroomAccess(request: StudentClassroomManualReviewRequest, deps: ManualDependencies = {}) {
  const { identity, flightPath } = await manualIdentity(request, deps);
  const sources = await manualSources(request, deps);
  const payloadByStudent = Object.fromEntries(sources.map(source => [source.studentId, flightPath
    ? compileStudentClassroomFlightPath({ schoolId: request.schoolId, flightPath, source }) : createStudentClassroomFocusPayload(request.schoolId, source)]));
  createStudentClassroomAccessEnvelope({ mode: request.mode, payloadByStudent });
  return createStudentClassroomAccessReview({ identity, mode: request.mode, sources }, deps);
}
export async function prepareStudentClassroomAccessCommand(context: Omit<StudentClassroomManualReviewRequest, "mode" | "authority"> & {
  teachingSessionId?: string | null; supervisionContextId?: string | null; contextAuthorityRevision?: string; targetScope: string;
}, commandType: string, payload: Payload, deps: ManualDependencies = {}): Promise<Payload> {
  if (payload.classroomAccess === undefined) return payload;
  const ref = record(payload.classroomAccess);
  if (Object.keys(ref).length !== 1 || typeof ref.reviewToken !== "string" || context.targetScope !== "students"
    || !["lock-screen", "apply-flight-path"].includes(commandType) || payload.classroomAccessV1 !== undefined
    || commandType === "lock-screen" && !isClassroomFocusWebsiteUrl(payload.url)) fail();
  const request: StudentClassroomManualReviewRequest = { schoolId: context.schoolId, actorId: context.actorId,
    mode: commandType === "lock-screen" ? "focus" : "flight-path",
    authority: context.teachingSessionId ? { teachingSessionId: context.teachingSessionId }
      : { supervisionContextId: context.supervisionContextId ?? undefined, contextAuthorityRevision: context.contextAuthorityRevision },
    targetStudentIds: context.targetStudentIds,
    ...(commandType === "apply-flight-path" ? { flightPathId: String(payload.flightPathId), expectedFlightPathUpdatedAt: String(payload.expectedFlightPathUpdatedAt) } : {}) };
  const { identity, flightPath } = await manualIdentity(request, deps);
  verifyStudentClassroomAccessReview({ identity, mode: request.mode, reviewToken: ref.reviewToken }, deps);
  const sources = await manualSources(request, deps);
  verifyStudentClassroomAccessReview({ identity, mode: request.mode, reviewToken: ref.reviewToken, sources }, deps);
  const payloadByStudent = Object.fromEntries(sources.map(source => [source.studentId, flightPath
    ? compileStudentClassroomFlightPath({ schoolId: request.schoolId, flightPath, source }) : createStudentClassroomFocusPayload(request.schoolId, source)]));
  const { classroomAccess: _reviewToken, ...base } = payload;
  return { ...base, classroomAccessV1: createStudentClassroomAccessEnvelope({ mode: request.mode, payloadByStudent }) };
}
