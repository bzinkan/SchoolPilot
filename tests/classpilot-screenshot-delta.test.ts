import assert from "node:assert/strict";
import test from "node:test";
import { parseScreenshotImageRequest } from "../src/services/classpilotScreenshotImageRequest.js";
import { SCREENSHOT_JPEG_DATA_URI, parseScreenshotUploadDelta, parseScreenshotDisplayDelta,
  screenshotDeltaTargetByteLimit, materializeScreenshotDelta, displayScreenshotDelta,
} from "../src/services/classpilotScreenshotDelta.js";

const baseImageId = "12345678-1234-4234-8234-123456789abc";
const targetImageId = "98765432-9876-4876-8876-987654321abc";
const base = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251));
base[0] = 255; base[1] = 216; base[1022] = 255; base[1023] = 217;
const target = Buffer.from(base); target[500] = 233;
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const patch = Buffer.concat([Buffer.from("CPD1"), u32(1024), u32(1024), Buffer.from([1]), u32(0), u32(500),
  Buffer.from([0]), u32(1), Buffer.from([233]), Buffer.from([1]), u32(501 * 8), u32(523)]);
const descriptor = { codec: "cp-bit-copy-v1" as const, baseImageId, data: patch.toString("base64"), targetBytes: 1024,
  uploadIntegrity: "b5770fcc061ca57e5b2180e24caa68b1b6a8523b1dddc1bc0b09e5ca026b3f18" };
const baseUri = `${SCREENSHOT_JPEG_DATA_URI}${base.toString("base64")}`;

test("deltas are separately negotiated and never combine with a full/reference/safety image", () => {
  const payload = { screenshotImageProtocolVersion: 1, screenshotDelta: descriptor };
  assert.deepEqual(parseScreenshotImageRequest(payload, true, true), { mode: "delta", delta: descriptor });
  assert.deepEqual(parseScreenshotImageRequest(payload, true, false), { mode: "need_full_frame" });
  assert.deepEqual(parseScreenshotImageRequest(payload, false, true), { mode: "need_full_frame" });
  for (const conflict of [{ screenshot: "pixels" }, { screenshotReferenceId: baseImageId }, { captureKind: "safety_evidence" }]) {
    assert.deepEqual(parseScreenshotImageRequest({ ...payload, ...conflict }, true, true), { mode: "invalid" });
  }
});

test("a validated student patch reconstructs the exact canonical JPEG bytes with upload integrity", () => {
  assert.deepEqual(parseScreenshotUploadDelta(descriptor), descriptor);
  const result = materializeScreenshotDelta(baseUri, descriptor, 1024);
  assert.ok(result);
  assert.deepEqual(result.bytes, target);
  assert.equal(result.screenshot, `${SCREENSHOT_JPEG_DATA_URI}${target.toString("base64")}`);
});

test("unknown formats, fields, malformed Base64 and unbounded declarations are not decoded", () => {
  for (const invalid of [null, [], { ...descriptor, codec: "unknown" }, { ...descriptor, data: "!bad" },
    { ...descriptor, targetBytes: 262145 }, { ...descriptor, targetBytes: 3 }, { ...descriptor, baseImageId: "hash" },
    { ...descriptor, uploadIntegrity: "raw secret" }, { ...descriptor, deviceId: "private" }]) {
    assert.equal(parseScreenshotUploadDelta(invalid), undefined);
  }
});

test("wrong upload integrity, wrong scope base, non-JPEG images and oversized reconstruction require a full frame", () => {
  assert.equal(materializeScreenshotDelta(baseUri, { ...descriptor, uploadIntegrity: "0".repeat(64) }, 1024), undefined);
  assert.equal(materializeScreenshotDelta(baseUri, { ...descriptor, baseImageId: targetImageId }, 1024), undefined);
  assert.equal(materializeScreenshotDelta(baseUri.replace("jpeg", "png"), descriptor, 1024), undefined);
  assert.equal(materializeScreenshotDelta(`${baseUri}=`, descriptor, 1024), undefined);
  assert.equal(materializeScreenshotDelta(baseUri, descriptor, 1023), undefined);
  const malformed = Buffer.from(patch); malformed[0] = 0;
  assert.equal(materializeScreenshotDelta(baseUri, { ...descriptor, data: malformed.toString("base64") }, 1024), undefined);
});

test("unprofitable patches cannot consume the one retained delta slot", () => {
  const literal = Buffer.concat([Buffer.from("CPD1"), u32(1024), u32(1024), Buffer.from([0]), u32(1024), target]);
  assert.equal(materializeScreenshotDelta(baseUri, { ...descriptor, data: literal.toString("base64") }, 1024), undefined);
});

test("logical full-image limits include metadata, Base64, JWT reserve and envelope rather than compressed wire size", () => {
  assert.equal(screenshotDeltaTargetByteLimit({}), 183522);
  const payload = { tabTitle: "😀".repeat(200), tabUrl: "https://example.invalid/lesson", screenshotDelta: descriptor,
    screenshotImageProtocolVersion: 1, telemetryOperationId: "12345678-1234-4234-8234-123456789abc" };
  const limit = screenshotDeltaTargetByteLimit(payload);
  assert.ok(limit > 0 && limit < 183522);
  const { screenshotDelta: _delta, ...metadata } = payload;
  const full = { ...metadata, screenshot: `${SCREENSHOT_JPEG_DATA_URI}${Buffer.alloc(limit).toString("base64")}` };
  assert.ok(Buffer.byteLength(JSON.stringify(full)) + 16384 + 1024 <= 262144);
  assert.equal(screenshotDeltaTargetByteLimit({ tabTitle: "x".repeat(262144) }), 0);
});

test("public display integrity is target-ID scoped and never exposes upload integrity or a private global hash", () => {
  const display = displayScreenshotDelta(targetImageId, descriptor, target);
  assert.deepEqual(display, { codec: "cp-bit-copy-v1", baseImageId, data: descriptor.data, targetBytes: 1024,
    integrityTag: "8332727323a68d66d1da9b74c2921e2bef89591cb3b80171b2312878747b4ee6" });
  assert.deepEqual(parseScreenshotDisplayDelta(display), display);
  assert.notEqual(displayScreenshotDelta(baseImageId, descriptor, target).integrityTag, display.integrityTag);
  assert.equal(parseScreenshotDisplayDelta({ ...display, uploadIntegrity: descriptor.uploadIntegrity }), undefined);
  assert.equal(parseScreenshotDisplayDelta({ ...display, integrityTag: "invalid" }), undefined);
});
