import {
  CHAT_SAFETY_RULESET_VERSION,
  classifyChatMessage,
  classifyChatText,
  type ChatSafetyMatch,
  type ChatTextClassification,
} from "./aiClassification.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";
import type { SafetyObservation } from "./safetyCenter.js";

export type ChatSafetyScanMode = "hit" | "off";

/** AI enrichment runs only on a lexicon hit; "off" keeps every message inside the system. */
export function chatSafetyScanMode(): ChatSafetyScanMode {
  return process.env.CLASSPILOT_CHAT_AI_SCAN_MODE === "off" ? "off" : "hit";
}

const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
type Severity = typeof SEVERITY_ORDER[number];

function lexiconSeverity(safetyAlert: string): Severity {
  if (safetyAlert === "self-harm" || safetyAlert === "violence" || safetyAlert === "weapons") return "high";
  return "medium";
}

function higherSeverity(first: Severity, second: unknown): Severity {
  const index = Math.max(SEVERITY_ORDER.indexOf(first), SEVERITY_ORDER.indexOf(second as Severity));
  return SEVERITY_ORDER[index] ?? first;
}

export type ChatSafetyScanInput = {
  schoolId: string;
  studentId: string;
  messageId: string;
  deviceId: string;
  content: string;
  teachingSessionId?: string | null;
  supervisionContextId?: string | null;
  occurredAt?: Date;
};

export type ChatSafetyScanDependencies = {
  classify: (content: string) => ChatSafetyMatch | null;
  enrich: (content: string) => Promise<ChatTextClassification | null>;
  claim: (input: { schoolId: string; deviceId: string; domain: string }) => Promise<boolean>;
  record: (observation: SafetyObservation) => Promise<{ suppressed: boolean; created: boolean; caseId: string | null; alertId: string | null }>;
  mode: () => ChatSafetyScanMode;
  log: { warn: (line: string) => void };
};

// The claim and record paths reach Redis and the database; they are resolved lazily so
// importing this module (as the pure unit lane does) never opens either connection.
const defaultDependencies: ChatSafetyScanDependencies = {
  classify: classifyChatMessage,
  enrich: classifyChatText,
  claim: async (input) => {
    const { claimClasspilotSafetyAlert } = await import("./classpilotSafetyCooldown.js");
    return claimClasspilotSafetyAlert(input);
  },
  record: async (observation) => {
    const [{ runWithTenantContext }, { recordSafetyAlert }] = await Promise.all([
      import("../middleware/tenantContext.js"),
      import("./safetyCenter.js"),
    ]);
    return runWithTenantContext({ schoolId: observation.schoolId }, () => recordSafetyAlert(observation));
  },
  mode: chatSafetyScanMode,
  log: console,
};

export type ChatSafetyScanResult = {
  safetyAlert: string | null;
  recorded: boolean;
  created: boolean;
  classificationSource: "chat-lexicon" | "chat-ai" | null;
};

/**
 * Scan one student-authored chat message. Lexicon first, so an unflagged
 * message never leaves the system; the AI provider only ever sees text that
 * already matched, and only to grade severity and explain the hit. A provider
 * failure never suppresses the lexicon alert. Never throws into the send path
 * and never logs message content.
 */
export async function scanStudentChatMessage(
  input: ChatSafetyScanInput,
  dependencies: Partial<ChatSafetyScanDependencies> = {}
): Promise<ChatSafetyScanResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const none: ChatSafetyScanResult = { safetyAlert: null, recorded: false, created: false, classificationSource: null };
  try {
    const hit = deps.classify(input.content);
    if (!hit) return none;
    let severity = lexiconSeverity(hit.safetyAlert);
    let classificationSource: "chat-lexicon" | "chat-ai" = "chat-lexicon";
    let reason: string | null = `Matched "${hit.label}" in a class chat message`;
    let modelVersion: string | null = null;
    let confidence: number | null = null;
    if (deps.mode() === "hit") {
      // One enrichment per student, concern and cooldown window; repeats keep the lexicon grade.
      const claimed = await deps.claim({ schoolId: input.schoolId, deviceId: input.deviceId, domain: `chat:${input.studentId}:${hit.safetyAlert}` })
        .catch(() => false);
      if (claimed) {
        const enriched = await deps.enrich(input.content).catch(() => null);
        if (enriched) {
          severity = higherSeverity(severity, enriched.severity);
          classificationSource = "chat-ai";
          reason = enriched.reasoning || reason;
          modelVersion = enriched.modelVersion ?? null;
          confidence = enriched.confidence ?? null;
        }
      }
    }
    const outcome = await deps.record({
      schoolId: input.schoolId,
      studentId: input.studentId,
      sourceType: "chat",
      sourceId: input.messageId,
      url: null,
      title: null,
      safetyAlert: hit.safetyAlert,
      severity,
      classificationSource,
      matchedTerm: hit.label,
      reason,
      rulesetVersion: CHAT_SAFETY_RULESET_VERSION,
      modelVersion,
      confidence,
      teachingSessionId: input.teachingSessionId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    });
    if (!outcome.suppressed) recordRuntimePerformanceCounter("chatSafetyAlertsRecorded");
    return { safetyAlert: hit.safetyAlert, recorded: !outcome.suppressed, created: outcome.created, classificationSource };
  } catch (error) {
    recordRuntimePerformanceCounter("chatSafetyScanFailed");
    try {
      deps.log.warn(`[ClassPilot chat] safety scan failed school=${input.schoolId} student=${input.studentId} message=${input.messageId} error=${(error as { code?: string })?.code ?? (error as Error)?.name ?? "unknown"}`);
    } catch {
      // Logging must never throw into the send path either.
    }
    return none;
  }
}
