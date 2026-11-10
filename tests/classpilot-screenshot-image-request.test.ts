import assert from "node:assert/strict";
import test from "node:test";
import { parseScreenshotImageRequest, uploadedScreenshotPixelBytes } from "../src/services/classpilotScreenshotImageRequest.js";

test("image references are separately negotiated and cannot replace safety evidence", () => {
  const reference = { screenshotImageProtocolVersion: 1, screenshotReferenceId: "opaque-image-reference-123" };
  assert.deepEqual(parseScreenshotImageRequest(reference, true), { mode: "reference", imageId: reference.screenshotReferenceId });
  assert.deepEqual(parseScreenshotImageRequest(reference, false), { mode: "need_full_frame" });
  assert.deepEqual(parseScreenshotImageRequest({ ...reference, captureKind: "safety_evidence" }, true), { mode: "invalid" });
  assert.deepEqual(parseScreenshotImageRequest({ ...reference, screenshot: "pixels" }, true), { mode: "invalid" });
  assert.deepEqual(parseScreenshotImageRequest({ ...reference, screenshotReferenceId: "" }, true), { mode: "invalid" });
});
test("old and unsupported full-image clients retain their exact original bytes", () => {
  assert.deepEqual(parseScreenshotImageRequest({ screenshot: "original" }, true), { mode: "full", screenshot: "original", referenceProtocol: false });
  assert.deepEqual(parseScreenshotImageRequest({ screenshot: "original", screenshotImageProtocolVersion: 1 }, false),
    { mode: "full", screenshot: "original", referenceProtocol: false });
  assert.deepEqual(parseScreenshotImageRequest({ screenshot: "original", screenshotImageProtocolVersion: 1 }, true),
    { mode: "full", screenshot: "original", referenceProtocol: true });
});
test("reference-only and discarded recaptures count zero uploaded pixel bytes", () => {
  assert.equal(uploadedScreenshotPixelBytes(undefined), 0);
  assert.equal(uploadedScreenshotPixelBytes(null), 0);
  assert.equal(uploadedScreenshotPixelBytes("pixels"), Buffer.byteLength("pixels"));
});
