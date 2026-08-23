import {
  screenshotMatchesBinding,
  type ScreenshotBinding,
  type ScreenshotData,
} from "../realtime/ws-redis.js";

export type ClasspilotSafetyEvidenceSelection =
  | { available: true; screenshot: ScreenshotData; unavailableReason: null }
  | {
      available: false;
      screenshot: null;
      unavailableReason:
        | "exact_binding_unavailable"
        | "tab_mismatch"
        | "capture_precedes_alert_window";
    };

const SAFETY_EVIDENCE_LOOKBACK_MS = 30_000;

/**
 * A recent screenshot is evidence for a browser alert only when it belongs to
 * the exact authenticated tuple and depicts the exact classified tab. A nearby
 * image from another tab is not silently attached to the case.
 */
export function selectClasspilotSafetyEvidence(options: {
  screenshot: ScreenshotData | null;
  binding: ScreenshotBinding;
  classifiedUrl: string;
  observedAt: number;
}): ClasspilotSafetyEvidenceSelection {
  if (!screenshotMatchesBinding(options.screenshot, options.binding, { allowLegacy: true })) {
    return {
      available: false,
      screenshot: null,
      unavailableReason: "exact_binding_unavailable",
    };
  }
  const screenshot = options.screenshot!;
  if (screenshot.tabUrl !== options.classifiedUrl) {
    return { available: false, screenshot: null, unavailableReason: "tab_mismatch" };
  }
  if (screenshot.timestamp < options.observedAt - SAFETY_EVIDENCE_LOOKBACK_MS) {
    return {
      available: false,
      screenshot: null,
      unavailableReason: "capture_precedes_alert_window",
    };
  }
  return { available: true, screenshot, unavailableReason: null };
}
