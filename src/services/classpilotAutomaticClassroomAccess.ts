import { createHash } from "node:crypto";
import type { AutomaticClassroomAccessApproval, AutomaticFlightPathPayload, AutomaticFlightPathPolicy } from "./classpilotAutomaticFlightPath.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { canonicalRestrictionHostname, validateAllowedResourceList } from "./restrictionResources.js";
import { classroomFlightPathBasePolicyHash, compileStudentClassroomFlightPath,
  createStudentClassroomAccessReview, verifyStudentClassroomAccessReview, validateStudentClassroomFlightPath,
  type StudentClassroomAccessSource, type StudentClassroomFlightPath } from "./classpilotStudentClassroomAccess.js";

export type AutomaticClassroomReviewContext = {
  schoolId: string; actorId: string; groupId: string; primaryTeacherId: string; policyRevision: number;
  flightPath: StudentClassroomFlightPath & { updatedAt: Date }; studentIds: string[];
};
export type AutomaticClassroomPreparationContext = Omit<AutomaticClassroomReviewContext, "actorId" | "policyRevision"> & {
  policy: AutomaticFlightPathPolicy;
};
export type PreparedAutomaticClassroomAccess = {
  schemaVersion: 1; status: "ready" | "unavailable"; bindingHash: string | null; preparedAt: number; expiresAt: number;
  reasonCode: string | null; perStudentPayloads: Record<string, AutomaticFlightPathPayload>; payloadsHash: string;
};
type Dependencies = {
  now?: () => number; signingSecret?: string; enabled?: boolean;
  resolveSources?: (request: { schoolId: string; studentIds: string[] }) => Promise<StudentClassroomAccessSource[]>;
};
const PREPARATION_TTL_MS = 60_000;
function fail(code: string, message = "Classroom access changed. Review this class preset again."): never {
  throw Object.assign(new Error(message), { code, status: 409, expose: true });
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function studentIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== "string" || !id || id.length > 128)
    || new Set(value).size !== value.length) fail("STUDENT_CLASSROOM_ACCESS_TARGETS_REQUIRED");
  return [...value].sort();
}
export function automaticFlightPathContainsClassroom(path: StudentClassroomFlightPath): boolean {
  const domains = Array.isArray(path.allowedDomains) ? path.allowedDomains : [];
  return domains.some(domain => canonicalRestrictionHostname(domain) === "classroom.google.com")
    || (validateAllowedResourceList(path.resources ?? []) ?? []).some(resource => resource.type === "website" && resource.hostname === "classroom.google.com");
}
function requireEnabled(schoolId: string, deps: Dependencies) {
  if (!(deps.enabled ?? isClasspilotCapabilityActive("classroomFocusScopeV1", { schoolId })))
    fail("CLASSROOM_FOCUS_DISABLED", "Classroom assignment access is not enabled for this school.");
}
export function automaticClassroomReviewIdentity(context: AutomaticClassroomReviewContext) {
  if (!context.schoolId || !context.actorId || !context.groupId || !context.primaryTeacherId
    || !Number.isSafeInteger(context.policyRevision) || context.policyRevision < 0
    || !Number.isFinite(context.flightPath.updatedAt.getTime())) fail("STUDENT_CLASSROOM_ACCESS_REVIEW_STALE");
  return { schoolId: context.schoolId, actorId: context.actorId, groupId: context.groupId,
    primaryTeacherId: context.primaryTeacherId, policyRevision: context.policyRevision,
    flightPathId: context.flightPath.id, flightPathUpdatedAt: context.flightPath.updatedAt.toISOString(),
    basePolicyHash: classroomFlightPathBasePolicyHash(context.flightPath), studentIds: studentIds(context.studentIds) };
}
async function readSources(context: { schoolId: string; studentIds: string[] }, deps: Dependencies) {
  const ids = studentIds(context.studentIds);
  if (!ids.length) fail("STUDENT_CLASSROOM_ACCESS_TARGETS_REQUIRED", "Add students to this class before reviewing Classroom access.");
  const resolve = deps.resolveSources ?? (await import("./classpilotStudentClassroomAccessSource.js")).resolveStudentClassroomAccessSources;
  const sources = await resolve({ schoolId: context.schoolId, studentIds: ids });
  if (sources.length !== ids.length || new Set(sources.map(source => source.studentId)).size !== sources.length
    || sources.some(source => !ids.includes(source.studentId))) fail("STUDENT_CLASSROOM_ACCESS_SOURCE_INCOMPLETE");
  return sources;
}
function compile(context: { schoolId: string; flightPath: StudentClassroomFlightPath }, sources: readonly StudentClassroomAccessSource[]) {
  const payloads = Object.fromEntries(sources.map(source => [source.studentId,
    compileStudentClassroomFlightPath({ schoolId: context.schoolId, flightPath: context.flightPath, source })]));
  if (Buffer.byteLength(JSON.stringify(payloads), "utf8") > 512 * 1024)
    fail("STUDENT_CLASSROOM_ACCESS_TOO_LARGE", "This class's combined Classroom permissions exceed the safe preset limit.");
  return payloads;
}
export async function previewAutomaticClassroomAccessReview(context: AutomaticClassroomReviewContext, deps: Dependencies = {}) {
  const binding = automaticClassroomReviewIdentity(context);
  requireEnabled(context.schoolId, deps);
  const sources = await readSources(context, deps);
  compile(context, sources);
  return createStudentClassroomAccessReview({ identity: binding, mode: "automatic-flight-path", sources }, deps);
}
export async function confirmAutomaticClassroomAccessReview(context: AutomaticClassroomReviewContext, reviewToken: string, deps: Dependencies = {}) {
  const binding = automaticClassroomReviewIdentity(context);
  requireEnabled(context.schoolId, deps);
  verifyStudentClassroomAccessReview({ identity: binding, mode: "automatic-flight-path", reviewToken }, deps);
  const sources = await readSources(context, deps);
  compile(context, sources);
  const verified = verifyStudentClassroomAccessReview({ identity: binding, mode: "automatic-flight-path", reviewToken, sources }, deps);
  const approval: AutomaticClassroomAccessApproval = { schemaVersion: 1, mode: "student-courses",
    groupId: context.groupId, flightPathId: context.flightPath.id, primaryTeacherId: context.primaryTeacherId,
    approvedBy: context.actorId, approvedAt: new Date((deps.now ?? Date.now)()).toISOString(), approvalKey: sources[0]!.approvalKey };
  if (sources.some(source => source.approvalKey !== approval.approvalKey)) fail("STUDENT_CLASSROOM_ACCESS_REVIEW_STALE");
  return { approval, identity: binding, expiresAt: verified.expiresAt };
}
function preparationBinding(context: AutomaticClassroomPreparationContext) {
  return { ...automaticClassroomReviewIdentity({ ...context, actorId: context.policy.classroomAccess?.approvedBy || context.primaryTeacherId,
    policyRevision: context.policy.revision }), approvalKey: context.policy.classroomAccess?.approvalKey ?? null };
}
function approvalMatchesContext(context: AutomaticClassroomPreparationContext): boolean {
  const approval = context.policy.classroomAccess;
  return context.policy.enabled && context.policy.schemaVersion === 2 && !!approval
    && approval.groupId === context.groupId && approval.flightPathId === context.flightPath.id
    && approval.primaryTeacherId === context.primaryTeacherId && /^[a-f0-9]{64}$/.test(approval.approvalKey);
}
export function unavailableAutomaticClassroomPreparation(context: AutomaticClassroomPreparationContext, reasonCode: string, now: number): PreparedAutomaticClassroomAccess {
  let bindingHash = null;
  try { bindingHash = hash(preparationBinding(context)); } catch { /* Preserve the failure without accepting malformed source identity. */ }
  return { schemaVersion: 1, status: "unavailable", bindingHash, preparedAt: now, expiresAt: now + PREPARATION_TTL_MS,
    reasonCode, perStudentPayloads: {}, payloadsHash: hash({}) };
}
export async function prepareAutomaticClassroomAccess(context: AutomaticClassroomPreparationContext, deps: Dependencies = {}): Promise<PreparedAutomaticClassroomAccess | null> {
  if (!context.policy.enabled || !automaticFlightPathContainsClassroom(context.flightPath)) return null;
  const now = deps.now ?? Date.now;
  try {
    requireEnabled(context.schoolId, deps);
    const approval = context.policy.classroomAccess;
    if (!approvalMatchesContext(context) || !approval)
      fail("STUDENT_CLASSROOM_ACCESS_REVIEW_REQUIRED");
    if (!deps.resolveSources) {
      const { studentClassroomAccessApprovalKeyForSchool } = await import("./googleClassroomAccess.js");
      if (await studentClassroomAccessApprovalKeyForSchool(context.schoolId) !== approval.approvalKey)
        fail("STUDENT_CLASSROOM_ACCESS_REVIEW_REQUIRED");
    }
    const bindingHash = hash(preparationBinding(context));
    const sources = context.studentIds.length ? await readSources(context, deps) : [];
    if (sources.some(source => source.approvalKey !== approval.approvalKey)) fail("STUDENT_CLASSROOM_ACCESS_REVIEW_REQUIRED");
    const perStudentPayloads = compile(context, sources), preparedAt = now();
    return { schemaVersion: 1, status: "ready", bindingHash, preparedAt, expiresAt: preparedAt + PREPARATION_TTL_MS,
      reasonCode: null, perStudentPayloads, payloadsHash: hash(perStudentPayloads) };
  } catch (error) {
    return unavailableAutomaticClassroomPreparation(context, String((error as { code?: string }).code || "STUDENT_CLASSROOM_SOURCE_UNAVAILABLE"), now());
  }
}
/** A purely local check: never reads Google while the caller holds authority locks. */
export function validateAutomaticClassroomPreparation(context: AutomaticClassroomPreparationContext,
  prepared: PreparedAutomaticClassroomAccess | null | undefined, now = Date.now()): PreparedAutomaticClassroomAccess {
  if (!prepared || prepared.schemaVersion !== 1 || !Number.isSafeInteger(prepared.expiresAt) || !Number.isSafeInteger(prepared.preparedAt)
    || prepared.expiresAt <= now || prepared.expiresAt <= prepared.preparedAt
    || prepared.preparedAt > now || prepared.expiresAt - prepared.preparedAt > PREPARATION_TTL_MS)
    return unavailableAutomaticClassroomPreparation(context, "STUDENT_CLASSROOM_ACCESS_PREPARATION_STALE", now);
  try {
    if (prepared.bindingHash !== hash(preparationBinding(context))) fail("STUDENT_CLASSROOM_ACCESS_PREPARATION_STALE");
    if (prepared.status === "unavailable") return prepared;
    if (!approvalMatchesContext(context)) fail("STUDENT_CLASSROOM_ACCESS_PREPARATION_STALE");
    const ids = studentIds(context.studentIds);
    if (hash(prepared.perStudentPayloads) !== prepared.payloadsHash || Object.keys(prepared.perStudentPayloads).length !== ids.length
      || Object.entries(prepared.perStudentPayloads).some(([id, payload]) => !ids.includes(id)
        || !validateStudentClassroomFlightPath(payload)
        || (payload.classroomMaterials as { studentId?: string; schoolId?: string }).studentId !== id
        || (payload.classroomMaterials as { studentId?: string; schoolId?: string }).schoolId !== context.schoolId))
      fail("STUDENT_CLASSROOM_ACCESS_PREPARATION_STALE");
    return prepared;
  } catch { return unavailableAutomaticClassroomPreparation(context, "STUDENT_CLASSROOM_ACCESS_PREPARATION_STALE", now); }
}
