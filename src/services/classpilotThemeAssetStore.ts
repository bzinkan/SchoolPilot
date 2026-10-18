import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { classpilotTeacherPreferences as preferences } from "../schema/classpilotTeacherPreferences.js";
import { myDeskObjectStore, type MyDeskObjectStore } from "./mydeskFiles.js";
import type { DashboardThemeAsset, DashboardThemeAssetContentType } from "./classpilotThemes.js";

/**
 * Where teacher background images live: the private attachments bucket that
 * production already configures for My Desk. Tests inject an in-memory store.
 * Kept apart from the upload pipeline so the settings DTO can ask whether
 * uploads are possible, and so a kiosk route can serve bytes through the same
 * verified read without importing teacher authorization.
 */
let injected: MyDeskObjectStore | null = null;

export function setDashboardThemeAssetStore(store: MyDeskObjectStore | null): void { injected = store; }
export function dashboardThemeAssetStore(): MyDeskObjectStore { return injected ?? myDeskObjectStore; }
export function themeAssetStoreConfigured(): boolean {
  return injected !== null || Boolean(process.env.MYDESK_ATTACHMENTS_BUCKET?.trim());
}

/** The record exists but its bytes could not be served as recorded. */
export class DashboardThemeAssetUnavailableError extends Error {
  constructor() { super("Background images are temporarily unavailable. Please retry."); }
}
export type DashboardThemeAssetContent = { teacherId: string; contentType: DashboardThemeAssetContentType; sha256: string; byteSize: number; body: Buffer };

/**
 * The school's READY image with this id, or null: the library entry with that
 * id on whichever teacher's row holds it. Callers establish tenant context and
 * decide who may see it (owner, same-school admin, bound kiosk).
 */
export async function findReadyDashboardThemeAsset(schoolId: string, assetId: string): Promise<{ teacherId: string; asset: DashboardThemeAsset } | null> {
  const [row] = await db.select({ teacherId: preferences.teacherId, assets: preferences.dashboardThemeAssets }).from(preferences)
    .where(and(eq(preferences.schoolId, schoolId),
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${preferences.dashboardThemeAssets}) entry WHERE entry->>'id' = ${assetId})`));
  const asset = Array.isArray(row?.assets) ? row.assets.find(entry => entry.id === assetId) : undefined;
  return row && asset && asset.status === "ready" ? { teacherId: row.teacherId, asset } : null;
}

/**
 * Verified bytes for a ready image: the record is re-read after object I/O and
 * the body must hash to the recorded SHA-256, so a replaced or corrupt object
 * is never served under a stale ETag. Null when no ready record exists.
 */
export async function readDashboardThemeAssetContent(schoolId: string, assetId: string): Promise<DashboardThemeAssetContent | null> {
  const found = await findReadyDashboardThemeAsset(schoolId, assetId);
  if (!found) return null;
  let body: Buffer;
  try { body = await dashboardThemeAssetStore().get(found.asset.storageKey); } catch { throw new DashboardThemeAssetUnavailableError(); }
  const again = await findReadyDashboardThemeAsset(schoolId, assetId);
  if (!again) return null;
  const { asset } = found;
  if (again.asset.sha256 !== asset.sha256 || body.length !== asset.byteSize || createHash("sha256").update(body).digest("hex") !== asset.sha256) {
    throw new DashboardThemeAssetUnavailableError();
  }
  return { teacherId: found.teacherId, contentType: asset.contentType, sha256: asset.sha256, byteSize: asset.byteSize, body };
}
