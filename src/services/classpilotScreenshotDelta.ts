import { createHash, timingSafeEqual } from "node:crypto";
import { DEVICE_TELEMETRY_MAX_BYTES } from "./classpilotDeviceTelemetry.js";
import { applyScreenshotDelta, MAX_SCREENSHOT_DELTA_BYTES, SCREENSHOT_DELTA_CODEC } from "./screenshotDeltaCodec.js";

export const SCREENSHOT_JPEG_DATA_URI = "data:image/jpeg;base64,";
export type ScreenshotUploadDelta = { codec: typeof SCREENSHOT_DELTA_CODEC; baseImageId: string;
  data: string; targetBytes: number; uploadIntegrity: string };
export type ScreenshotDisplayDelta = { codec: typeof SCREENSHOT_DELTA_CODEC; baseImageId: string;
  data: string; targetBytes: number; integrityTag: string };
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function base64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0
    && value.length <= Math.ceil(MAX_SCREENSHOT_DELTA_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
function shape(value: unknown, tag: "uploadIntegrity" | "integrityTag"): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === 5
    && Object.keys(value).every(key => ["codec", "baseImageId", "data", "targetBytes", tag].includes(key))
    && value.codec === SCREENSHOT_DELTA_CODEC && typeof value.baseImageId === "string" && IMAGE_ID.test(value.baseImageId)
    && base64(value.data) && typeof value.targetBytes === "number" && Number.isSafeInteger(value.targetBytes)
    && value.targetBytes >= 4 && value.targetBytes <= MAX_SCREENSHOT_DELTA_BYTES
    && typeof value[tag] === "string" && HEX.test(value[tag]);
}
export function parseScreenshotUploadDelta(value: unknown): ScreenshotUploadDelta | undefined {
  if (!shape(value, "uploadIntegrity")) return undefined;
  return { codec: SCREENSHOT_DELTA_CODEC, baseImageId: String(value.baseImageId), data: String(value.data),
    targetBytes: Number(value.targetBytes), uploadIntegrity: String(value.uploadIntegrity) };
}
export function parseScreenshotDisplayDelta(value: unknown): ScreenshotDisplayDelta | undefined {
  if (!shape(value, "integrityTag")) return undefined;
  return { codec: SCREENSHOT_DELTA_CODEC, baseImageId: String(value.baseImageId), data: String(value.data),
    targetBytes: Number(value.targetBytes), integrityTag: String(value.integrityTag) };
}
/** A compressed request must not bypass the original full logical frame bound. */
export function screenshotDeltaTargetByteLimit(payload: Record<string, unknown>): number {
  try {
    const { screenshot: _pixels, screenshotReferenceId: _reference, screenshotDelta: _delta, ...metadata } = payload;
    const metadataBytes = Buffer.byteLength(JSON.stringify({ ...metadata, screenshot: SCREENSHOT_JPEG_DATA_URI }));
    const base64Budget = DEVICE_TELEMETRY_MAX_BYTES - 16_384 - 1024 - metadataBytes;
    return Math.max(0, Math.min(MAX_SCREENSHOT_DELTA_BYTES, Math.floor(base64Budget / 4) * 3));
  } catch { return 0; }
}
function canonicalBytes(value: string): Buffer | undefined {
  if (!base64(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_SCREENSHOT_DELTA_BYTES && bytes.toString("base64") === value ? bytes : undefined;
}
function jpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes.length <= MAX_SCREENSHOT_DELTA_BYTES
    && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
}
/** Only invoke under the existing fresh upload-authority/capture fence. */
export function materializeScreenshotDelta(base: string, delta: ScreenshotUploadDelta, maxBytes: number): { screenshot: string; bytes: Buffer } | undefined {
  const checked = parseScreenshotUploadDelta(delta);
  if (!checked || !Number.isSafeInteger(maxBytes) || maxBytes < checked.targetBytes
    || !base.startsWith(SCREENSHOT_JPEG_DATA_URI)) return undefined;
  const patch = canonicalBytes(checked.data);
  if (!patch || patch.length < 12 || patch.readUInt32BE(8) !== checked.targetBytes
    || patch.length * 4 > checked.targetBytes * 3 || checked.targetBytes - patch.length < 512) return undefined;
  const previous = canonicalBytes(base.slice(SCREENSHOT_JPEG_DATA_URI.length));
  if (!previous || !jpeg(previous)) return undefined;
  try {
    const target = applyScreenshotDelta(previous, patch);
    if (target.length !== checked.targetBytes || target.length > maxBytes || !jpeg(target)) return undefined;
    const digest = createHash("sha256").update("classpilot:screenshot-delta-upload:v1\0")
      .update(checked.baseImageId).update("\0").update(target).digest();
    if (!timingSafeEqual(digest, Buffer.from(checked.uploadIntegrity, "hex"))) return undefined;
    const bytes = Buffer.from(target);
    return { bytes, screenshot: `${SCREENSHOT_JPEG_DATA_URI}${bytes.toString("base64")}` };
  } catch { return undefined; }
}
export function screenshotDeltaDisplayTag(imageId: string, bytes: Uint8Array): string {
  return createHash("sha256").update("classpilot:screenshot-delta-display:v1\0").update(imageId).update("\0").update(bytes).digest("hex");
}
export function displayScreenshotDelta(imageId: string, delta: ScreenshotUploadDelta, bytes: Uint8Array): ScreenshotDisplayDelta {
  return { codec: SCREENSHOT_DELTA_CODEC, baseImageId: delta.baseImageId, data: delta.data,
    targetBytes: delta.targetBytes, integrityTag: screenshotDeltaDisplayTag(imageId, bytes) };
}
