import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { settings } from "../schema/shared.js";
import { studentSessions } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { users, schoolMemberships } from "../schema/core.js";
import { classpilotSchoolWebsitePolicies as policies, classpilotSchoolWebsiteDeliveries as deliveries } from "../schema/classpilotSchoolWebsitePolicy.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { currentStudentSessionAuthorityPredicate } from "./classpilotStudentSessionAuthority.js";
import { sendToStudentBindingLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";

export function normalizeSchoolBlockedWebsite(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > 253 || /[\s/@?#:*]/.test(raw)) {
    throw Object.assign(new Error("A website hostname is required"), { status: 400 });
  }
  const hostname = new URL(`https://${raw}`).hostname;
  if (!hostname.includes(".") || hostname !== raw || hostname.endsWith(".")) {
    throw Object.assign(new Error("A website hostname is required"), { status: 400 });
  }
  return hostname;
}

export async function getSchoolWebsitePolicy(schoolId: string) {
  const [row] = await db.select({ revision: policies.revision, blockedDomains: settings.blockedDomains })
    .from(settings).leftJoin(policies, eq(policies.schoolId, settings.schoolId)).where(eq(settings.schoolId, schoolId));
  return { policyRevision: row?.revision ?? 0, blockedDomains: row?.blockedDomains ?? [] };
}

/** Match the existing school website enforcement contract, including subdomains. */
export function schoolWebsiteRuleApplies(hostname: string, rule: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const blocked = rule.toLowerCase().replace(/^www\./, "");
  return Boolean(blocked) && (host === blocked || host.endsWith(`.${blocked}`));
}

async function websiteEnforcementStatus(schoolId: string, revision: number) {
  const effectiveStatus = sql<string>`coalesce(${deliveries.status},'pending')`;
  const rows = await db.select({ status: effectiveStatus, count: sql<number>`count(*)::int` })
    .from(studentSessions).innerJoin(students, eq(students.id, studentSessions.studentId))
    .leftJoin(deliveries, and(eq(deliveries.schoolId, schoolId), eq(deliveries.policyRevision, revision),
      eq(deliveries.studentSessionId, studentSessions.id), eq(deliveries.studentId, studentSessions.studentId),
      eq(deliveries.deviceId, studentSessions.deviceId)))
    .where(and(eq(students.schoolId, schoolId), eq(students.status, "active"), currentStudentSessionAuthorityPredicate()))
    .groupBy(effectiveStatus);
  return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
}

export async function getSchoolWebsitePolicyStatus(schoolId: string, domain: string) {
  const policy = await getSchoolWebsitePolicy(schoolId);
  return { ...policy, blocked: policy.blockedDomains.some(rule => schoolWebsiteRuleApplies(domain, rule)),
    enforcement: await websiteEnforcementStatus(schoolId, policy.policyRevision) };
}

async function mutateSchoolBlockedWebsites(options: {
  schoolId: string; actorId: string; expectedRevision?: number;
  mutate: (current: string[]) => string[];
  afterSave?: (tx: typeof db, policy: { policyRevision: number; blockedDomains: string[] }) => Promise<void>;
}) {
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) {
    throw Object.assign(new Error("Invalid website policy revision"), { status: 400 });
  }
  const saved = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await assertClasspilotEntitled(options.schoolId, transactionDb, { lock: true });
    const [actor] = await tx.select().from(users).where(eq(users.id, options.actorId)).for("share");
    const memberships = await tx.select().from(schoolMemberships).where(and(
      eq(schoolMemberships.userId, options.actorId), eq(schoolMemberships.schoolId, options.schoolId),
      eq(schoolMemberships.status, "active"),
    )).for("share");
    if (!actor?.isSuperAdmin && !memberships.some(membership => ["admin", "school_admin"].includes(membership.role))) {
      throw Object.assign(new Error("School administrator access required"), { status: 403 });
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`school-website-policy:${options.schoolId}`}, 0))`);
    await tx.insert(policies).values({ schoolId: options.schoolId }).onConflictDoNothing();
    const [policy] = await tx.select().from(policies).where(eq(policies.schoolId, options.schoolId)).for("update");
    const [current] = await tx.select().from(settings).where(eq(settings.schoolId, options.schoolId)).for("update");
    if (!policy || !current) throw new Error("School website policy unavailable");
    if (options.expectedRevision !== undefined && options.expectedRevision !== policy.revision) {
      throw Object.assign(new Error("School website policy changed; refresh and retry"), { status: 409, code: "SCHOOL_WEBSITE_POLICY_CONFLICT", revision: policy.revision });
    }
    const blockedDomains = [...new Set(options.mutate(current.blockedDomains ?? []))].sort();
    if (blockedDomains.length > 1_000) throw Object.assign(new Error("School block list cannot exceed 1,000 entries"), { status: 400 });
    const changed = JSON.stringify(blockedDomains) !== JSON.stringify([...(current.blockedDomains ?? [])].sort());
    const revision = policy.revision + (changed ? 1 : 0);
    const targets = changed ? await tx.select({ id: studentSessions.id, studentId: studentSessions.studentId, deviceId: studentSessions.deviceId })
      .from(studentSessions).innerJoin(students, eq(students.id, studentSessions.studentId)).where(and(
      eq(students.schoolId, options.schoolId), currentStudentSessionAuthorityPredicate(),
    )) : [];
    if (changed) {
      await tx.update(settings).set({ blockedDomains }).where(eq(settings.schoolId, options.schoolId));
      await tx.update(policies).set({ revision, updatedAt: new Date(), updatedBy: options.actorId })
        .where(eq(policies.schoolId, options.schoolId));
      if (targets.length) await tx.insert(deliveries).values(targets.map((target) => ({
        schoolId: options.schoolId, policyRevision: revision, studentId: target.studentId,
        studentSessionId: target.id, deviceId: target.deviceId,
      }))).onConflictDoNothing();
    }
    await options.afterSave?.(transactionDb, { policyRevision: revision, blockedDomains });
    return { policyRevision: revision, revision, blockedDomains, targets };
  });
  // A revision is a durable policy, not a teacher command. Offline clients get
  // the same authoritative revision from settings on their next connection.
  await Promise.all(saved.targets.map(async (target) => {
    const message = { type: "update-global-blacklist", schoolId: options.schoolId,
      studentId: target.studentId, studentSessionId: target.id,
      blockedDomains: saved.blockedDomains, policyRevision: saved.policyRevision };
    const exactTarget = { kind: "student-binding" as const, schoolId: options.schoolId,
      studentId: target.studentId, studentSessionId: target.id, deviceId: target.deviceId };
    sendToStudentBindingLocal(exactTarget, message);
    await publishWS(exactTarget, message).catch(() => {});
  }));
  return { policyRevision: saved.policyRevision, revision: saved.revision, blockedDomains: saved.blockedDomains,
    enforcement: await websiteEnforcementStatus(options.schoolId, saved.policyRevision) };
}

export function addSchoolBlockedWebsite(options: { schoolId: string; domain: string; expectedRevision?: number; actorId: string;
  afterSave?: (tx: typeof db, policy: { policyRevision: number; blockedDomains: string[] }) => Promise<void>;
}) {
  const domain = normalizeSchoolBlockedWebsite(options.domain);
  return mutateSchoolBlockedWebsites({ ...options, mutate: (current) =>
    current.some(rule => schoolWebsiteRuleApplies(domain, rule)) ? current : [...current, domain] });
}

export function replaceSchoolBlockedWebsites(options: { schoolId: string; blockedDomains: string[]; expectedRevision?: number; actorId: string }) {
  return mutateSchoolBlockedWebsites({ ...options, mutate: () => options.blockedDomains });
}

export async function recordSchoolWebsitePolicyAck(binding: {
  schoolId: string; studentId: string; studentSessionId: string; deviceId: string;
}, payload: { policyRevision: number; status: "applied" | "failed"; closedTabCount: number; errorCode?: string }) {
  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(policies).where(eq(policies.schoolId, binding.schoolId)).for("share");
    if (!policy || policy.revision !== payload.policyRevision) return { accepted: false, terminal: true, code: "POLICY_SUPERSEDED" };
    const [session] = await tx.select({ id: studentSessions.id }).from(studentSessions)
      .innerJoin(students, eq(students.id, studentSessions.studentId)).where(and(
      eq(studentSessions.id, binding.studentSessionId), eq(students.schoolId, binding.schoolId),
      eq(studentSessions.studentId, binding.studentId), eq(studentSessions.deviceId, binding.deviceId),
      currentStudentSessionAuthorityPredicate(),
    )).for("share");
    if (!session) return { accepted: false, terminal: true, code: "BINDING_SUPERSEDED" };
    await tx.insert(deliveries).values({ ...binding, policyRevision: payload.policyRevision }).onConflictDoNothing();
    const [delivery] = await tx.select().from(deliveries).where(and(
      eq(deliveries.schoolId, binding.schoolId), eq(deliveries.policyRevision, payload.policyRevision),
      eq(deliveries.studentSessionId, binding.studentSessionId),
    )).for("update");
    if (delivery?.status !== "applied") await tx.update(deliveries).set({
      status: payload.status, closedTabCount: payload.closedTabCount,
      errorCode: payload.errorCode ?? null, acknowledgedAt: new Date(),
    }).where(eq(deliveries.id, delivery!.id));
    return { accepted: true, terminal: false };
  });
}
