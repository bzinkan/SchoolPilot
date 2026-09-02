import { domainMatches, type AiClassification } from "./aiClassification.js";
import type {
  ClasspilotRealtimeMutationResult,
  ClasspilotRealtimeStatus,
} from "./classpilotRealtimeStatus.js";
import { classpilotExactTabCloseVersion } from "./classpilotExactTabCapability.js";

const SAFETY_ALERT_LABELS: Record<NonNullable<AiClassification["safetyAlert"]>, string> = {
  "self-harm": "Self-harm",
  violence: "Violence",
  sexual: "Sexual content",
  drugs: "Drugs",
};

function isSearchClassification(
  classification: Pick<AiClassification, "domain" | "source">
): boolean {
  return classification.source === "search"
    || String(classification.domain || "").startsWith("search:");
}

/**
 * School Allowed Domains (plus an active Flight Path's allowed domains) exempt
 * a page from every AI safety side effect. Search-query hits are never exempt:
 * an allow-list entry describes a site, not what a student types into it.
 */
export function isClasspilotSafetyExempt(options: {
  url: string;
  classification: Pick<AiClassification, "domain" | "source">;
  allowedDomains: readonly string[];
}): boolean {
  if (isSearchClassification(options.classification)) return false;
  if (!options.allowedDomains.length) return false;
  let hostname: string;
  try {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (!hostname) return false;
  for (const entry of options.allowedDomains) {
    if (domainMatches(hostname, entry)) return true;
  }
  return false;
}

/**
 * One-line, teacher-facing reason built only from URL-derived labels
 * (never page content), e.g. `Self-harm search: "commit suicide"`.
 */
export function describeClasspilotSafetyReason(
  classification: Pick<AiClassification, "safetyAlert" | "domain" | "matchedTerm" | "source">
): string | null {
  if (!classification.safetyAlert) return null;
  const label = SAFETY_ALERT_LABELS[classification.safetyAlert];
  if (isSearchClassification(classification)) {
    const term = classification.matchedTerm
      || String(classification.domain || "").replace(/^search:/, "");
    return term ? `${label} search: "${term}"` : `${label} search`;
  }
  const site = classification.matchedTerm || classification.domain;
  return site ? `${label}: ${site}` : label;
}

export type ClasspilotSafetyAction = {
  snapshot: ClasspilotRealtimeStatus;
  classifiedUrl: string;
  classifiedTitle: string;
  teachingSessionId: string | null;
  exactTabCloseVersion: 1 | 2 | null;
  closeTabData:
    | { tabRefs: [string]; snapshotRevision: number }
    | { specificUrls: [string] }
    | null;
  evidenceTarget: { tabRef: string; snapshotRevision: number } | null;
};

function normalizedLegacyUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Converts a safety classification into live side-effect context only when the
 * realtime store confirms that the classified heartbeat still owns the exact
 * active student/session/device binding. Historical heartbeat persistence is
 * intentionally handled before this boundary by the caller.
 */
export function resolveCurrentClasspilotSafetyAction(options: {
  classification: AiClassification;
  realtimeMutation: ClasspilotRealtimeMutationResult;
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  heartbeatId: string;
  activeTabUrl: string;
  activeTabTitle?: string;
}): ClasspilotSafetyAction | null {
  if (!options.classification.safetyAlert) return null;
  if (options.realtimeMutation.status === "stale") return null;

  const snapshot = options.realtimeMutation.snapshot;
  if (
    !snapshot
    || snapshot.state !== "active"
    || snapshot.schoolId !== options.schoolId
    || snapshot.studentId !== options.studentId
    || snapshot.studentSessionId !== options.studentSessionId
    || snapshot.deviceId !== options.deviceId
    || snapshot.heartbeatId !== options.heartbeatId
  ) {
    return null;
  }

  const classifiedUrl = String(options.activeTabUrl || "");
  if (!classifiedUrl || snapshot.activeTabUrl !== classifiedUrl) return null;

  const snapshotRevision = snapshot.tabSnapshotRevision;
  const activeTabRef = snapshot.activeTabRef;
  const exactTab = activeTabRef
    ? snapshot.allOpenTabs.find(
        (tab) => tab.tabRef === activeTabRef && tab.url === classifiedUrl
      )
    : undefined;
  const exactTabCloseVersion = classpilotExactTabCloseVersion(snapshot);
  const exactTarget = exactTabCloseVersion && exactTab?.tabRef && snapshotRevision
    ? { tabRef: exactTab.tabRef, snapshotRevision }
    : null;

  // Protocol-v2 compatibility may use a URL only when the complete snapshot
  // proves it identifies exactly one tab. Missing/truncated tab data never
  // broadens the action into closing every matching or open tab.
  const normalizedClassifiedUrl = normalizedLegacyUrl(classifiedUrl);
  const legacyMatches = normalizedClassifiedUrl && !snapshot.tabsTruncated
    ? snapshot.allOpenTabs.filter((tab) => normalizedLegacyUrl(tab.url) === normalizedClassifiedUrl)
    : [];
  const closeTabData = exactTarget
    ? { tabRefs: [exactTarget.tabRef] as [string], snapshotRevision: exactTarget.snapshotRevision }
    : exactTabCloseVersion !== 2 && legacyMatches.length === 1
      ? { specificUrls: [legacyMatches[0]!.url] as [string] }
      : null;

  return {
    snapshot,
    classifiedUrl,
    classifiedTitle: String(options.activeTabTitle || ""),
    teachingSessionId: snapshot.classroomState?.teachingSessionId ?? null,
    exactTabCloseVersion,
    closeTabData,
    evidenceTarget: exactTarget,
  };
}
