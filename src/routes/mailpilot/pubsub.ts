import { Router } from "express";
import { getMailpilotWatchByEmail, getSchoolById, upsertEmailScanLog, getStudentById } from "../../services/storage.js";
import { fetchMessage, listHistorySince, determineDirection } from "../../services/mailpilotGmail.js";
import { classifyEmail } from "../../services/aiClassification.js";
import errorMonitor from "../../services/errorMonitor.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";
import { schedulerDb } from "../../services/schedulerDb.js";
import { createMailpilotPubsubPushHandler } from "../../services/mailpilotPubsubDelivery.js";
import { resolveClasspilotEntitlement } from "../../services/classpilotEntitlement.js";
import { completeMailpilotHistoryCursor, noteMailpilotProcessingFailure, persistMailpilotSafetyAlert } from "../../services/mailpilotSafetyPersistence.js";
import { mailpilotClassificationAvailable, mailpilotHistoryCovered, mailpilotRetryError, processMailpilotHistoryBatch, validMailpilotHistoryId } from "../../services/mailpilotNotification.js";

const router = Router();

/** Google Pub/Sub retries 503 responses; successful delivery is acknowledged only after processing. */
router.post("/push", createMailpilotPubsubPushHandler({
  processNotification,
  onProcessingFailure: () => {
    console.error("[MailPilot] Notification processing incomplete; retry required");
    errorMonitor.trackError("scheduler_failure", new Error("MailPilot notification processing incomplete"), {
      job: "mailpilot_pubsub", messageType: "gmail_pubsub",
    });
  },
}));
async function processNotification(studentEmail: string, notificationHistoryId: string): Promise<void> {
  // Only this mailbox lookup is cross-tenant; all subsequent work is tenant scoped.
  const watch = await getMailpilotWatchByEmail(studentEmail, schedulerDb);
  if (!watch || watch.status !== "active") return;
  // Elapsed time since polling cannot distinguish duplicate pushes from new mail.
  if (mailpilotHistoryCovered(watch.historyId, notificationHistoryId)) return;
  await runWithTenantContext({ schoolId: watch.schoolId }, async () => {
    try { await processActiveWatch(studentEmail, watch); }
    catch (error) {
      const candidate = (error as {code?:unknown})?.code;
      const code = typeof candidate === "string" && /^MAILPILOT_[A-Z_]+$/.test(candidate) ? candidate : "MAILPILOT_PROCESSING_FAILED";
      await noteMailpilotProcessingFailure(watch, code).catch(() => {});
      throw mailpilotRetryError(code);
    }
  });
}

async function processActiveWatch(studentEmail: string, watch: NonNullable<Awaited<ReturnType<typeof getMailpilotWatchByEmail>>>): Promise<void> {
  const activeStudent = await getStudentById(watch.studentId);
  if (!activeStudent || activeStudent.schoolId !== watch.schoolId || activeStudent.status !== "active" || activeStudent.emailLc !== studentEmail.toLowerCase()) return;
  const school = await getSchoolById(watch.schoolId);
  if (!school || !school.mailpilotEntitled || !school.classpilotEmailMonitoring) return;
  if (!(await resolveClasspilotEntitlement(watch.schoolId)).entitled) return;

  const startHistoryId = watch.historyId;
  if (!validMailpilotHistoryId(startHistoryId)) throw mailpilotRetryError("MAILPILOT_HISTORY_RESYNC_REQUIRED");
  let result: Awaited<ReturnType<typeof listHistorySince>>;
  try { result = await listHistorySince(studentEmail, startHistoryId); }
  catch (error) {
    // Expired history requires explicit recovery/backfill; starting a new watch
    // here would silently skip the mail this notification promised to process.
    if ((error as Error)?.message === "history_expired") throw mailpilotRetryError("MAILPILOT_HISTORY_RESYNC_REQUIRED");
    throw error;
  }
  const timezone = school.schoolTimezone || "America/New_York";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  await processMailpilotHistoryBatch({
    messageIds: result.messageIds,
    processMessage: messageId => processSingleMessage(studentEmail, messageId, watch.schoolId, watch.studentId),
    recordStats: stats => upsertEmailScanLog({ schoolId: watch.schoolId, date: today, ...stats }),
    complete: () => completeMailpilotHistoryCursor(watch, result.newHistoryId),
  });
}

async function processSingleMessage(studentEmail: string, messageId: string, schoolId: string, studentId: string): Promise<"alert" | "benign" | "skipped"> {
  const identity = { schoolId, studentId, studentEmail, gmailMessageId: messageId };
  // Repair a retained legacy alert, or skip its already durable source, before
  // fetching or reclassifying the same message on provider redelivery.
  const retained = await persistMailpilotSafetyAlert(identity);
  if (retained) return retained.created ? "alert" : "skipped";
  const message = await fetchMessage(studentEmail, messageId);
  if (!message) return "skipped"; // Gmail confirms the message was deleted.
  if (!message.labelIds.includes("INBOX") && !message.labelIds.includes("SENT")) return "skipped";
  const direction = determineDirection(studentEmail, message.labelIds, message.from);
  const classification = await classifyEmail({ subject: message.subject, from: message.from, to: message.to, body: message.body || message.snippet, direction });
  if (!classification || !mailpilotClassificationAvailable(classification)) throw mailpilotRetryError("MAILPILOT_CLASSIFICATION_UNAVAILABLE");
  if (!classification.safetyAlert && !classification.bullying) return "benign";
  const persisted = await persistMailpilotSafetyAlert(identity, {
    ...identity, gmailThreadId: message.threadId, direction,
    sender: message.from, recipients: message.to, subject: message.subject,
    snippet: (message.body || message.snippet || "").slice(0, 600),
    category: classification.category,
    safetyAlert: classification.safetyAlert || "bullying",
    bullying: classification.bullying ? "true" : "false",
    confidence: classification.confidence, severity: classification.severity,
    reasoning: classification.reasoning, messageDate: message.date || null,
  });
  return persisted?.created ? "alert" : "skipped";
}

export default router;
