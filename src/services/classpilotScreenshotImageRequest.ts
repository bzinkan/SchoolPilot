import { parseScreenshotUploadDelta, type ScreenshotUploadDelta } from "./classpilotScreenshotDelta.js";

export type ScreenshotImageRequest =
  | { mode: "full"; screenshot: string; referenceProtocol: boolean }
  | { mode: "reference"; imageId: string }
  | { mode: "delta"; delta: ScreenshotUploadDelta }
  | { mode: "need_full_frame" }
  | { mode: "invalid" };

export function uploadedScreenshotPixelBytes(screenshot: unknown): number {
  return typeof screenshot === "string" ? Buffer.byteLength(screenshot, "utf8") : 0;
}

/** Selection only: canonical authority and capture-time checks still precede storage. */
export function parseScreenshotImageRequest(payload: Record<string, unknown>, negotiated: boolean, deltaNegotiated = false): ScreenshotImageRequest {
  if (payload.screenshotDelta !== undefined) {
    if (payload.captureKind === "safety_evidence" || payload.screenshot !== undefined || payload.screenshotReferenceId !== undefined) return { mode: "invalid" };
    if (!negotiated || !deltaNegotiated || payload.screenshotImageProtocolVersion !== 1) return { mode: "need_full_frame" };
    const delta = parseScreenshotUploadDelta(payload.screenshotDelta);
    return delta ? { mode: "delta", delta } : { mode: "need_full_frame" };
  }
  const reference = payload.screenshotReferenceId;
  if (reference !== undefined) {
    if (payload.captureKind === "safety_evidence" || payload.screenshot !== undefined
      || typeof reference !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(reference)) return { mode: "invalid" };
    if (!negotiated || payload.screenshotImageProtocolVersion !== 1) return { mode: "need_full_frame" };
    return { mode: "reference", imageId: reference };
  }
  if (typeof payload.screenshot !== "string" || !payload.screenshot) return { mode: "invalid" };
  return { mode: "full", screenshot: payload.screenshot,
    referenceProtocol: negotiated && payload.screenshotImageProtocolVersion === 1 && payload.captureKind !== "safety_evidence" };
}
