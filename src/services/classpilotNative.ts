import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { verifyClassPilotPin } from "./classpilotPins.js";
import { classpilotFullMonitoringDeadline, resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { requireScheduledClassroomRequestRevision } from "./classpilotActivityAuthority.js";
import { classpilotNativeStore as store, type NativeCaptureGrant, type NativeViewerLease, type NativeStoredImage } from "./classpilotNativeStore.js";
import { ClasspilotNativeError, NATIVE_LIMITS, createNativeCredential, nativeVisibilityEnabled, nativeSecretHash,
  parseNativeCredential, nativeCaptureTimestampValid, requireNativeEnabled, type NativeContext, type NativeTarget, type NativeObservationMetadata } from "./classpilotNativeProtocol.js";
import { createClasspilotNativeEnrollment, redeemClasspilotNativeEnrollment, readClasspilotNativeInstallation, findClasspilotNativeStudent,
  bindClasspilotNativeStudent, readClasspilotNativeSession, renewClasspilotNativeSession, updateClasspilotNativeSource,
  endClasspilotNativeSession, revokeClasspilotNativeInstallation, withClasspilotNativeAuthority, authorizeClasspilotNativeStudents,
  classpilotNativeCurrentAuthority, readClasspilotNativeSessions, lockClasspilotStudentControlAuthorities,
  getHeartbeatTrackingSettingsForSchool, classpilotNativeStaffCredentialVersion, classpilotNativeEntitlementDeadline,
  type NativeCurrentAuthority, type NativeStorageDb } from "./storage.js";
import type { ClasspilotNativeSession } from "../schema/classpilotNative.js";

export type NativeStaffScope = { schoolId: string; actorId: string; authVersion?: number; contextAuthorityRevision?: string };
type TileRequest = NativeContext & { studentIds: string[]; viewerInstanceId?: string; selectedSources?: NativeTarget[] };
type LeaseRequest = NativeContext & { targets: NativeTarget[] };
const targetFor = (session: ClasspilotNativeSession): NativeTarget => ({ studentId: session.studentId,
  sourceRef: session.sourceRef, bindingRevision: session.bindingRevision });
function sameContext(left: NativeContext, right: NativeContext): boolean {
  return (left.teachingSessionId ?? null) === (right.teachingSessionId ?? null)
    && (left.supervisionContextId ?? null) === (right.supervisionContextId ?? null);
}
function matchesTarget(lease: NativeViewerLease, session: ClasspilotNativeSession): boolean {
  return lease.targets.some(target => target.studentId === session.studentId && target.sourceRef === session.sourceRef
    && target.bindingRevision === session.bindingRevision);
}
function withSchool<T>(schoolId: string, students: string[], action: (database: NativeStorageDb) => Promise<T>) {
  return runWithTenantContext({ schoolId }, () => withClasspilotNativeAuthority(schoolId, students, action));
}
async function withSession<T>(token: string, action: (session: ClasspilotNativeSession, database: NativeStorageDb) => Promise<T>) {
  const credential = parseNativeCredential(token, "session");
  return withSchool(credential.schoolId, [], async database => {
    const session = await readClasspilotNativeSession(credential, database);
    await lockClasspilotStudentControlAuthorities(session.schoolId, [session.studentId], database);
    return action(session, database);
  });
}
function sessionResponse(session: ClasspilotNativeSession) {
  return { bindingRevision: session.bindingRevision, expiresAt: session.expiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(), serverTime: new Date().toISOString() };
}

export async function issueNativeEnrollment(scope: NativeStaffScope) {
  const credential = createNativeCredential("enroll", scope.schoolId);
  return withSchool(scope.schoolId, [], async database => {
    const enrollment = await createClasspilotNativeEnrollment({ ...scope, id: credential.id, tokenHash: credential.tokenHash }, database);
    return { enrollmentToken: credential.credential, expiresAt: enrollment.expiresAt.toISOString() };
  });
}
export async function enrollNativeInstallation(input: { enrollmentToken: string; clientVersion: string }, ip: string) {
  const enrollment = parseNativeCredential(input.enrollmentToken, "enroll");
  requireNativeEnabled(enrollment.schoolId);
  await store.rateLimit(["enroll", ip], 10, 600_000);
  const installation = createNativeCredential("install", enrollment.schoolId);
  return withSchool(enrollment.schoolId, [], async database => {
    await redeemClasspilotNativeEnrollment(enrollment, { id: installation.id, tokenHash: installation.tokenHash, clientVersion: input.clientVersion }, database);
    return { installationCredential: installation.credential, schoolId: enrollment.schoolId };
  });
}
export async function signInNativeStudent(token: string, input: { identifier: string; pin: string; osSessionNonce: string }, ip: string) {
  const credential = parseNativeCredential(token, "install");
  // Authentication precedes identifier-specific limiting; unverified installation IDs never choose another limiter bucket.
  await withSchool(credential.schoolId, [], database => readClasspilotNativeInstallation(credential, database));
  await store.rateLimit(["pin-installation", credential.schoolId, credential.id], 20, 300_000);
  await store.rateLimit(["pin-ip", ip], 100, 300_000);
  const issued = createNativeCredential("session", credential.schoolId);
  return withSchool(credential.schoolId, [], async database => {
    await readClasspilotNativeInstallation(credential, database);
    const student = await findClasspilotNativeStudent(credential.schoolId, input.identifier, database);
    const pinLimit = ["pin-student", credential.schoolId, credential.id, student.id];
    await store.checkFailureLimit(pinLimit, 5);
    const verified = await verifyClassPilotPin(student, input.pin);
    if (!verified.ok) {
      await store.rateLimit(pinLimit, 5, 300_000);
      throw new ClasspilotNativeError("NATIVE_CREDENTIAL_INVALID", 401, "Invalid student credentials");
    }
    await lockClasspilotStudentControlAuthorities(credential.schoolId, [student.id], database);
    const session = await bindClasspilotNativeStudent({ credential, studentId: student.id, osSessionNonce: input.osSessionNonce,
      id: issued.id, tokenHash: issued.tokenHash, studentCredentialFingerprint: nativeSecretHash(JSON.stringify([
        student.classpilotPinHash, student.classpilotPinEncrypted])) }, database);
    return { sessionCredential: issued.credential, schoolId: credential.schoolId,
      student: { id: student.id, displayName: `${student.firstName} ${student.lastName}`.trim() }, ...sessionResponse(session) };
  });
}
export async function renewNativeSession(token: string, nonce: string) {
  const credential = parseNativeCredential(token, "session");
  return withSession(token, async (_session, database) => sessionResponse(await renewClasspilotNativeSession(credential, nonce, database)));
}
export async function checkNativeSessionCredential(token: string): Promise<void> {
  await withSession(token, async () => undefined);
}
export async function signOutNativeSession(token: string) {
  return withSession(token, async (session, database) => {
    await endClasspilotNativeSession(session, database);
    // Logical invalidation is transactional even if Redis cleanup is unavailable.
    await store.clearImage(session.schoolId, session.sourceRef).catch(() => undefined);
  });
}
export async function stopNativeObservation(token: string, bindingRevision: number) {
  return withSession(token, async (session, database) => {
    if (!session.sourceGeneration) return;
    if (session.bindingRevision !== bindingRevision) throw new ClasspilotNativeError("NATIVE_BINDING_STALE", 409);
    await updateClasspilotNativeSource(session, null, database);
    await store.clearImage(session.schoolId, session.sourceRef).catch(() => undefined);
  });
}
export async function revokeNativeInstallation(scope: NativeStaffScope, id: string) {
  return withSchool(scope.schoolId, [], async database => {
    const sessions = await revokeClasspilotNativeInstallation(scope.schoolId, scope.actorId, id, database);
    for (const session of sessions) await store.clearImage(session.schoolId, session.sourceRef).catch(() => undefined);
  });
}

async function monitoringDeadline(schoolId: string, maximumEnd: number, database: NativeStorageDb): Promise<number> {
  maximumEnd = Math.min(maximumEnd, await classpilotNativeEntitlementDeadline(schoolId, database));
  if (maximumEnd <= Date.now()) return Date.now();
  const settings = await getHeartbeatTrackingSettingsForSchool(schoolId, database, { lock: true, bypassCache: true });
  // Native scope never inherits the browser after-hours full-monitoring override.
  if (!settings || !settings.enableTrackingHours) return Date.now();
  const nativeSettings = { ...settings, afterHoursMode: "off" as const };
  if (resolveClasspilotMonitoringPolicy(nativeSettings).policyMode !== "full") return Date.now();
  return classpilotFullMonitoringDeadline(nativeSettings, Date.now(), maximumEnd);
}
function requestRevision(scope: NativeStaffScope, context: NativeContext): string | undefined {
  return context.supervisionContextId ? requireScheduledClassroomRequestRevision(scope.contextAuthorityRevision) : undefined;
}
async function authorizedViewers(session: ClasspilotNativeSession, authority: NativeCurrentAuthority, database: NativeStorageDb) {
  const viewers = await store.getViewers(session.schoolId, targetFor(session));
  const valid: NativeViewerLease[] = [];
  for (const viewer of viewers) {
    if (!sameContext(viewer, authority) || (authority.supervisionContextId
      && viewer.contextAuthorityRevision !== authority.contextAuthorityRevision)) continue;
    try {
      if (!Number.isSafeInteger(viewer.authVersion) || viewer.authVersion < 1) continue;
      const authorized = await authorizeClasspilotNativeStudents({ schoolId: session.schoolId, actorId: viewer.actorId,
        authVersion: viewer.authVersion,
        studentIds: [session.studentId], teachingSessionId: viewer.teachingSessionId, supervisionContextId: viewer.supervisionContextId,
        contextAuthorityRevision: viewer.contextAuthorityRevision }, database);
      if (authorized.has(session.studentId)) valid.push(viewer);
    } catch (error) { if (!(error instanceof ClasspilotNativeError && error.status === 403)) throw error; }
  }
  return valid;
}

export async function nativeCapturePolicy(token: string, generation: string, bindingRevision: number) {
  return withSession(token, async (existing, database) => {
    if (existing.bindingRevision !== bindingRevision) throw new ClasspilotNativeError("NATIVE_BINDING_STALE", 409);
    await store.rateLimit(["policy", existing.schoolId, existing.id], 12, 60_000);
    const changed = existing.sourceGeneration !== generation;
    const session = await updateClasspilotNativeSource(existing, generation, database);
    if (changed) await store.clearImage(session.schoolId, session.sourceRef);
    const base = { captureAllowed: false, bindingRevision: session.bindingRevision, expiresInSeconds: 0,
      intervalSeconds: NATIVE_LIMITS.captureSeconds, maxWidth: NATIVE_LIMITS.maxWidth, maxHeight: NATIVE_LIMITS.maxHeight,
      maxBytes: NATIVE_LIMITS.maxBytes, serverTime: new Date().toISOString() };
    const authority = await classpilotNativeCurrentAuthority(session.schoolId, session.studentId, database);
    if (!authority) return { ...base, reason: "no_current_authority" };
    const deadline = await monitoringDeadline(session.schoolId, Math.min(Date.now() + NATIVE_LIMITS.leaseMs,
      session.expiresAt.getTime(), authority.expiresAt), database);
    if (deadline <= Date.now()) return { ...base, reason: "policy_paused" };
    const viewers = await authorizedViewers(session, authority, database);
    if (!viewers.length) return { ...base, reason: "not_observed" };
    const issuedAt = Date.now();
    const expiresAt = Math.min(deadline, Math.max(...viewers.map(viewer => viewer.expiresAt)));
    const grant: NativeCaptureGrant = { id: randomUUID(), schoolId: session.schoolId, nativeSessionId: session.id,
      studentId: session.studentId, sourceRef: session.sourceRef, sourceGeneration: generation, bindingRevision: session.bindingRevision,
      controlRevision: authority.controlRevision, teachingSessionId: authority.teachingSessionId,
      supervisionContextId: authority.supervisionContextId, contextAuthorityRevision: authority.contextAuthorityRevision, issuedAt, expiresAt };
    await store.saveGrant(grant, viewers);
    return { ...base, captureAllowed: true, reason: "observed", grantId: grant.id, expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), serverTime: new Date().toISOString() };
  });
}

