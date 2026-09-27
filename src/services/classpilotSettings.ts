import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { classpilotTeacherPreferences, schoolMemberships, schools, users } from "../schema/index.js";
import { auditLogs, settings, type Settings, type InsertSettings } from "../schema/shared.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { assertClasspilotRetentionHours } from "../util/classpilotRetention.js";
import { assertClasspilotMonitoringSettingsUpdate } from "./classpilotMonitoringSettings.js";
import { getSchoolWebsitePolicy, replaceSchoolBlockedWebsites } from "./classpilotSchoolWebsitePolicy.js";
import { getActiveSessions, invalidateHeartbeatTrackingSettingsCache } from "./storage.js";
import { publishCacheInvalidation } from "../realtime/cacheInvalidation.js";
import { sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch } from "../realtime/ws-redis.js";
import { classpilotSchoolPolicyAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { safeErrorMetadata } from "../util/safeLogging.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;
export type SettingsActor = { schoolId: string; actorId: string };
const teacherRoles = ["teacher", "admin", "school_admin"];
const adminRoles = ["admin", "school_admin"];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const tabLimit = z.number().int().min(1).max(100).nullable();
const rules = z.array(z.string().trim().min(1).max(2048)).max(1000).transform(values => [...new Set(values)]);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const schemas = {
  retention: z.object({ expectedVersion: version, retentionHours: z.union([z.string(), z.number()]) }).strict(),
  classroom: z.object({ expectedVersion: version, maxTabsPerStudent: tabLimit, allowedDomains: rules }).strict(),
  monitoring: z.object({ expectedVersion: version, enableTrackingHours: z.boolean(),
    trackingStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    trackingEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    trackingDays: z.array(z.enum(weekdays)).min(1).max(7).transform(values => [...new Set(values)]),
    afterHoursMode: z.enum(["off", "limited", "full"]) }).strict(),
  signIn: z.object({ expectedVersion: version, sharedChromebookSignInEnabled: z.boolean() }).strict(),
  email: z.object({ expectedVersion: version, centralEmailRecipientUserId: z.string().trim().min(1).nullable() }).strict(),
  rosterGrades: z.object({ expectedVersion: version, gradeLevels: z.array(z.string().trim().min(1).max(40)).max(50)
    .transform(values => [...new Set(values)]) }).strict(),
};
export type SchoolSettingsSection = keyof typeof schemas;
const personalSchema = z.object({ expectedRevision: z.number().int().min(0), maxTabsPerStudent: tabLimit }).strict();
const blockedSchema = z.object({ policyRevision: z.number().int().min(0), blockedDomains: rules }).strict();

export class ClasspilotSettingsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly current?: unknown) { super(message); }
}
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ClasspilotSettingsError("Provide exactly the visible settings fields and their current version.", 400, "CLASSPILOT_SETTINGS_INVALID");
  return parsed.data;
}
function readTabLimit(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? number : null;
}

async function authorize(tx: Transaction, scope: SettingsActor, admin: boolean, write = false): Promise<string> {
  if (write && !await lockStaffAssignmentLifecycleSchool(tx, scope.schoolId)) {
    throw new ClasspilotSettingsError("School is unavailable.", 403, "CLASSPILOT_NOT_ENTITLED");
  }
  await assertClasspilotEntitled(scope.schoolId, tx, { lock: true });
  const [actor] = await tx.select().from(users).where(eq(users.id, scope.actorId)).for("share");
  if (!actor) throw new ClasspilotSettingsError("Staff access is unavailable.", 403, "CLASSPILOT_SETTINGS_FORBIDDEN");
  const memberships = await tx.select().from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, scope.schoolId), eq(schoolMemberships.userId, scope.actorId),
    eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, admin ? adminRoles : teacherRoles),
  )).for("share");
  if (!memberships.length && !(admin && actor.isSuperAdmin)) {
    throw new ClasspilotSettingsError("An active authorized school membership is required.", 403, "CLASSPILOT_SETTINGS_FORBIDDEN");
  }
  return actor.isSuperAdmin ? "super_admin" : memberships[0]!.role;
}

