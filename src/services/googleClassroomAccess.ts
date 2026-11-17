import { createHash, randomUUID } from "node:crypto";
import type { GoogleClassroomAccessApproval, GoogleRosterConnector } from "../schema/shared.js";
import type { StudentClassroomAccessClient, StudentClassroomAccessStudent } from "./classpilotStudentClassroomAccessSource.js";
import { studentClassroomAccessError, withStudentClassroomAccessDeadline, STUDENT_CLASSROOM_REQUEST_TIMEOUT_MS } from "./classpilotStudentClassroomAccessSource.js";
import { GOOGLE_ROSTER_SCOPES } from "./googleRosterScopes.js";
import { dispatchCacheInvalidation, publishCacheInvalidation, registerCacheInvalidationHandler } from "../realtime/cacheInvalidation.js";

export const STUDENT_CLASSROOM_ACCESS_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
] as const;
export const STUDENT_CLASSROOM_ACCESS_CONTENT_ONLY_SCOPES = STUDENT_CLASSROOM_ACCESS_SCOPES.filter(scope => !(GOOGLE_ROSTER_SCOPES as readonly string[]).includes(scope));
export function classifyGoogleRosterScopeReadiness(approvedScopes: readonly string[], studentClassroomAccessApproved: boolean) {
  const configured = [...new Set(approvedScopes.filter(Boolean))];
  const expected = new Set<string>([...GOOGLE_ROSTER_SCOPES,
    ...(studentClassroomAccessApproved ? STUDENT_CLASSROOM_ACCESS_SCOPES : [])]);
  return { missingRosterScopes: GOOGLE_ROSTER_SCOPES.filter(scope => !configured.includes(scope)),
    extraRosterScopes: configured.filter(scope => !expected.has(scope)) };
}
const DWD_URL = "https://admin.google.com/ac/owl/domainwidedelegation";
const DWD_PATH = "Security → Access and data control → API controls → Domain-wide delegation → Manage Domain Wide Delegation";
type ServiceAccountInfo = { configured: boolean; clientId: string | null; email: string | null; authMode: string };
type Connector = Pick<GoogleRosterConnector, "id" | "schoolId" | "domain" | "status" | "delegatedAdminEmail" | "serviceAccountClientId" | "approvedScopes" | "updatedAt" | "classroomAccessApproval"> & { approvalVersion?: string };
export type StudentClassroomAccessApprovalDependencies = {
  getSchool: (schoolId: string) => Promise<{ id: string; domain: string | null } | undefined>;
  getConnector: (schoolId: string) => Promise<Connector | undefined>;
  getServiceAccountInfo: () => ServiceAccountInfo;
  getStudent: (studentId: string, schoolId: string) => Promise<StudentClassroomAccessStudent | undefined>;
  getVerificationStudents?: (schoolId: string) => Promise<Array<{ id: string; name: string }>>;
  createClient: (student: StudentClassroomAccessStudent, options: { signal: AbortSignal; timeoutMs: number }) => Promise<StudentClassroomAccessClient>;
  compareAndSetScopes: (schoolId: string, expected: Connector, scopes: string[], approval: GoogleClassroomAccessApproval | null) => Promise<Connector | undefined>;
  approvalChanged?: (schoolId: string) => Promise<void>;
};
function normalizeDomain(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9.-]+$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}
function emailDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.split("@").length !== 2) return null;
  const [local, domain] = value.split("@");
  return local ? normalizeDomain(domain) : null;
}
function safeError(error: unknown): Error {
  if (error instanceof Error && "expose" in error && error.expose === true
    && "code" in error && typeof error.code === "string" && error.code.startsWith("STUDENT_CLASSROOM_")) return error;
  return studentClassroomAccessError("Student Classroom access could not be verified. Check the read-only Google authorization and retry.");
}
function sameConnector(left: Connector, right: Connector): boolean {
  return left.id === right.id && left.schoolId === right.schoolId && left.status === right.status
    && left.domain === right.domain && left.serviceAccountClientId === right.serviceAccountClientId
    && left.delegatedAdminEmail === right.delegatedAdminEmail && +left.updatedAt === +right.updatedAt
    && left.approvalVersion === right.approvalVersion;
}
function approvalIdentityKey(schoolId: string, connector: Connector, schoolDomain: string, clientId: string): string | null {
  const approval = connector.classroomAccessApproval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)
    || Object.keys(approval).sort().join(",") !== "approvalId,approvedAt,approvedByUserId,delegatedAdminEmail,domain,schemaVersion,schoolId,serviceAccountClientId"
    || approval.schemaVersion !== 1 || approval.schoolId !== schoolId || approval.domain !== schoolDomain
    || approval.serviceAccountClientId !== clientId || approval.delegatedAdminEmail !== connector.delegatedAdminEmail
    || typeof approval.approvalId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(approval.approvalId)
    || typeof approval.approvedByUserId !== "string" || !approval.approvedByUserId || approval.approvedByUserId.length > 128
    || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))) return null;
  return createHash("sha256").update(JSON.stringify({ schoolId, domain: schoolDomain, clientId,
    delegatedAdminEmail: connector.delegatedAdminEmail, approvalId: approval.approvalId })).digest("hex");
}
async function snapshot(schoolId: string, deps: StudentClassroomAccessApprovalDependencies) {
  const [school, connector] = await Promise.all([deps.getSchool(schoolId), deps.getConnector(schoolId)]);
  let account: ServiceAccountInfo;
  try { account = deps.getServiceAccountInfo(); }
  catch { throw studentClassroomAccessError("The server Google authorization configuration is unavailable.", "STUDENT_CLASSROOM_CONNECTOR_REQUIRED", 503); }
  const schoolDomain = normalizeDomain(school?.domain);
  const available = !!(school?.id === schoolId && schoolDomain && account.configured && account.clientId
    && connector?.schoolId === schoolId && connector.status === "verified"
    && normalizeDomain(connector.domain) === schoolDomain && emailDomain(connector.delegatedAdminEmail) === schoolDomain
    && connector.serviceAccountClientId === account.clientId
    && GOOGLE_ROSTER_SCOPES.every(scope => connector.approvedScopes.includes(scope)));
  const approvalKey = available && STUDENT_CLASSROOM_ACCESS_SCOPES.every(scope => connector!.approvedScopes.includes(scope))
    ? approvalIdentityKey(schoolId, connector!, schoolDomain!, account.clientId!) : null;
  const enabled = approvalKey !== null;
  return { schoolDomain, connector, account, available, enabled, approvalKey };
}