function grantMatches(grant: NativeCaptureGrant, session: ClasspilotNativeSession, authority: NativeCurrentAuthority) {
  return grant.schoolId === session.schoolId && grant.nativeSessionId === session.id && grant.studentId === session.studentId
    && grant.sourceRef === session.sourceRef && grant.sourceGeneration === session.sourceGeneration
    && grant.bindingRevision === session.bindingRevision && grant.controlRevision === authority.controlRevision
    && sameContext(grant, authority) && grant.expiresAt > Date.now()
    && (!authority.supervisionContextId || grant.contextAuthorityRevision === authority.contextAuthorityRevision);
}
export async function acceptNativeObservation(token: string, metadata: NativeObservationMetadata, image: Buffer) {
  return withSession(token, async (session, database) => {
    await store.rateLimit(["upload", session.schoolId, session.id], 4, 60_000);
    const grant = await store.getGrant(session.schoolId, session.id, metadata.grantId);
    const authority = await classpilotNativeCurrentAuthority(session.schoolId, session.studentId, database);
    if (!grant || !authority || !grantMatches(grant, session, authority) || metadata.sourceGeneration !== session.sourceGeneration
      || !nativeCaptureTimestampValid(metadata.capturedAt, grant.issuedAt, grant.expiresAt)) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    const appTime = metadata.foregroundApplication ? Date.parse(metadata.foregroundApplication.observedAt) : null;
    if (appTime !== null && (Math.abs(appTime - Date.parse(metadata.capturedAt)) > 1_000 || appTime < grant.issuedAt || appTime >= grant.expiresAt)) {
      throw new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400);
    }
    const deadline = await monitoringDeadline(session.schoolId, Math.min(grant.expiresAt, authority.expiresAt, session.expiresAt.getTime()), database);
    const viewers = await authorizedViewers(session, authority, database);
    if (!viewers.length || deadline <= Date.now()) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    const imageExpiresAt = Math.min(deadline, Math.max(...viewers.map(viewer => viewer.expiresAt)),
      Date.parse(metadata.capturedAt) + NATIVE_LIMITS.leaseMs);
    const stored: NativeStoredImage = { ...grant, sequence: metadata.sequence, capturedAt: metadata.capturedAt,
      receivedAt: new Date().toISOString(), foregroundApplication: metadata.foregroundApplication,
      screenshot: `data:image/jpeg;base64,${image.toString("base64")}`, imageExpiresAt };
    await store.saveImage(stored, session.absoluteExpiresAt.getTime(), viewers);
    return { accepted: true, expiresAt: new Date(imageExpiresAt).toISOString() };
  });
}

