import {
  classpilotObservationStatus,
  type ClasspilotObservationStatus,
} from "./classpilotObservationLease.js";
import { isWithinTrackingWindow } from "./schoolHours.js";
import type {
  ClasspilotScreenshotAuthorityClaim,
  ClasspilotScreenshotAuthorityProjection,
  HeartbeatTrackingSettings,
} from "./storage.js";

export const CLASSPILOT_SCREENSHOT_TRACKING_LEASE_SECONDS = 90;
export const CLASSPILOT_SCREENSHOT_CAPTURE_FUTURE_SKEW_MS = 30_000;

export type ClasspilotScreenshotPolicy =
  | {
      mode: "legacy";
      observed: true;
      expiresInSeconds: 0;
      serverTime: string;
    }
  | {
      mode: "lease";
      observed: boolean;
      expiresInSeconds: number;
      serverTime: string;
      diagnostic?: "unavailable";
    }
  | {
      mode: "tracking_window_lease";
      captureAllowed: boolean;
      expiresInSeconds: number;
      serverTime: string;
      authority: ClasspilotScreenshotAuthorityClaim;
      diagnostic?: "unavailable";
    };

type ObservationStatusLoader = (options: {
  schoolId: string;
  teachingSessionId: string | null | undefined;
  studentId: string;
  now?: number;
}) => Promise<ClasspilotObservationStatus>;

/**
 * Resolve the screenshot policy presented by every authenticated extension
 * transport. Lease-capable clients fail private when the shared observation
 * store cannot be read; legacy clients retain their negotiated compatibility
 * behavior during the staged rollout.
 */
export async function resolveClasspilotScreenshotPolicy(options: {
  schoolId: string;
  studentId: string;
  teachingSessionId: string | null | undefined;
  acceptedCapabilities: readonly string[];
  now?: number;
  observationStatus?: ObservationStatusLoader;
  trackingSettings?: HeartbeatTrackingSettings;
  trackingAuthority?: ClasspilotScreenshotAuthorityProjection;
}): Promise<ClasspilotScreenshotPolicy> {
  const now = options.now ?? Date.now();
  const serverTime = new Date(now).toISOString();
  if (options.acceptedCapabilities.includes("screenshotTrackingWindowLeaseV1")) {
    return resolveClasspilotScreenshotTrackingWindowPolicy({
      trackingSettings: options.trackingSettings,
      trackingAuthority: options.trackingAuthority,
      now,
    });
  }
  if (!options.acceptedCapabilities.includes("screenshotObservationLeaseV1")) {
    return {
      mode: "legacy",
      observed: true,
      expiresInSeconds: 0,
      serverTime,
    };
  }

  try {
    const status = await (options.observationStatus ?? classpilotObservationStatus)({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentId: options.studentId,
      now,
    });
    return {
      mode: "lease",
      observed: status.status === "observed",
      expiresInSeconds: status.expiresInSeconds,
      serverTime,
      ...(status.status === "unavailable"
        ? { diagnostic: "unavailable" as const }
        : {}),
    };
  } catch {
    return {
      mode: "lease",
      observed: false,
      expiresInSeconds: 0,
      serverTime,
      diagnostic: "unavailable",
    };
  }
}

function trackingWindowCaptureAllowed(
  settings: HeartbeatTrackingSettings,
  at: Date
): boolean {
  return isWithinTrackingWindow(settings, at)
    || (settings.afterHoursMode ?? "off") !== "off";
}

function trackingWindowLeaseEnd(
  settings: HeartbeatTrackingSettings,
  now: number,
  maximumEnd: number
): number {
  if ((settings.afterHoursMode ?? "off") !== "off") return maximumEnd;
  if (trackingWindowCaptureAllowed(settings, new Date(maximumEnd))) return maximumEnd;

  // The rolling lease is at most 90 seconds, so a small binary search finds the
  // exact predicate transition without introducing a second timezone/DST model.
  let allowed = now;
  let denied = maximumEnd;
  for (let iteration = 0; iteration < 20 && denied - allowed > 1; iteration += 1) {
    const candidate = Math.floor((allowed + denied) / 2);
    if (trackingWindowCaptureAllowed(settings, new Date(candidate))) {
      allowed = candidate;
    } else {
      denied = candidate;
    }
  }
  return denied;
}

