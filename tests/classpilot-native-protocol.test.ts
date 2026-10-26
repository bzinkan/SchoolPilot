import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import sharp from "sharp";
import { createNativeCredential, parseNativeCredential, nativeHashMatches, nativeVisibilityEnabled,
  nativeLeaseSchema, nativeTileSchema, nativeObservationSchema, nativeCaptureTimestampValid, NATIVE_LIMITS } from "../src/services/classpilotNativeProtocol.js";
import { normalizeClasspilotNativeJpeg } from "../src/services/classpilotNativeImage.js";

test("native gate is default-off and malformed pilot configuration never broadens scope", () => {
  assert.equal(nativeVisibilityEnabled("school-a", {}), false);
  for (const mode of ["true", "ON", "pilot", " off", ""]) {
    assert.equal(nativeVisibilityEnabled("school-a", { CLASSPILOT_NATIVE_VISIBILITY_MODE: mode, CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS: "school-a" }), false);
  }
  for (const ids of ["", "school-a,", "school-a,*", "school-a,school/b"]) {
    assert.equal(nativeVisibilityEnabled("school-a", { CLASSPILOT_NATIVE_VISIBILITY_MODE: "on", CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS: ids }), false);
  }
  const env = { CLASSPILOT_NATIVE_VISIBILITY_MODE: "on", CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS: "school-a, school-b" };
  assert.equal(nativeVisibilityEnabled("school-a", env), true); assert.equal(nativeVisibilityEnabled("school-c", env), false);
});

test("native credentials are random, purpose separated, and hash the complete routed token", () => {
  for (const kind of ["enroll", "install", "session"] as const) {
    const credential = createNativeCredential(kind, "school-a");
    assert.deepEqual(parseNativeCredential(credential.credential, kind), { kind, schoolId: "school-a", id: credential.id, tokenHash: credential.tokenHash });
    assert.equal(nativeHashMatches(credential.tokenHash, credential.tokenHash), true);
    assert.equal(nativeHashMatches(credential.tokenHash, "f".repeat(64)), false);
    assert.equal(nativeHashMatches(credential.tokenHash, "x"), false);
    assert.notEqual(createNativeCredential(kind, "school-a").credential, credential.credential);
    for (const other of ["enroll", "install", "session"] as const) if (other !== kind) assert.throws(() => parseNativeCredential(credential.credential, other));
    const routed = credential.credential.replace(Buffer.from("school-a").toString("base64url"), Buffer.from("school-b").toString("base64url"));
    assert.notEqual(parseNativeCredential(routed, kind).tokenHash, credential.tokenHash);
  }
  assert.throws(() => parseNativeCredential("eyJhbGciOiJIUzI1NiJ9.payload.signature", "session"));
});

test("teacher targets cannot silently become class-wide, omit authority, or inject device identities", () => {
  const target = { studentId: "student-a", sourceRef: randomUUID(), bindingRevision: 1 };
  assert.equal(nativeLeaseSchema.safeParse({ teachingSessionId: "class-a", targets: [target] }).success, true);
  for (const value of [ { targets: [target] }, { teachingSessionId: "a", targets: [] },
    { teachingSessionId: "a", supervisionContextId: "b", targets: [target] },
    { teachingSessionId: "a", targets: [target, target] },
    { teachingSessionId: "a", targets: [{ ...target, deviceId: "device" }] } ]) assert.equal(nativeLeaseSchema.safeParse(value).success, false);
  assert.equal(nativeTileSchema.safeParse({ teachingSessionId: "a", studentIds: ["student-a"], selectedSources: [target] }).success, false);
  assert.equal(nativeTileSchema.safeParse({ teachingSessionId: "a", studentIds: ["different"], viewerInstanceId: randomUUID(), selectedSources: [target] }).success, false);
});

test("observation metadata excludes titles, command lines and executable paths", () => {
  const metadata = { grantId: randomUUID(), sourceGeneration: randomUUID(), sequence: 1, capturedAt: new Date().toISOString(), foregroundApplication: null };
  assert.equal(nativeObservationSchema.safeParse(metadata).success, true);
  for (const extra of [{ windowTitle: "Document" }, { commandLine: "secret" }, { deviceId: "other" }]) {
    assert.equal(nativeObservationSchema.safeParse({ ...metadata, ...extra }).success, false);
  }
  assert.equal(nativeObservationSchema.safeParse({ ...metadata, sequence: 0 }).success, false);
  assert.equal(nativeObservationSchema.safeParse({ ...metadata, foregroundApplication: { id: "C:\\app.exe", displayName: "App", observedAt: metadata.capturedAt } }).success, false);
});

test("Windows foreground metadata and DateTimeOffset serialization match the native wire contract", () => {
  // Shared verbatim with ClassPilotDesktop/fixtures/native-observation.json.
  const metadata = JSON.parse(readFileSync(new URL("fixtures/native-observation.json", import.meta.url), "utf8"));
  assert.equal(nativeObservationSchema.safeParse(metadata).success, true);
  assert.equal(nativeObservationSchema.safeParse({ ...metadata, foregroundApplication: {
    ...metadata.foregroundApplication, id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", displayName: "A".repeat(80),
  } }).success, true);
  for (const change of [{ id: "win32:syntheticcontent" }, { displayName: "A".repeat(81) }]) {
    assert.equal(nativeObservationSchema.safeParse({ ...metadata, foregroundApplication: { ...metadata.foregroundApplication, ...change } }).success, false);
  }
});

test("capture timestamps must lie within grant and bounded arrival window", () => {
  const start = Date.parse("2026-10-26T12:00:00Z");
  const at = (delta: number) => new Date(start + delta).toISOString();
  assert.equal(nativeCaptureTimestampValid(at(1000), start, start + 45_000, start + 4000), true);
  assert.equal(nativeCaptureTimestampValid(at(-1), start, start + 45_000, start + 100), false);
  assert.equal(nativeCaptureTimestampValid(at(0), start, start + 45_000, start + 5001), false);
  assert.equal(nativeCaptureTimestampValid(at(44_999), start, start + 45_000, start + 45_000), false);
  assert.equal(nativeCaptureTimestampValid(at(9000), start, start + 45_000, start + 1000), false);
});

test("native JPEG normalization decodes dimensions, strips metadata and rejects corrupt/oversized/foreign formats", async () => {
  const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#123456" } }).withMetadata().jpeg().toBuffer();
  const normalized = await normalizeClasspilotNativeJpeg(image);
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, "jpeg"); assert.equal(metadata.width, 640); assert.equal(metadata.exif, undefined);
  await assert.rejects(normalizeClasspilotNativeJpeg(Buffer.from("fake jpeg")));
  await assert.rejects(normalizeClasspilotNativeJpeg(Buffer.alloc(NATIVE_LIMITS.maxBytes + 1)));
  await assert.rejects(normalizeClasspilotNativeJpeg(await sharp({ create: { width: 1281, height: 10, channels: 3, background: "red" } }).jpeg().toBuffer()));
  await assert.rejects(normalizeClasspilotNativeJpeg(await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer()));
  await assert.rejects(normalizeClasspilotNativeJpeg(image.subarray(0, Math.floor(image.length / 2))));
});