export async function renewNativeViewer(scope: NativeStaffScope, instanceId: string, input: LeaseRequest) {
  const revision = requestRevision(scope, input);
  return withSchool(scope.schoolId, input.targets.map(target => target.studentId), async database => {
    const allowed = await authorizeClasspilotNativeStudents({ ...scope, ...input, studentIds: input.targets.map(target => target.studentId),
      contextAuthorityRevision: revision }, database);
    const sessions = await readClasspilotNativeSessions(scope.schoolId, [...allowed], database);
    let expiresAt = Date.now() + NATIVE_LIMITS.leaseMs;
    for (const target of input.targets) {
      const session = sessions.find(row => row.session.studentId === target.studentId)?.session;
      const authority = session && await classpilotNativeCurrentAuthority(scope.schoolId, target.studentId, database);
      if (!allowed.has(target.studentId) || !session || !session.sourceGeneration || session.sourceRef !== target.sourceRef
        || session.bindingRevision !== target.bindingRevision || !authority || !sameContext(input, authority)
        || (input.supervisionContextId && authority.contextAuthorityRevision !== revision)) throw new ClasspilotNativeError("NATIVE_NOT_AUTHORIZED");
      expiresAt = Math.min(expiresAt, session.expiresAt.getTime(), authority.expiresAt);
    }
    expiresAt = await monitoringDeadline(scope.schoolId, expiresAt, database);
    if (expiresAt <= Date.now()) throw new ClasspilotNativeError("NATIVE_NOT_AUTHORIZED");
    await store.setViewer({ schoolId: scope.schoolId, actorId: scope.actorId, viewerInstanceId: instanceId,
      authVersion: await classpilotNativeStaffCredentialVersion(scope.actorId, database),
      teachingSessionId: input.teachingSessionId, supervisionContextId: input.supervisionContextId,
      contextAuthorityRevision: revision, targets: input.targets, expiresAt });
    return { serverTime: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(), renewAfterSeconds: NATIVE_LIMITS.renewSeconds };
  });
}
export async function releaseNativeViewer(scope: NativeStaffScope, instanceId: string) {
  // Release is always allowed for this authenticated actor, including after policy disablement.
  return store.releaseViewer(scope.schoolId, scope.actorId, instanceId);
}

