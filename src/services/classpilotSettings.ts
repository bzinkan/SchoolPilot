import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { classpilotTeacherPreferences, schoolMemberships, schools, users } from "../schema/index.js";
import { auditLogs, settings, type Settings, type InsertSettings } from "../schema/shared.js";
import { classpilotStudentControlStates, sessionSettings } from "../schema/classpilot.js";
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
import { DASHBOARD_THEME_LIBRARY_LIMIT, appearanceSectionSchema, dashboardThemeAssetSummary, dashboardThemeSchema, dashboardThemesEnabled,
  imageThemeFit, mergeSchoolAppearance, readSchoolAppearance, schoolThemeFor, type DashboardThemeAsset, type ImageDashboardTheme,
  type PresetDashboardTheme, type SchoolTheme } from "./classpilotThemes.js";
import { themeAssetStoreConfigured } from "./classpilotThemeAssetStore.js";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;
export type SettingsActor = { schoolId: string; actorId: string };
const teacherRoles = ["teacher", "admin", "school_admin"];
export const adminRoles = ["admin", "school_admin"];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const tabLimit = z.number().int().min(1).max(100).nullable();
const rules = z.array(z.string().trim().min(1).max(2048)).max(1000).transform(values => [...new Set(values)]);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const schemas = {
  messaging: z.object({ expectedVersion: version, studentMessagingEnabled: z.boolean() }).strict(),
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
  appearance: appearanceSectionSchema,
};
export type SchoolSettingsSection = keyof typeof schemas;
// Teaching tools sends both personal fields; the dashboard quick switch sends
// only the theme. Absent fields keep their stored value.
const personalSchema = z.object({ expectedRevision: z.number().int().min(0), maxTabsPerStudent: tabLimit.optional(),
  dashboardTheme: dashboardThemeSchema.nullable().optional() }).strict()
  .refine(input => input.maxTabsPerStudent !== undefined || input.dashboardTheme !== undefined);
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
/** The ready images of a stored library, oldest ready first (then oldest created). */
function readyLibrary(value: unknown): DashboardThemeAsset[] {
  const stamp = (iso: string | null | undefined) => { const time = iso ? Date.parse(iso) : NaN; return Number.isNaN(time) ? 0 : time; };
  const entries: DashboardThemeAsset[] = Array.isArray(value) ? value : [];
  return entries.filter(entry => entry?.status === "ready")
    .sort((a, b) => stamp(a.readyAt) - stamp(b.readyAt) || stamp(a.createdAt) - stamp(b.createdAt));
}