async function preferenceDto(executor: Executor, scope: SettingsActor) {
  const [own] = await executor.select().from(classpilotTeacherPreferences).where(and(
    eq(classpilotTeacherPreferences.schoolId, scope.schoolId), eq(classpilotTeacherPreferences.teacherId, scope.actorId),
  ));
  const [school] = await executor.select({ maxTabsPerStudent: settings.maxTabsPerStudent }).from(settings)
    .where(eq(settings.schoolId, scope.schoolId));
  const maxTabsPerStudent = own?.maxTabsPerStudent ?? null;
  const schoolMaxTabsPerStudent = readTabLimit(school?.maxTabsPerStudent);
  return { schoolId: scope.schoolId, revision: own?.revision ?? 0, maxTabsPerStudent,
    schoolMaxTabsPerStudent, effectiveMaxTabsPerStudent: maxTabsPerStudent ?? schoolMaxTabsPerStudent };
}
export function getClasspilotTeacherPreferences(scope: SettingsActor) {
  return db.transaction(async tx => { await authorize(tx, scope, false); return preferenceDto(tx, scope); });
}
export function updateClasspilotTeacherPreferences(scope: SettingsActor, body: unknown) {
  const input = parse(personalSchema, body);
  return db.transaction(async tx => {
    await authorize(tx, scope, false, true);
    const current = await preferenceDto(tx, scope);
    if (current.revision !== input.expectedRevision) {
      throw new ClasspilotSettingsError("Your teaching defaults changed. Review the latest values before saving.", 409, "CLASSPILOT_PREFERENCES_CONFLICT", current);
    }
    if (current.revision === 0) {
      await tx.insert(classpilotTeacherPreferences).values({ schoolId: scope.schoolId, teacherId: scope.actorId,
        maxTabsPerStudent: input.maxTabsPerStudent, revision: 1 });
    } else {
      const updated = await tx.update(classpilotTeacherPreferences).set({ maxTabsPerStudent: input.maxTabsPerStudent,
        revision: current.revision + 1, updatedAt: new Date() }).where(and(
        eq(classpilotTeacherPreferences.schoolId, scope.schoolId), eq(classpilotTeacherPreferences.teacherId, scope.actorId),
        eq(classpilotTeacherPreferences.revision, current.revision),
      )).returning({ id: classpilotTeacherPreferences.id });
      if (!updated.length) throw new ClasspilotSettingsError("Your teaching defaults changed. Review the latest values before saving.", 409,
        "CLASSPILOT_PREFERENCES_CONFLICT", await preferenceDto(tx, scope));
    }
    return preferenceDto(tx, scope);
  });
}

function valuesFor(section: SchoolSettingsSection, row: Settings) {
  switch (section) {
    case "retention": return { retentionHours: row.retentionHours };
    case "classroom": return { maxTabsPerStudent: readTabLimit(row.maxTabsPerStudent), allowedDomains: row.allowedDomains ?? [] };
    case "monitoring": return { enableTrackingHours: row.enableTrackingHours === true, trackingStartTime: row.trackingStartTime ?? "08:00",
      trackingEndTime: row.trackingEndTime ?? "15:00", trackingDays: row.trackingDays ?? weekdays.slice(0, 5), afterHoursMode: row.afterHoursMode };
    case "signIn": return { sharedChromebookSignInEnabled: row.sharedChromebookSignInEnabled };
    case "email": return { centralEmailRecipientUserId: row.centralEmailRecipientUserId };
    case "rosterGrades": return { gradeLevels: row.gradeLevels ?? [] };
  }
}
function sectionDto(schoolId: string, section: SchoolSettingsSection, row: Settings) {
  const values = valuesFor(section, row);
  const fingerprint = createHash("sha256").update(JSON.stringify([schoolId, section, values])).digest("hex");
  return { version: fingerprint, ...values };
}
async function schoolSettingsRow(tx: Transaction, schoolId: string, lock = false) {
  const query = tx.select().from(settings).where(eq(settings.schoolId, schoolId));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ClasspilotSettingsError("School settings are unavailable. Refresh or ask your administrator for help.", 409, "CLASSPILOT_SETTINGS_UNAVAILABLE");
  return row;
}
export async function getClasspilotSchoolSettings(scope: SettingsActor) {
  const result = await db.transaction(async tx => {
    await authorize(tx, scope, true);
    const [school] = await tx.select({ name: schools.name, schoolTimezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, scope.schoolId));
    const row = await schoolSettingsRow(tx, scope.schoolId);
    const sections = Object.fromEntries((Object.keys(schemas) as SchoolSettingsSection[]).map(section => [section, sectionDto(scope.schoolId, section, row)]));
    return { schoolId: scope.schoolId, schoolName: school!.name, schoolTimezone: school!.schoolTimezone || "America/New_York", sections };
  });
  return { ...result, sections: { ...result.sections, blockedWebsites: await getSchoolWebsitePolicy(scope.schoolId) } };
}

async function assertRecipient(tx: Transaction, schoolId: string, recipientId: string) {
  const [recipient] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, recipientId)).for("share");
  const [membership] = await tx.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, recipientId), eq(schoolMemberships.status, "active"),
    inArray(schoolMemberships.role, [...teacherRoles, "office_staff"]),
  )).for("share");
  if (!recipient?.email?.trim() || !membership) {
    throw new ClasspilotSettingsError("Choose active staff at this school with an email address, or clear the recipient.", 400, "CLASSPILOT_SETTINGS_INVALID_RECIPIENT");
  }
}

