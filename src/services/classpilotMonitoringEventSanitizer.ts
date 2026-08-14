export const CLASSPILOT_MONITORING_EVENT_TYPES = new Set([
  "tab_changed",
  "navigation_changed",
  "navigation_blocked",
  "monitoring_state_changed",
  "restriction_state_applied",
  "restriction_state_failed",
  "restriction_state_cleared",
  "student_session_started",
  "student_session_ended",
  "monitoring_gap",
] as const);

export const EXTENSION_MONITORING_EVENT_TYPES = new Set([
  "tab_changed",
  "navigation_changed",
  "navigation_blocked",
  "monitoring_state_changed",
  "restriction_state_applied",
  "restriction_state_failed",
  "restriction_state_cleared",
] as const);

const METADATA_KEYS: Record<string, ReadonlySet<string>> = {
  navigation_blocked: new Set(["policySource", "ruleId"]),
  monitoring_state_changed: new Set(["state", "reason"]),
  restriction_state_applied: new Set(["restrictionType", "revision", "outcome"]),
  restriction_state_failed: new Set(["restrictionType", "revision", "outcome", "errorCode"]),
  restriction_state_cleared: new Set(["restrictionType", "revision", "outcome"]),
};

const NAVIGATION_POLICY_SOURCES = new Set([
  "school",
  "teacher",
  "flight_path",
  "screen_lock",
  "attention_mode",
  "tab_limit",
]);

export type SanitizedMonitoringEvent = {
  sourceEventId: string;
  schemaVersion: 1;
  eventType: string;
  occurredAt: Date;
  normalizedDomain: string | null;
  sanitizedPath: string | null;
  title: string | null;
  metadata: Record<string, string | number | boolean>;
};

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

export function sanitizeMonitoringUrl(value: unknown): {
  normalizedDomain: string | null;
  sanitizedPath: string | null;
} {
  if (typeof value !== "string" || value.length > 8_192) {
    return { normalizedDomain: null, sanitizedPath: null };
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return { normalizedDomain: null, sanitizedPath: null };
    const normalizedDomain = url.hostname.toLowerCase().replace(/^www\./, "").slice(0, 253) || null;
    let path = url.pathname || "/";
    path = path.replace(/\/{2,}/g, "/");
    const segments = path.split("/").map((segment) => {
      try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return encodeURIComponent(segment); }
    });
    path = segments.join("/").slice(0, 1_024) || "/";
    return { normalizedDomain, sanitizedPath: path };
  } catch {
    return { normalizedDomain: null, sanitizedPath: null };
  }
}

export function sanitizeExtensionMonitoringEvent(
  value: unknown,
  now = new Date()
): SanitizedMonitoringEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  const sourceEventId = boundedText(raw.sourceEventId, 128);
  const eventType = boundedText(raw.type ?? raw.eventType, 64);
  if (!sourceEventId || !eventType || !EXTENSION_MONITORING_EVENT_TYPES.has(eventType as any)) return null;
  const occurredAt = new Date(String(raw.occurredAt || ""));
  if (!Number.isFinite(occurredAt.getTime())) return null;
  // Reject replay-future timestamps and events older than the maximum possible
  // retention window. The extension outbox may legitimately retry for days.
  if (occurredAt.getTime() > now.getTime() + 5 * 60_000) return null;
  if (occurredAt.getTime() < now.getTime() - 366 * 24 * 60 * 60 * 1000) return null;
  const { normalizedDomain, sanitizedPath } = sanitizeMonitoringUrl(raw.url);
  const metadata: Record<string, string | number | boolean> = {};
  const rawMetadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown>
    : {};
  for (const key of METADATA_KEYS[eventType] || []) {
    const item = rawMetadata[key];
    if (typeof item === "boolean") metadata[key] = item;
    if (typeof item === "number" && Number.isFinite(item)) metadata[key] = Math.trunc(item);
    if (typeof item === "string") {
      const sanitized = boundedText(item, key === "errorCode" ? 64 : 128);
      if (sanitized && (key !== "policySource" || NAVIGATION_POLICY_SOURCES.has(sanitized))) {
        metadata[key] = sanitized;
      }
    }
  }
  if (eventType === "navigation_blocked" && !metadata.policySource) return null;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 2_048) return null;
  return {
    sourceEventId,
    schemaVersion: 1,
    eventType,
    occurredAt,
    normalizedDomain,
    sanitizedPath,
    title: boundedText(raw.title, 256),
    metadata,
  };
}