export async function authorize(tx: Transaction, scope: SettingsActor, admin: boolean, write = false): Promise<string> {
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

export async function preferenceDto(executor: Executor, scope: SettingsActor) {
  const [own] = await executor.select().from(classpilotTeacherPreferences).where(and(
    eq(classpilotTeacherPreferences.schoolId, scope.schoolId), eq(classpilotTeacherPreferences.teacherId, scope.actorId),
  ));
  const [school] = await executor.select({ maxTabsPerStudent: settings.maxTabsPerStudent, appearance: settings.appearance })
    .from(settings).where(eq(settings.schoolId, scope.schoolId));
  const [zone] = await executor.select({ schoolTimezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, scope.schoolId));
  const maxTabsPerStudent = own?.maxTabsPerStudent ?? null;
  const schoolMaxTabsPerStudent = readTabLimit(school?.maxTabsPerStudent);
  const appearance = readSchoolAppearance(school?.appearance);
  const themesEnabled = dashboardThemesEnabled() && appearance.teacherThemesEnabled;
  const uploadsEnabled = themesEnabled && appearance.teacherUploadsEnabled && themeAssetStoreConfigured();
  const dashboardTheme = own?.dashboardTheme ?? null;
  const library = readyLibrary(own?.dashboardThemeAssets);
  const chosen = dashboardTheme?.kind === "image" ? library.find(entry => entry.id === dashboardTheme.imageAssetId) ?? null : null;
  // The school theme today: the fixed default, else the calendar in the
  // school's zone while the automatic calendar is on.
  const schoolTheme = schoolThemeFor(appearance, { now: new Date(), timeZone: zone?.schoolTimezone || "America/New_York" });
  // The teacher's own choice counts only while teacher themes are allowed
  // ("plain, no theme" is a choice too); an image additionally needs uploads
  // allowed and its bytes ready in the library. Otherwise the school theme
  // applies, and nothing applies while the launch gate is off.
  const ownCounts = themesEnabled && dashboardTheme !== null && (dashboardTheme.kind !== "image" || (uploadsEnabled && chosen !== null));
  const effectiveDashboardTheme: PresetDashboardTheme | ImageDashboardTheme | SchoolTheme | null = !dashboardThemesEnabled() ? null
    : appearance.lockToSchoolTheme || !ownCounts || dashboardTheme === null ? schoolTheme
      : dashboardTheme.kind === "none" ? null
        : dashboardTheme.kind === "image" ? { ...dashboardTheme, fit: imageThemeFit(dashboardTheme) } : dashboardTheme;
  // `dashboardThemeAsset` is the single-image field a client from before the
  // library still reads: the chosen image, else the most recently ready one.
  const compat = chosen ?? library.at(-1) ?? null;
  return { schoolId: scope.schoolId, revision: own?.revision ?? 0, maxTabsPerStudent,
    schoolMaxTabsPerStudent, effectiveMaxTabsPerStudent: maxTabsPerStudent ?? schoolMaxTabsPerStudent,
    dashboardTheme, schoolDashboardTheme: appearance.schoolDefaultTheme, schoolTheme,
    schoolCalendar: { autoCalendar: appearance.autoCalendar, holidays: appearance.calendarHolidays, leadDays: appearance.calendarLeadDays,
      starts: appearance.calendarStarts, signInGateTheme: appearance.signInGateTheme },
    dashboardThemeLocked: appearance.lockToSchoolTheme,
    effectiveDashboardTheme, dashboardThemesEnabled: themesEnabled, dashboardThemeUploadsEnabled: uploadsEnabled,
    dashboardThemeAsset: compat ? dashboardThemeAssetSummary(compat) : null,
    dashboardThemeAssets: library.map(dashboardThemeAssetSummary), dashboardThemeLibraryLimit: DASHBOARD_THEME_LIBRARY_LIMIT };
}
export type TeacherPreferencesDto = Awaited<ReturnType<typeof preferenceDto>>;
export function getClasspilotTeacherPreferences(scope: SettingsActor) {
  return db.transaction(async tx => { await authorize(tx, scope, false); return preferenceDto(tx, scope); });
}
export function updateClasspilotTeacherPreferences(scope: SettingsActor, body: unknown) {
  const input = parse(personalSchema, body);
  // Presentation-only preference: no student command and nothing to invalidate.
  const patch = { ...(input.maxTabsPerStudent === undefined ? {} : { maxTabsPerStudent: input.maxTabsPerStudent }),
    ...(input.dashboardTheme === undefined ? {} : { dashboardTheme: input.dashboardTheme }) };
  return db.transaction(async tx => {
    await authorize(tx, scope, false, true);
    const current = await preferenceDto(tx, scope);
    // Governance refusals come before the revision check and never write.
    if (input.dashboardTheme !== undefined) {
      if (!current.dashboardThemesEnabled) {
        throw new ClasspilotSettingsError("Dashboard themes are not available at this school.", 409, "CLASSPILOT_DASHBOARD_THEMES_DISABLED");
      }
      if (current.dashboardThemeLocked) {
        throw new ClasspilotSettingsError("Your school uses one dashboard theme for everyone.", 409, "CLASSPILOT_DASHBOARD_THEME_LOCKED");
      }
      if (input.dashboardTheme?.kind === "image") {
        if (!current.dashboardThemeUploadsEnabled) {
          throw new ClasspilotSettingsError("Custom background uploads are not available at this school.", 409, "CLASSPILOT_DASHBOARD_THEME_UPLOADS_DISABLED");
        }
        const imageAssetId = input.dashboardTheme.imageAssetId;
        if (!current.dashboardThemeAssets.some(entry => entry.id === imageAssetId)) {
          throw new ClasspilotSettingsError("Upload a background image before choosing it.", 409, "CLASSPILOT_DASHBOARD_THEME_ASSET_MISSING");
        }
      }
    }
    if (current.revision !== input.expectedRevision) {
      throw new ClasspilotSettingsError("Your teaching defaults changed. Review the latest values before saving.", 409, "CLASSPILOT_PREFERENCES_CONFLICT", current);
    }
    if (current.revision === 0) {
      await tx.insert(classpilotTeacherPreferences).values({ schoolId: scope.schoolId, teacherId: scope.actorId, ...patch, revision: 1 });
    } else {
      const updated = await tx.update(classpilotTeacherPreferences).set({ ...patch,
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
    case "messaging": return { studentMessagingEnabled: row.studentMessagingEnabled !== false, privateChatEpoch:row.privateChatEpoch };
    case "retention": return { retentionHours: row.retentionHours };
    case "classroom": return { maxTabsPerStudent: readTabLimit(row.maxTabsPerStudent), allowedDomains: row.allowedDomains ?? [] };
    case "monitoring": return { enableTrackingHours: row.enableTrackingHours === true, trackingStartTime: row.trackingStartTime ?? "08:00",
      trackingEndTime: row.trackingEndTime ?? "15:00", trackingDays: row.trackingDays ?? weekdays.slice(0, 5), afterHoursMode: row.afterHoursMode };
    case "signIn": return { sharedChromebookSignInEnabled: row.sharedChromebookSignInEnabled };
    case "email": return { centralEmailRecipientUserId: row.centralEmailRecipientUserId };
    case "rosterGrades": return { gradeLevels: row.gradeLevels ?? [] };
    case "appearance": return { ...readSchoolAppearance(row.appearance) };
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

/** The caller holds the school lifecycle lock, before any activity writer. */
async function advanceSchoolFabLifecycle(tx: Transaction, schoolId: string): Promise<string[]> {
  const scopes = await tx.select({ studentId: classpilotStudentControlStates.studentId,
    teachingSessionId: classpilotStudentControlStates.teachingSessionId,
    supervisionContextId: classpilotStudentControlStates.supervisionContextId })
    .from(classpilotStudentControlStates).where(and(eq(classpilotStudentControlStates.schoolId, schoolId),
      or(isNotNull(classpilotStudentControlStates.teachingSessionId), isNotNull(classpilotStudentControlStates.supervisionContextId))));
  const teachingSessionIds = [...new Set(scopes.flatMap(scope => scope.teachingSessionId ? [scope.teachingSessionId] : []))].sort();
  const supervisionContextIds = [...new Set(scopes.flatMap(scope => scope.supervisionContextId ? [scope.supervisionContextId] : []))].sort();
  const now = new Date();
  const next = { lifecycleRevision: sql<number>`${sessionSettings.lifecycleRevision} + 1`, updatedAt: now };
  // The school switch affects the complete FAB, so its generation must advance
  // in the same per-activity clock that clients already compare. Keep classroom
  // control revisions and independent restrictions/provenance unchanged.
  if (teachingSessionIds.length) await tx.insert(sessionSettings)
    .values(teachingSessionIds.map(sessionId => ({ schoolId, sessionId, lifecycleRevision: 1, updatedAt: now })))
    .onConflictDoUpdate({ target: sessionSettings.sessionId, set: next, setWhere: eq(sessionSettings.schoolId, schoolId) });
  if (supervisionContextIds.length) await tx.insert(sessionSettings)
    .values(supervisionContextIds.map(supervisionContextId => ({ schoolId, supervisionContextId, lifecycleRevision: 1, updatedAt: now })))
    .onConflictDoUpdate({ target: [sessionSettings.schoolId, sessionSettings.supervisionContextId],
      targetWhere: sql`${sessionSettings.supervisionContextId} IS NOT NULL`, set: next });
  return [...new Set(scopes.map(scope => scope.studentId))];
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
      case "messaging": { const value = parse(schemas.messaging,body); patch = {studentMessagingEnabled:value.studentMessagingEnabled}; break; }
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
      // Omitted calendar keys keep their live values; see mergeSchoolAppearance.
      case "appearance": { const { expectedVersion: _version, ...value } = parse(schemas.appearance, body); patch = { appearance: mergeSchoolAppearance(row.appearance, value) }; break; }
    }
    const [next] = await tx.update(settings).set(patch).where(eq(settings.schoolId, scope.schoolId)).returning();
    const fabStudentIds = key === "messaging" && (row.studentMessagingEnabled !== false) !== (next!.studentMessagingEnabled !== false)
      ? await advanceSchoolFabLifecycle(tx, scope.schoolId) : [];
    await tx.insert(auditLogs).values({ schoolId: scope.schoolId, userId: scope.actorId, userRole: actorRole,
      action: "classpilot.settings.update", entityType: "settings", entityId: scope.schoolId,
      metadata: { section: key, fields: Object.keys(patch) } });
    return { dto: sectionDto(scope.schoolId, key, next!), changedTabLimit: key === "classroom" && row.maxTabsPerStudent !== next!.maxTabsPerStudent,
      maxTabs: readTabLimit(next!.maxTabsPerStudent), fabStudentIds };
  });
  invalidateHeartbeatTrackingSettingsCache(scope.schoolId);
  await publishCacheInvalidation({ kind: "cache-invalidation", schoolId: scope.schoolId, cache: "heartbeat-tracking-settings" });
  // The persisted policy is authoritative on reconnect. A delivery outage after
  // commit must not report the accepted settings save as a failed transaction.
  if (saved.changedTabLimit) await fanoutSchoolTabLimit(scope.schoolId, saved.maxTabs).catch(error => {
    console.warn("ClassPilot school tab policy delivery failed", safeErrorMetadata(error));
  });
  if (saved.fabStudentIds.length) {
    const { syncClasspilotControlStatesToActiveDevices } = await import("./classpilotControlStateDelivery.js");
    await syncClasspilotControlStatesToActiveDevices(scope.schoolId, saved.fabStudentIds).catch(error => {
      console.warn("ClassPilot school messaging settings delivery failed", safeErrorMetadata(error));
    });
  }
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
