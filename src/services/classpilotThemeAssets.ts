import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import db from "../db.js";
import { classpilotTeacherPreferences as preferences } from "../schema/classpilotTeacherPreferences.js";
import { MYDESK_UPLOAD_LEASE_MS } from "./mydeskFiles.js";
import { privateNativeProcessing, PrivateNativeProcessingError } from "./privateNativeProcessing.js";
import { adminRoles, authorize, ClasspilotSettingsError, preferenceDto, type SettingsActor, type TeacherPreferencesDto,
  type Transaction } from "./classpilotSettings.js";
import { DASHBOARD_THEME_ASSET_INPUT_TYPES, DASHBOARD_THEME_ASSET_MAX_BYTES, DASHBOARD_THEME_ASSET_MAX_EDGE, DASHBOARD_THEME_LIBRARY_LIMIT,
  dashboardThemeAssetSummary, type DashboardThemeAsset, type DashboardThemeAssetContentType } from "./classpilotThemes.js";
import { dashboardThemeAssetStore, DashboardThemeAssetUnavailableError, findReadyDashboardThemeAsset, readDashboardThemeAssetContent,
  setDashboardThemeAssetStore, themeAssetStoreConfigured } from "./classpilotThemeAssetStore.js";
import { safeErrorMetadata } from "../util/safeLogging.js";

export { readDashboardThemeAssetContent, setDashboardThemeAssetStore, themeAssetStoreConfigured };

/**
 * A teacher's background library: up to DASHBOARD_THEME_LIBRARY_LIMIT images,
 * each reserve -> PUT bytes -> ready. The entries live as an array on the
 * teacher's own preferences row, so RLS, membership and entitlement checks are
 * the same as for every other personal preference. Reads are
 * owner-or-same-school-admin; everything else is owner only.
 */