export function createStudentClassroomAccessApprovalCache(readApproval: (schoolId: string) => Promise<string | null>, options: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = Math.max(1, Math.min(10_000, options.ttlMs ?? 10_000));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string | null; expiresAt: number }>();
  const pending = new Map<string, Promise<string | null>>();
  const invalidate = (schoolId: string) => { entries.delete(schoolId); pending.delete(schoolId); };
  const peek = (schoolId: string) => {
    const entry = entries.get(schoolId);
    return entry && entry.expiresAt > now() ? entry.value : null;
  };
  const read = (schoolId: string): Promise<string | null> => {
    const entry = entries.get(schoolId);
    if (entry && entry.expiresAt > now()) return Promise.resolve(entry.value);
    if (pending.has(schoolId)) return pending.get(schoolId)!;
    const job: Promise<string | null> = Promise.resolve().then(() => readApproval(schoolId)).catch(() => null).then(value => {
      if (pending.get(schoolId) !== job) return null;
      if (entries.size >= 1024 && !entries.has(schoolId)) entries.delete(entries.keys().next().value!);
      entries.set(schoolId, { value, expiresAt: now() + ttlMs });
      return value;
    }).finally(() => { if (pending.get(schoolId) === job) pending.delete(schoolId); });
    pending.set(schoolId, job);
    return job;
  };
  return { read, peek, invalidate };
}

