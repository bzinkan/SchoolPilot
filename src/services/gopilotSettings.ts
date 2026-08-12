import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../db.js";
import { schools } from "../schema/core.js";
import { auditLogs, settings } from "../schema/shared.js";

export type GoPilotPickupZone = {
  id: string;
  name: string;
};

export type GoPilotSettingsDto = {
  dismissalTime: string | null;
  schoolTimezone: string;
  autoStartEnabled: boolean;
  pickupZones: GoPilotPickupZone[];
  revision: number;
};

export type GoPilotSettingsPatch = {
  dismissalTime?: string | null;
  schoolTimezone?: string;
  autoStartEnabled?: boolean;
  pickupZones?: GoPilotPickupZone[];
};

export type GoPilotSettingsActor = {
  userId: string;
  userEmail?: string;
  userRole?: string;
};

export type UpdateGoPilotSettingsResult =
  | { status: "saved"; current: GoPilotSettingsDto; changedFields: string[] }
  | { status: "conflict"; current: GoPilotSettingsDto }
  | { status: "dismissal_time_required"; current: GoPilotSettingsDto };

type GoPilotSettingsRow = {
  dismissalTime: string | null;
  schoolTimezone: string;
  gopilotAutoStartEnabled: boolean;
  gopilotPickupZones: unknown;
  gopilotSettingsRevision: number;
};

export const DEFAULT_GOPILOT_PICKUP_ZONES: readonly GoPilotPickupZone[] = Object.freeze([
  Object.freeze({ id: "A", name: "Zone A" }),
  Object.freeze({ id: "B", name: "Zone B" }),
  Object.freeze({ id: "C", name: "Zone C" }),
]);

export function normalizeGoPilotPickupZones(value: unknown): GoPilotPickupZone[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    return DEFAULT_GOPILOT_PICKUP_ZONES.map((zone) => ({ ...zone }));
  }
  const seen = new Set<string>();
  const normalized: GoPilotPickupZone[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return DEFAULT_GOPILOT_PICKUP_ZONES.map((zone) => ({ ...zone }));
    }
    const id = typeof (candidate as any).id === "string" ? (candidate as any).id.trim() : "";
    const name = typeof (candidate as any).name === "string" ? (candidate as any).name.trim() : "";
    const key = id.toLowerCase();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
      || id.length > 16
      || name.length < 1
      || name.length > 80
      || seen.has(key)
    ) {
      return DEFAULT_GOPILOT_PICKUP_ZONES.map((zone) => ({ ...zone }));
    }
    seen.add(key);
    normalized.push({ id, name });
  }
  return normalized;
}

function settingsDto(row: GoPilotSettingsRow): GoPilotSettingsDto {
  return {
    dismissalTime: row.dismissalTime,
    schoolTimezone: row.schoolTimezone,
    autoStartEnabled: row.gopilotAutoStartEnabled,
    pickupZones: normalizeGoPilotPickupZones(row.gopilotPickupZones),
    revision: row.gopilotSettingsRevision,
  };
}

const settingsSelection = {
  dismissalTime: schools.dismissalTime,
  schoolTimezone: schools.schoolTimezone,
  gopilotAutoStartEnabled: schools.gopilotAutoStartEnabled,
  gopilotPickupZones: schools.gopilotPickupZones,
  gopilotSettingsRevision: schools.gopilotSettingsRevision,
};

/** Read the deliberately narrow, non-parent GoPilot settings DTO. */
export async function getGoPilotSettings(
  schoolId: string
): Promise<GoPilotSettingsDto | undefined> {
  const [row] = await db
    .select(settingsSelection)
    .from(schools)
    .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
    .limit(1);
  return row ? settingsDto(row) : undefined;
}

/**
 * Persist all staff-operated dismissal settings under one row lock. The
 * authoritative school update, timezone mirror, revision, and audit event
 * either commit together or roll back together.
 */
export async function updateGoPilotSettings(
  schoolId: string,
  expectedRevision: number,
  patch: GoPilotSettingsPatch,
  actor: GoPilotSettingsActor
): Promise<UpdateGoPilotSettingsResult | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select(settingsSelection)
      .from(schools)
      .where(and(eq(schools.id, schoolId), isNull(schools.deletedAt)))
      .limit(1)
      .for("update");
    if (!row) return undefined;

    const current = settingsDto(row);
    if (current.revision !== expectedRevision) {
      return { status: "conflict" as const, current };
    }

    const next: GoPilotSettingsDto = {
      dismissalTime:
        patch.dismissalTime === undefined
          ? current.dismissalTime
          : patch.dismissalTime,
      schoolTimezone: patch.schoolTimezone ?? current.schoolTimezone,
      autoStartEnabled: patch.autoStartEnabled ?? current.autoStartEnabled,
      pickupZones: patch.pickupZones ?? current.pickupZones,
      revision: current.revision + 1,
    };
    if (next.autoStartEnabled && !next.dismissalTime) {
      return { status: "dismissal_time_required" as const, current };
    }

    const changedFields: string[] = [];
    if (next.dismissalTime !== current.dismissalTime) changedFields.push("dismissalTime");
    if (next.schoolTimezone !== current.schoolTimezone) changedFields.push("schoolTimezone");
    if (next.autoStartEnabled !== current.autoStartEnabled) changedFields.push("autoStartEnabled");
    if (JSON.stringify(next.pickupZones) !== JSON.stringify(current.pickupZones)) {
      changedFields.push("pickupZones");
    }

    const now = new Date();
    const [saved] = await tx
      .update(schools)
      .set({
        dismissalTime: next.dismissalTime,
        dismissalMode: "no_app",
        schoolTimezone: next.schoolTimezone,
        gopilotAutoStartEnabled: next.autoStartEnabled,
        gopilotPickupZones: next.pickupZones,
        gopilotSettingsRevision: next.revision,
        ...(next.schoolTimezone !== current.schoolTimezone
          ? { passpilotSettingsRevision: sql`${schools.passpilotSettingsRevision} + 1` }
          : {}),
        updatedAt: now,
      })
      .where(eq(schools.id, schoolId))
      .returning(settingsSelection);
    if (!saved) return undefined;

    // The duplicate timezone is still consumed by ClassPilot. A missing
    // mirror is an integrity error, not a reason to return a partial success.
    const [savedMirror] = await tx
      .update(settings)
      .set({ schoolTimezone: next.schoolTimezone })
      .where(eq(settings.schoolId, schoolId))
      .returning({ id: settings.id });
    if (!savedMirror) {
      throw Object.assign(new Error("GoPilot school settings are not initialized."), {
        status: 500,
        code: "GOPILOT_SETTINGS_MIRROR_MISSING",
      });
    }

    await tx.insert(auditLogs).values({
      schoolId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? null,
      userRole: actor.userRole ?? null,
      action: "gopilot.settings.update",
      entityType: "school",
      entityId: schoolId,
      changes: { fields: changedFields },
      metadata: {
        revision: next.revision,
        pickupZoneCount: next.pickupZones.length,
        autoStartEnabled: next.autoStartEnabled,
      },
    });

    return {
      status: "saved" as const,
      current: settingsDto(saved),
      changedFields,
    };
  });
}