const fail = (status: number, code: string, message: string) => new ClasspilotSettingsError(message, status, code);
const missing = () => fail(404, "CLASSPILOT_DASHBOARD_THEME_ASSET_NOT_FOUND", "Background image not found.");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reserveSchema = z.object({ contentType: z.string().trim().min(1).max(100), size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type AssetResult = { asset: ReturnType<typeof dashboardThemeAssetSummary>; preferences: TeacherPreferencesDto };
type PreferenceRow = typeof preferences.$inferSelect;

function validateInput(contentType: string, size: number): asserts contentType is DashboardThemeAssetContentType {
  if (!DASHBOARD_THEME_ASSET_INPUT_TYPES.includes(contentType as DashboardThemeAssetContentType)) {
    throw fail(415, "CLASSPILOT_DASHBOARD_THEME_ASSET_UNSUPPORTED_TYPE", "Choose a JPEG, PNG or WebP image. Convert HEIC/HEIF photos to JPEG first.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > DASHBOARD_THEME_ASSET_MAX_BYTES) {
    throw fail(413, "CLASSPILOT_DASHBOARD_THEME_ASSET_TOO_LARGE", "The image must be nonempty and no larger than 6 MiB.");
  }
}
function assertUploadsAllowed(current: TeacherPreferencesDto) {
  if (!current.dashboardThemeUploadsEnabled) {
    throw fail(409, "CLASSPILOT_DASHBOARD_THEME_UPLOADS_DISABLED", "Custom background uploads are not available at this school.");
  }
}
const liveLease = (asset: DashboardThemeAsset) => asset.status === "uploading" && !!asset.leaseUntil && Date.parse(asset.leaseUntil) > Date.now();
const inProgress = () => fail(409, "CLASSPILOT_DASHBOARD_THEME_UPLOAD_IN_PROGRESS", "Your background image is still uploading. Retry shortly.");
const libraryFull = () => fail(409, "CLASSPILOT_DASHBOARD_THEME_LIBRARY_FULL",
  `You can keep up to ${DASHBOARD_THEME_LIBRARY_LIMIT} backgrounds. Remove one to add another.`);
/** The stored library; a row from before the array column reads as empty. */
const libraryOf = (row: PreferenceRow | null): DashboardThemeAsset[] => Array.isArray(row?.dashboardThemeAssets) ? row.dashboardThemeAssets : [];
const replaceEntry = (library: DashboardThemeAsset[], next: DashboardThemeAsset) => library.map(entry => entry.id === next.id ? next : entry);
async function lockedOwnRow(tx: Transaction, scope: SettingsActor) {
  const [row] = await tx.select().from(preferences).where(and(
    eq(preferences.schoolId, scope.schoolId), eq(preferences.teacherId, scope.actorId))).for("update");
  return row ?? null;
}
async function writeLibrary(tx: Transaction, scope: SettingsActor, row: PreferenceRow | null, library: DashboardThemeAsset[]) {
  if (row) await tx.update(preferences).set({ dashboardThemeAssets: library, updatedAt: new Date() }).where(eq(preferences.id, row.id));
  else await tx.insert(preferences).values({ schoolId: scope.schoolId, teacherId: scope.actorId, dashboardThemeAssets: library, revision: 1 });
}
// Object I/O never surfaces bucket names, keys or provider errors to clients.
const unavailable = () => fail(503, "CLASSPILOT_DASHBOARD_THEME_ASSET_UNAVAILABLE", "Background images are temporarily unavailable. Please retry.");
async function putObject(key: string, bytes: Buffer) {
  try { await dashboardThemeAssetStore().put(key, bytes, "image/webp"); } catch { throw unavailable(); }
}
/** Best-effort removal of an object nothing references any more. */
async function discard(key: string | null | undefined) {
  if (!key) return;
  try { await dashboardThemeAssetStore().delete(key); } catch (error) {
    console.warn("ClassPilot dashboard theme asset cleanup deferred", safeErrorMetadata(error));
  }
}

/** Decode actual bytes, re-encode to WebP and drop every metadata chunk. */
async function normalizeBackground(bytes: Buffer, contentType: DashboardThemeAssetContentType) {
  try {
    return await privateNativeProcessing.run(async () => {
      const input = sharp(bytes, { limitInputPixels: 24_000_000, failOn: "warning", animated: false });
      const metadata = await input.metadata();
      const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[contentType];
      if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("format_mismatch");
      const output = await input.rotate().resize({ width: DASHBOARD_THEME_ASSET_MAX_EDGE, height: DASHBOARD_THEME_ASSET_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).webp({ quality: 82 }).timeout({ seconds: 20 }).toBuffer({ resolveWithObject: true });
      // sharp strips EXIF/XMP/IPTC/ICC by default; do not call withMetadata or keepMetadata.
      return { bytes: output.data, width: output.info.width, height: output.info.height, sha256: sha256(output.data) };
    });
  } catch (error) {
    if (error instanceof PrivateNativeProcessingError) {
      throw fail(503, "CLASSPILOT_DASHBOARD_THEME_ASSET_PROCESSING_UNAVAILABLE", "Image processing is temporarily unavailable. Please retry your upload.");
    }
    throw fail(422, "CLASSPILOT_DASHBOARD_THEME_ASSET_INVALID", "This image could not be read. Choose a single JPEG, PNG or WebP image no larger than 24 megapixels.");
  }
}

/**
 * Reserve a library slot. An image already in the library with the same input
 * (hash, type, size) is returned as-is, ready, consuming no slot. Abandoned
 * reservations and expired leases are pruned on the way, their keys handed to
 * cleanup; a live lease refuses, and a full library refuses before any write.
 */
export async function reserveDashboardThemeAsset(scope: SettingsActor, body: unknown): Promise<AssetResult> {
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) throw fail(400, "CLASSPILOT_SETTINGS_INVALID", "Provide the image type, byte size and SHA-256.");
  const input = { ...parsed.data, contentType: parsed.data.contentType.toLowerCase() };
  validateInput(input.contentType, input.size);
  const contentType: DashboardThemeAssetContentType = input.contentType;
  const result = await db.transaction(async tx => {
    await authorize(tx, scope, false, true);
    const row = await lockedOwnRow(tx, scope);
    assertUploadsAllowed(await preferenceDto(tx, scope));
    const library = libraryOf(row);
    if (library.some(liveLease)) throw inProgress();
    const orphans = library.filter(entry => entry.status !== "ready").map(entry => entry.storageKey);
    const ready = library.filter(entry => entry.status === "ready");
    const same = ready.find(entry => entry.inputSha256 === input.sha256 && entry.inputContentType === contentType && entry.inputByteSize === input.size);
    if (same) {
      if (orphans.length) await writeLibrary(tx, scope, row, ready);
      return { asset: same, orphans, preferences: await preferenceDto(tx, scope) };
    }
    if (ready.length >= DASHBOARD_THEME_LIBRARY_LIMIT) throw libraryFull();
    const id = randomUUID();
    const asset: DashboardThemeAsset = { id, status: "reserved", storageKey: `classpilot/themes/${scope.schoolId}/${scope.actorId}/${id}`,
      contentType, byteSize: input.size, sha256: input.sha256, inputSha256: input.sha256, inputContentType: contentType,
      inputByteSize: input.size, leaseId: null, leaseUntil: null, createdAt: new Date().toISOString(), readyAt: null, replaces: null };
    await writeLibrary(tx, scope, row, [...ready, asset]);
    return { asset, orphans, preferences: await preferenceDto(tx, scope) };
  });
  for (const key of result.orphans) await discard(key);
  return { asset: dashboardThemeAssetSummary(result.asset), preferences: result.preferences };
}

export async function uploadDashboardThemeAsset(scope: SettingsActor, assetId: string, bytes: Buffer, contentType: string): Promise<AssetResult> {
  validateInput(contentType, bytes.length);
  const inputHash = sha256(bytes), leaseId = randomUUID();
  const claimed = await db.transaction(async tx => {
    await authorize(tx, scope, false, true);
    const row = await lockedOwnRow(tx, scope);
    const library = libraryOf(row);
    const asset = library.find(entry => entry.id === assetId);
    if (!row || !asset) throw missing();
    if (asset.inputSha256 !== inputHash || asset.inputByteSize !== bytes.length || asset.inputContentType !== contentType) {
      throw fail(409, "CLASSPILOT_DASHBOARD_THEME_UPLOAD_MISMATCH", "Upload the image you selected when reserving.");
    }
    const current = await preferenceDto(tx, scope);
    if (asset.status === "ready") return { ready: true as const, asset, preferences: current };
    assertUploadsAllowed(current);
    if (liveLease(asset)) throw inProgress();
    const leased: DashboardThemeAsset = { ...asset, status: "uploading", leaseId, leaseUntil: new Date(Date.now() + MYDESK_UPLOAD_LEASE_MS).toISOString() };
    await writeLibrary(tx, scope, row, replaceEntry(library, leased));
    return { ready: false as const, asset: leased };
  });
  if (claimed.ready) return { asset: dashboardThemeAssetSummary(claimed.asset), preferences: claimed.preferences };
  try {
    const normalized = await normalizeBackground(bytes, contentType);
    // The key is durable before object I/O; a late write stays cleanup-owned.
    await putObject(claimed.asset.storageKey, normalized.bytes);
    const result = await db.transaction(async tx => {
      await authorize(tx, scope, false, true);
      const row = await lockedOwnRow(tx, scope);
      const library = libraryOf(row);
      const asset = library.find(entry => entry.id === assetId);
      if (!row || !asset || asset.status !== "uploading" || asset.leaseId !== leaseId || !liveLease(asset)) {
        throw fail(409, "CLASSPILOT_DASHBOARD_THEME_UPLOAD_CONFLICT", "This upload was replaced or expired. Start again.");
      }
      const ready: DashboardThemeAsset = { ...asset, status: "ready", contentType: "image/webp", byteSize: normalized.bytes.length,
        sha256: normalized.sha256, width: normalized.width, height: normalized.height, leaseId: null, leaseUntil: null,
        readyAt: new Date().toISOString(), replaces: null };
      await writeLibrary(tx, scope, row, replaceEntry(library, ready));
      return { asset: ready, preferences: await preferenceDto(tx, scope) };
    });
    return { asset: dashboardThemeAssetSummary(result.asset), preferences: result.preferences };
  } catch (error) {
    // Expiry cleanup does not depend on this release succeeding.
    await releaseLease(scope, assetId, leaseId).catch(() => undefined);
    throw error;
  }
}
async function releaseLease(scope: SettingsActor, assetId: string, leaseId: string) {
  await db.transaction(async tx => {
    const row = await lockedOwnRow(tx, scope);
    const library = libraryOf(row);
    const asset = library.find(entry => entry.id === assetId);
    if (!row || !asset || asset.status !== "uploading" || asset.leaseId !== leaseId) return;
    await writeLibrary(tx, scope, row, replaceEntry(library, { ...asset, status: "reserved", leaseId: null, leaseUntil: null }));
  });
}

export type DashboardThemeAssetRead =
  | { unchanged: true; contentType: DashboardThemeAssetContentType; sha256: string; byteSize: number }
  | { unchanged: false; bytes: Buffer; contentType: DashboardThemeAssetContentType; sha256: string; byteSize: number };
/**
 * The owner, or with `allowAdmin` an admin/school_admin of the same school,
 * reads a ready image. Anyone else gets 404 so existence is never confirmed.
 * `knownSha256` lets a conditional request skip object I/O.
 */
export async function readDashboardThemeAsset(scope: SettingsActor, assetId: string,
  options: { allowAdmin?: boolean; knownSha256?: readonly string[] } = {}): Promise<DashboardThemeAssetRead> {
  const found = await db.transaction(async tx => {
    const role = await authorize(tx, scope, false);
    const found = await findReadyDashboardThemeAsset(scope.schoolId, assetId);
    if (!found || !(found.teacherId === scope.actorId || (options.allowAdmin === true && adminRoles.includes(role)))) throw missing();
    return found;
  });
  const { asset } = found;
  if (options.knownSha256?.includes(asset.sha256)) return { unchanged: true, contentType: asset.contentType, sha256: asset.sha256, byteSize: asset.byteSize };
  let content;
  try { content = await readDashboardThemeAssetContent(scope.schoolId, assetId); } catch (error) {
    if (error instanceof DashboardThemeAssetUnavailableError) throw unavailable();
    throw error;
  }
  if (!content || content.teacherId !== found.teacherId || content.sha256 !== asset.sha256) throw unavailable();
  return { unchanged: false, bytes: content.body, contentType: content.contentType, sha256: content.sha256, byteSize: content.byteSize };
}

/** Owner only. Removes one library entry; also clears an image theme that pointed at it. Other entries stay. */
export async function deleteDashboardThemeAsset(scope: SettingsActor, assetId: string): Promise<TeacherPreferencesDto> {
  const result = await db.transaction(async tx => {
    await authorize(tx, scope, false, true);
    const row = await lockedOwnRow(tx, scope);
    const library = libraryOf(row);
    const asset = library.find(entry => entry.id === assetId);
    if (!row || !asset) throw missing();
    if (liveLease(asset)) throw inProgress();
    const clearsTheme = row.dashboardTheme?.kind === "image" && row.dashboardTheme.imageAssetId === assetId;
    await tx.update(preferences).set({ dashboardThemeAssets: library.filter(entry => entry.id !== assetId), updatedAt: new Date(),
      ...(clearsTheme ? { dashboardTheme: null, revision: row.revision + 1 } : {}) }).where(eq(preferences.id, row.id));
    return { key: asset.storageKey, preferences: await preferenceDto(tx, scope) };
  });
  await discard(result.key);
  return result.preferences;
}