async function dependenciesForSchool(schoolId: string): Promise<StudentClassroomAccessApprovalDependencies> {
  const [storage, tenant, roster] = await Promise.all([import("./storage.js"), import("../middleware/tenantContext.js"), import("./googleRosterConnector.js")]);
  return {
    getSchool: id => tenant.runWithTenantContext({ schoolId: id }, async () => storage.getSchoolById(id)),
    getConnector: id => tenant.runWithTenantContext({ schoolId: id }, async () => storage.getGoogleClassroomAccessConnector(id)),
    getServiceAccountInfo: roster.getRosterServiceAccountInfo,
    getStudent: (id, school) => tenant.runWithTenantContext({ schoolId: school }, async () => storage.getStudentForGoogleClassroomAccess(school, id)),
    getVerificationStudents: school => tenant.runWithTenantContext({ schoolId: school }, async () => storage.getGoogleClassroomVerificationStudents(school)),
    createClient: (student, options) => mintStudentClient(student, options),
    compareAndSetScopes: (school, expected, scopes, approval) => tenant.runWithTenantContext({ schoolId: school }, async () => storage.compareAndSetGoogleClassroomAccessScopes(school, expected, scopes, approval)),
    approvalChanged: announceStudentClassroomAccessApprovalChanged,
  };
}
const approvalCache = createStudentClassroomAccessApprovalCache(async schoolId => withStudentClassroomAccessDeadline(async () =>
  (await snapshot(schoolId, await dependenciesForSchool(schoolId))).approvalKey, 4000));
export const invalidateStudentClassroomAccessApproval = (schoolId: string): void => approvalCache.invalidate(schoolId);
registerCacheInvalidationHandler(target => {
  if (target.cache === "classpilot-passive-authorization" && "schoolId" in target) approvalCache.invalidate(target.schoolId);
});
export async function announceStudentClassroomAccessApprovalChanged(schoolId: string): Promise<void> {
  const target = { kind: "cache-invalidation" as const, schoolId, cache: "classpilot-passive-authorization" as const };
  dispatchCacheInvalidation(target);
  await publishCacheInvalidation(target);
}
export const studentClassroomAccessApprovalKeyFromCache = (schoolId: string): string | null => approvalCache.peek(schoolId);
export const studentClassroomAccessApprovalKeyForSchool = (schoolId: string): Promise<string | null> => approvalCache.read(schoolId);
export const isStudentClassroomAccessApprovedFromCache = (schoolId: string): boolean => studentClassroomAccessApprovalKeyFromCache(schoolId) !== null;
/** Only bounded school configuration reads; never Google transport or course reads on delivery. */
export const isStudentClassroomAccessApprovedForSchool = async (schoolId: string): Promise<boolean> => await studentClassroomAccessApprovalKeyForSchool(schoolId) !== null;

export async function getStudentClassroomAccessSetupInfo(schoolId: string, dependencies?: StudentClassroomAccessApprovalDependencies) {
  const deps = dependencies ?? await dependenciesForSchool(schoolId);
  const state = await snapshot(schoolId, deps);
  const verificationStudents = (await deps.getVerificationStudents?.(schoolId) ?? []).slice(0, 100).map(student => ({ id: student.id, name: student.name }));
  const scopes = [...new Set<string>([...GOOGLE_ROSTER_SCOPES, ...STUDENT_CLASSROOM_ACCESS_SCOPES])];
  return { purpose: "student_classroom_access" as const, available: state.available, enabled: state.enabled,
    schoolDomain: state.schoolDomain, serviceAccountClientId: state.account.clientId,
    requiredScopes: [...STUDENT_CLASSROOM_ACCESS_SCOPES], scopes, scopesCsv: scopes.join(","), verificationStudents,
    adminConsoleUrl: DWD_URL, manualAdminConsolePath: DWD_PATH, requiresRosterConnector: true,
    setupCopy: { title: "Student Google Classroom access",
      description: "Authorize read-only access to each student's own active and archived Classroom courses, assignments, materials and Stream posts. SchoolPilot does not read submissions or comments.",
      revocation: "Disable student Classroom access here without disconnecting roster imports. In Google Admin, keep the original roster scopes when removing the additional Classroom content scopes." } };
}