export async function readNativeTiles<T>(scope: NativeStaffScope, input: TileRequest, send: (response: unknown) => T): Promise<T> {
  if (!nativeVisibilityEnabled(scope.schoolId)) return send({ enabled: false, serverTime: new Date().toISOString(), tiles: [] });
  const revision = requestRevision(scope, input);
  return withSchool(scope.schoolId, input.studentIds, async database => {
    const allowed = await authorizeClasspilotNativeStudents({ ...scope, ...input, contextAuthorityRevision: revision }, database);
    const actorVersion = await classpilotNativeStaffCredentialVersion(scope.actorId, database);
    const sessions = await readClasspilotNativeSessions(scope.schoolId, [...allowed], database);
    const deadline = await monitoringDeadline(scope.schoolId, Date.now() + NATIVE_LIMITS.leaseMs, database);
    const viewer = input.viewerInstanceId ? await store.getViewer(scope.schoolId, scope.actorId, input.viewerInstanceId) : null;
    const tiles: Record<string, unknown>[] = [];
    for (const studentId of input.studentIds) {
      if (!allowed.has(studentId)) { tiles.push({ studentId, state: "unbound" }); continue; }
      const session = sessions.find(row => row.session.studentId === studentId)?.session;
      if (!session) { tiles.push({ studentId, state: "unbound" }); continue; }
      const base = { studentId, sourceRef: session.sourceRef, bindingRevision: session.bindingRevision,
        sourceLabel: "Selected source", platform: "windows" };
      const authority = await classpilotNativeCurrentAuthority(scope.schoolId, studentId, database);
      if (!authority || !sameContext(input, authority) || deadline <= Date.now()) { tiles.push({ ...base, state: "policy_paused" }); continue; }
      if (!session.sourceGeneration) { tiles.push({ ...base, state: "permission_required" }); continue; }
      if (Date.now() - session.lastSeenAt.getTime() > NATIVE_LIMITS.leaseMs) { tiles.push({ ...base, state: "offline" }); continue; }
      const selected = input.selectedSources?.some(target => target.studentId === studentId && target.sourceRef === session.sourceRef
        && target.bindingRevision === session.bindingRevision);
      if (!selected || !viewer || viewer.authVersion !== actorVersion || !sameContext(viewer, input) || !matchesTarget(viewer, session)
        || (input.supervisionContextId && viewer.contextAuthorityRevision !== revision)) { tiles.push({ ...base, state: "available" }); continue; }
      const image = await store.readImage(scope.schoolId, session.sourceRef);
      if (!image || !grantMatches(image, session, authority) || image.imageExpiresAt <= Date.now()) {
        tiles.push({ ...base, state: "stale" }); continue;
      }
      const expiresAt = Math.min(image.imageExpiresAt, viewer.expiresAt, deadline, authority.expiresAt, session.expiresAt.getTime());
      if (expiresAt <= Date.now()) { tiles.push({ ...base, state: "stale" }); continue; }
      tiles.push({ ...base, state: "available", sequence: image.sequence, observedAt: image.capturedAt,
        expiresAt: new Date(expiresAt).toISOString(), foregroundApplication: image.foregroundApplication, screenshot: image.screenshot });
    }
    // Serialize while the database authority locks still protect this response.
    return send({ enabled: true, serverTime: new Date().toISOString(), tiles });
  });
}
