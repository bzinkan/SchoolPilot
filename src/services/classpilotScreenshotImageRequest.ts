export type ScreenshotImageRequest =
  | { mode: "full"; screenshot: string; referenceProtocol: boolean }
  | { mode: "reference"; imageId: string }
  | { mode: "need_full_frame" }
  | { mode: "invalid" };

export function uploadedScreenshotPixelBytes(screenshot: unknown): number {
  return typeof screenshot === "string" ? Buffer.byteLength(screenshot, "utf8") : 0;
}

/** Selection only: canonical authority and capture-time checks still precede storage. */
export function parseScreenshotImageRequest(payload: Record<string, unknown>, negotiated: boolean): ScreenshotImageRequest {
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