function validStudent(student: StudentClassroomAccessStudent | undefined, schoolId: string, studentId: string, schoolDomain: string | null): student is StudentClassroomAccessStudent & { email: string; googleUserId: string } {
  return !!student && student.id === studentId && student.schoolId === schoolId && student.status === "active"
    && typeof student.googleUserId === "string" && student.googleUserId.length > 0 && student.googleUserId.length <= 128
    && typeof student.email === "string" && !!schoolDomain && emailDomain(student.email) === schoolDomain;
}

export async function verifyStudentClassroomAccessForSchool(schoolId: string, studentId: string, actorId: string, dependencies?: StudentClassroomAccessApprovalDependencies) {
  const deps = dependencies ?? await dependenciesForSchool(schoolId);
  try {
    const captured = await snapshot(schoolId, deps);
    if (typeof actorId !== "string" || !actorId || actorId.length > 128) throw studentClassroomAccessError("A current school administrator must verify Classroom access.", "STUDENT_CLASSROOM_APPROVAL_REQUIRED", 403);
    if (!captured.available || !captured.connector) throw studentClassroomAccessError("Verify this school's Google roster connector before authorizing student Classroom access.", "STUDENT_CLASSROOM_CONNECTOR_REQUIRED", 409);
    const student = await deps.getStudent(studentId, schoolId);
    if (!validStudent(student, schoolId, studentId, captured.schoolDomain)) throw studentClassroomAccessError("Choose a current-school student with an imported Google identity to verify access.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
    await withStudentClassroomAccessDeadline(async signal => {
      const client = await deps.createClient(student, { signal, timeoutMs: STUDENT_CLASSROOM_REQUEST_TIMEOUT_MS });
      const profile = (await client.profile()).data;
      if (!profile || typeof profile !== "object" || Array.isArray(profile)
        || !("id" in profile) || profile.id !== student.googleUserId
        || !("emailAddress" in profile) || emailDomain(profile.emailAddress) !== captured.schoolDomain)
        throw studentClassroomAccessError("The Google identity does not match this school's student.", "STUDENT_CLASSROOM_IDENTITY_MISMATCH", 409);
      const result = (await client.courses({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"], pageSize: 1 })).data;
      if (!result || typeof result !== "object" || Array.isArray(result)
        || "courses" in result && result.courses !== undefined && !Array.isArray(result.courses))
        throw studentClassroomAccessError("Google did not return a complete student Classroom verification.");
    }, 12_000);
    const current = await snapshot(schoolId, deps);
    if (!current.available || !current.connector || !sameConnector(captured.connector, current.connector))
      throw studentClassroomAccessError("The Google connector changed during verification. Review the current setup and retry.", "STUDENT_CLASSROOM_APPROVAL_STALE", 409);
    const scopes = [...new Set([...current.connector.approvedScopes, ...STUDENT_CLASSROOM_ACCESS_SCOPES])];
    const approval: GoogleClassroomAccessApproval = { schemaVersion: 1, approvalId: randomUUID(),
      approvedByUserId: actorId, approvedAt: new Date().toISOString(), schoolId, domain: captured.schoolDomain!,
      serviceAccountClientId: captured.account.clientId!, delegatedAdminEmail: captured.connector.delegatedAdminEmail! };
    const updated = await deps.compareAndSetScopes(schoolId, captured.connector, scopes, approval);
    if (!updated) throw studentClassroomAccessError("The Google connector changed during verification. Review the current setup and retry.", "STUDENT_CLASSROOM_APPROVAL_STALE", 409);
    invalidateStudentClassroomAccessApproval(schoolId);
    await deps.approvalChanged?.(schoolId);
    return { classroomAccess: { purpose: "student_classroom_access" as const, enabled: true } };
  } catch (error) { invalidateStudentClassroomAccessApproval(schoolId); throw safeError(error); }
}

export async function disableStudentClassroomAccessForSchool(schoolId: string, dependencies?: StudentClassroomAccessApprovalDependencies) {
  const deps = dependencies ?? await dependenciesForSchool(schoolId);
  const connector = await deps.getConnector(schoolId);
  if (connector) {
    const scopes = connector.approvedScopes.filter(scope => !(STUDENT_CLASSROOM_ACCESS_CONTENT_ONLY_SCOPES as readonly string[]).includes(scope));
    const updated = await deps.compareAndSetScopes(schoolId, connector, scopes, null);
    if (!updated) throw studentClassroomAccessError("The Google connector changed. Refresh before disabling Classroom access.", "STUDENT_CLASSROOM_APPROVAL_STALE", 409);
  }
  invalidateStudentClassroomAccessApproval(schoolId);
  await deps.approvalChanged?.(schoolId);
  return { classroomAccess: { purpose: "student_classroom_access" as const, enabled: false } };
}

async function mintStudentClient(student: StudentClassroomAccessStudent, options: { signal: AbortSignal; timeoutMs: number }): Promise<StudentClassroomAccessClient> {
  try {
    if (!student.email || options.signal.aborted) throw studentClassroomAccessError();
    const [{ google }, roster] = await Promise.all([import("googleapis"), import("./googleRosterConnector.js")]);
    const auth = await roster.getRosterDwdAuthClient(student.email, STUDENT_CLASSROOM_ACCESS_SCOPES, options);
    if (options.signal.aborted) throw studentClassroomAccessError();
    const classroom = google.classroom({ version: "v1", auth });
    const requestOptions = { timeout: options.timeoutMs, signal: options.signal };
    const pageToken = (params: Record<string, unknown>) => typeof params.pageToken === "string" ? params.pageToken : undefined;
    const courseId = (params: Record<string, unknown>) => typeof params.courseId === "string" ? params.courseId : "";
    return {
      profile: () => classroom.userProfiles.get({ userId: "me", fields: "id,emailAddress" }, requestOptions),
      courses: params => classroom.courses.list({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"],
        pageSize: params.pageSize === 1 ? 1 : 100, pageToken: pageToken(params), fields: "courses(id,courseState),nextPageToken" }, requestOptions),
      work: params => classroom.courses.courseWork.list({ courseId: courseId(params), courseWorkStates: ["PUBLISHED"], pageSize: 100, pageToken: pageToken(params),
        fields: "courseWork(id,state,alternateLink,description,materials,assigneeMode,individualStudentsOptions),nextPageToken" }, requestOptions),
      materials: params => classroom.courses.courseWorkMaterials.list({ courseId: courseId(params), courseWorkMaterialStates: ["PUBLISHED"], pageSize: 100, pageToken: pageToken(params),
        fields: "courseWorkMaterial(id,state,alternateLink,description,materials,assigneeMode,individualStudentsOptions),nextPageToken" }, requestOptions),
      announcements: params => classroom.courses.announcements.list({ courseId: courseId(params), announcementStates: ["PUBLISHED"], pageSize: 100, pageToken: pageToken(params),
        fields: "announcements(id,state,alternateLink,text,materials,assigneeMode,individualStudentsOptions),nextPageToken" }, requestOptions),
    };
  } catch (error) { throw safeError(error); }
}

export async function createStudentClassroomAccessClient(schoolId: string, student: StudentClassroomAccessStudent,
  options: { signal: AbortSignal; timeoutMs: number }): Promise<StudentClassroomAccessClient> {
  const deps = await dependenciesForSchool(schoolId);
  const state = await snapshot(schoolId, deps);
  if (!state.enabled || !validStudent(student, schoolId, student.id, state.schoolDomain))
    throw studentClassroomAccessError("A school administrator must authorize this student's Classroom access first.", "STUDENT_CLASSROOM_APPROVAL_REQUIRED", 409);
  return mintStudentClient(student, options);
}
