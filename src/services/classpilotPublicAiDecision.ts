import type { ClasspilotAiDecision } from "../schema/shared.js";

/**
 * The AI decision identifier is a public resource reference because the review
 * route targets it. Device, heartbeat, tenant, session, and actor bindings are
 * internal implementation details and intentionally do not appear here.
 */
export interface PublicClasspilotAiDecision {
  id: string;
  url: string | null;
  title: string | null;
  domain: string | null;
  category: string | null;
  safetyAlert: string | null;
  confidence: number | null;
  reasoning: string | null;
  matchedRule: string | null;
  actionTaken: string | null;
  teacherIntentSource: string | null;
  reviewStatus: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export function toPublicClasspilotAiDecision(
  decision: ClasspilotAiDecision
): PublicClasspilotAiDecision {
  return {
    id: decision.id,
    url: decision.url,
    title: decision.title,
    domain: decision.domain,
    category: decision.category,
    safetyAlert: decision.safetyAlert,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    matchedRule: decision.matchedRule,
    actionTaken: decision.actionTaken,
    teacherIntentSource: decision.teacherIntentSource,
    reviewStatus: decision.reviewStatus,
    reviewNote: decision.reviewNote,
    reviewedAt: decision.reviewedAt,
    createdAt: decision.createdAt,
  };
}

function canonicalMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isInternalIdentifierKey(key: string): boolean {
  const canonical = canonicalMetadataKey(key);
  const parts = canonical.split("_").filter(Boolean);
  const suffix = parts.at(-1);
  return (
    canonical === "id" ||
    suffix === "id" ||
    suffix === "ids" ||
    // Timeline producers conventionally store an acting user's identifier in
    // fields such as reviewedBy, createdBy, issuedBy, or acknowledged_by.
    suffix === "by"
  );
}

/**
 * Metadata is persisted by several older producers, so an allowlist at each
 * producer is not enough to protect already-stored rows. Recursively remove
 * identifier-shaped keys at the public API boundary, including camelCase,
 * snake_case, kebab-case, nested objects, and arrays.
 */
export function redactClasspilotInternalIdentifiers(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value
      .map((entry) => redactClasspilotInternalIdentifiers(entry))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== "object") return undefined;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isInternalIdentifierKey(key)) continue;
    const safeEntry = redactClasspilotInternalIdentifiers(entry);
    if (safeEntry !== undefined) redacted[key] = safeEntry;
  }
  return redacted;
}

export function toPublicAiDecisionTimelineMetadata(
  decision: ClasspilotAiDecision
): Record<string, unknown> {
  return {
    domain: decision.domain,
    category: decision.category,
    safetyAlert: decision.safetyAlert,
    confidence: decision.confidence,
    matchedRule: decision.matchedRule,
    actionTaken: decision.actionTaken,
    teacherIntentSource: decision.teacherIntentSource,
    reviewStatus: decision.reviewStatus,
  };
}

export function toPublicBrowserSafetyTimelineMetadata(
  classification: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const safe = {
    domain: classification?.domain ?? null,
    category: classification?.category ?? null,
    safetyAlert: classification?.safetyAlert ?? null,
    confidence: classification?.confidence ?? null,
    matchedRule: classification?.source ?? null,
    actionTaken: "close-tab",
    teacherIntentSource: classification?.teacherIntentSource ?? null,
  };
  return redactClasspilotInternalIdentifiers(safe) as Record<string, unknown>;
}

const PUBLIC_AI_TIMELINE_METADATA_KEYS = [
  "domain",
  "category",
  "safetyAlert",
  "confidence",
  "matchedRule",
  "actionTaken",
  "teacherIntentSource",
  "reviewStatus",
  "reviewNote",
  "redacted",
] as const;

export function toPublicClasspilotAiTimelineMetadata(
  metadata: unknown
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const source = metadata as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of PUBLIC_AI_TIMELINE_METADATA_KEYS) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return redactClasspilotInternalIdentifiers(safe) as Record<string, unknown>;
}

export interface PublicClasspilotTimelineEvent {
  id: string;
  eventType: string;
  sourceType: string;
  title: string;
  summary: string | null;
  severity: string | null;
  metadata: unknown;
  occurredAt: Date | string;
  persisted: boolean;
}

export function toPublicClasspilotTimelineEvent(
  event: Record<string, any>
): PublicClasspilotTimelineEvent {
  return {
    id: String(event.id),
    eventType: String(event.eventType),
    sourceType: String(event.sourceType),
    title: String(event.title),
    summary: event.summary == null ? null : String(event.summary),
    severity: event.severity == null ? null : String(event.severity),
    metadata: redactClasspilotInternalIdentifiers(event.metadata ?? {}),
    occurredAt: event.occurredAt,
    persisted: Boolean(event.persisted),
  };
}