export async function updateClasspilotSchoolSettings(scope: SettingsActor, section: string, body: unknown) {
  if (section === "blockedWebsites") {
    const input = parse(blockedSchema, body);
    const result = await replaceSchoolBlockedWebsites({ schoolId: scope.schoolId, actorId: scope.actorId,
      expectedRevision: input.policyRevision, blockedDomains: input.blockedDomains });
    return { schoolId: scope.schoolId, policyRevision: result.policyRevision, blockedDomains: result.blockedDomains };
  }
  if (!Object.prototype.hasOwnProperty.call(schemas, section)) {
    throw new ClasspilotSettingsError("Unknown school settings section.", 404, "CLASSPILOT_SETTINGS_SECTION_NOT_FOUND");
  }
  const key = section as SchoolSettingsSection;
  const input = parse(schemas[key], body);
  const saved = await db.transaction(async tx => {
    const actorRole = await authorize(tx, scope, true, true);
    const row = await schoolSettingsRow(tx, scope.schoolId, true);
    const current = sectionDto(scope.schoolId, key, row);
    if (input.expectedVersion !== current.version) {
      throw new ClasspilotSettingsError("This school settings section changed. Review the latest values before saving.", 409, "CLASSPILOT_SETTINGS_CONFLICT", current);
    }
    let patch: Partial<InsertSettings>;
    switch (key) {
      case "retention": { const value = parse(schemas.retention, body); patch = { retentionHours: String(assertClasspilotRetentionHours(value.retentionHours)) }; break; }
      case "classroom": { const value = parse(schemas.classroom, body); patch = { maxTabsPerStudent: value.maxTabsPerStudent === null ? null : String(value.maxTabsPerStudent), allowedDomains: value.allowedDomains }; break; }
      case "monitoring": {
        const { expectedVersion: _version, ...value } = parse(schemas.monitoring, body);
        const [school] = await tx.select({ schoolTimezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, scope.schoolId));
        assertClasspilotMonitoringSettingsUpdate({ ...row, schoolTimezone: school?.schoolTimezone || "America/New_York" }, value);
        patch = value; break;
      }
      case "signIn": {
        const value = parse(schemas.signIn, body); patch = { sharedChromebookSignInEnabled: value.sharedChromebookSignInEnabled };
        if (value.sharedChromebookSignInEnabled && !row.sharedChromebookSignInEnabled) {
          patch.sharedChromebookLoginMethod = "name_pin"; patch.sharedChromebookPinLoginEnabled = true;
        }
        break;
      }
      case "email": { const value = parse(schemas.email, body); if (value.centralEmailRecipientUserId) await assertRecipient(tx, scope.schoolId, value.centralEmailRecipientUserId); patch = { centralEmailRecipientUserId: value.centralEmailRecipientUserId }; break; }
      case "rosterGrades": { const value = parse(schemas.rosterGrades, body); patch = { gradeLevels: value.gradeLevels }; break; }
    }
    const [next] = await tx.update(settings).set(patch).where(eq(settings.schoolId, scope.schoolId)).returning();
    await tx.insert(auditLogs).values({ schoolId: scope.schoolId, userId: scope.actorId, userRole: actorRole,
      action: "classpilot.settings.update", entityType: "settings", entityId: scope.schoolId,
      metadata: { section: key, fields: Object.keys(patch) } });
    return { dto: sectionDto(scope.schoolId, key, next!), changedTabLimit: key === "classroom" && row.maxTabsPerStudent !== next!.maxTabsPerStudent,
      maxTabs: readTabLimit(next!.maxTabsPerStudent) };
  });
  invalidateHeartbeatTrackingSettingsCache(scope.schoolId);
  await publishCacheInvalidation({ kind: "cache-invalidation", schoolId: scope.schoolId, cache: "heartbeat-tracking-settings" });
  // The persisted policy is authoritative on reconnect. A delivery outage after
  // commit must not report the accepted settings save as a failed transaction.
  if (saved.changedTabLimit) await fanoutSchoolTabLimit(scope.schoolId, saved.maxTabs).catch(error => {
    console.warn("ClassPilot school tab policy delivery failed", safeErrorMetadata(error));
  });
  return { schoolId: scope.schoolId, ...saved.dto };
}

async function fanoutSchoolTabLimit(schoolId: string, maxTabs: number | null) {
  const bindings = await getActiveSessions(schoolId);
  const publications = bindings.map(binding => {
    const exactBinding = { studentId: binding.studentId, studentSessionId: binding.id };
    const message = { type: "remote-control", _msgId: randomUUID(), ...exactBinding,
      command: { type: "limit-tabs", ...exactBinding, ...classpilotSchoolPolicyAuthorityEnvelope(schoolId, "school_settings"), data: { maxTabs, ...exactBinding } } };
    sendToDeviceLocal(schoolId, binding.deviceId, message);
    return { target: { kind: "device" as const, schoolId, deviceId: binding.deviceId }, message };
  });
  if (publications.length) await publishWSBatch(publications);
}
