import { resolveClasspilotScreenshotPolicy } from "./classpilotScreenshotPolicy.js";
import type { ClasspilotScreenshotAuthorityClaim, HeartbeatTrackingSettings } from "./storage.js";

type CanonicalOptions = Parameters<typeof resolveClasspilotScreenshotPolicy>[0];

/** Browser observation uses the existing class-wide leases; Desktop has its own viewer grants. */
export async function resolveWindowsScreenshotPolicy(options: {
  schoolId: string;
  studentId: string;
  acceptedCapabilities: readonly string[];
  trackingSettings: HeartbeatTrackingSettings | undefined;
  authority: ClasspilotScreenshotAuthorityClaim;
  authorityStartedAt: Date;
  expiresAt: number;
  now?: number;
  observationStatus?: CanonicalOptions["observationStatus"];
}) {
  const startedAt = options.now ?? Date.now();
  const deadline = Math.min(options.expiresAt, startedAt + 45_000);
  const denied = () => ({
    mode: "tracking_window_lease" as const,
    captureAllowed: false,
    expiresInSeconds: 0,
    serverTime: new Date(options.now ?? Date.now()).toISOString(),
    authority: options.authority,
    captureCadence: { mode: "background" as const, intervalSeconds: 30 as const, expiresInSeconds: 0 },
  });
  // Never negotiate the legacy unrestricted image path if a school's tracking
  // capability is disabled, or prolong a guard/class/hours/entitlement deadline.
  if (!options.acceptedCapabilities.includes("screenshotTrackingWindowLeaseV1") || deadline <= startedAt) return denied();
  const policy = await resolveClasspilotScreenshotPolicy({
    schoolId: options.schoolId,
    studentId: options.studentId,
    teachingSessionId: options.authority.kind === "teaching_session" ? options.authority.teachingSessionId : null,
    acceptedCapabilities: options.acceptedCapabilities,
    trackingSettings: options.trackingSettings,
    trackingAuthority: {
      authority: options.authority,
      authorityStartedAt: options.authorityStartedAt,
      authorityExpiresAt: new Date(deadline),
    },
    now: startedAt,
    observationStatus: options.observationStatus,
  });
  if (policy.mode !== "tracking_window_lease" || !policy.captureAllowed) return denied();
  const completedAt = options.now ?? Date.now();
  const seconds = Math.max(0, Math.min(policy.expiresInSeconds, Math.floor((deadline - completedAt) / 1000)));
  if (seconds === 0) return denied();
  const cadence = policy.captureCadence ?? { mode: "background" as const, intervalSeconds: 30 as const, expiresInSeconds: seconds };
  return { ...policy, authority: options.authority, expiresInSeconds: seconds,
    serverTime: new Date(completedAt).toISOString(),
    captureCadence: { ...cadence, expiresInSeconds: Math.min(seconds, cadence.expiresInSeconds) } };
}
