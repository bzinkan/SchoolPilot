import {
  classpilotObservationStatus,
  type ClasspilotObservationStatus,
} from "./classpilotObservationLease.js";

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
}): Promise<ClasspilotScreenshotPolicy> {
  const now = options.now ?? Date.now();
  const serverTime = new Date(now).toISOString();
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
