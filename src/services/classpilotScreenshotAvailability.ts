import { classpilotRealtimeOrderingKey } from "./classpilotRealtimeStatus.js";

export const CLASSPILOT_SCREENSHOT_AVAILABLE_ORDERING_NAMESPACE =
  "screenshot-available";

export function classpilotScreenshotAvailableOrderingKey(
  schoolId: string,
  deviceId: string
): string {
  return `${classpilotRealtimeOrderingKey(schoolId, deviceId)}:${CLASSPILOT_SCREENSHOT_AVAILABLE_ORDERING_NAMESPACE}`;
}

export function classpilotScreenshotAvailableEvent(options: {
  studentId: string;
  capturedAt: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: "screenshot-available",
    studentId: options.studentId,
    capturedAt: options.capturedAt,
    timestamp: options.timestamp,
  };
}
