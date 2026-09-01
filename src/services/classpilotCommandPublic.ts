import { classpilotCommandDeliveryPolicy } from "./classpilotCommandDelivery.js";

function isInternalTargetKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return normalized.includes("deviceid")
    || normalized.includes("studentsessionid")
    || normalized.includes("frozencontrolrevision")
    || normalized.includes("exacttabcloseversion");
}

function stripInternalTargetIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripInternalTargetIdentifiers);
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }

  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isInternalTargetKey(key)) continue;
    safe[key] = stripInternalTargetIdentifiers(entry);
  }
  return safe;
}

/**
 * Serialize a command for staff-facing HTTP and WebSocket contracts. Device
 * and authenticated student-session identifiers are internal routing details;
 * staff controls and status updates are keyed by the frozen roster student id.
 */
export function publicClasspilotCommand(command: any): Record<string, any> {
  const safe = stripInternalTargetIdentifiers(command);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return {};
  const result = safe as Record<string, any>;
  if (typeof result.commandType === "string") {
    result.deliveryPolicy = result.commandType === "lock-screen"
      && result.commandPayload?.currentPage === true
      ? "transient_action"
      : classpilotCommandDeliveryPolicy(result.commandType);
  }
  return result;
}
