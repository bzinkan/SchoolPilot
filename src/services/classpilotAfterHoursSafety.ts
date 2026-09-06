import crypto from "node:crypto";
import { classifyUrl } from "./aiClassification.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { getSchoolById, getHeartbeatTrackingSettingsForSchool, withClasspilotStudentControlDeliveryAuthority } from "./storage.js";
import { resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { classpilotBrowserSafetySeverity } from "./classpilotBrowserSafetySeverity.js";

/** No heartbeat, timeline of ordinary browsing, realtime snapshot or pixel is created here. */
export async function processClasspilotAfterHoursSafety(options: {
  schoolId: string; studentId: string; studentSessionId: string; deviceId: string;
  url: string; title: string; acceptedCapabilities: readonly string[];
}) {
  const occurredAt = new Date();
  const sourceId = crypto.randomUUID();
  const school = await runWithTenantContext({ schoolId: options.schoolId }, () => getSchoolById(options.schoolId));
  const classification = await classifyUrl(options.url, options.title, { schoolDomain: school?.domain });
  if (!classification?.safetyAlert) return;
  const safetyAlert = classification.safetyAlert;
  await runWithTenantContext({ schoolId: options.schoolId }, async () => {
    await withClasspilotStudentControlDeliveryAuthority(options, async (transactionDb) => {
      const schoolSettings = await getHeartbeatTrackingSettingsForSchool(options.schoolId, transactionDb, { lock: true });
      const policy = resolveClasspilotMonitoringPolicy(schoolSettings, {
        acceptedCapabilities: options.acceptedCapabilities,
      });
      if (policy.mode !== "safety_only") return;
      const { recordSafetyAlert } = await import("./safetyCenter.js");
      await recordSafetyAlert({
      schoolId: options.schoolId, studentId: options.studentId,
      sourceType: "browser", sourceId, url: options.url, title: options.title,
      safetyAlert, severity: classpilotBrowserSafetySeverity(classification),
      classificationSource: classification.source ?? "unknown",
      matchedTerm: classification.matchedTerm ?? undefined,
      reason: classification.reasoning, rulesetVersion: classification.rulesetVersion,
      modelVersion: classification.modelVersion, confidence: classification.confidence, occurredAt,
      }, transactionDb);
    }, () => undefined);
  });
}