export function resolveClasspilotScreenshotTrackingWindowPolicy(options: {
  trackingSettings?: HeartbeatTrackingSettings;
  trackingAuthority?: ClasspilotScreenshotAuthorityProjection;
  now?: number;
}): Extract<ClasspilotScreenshotPolicy, { mode: "tracking_window_lease" }> {
  const now = options.now ?? Date.now();
  const serverTime = new Date(now).toISOString();
  const fallbackAuthority: ClasspilotScreenshotAuthorityClaim = {
    kind: "student_session",
    controlRevision: 0,
  };
  if (!options.trackingSettings || !options.trackingAuthority) {
    return {
      mode: "tracking_window_lease",
      captureAllowed: false,
      expiresInSeconds: 0,
      serverTime,
      authority: options.trackingAuthority?.authority ?? fallbackAuthority,
      diagnostic: "unavailable",
    };
  }

  const { trackingSettings, trackingAuthority } = options;
  if (
    trackingAuthority.authorityStartedAt.getTime() > now
    || !trackingWindowCaptureAllowed(trackingSettings, new Date(now))
  ) {
    return {
      mode: "tracking_window_lease",
      captureAllowed: false,
      expiresInSeconds: 0,
      serverTime,
      authority: trackingAuthority.authority,
    };
  }

  const rollingEnd = now + CLASSPILOT_SCREENSHOT_TRACKING_LEASE_SECONDS * 1_000;
  let leaseEnd = trackingWindowLeaseEnd(trackingSettings, now, rollingEnd);
  const authorityEnd = trackingAuthority.authorityExpiresAt?.getTime();
  if (authorityEnd !== undefined && Number.isFinite(authorityEnd)) {
    leaseEnd = Math.min(leaseEnd, authorityEnd);
  }
  const expiresInSeconds = Math.min(
    CLASSPILOT_SCREENSHOT_TRACKING_LEASE_SECONDS,
    Math.max(0, Math.floor((leaseEnd - now) / 1_000))
  );
  return {
    mode: "tracking_window_lease",
    captureAllowed: expiresInSeconds > 0,
    expiresInSeconds,
    serverTime,
    authority: trackingAuthority.authority,
  };
}

export function parseClasspilotScreenshotAuthority(
  value: unknown
): ClasspilotScreenshotAuthorityClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.controlRevision !== "number"
    || !Number.isSafeInteger(candidate.controlRevision)
    || candidate.controlRevision < 0
  ) return null;
  const controlRevision = candidate.controlRevision;
  if (candidate.kind === "student_session") {
    const keys = Object.keys(candidate);
    if (keys.some((key) => key !== "kind" && key !== "controlRevision")) return null;
    return { kind: "student_session", controlRevision };
  }
  if (candidate.kind === "teaching_session") {
    const teachingSessionId = typeof candidate.teachingSessionId === "string"
      ? candidate.teachingSessionId.trim()
      : "";
    const keys = Object.keys(candidate);
    if (
      !teachingSessionId
      || teachingSessionId !== candidate.teachingSessionId
      || teachingSessionId.length > 200
      || keys.some((key) =>
        key !== "kind" && key !== "teachingSessionId" && key !== "controlRevision"
      )
    ) return null;
    return { kind: "teaching_session", teachingSessionId, controlRevision };
  }
  return null;
}

export type ClasspilotScreenshotCapturedAtValidation =
  | "ok"
  | "expired"
  | "future"
  | "before_authority"
  | "outside_tracking_window"
  | "after_authority";

export function validateClasspilotScreenshotCapturedAt(options: {
  capturedAt: Date;
  now?: number;
  trackingSettings: HeartbeatTrackingSettings;
  trackingAuthority: ClasspilotScreenshotAuthorityProjection;
}): ClasspilotScreenshotCapturedAtValidation {
  const now = options.now ?? Date.now();
  const capturedAt = options.capturedAt.getTime();
  if (capturedAt > now + CLASSPILOT_SCREENSHOT_CAPTURE_FUTURE_SKEW_MS) return "future";
  if (capturedAt < now - CLASSPILOT_SCREENSHOT_TRACKING_LEASE_SECONDS * 1_000) {
    return "expired";
  }
  if (capturedAt < options.trackingAuthority.authorityStartedAt.getTime()) {
    return "before_authority";
  }
  const authorityEnd = options.trackingAuthority.authorityExpiresAt?.getTime();
  if (authorityEnd !== undefined && capturedAt >= authorityEnd) return "after_authority";
  if (!trackingWindowCaptureAllowed(options.trackingSettings, options.capturedAt)) {
    return "outside_tracking_window";
  }
  return "ok";
}
