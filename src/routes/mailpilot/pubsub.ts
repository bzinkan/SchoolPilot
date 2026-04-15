import { Router } from "express";
import {
  getMailpilotWatchByEmail,
  getSchoolById,
  updateMailpilotWatchHistoryId,
  updateMailpilotWatchError,
  upsertMailpilotWatch,
  createEmailAlert,
  upsertEmailScanLog,
  getSchoolAdminAndLeadershipEmails,
  getStudentById,
} from "../../services/storage.js";
import {
  fetchMessage,
  listHistorySince,
  determineDirection,
  startWatch,
} from "../../services/mailpilotGmail.js";
import { classifyEmail } from "../../services/aiClassification.js";
import { sendEmailSafetyAlert } from "../../services/email.js";
import errorMonitor from "../../services/errorMonitor.js";

const router = Router();

/**
 * POST /api/mailpilot/pubsub/push
 *
 * Google Cloud Pub/Sub push endpoint. Gmail publishes a notification
 * whenever a watched mailbox changes; Pub/Sub forwards it here.
 *
 * Auth: verify bearer token (MAILPILOT_PUBSUB_VERIFY_TOKEN).
 * Always respond 2xx to prevent Pub/Sub retry storms — errors are logged
 * to errorMonitor and the watch row.
 */
router.post("/push", async (req, res) => {
  const verifyToken = process.env.MAILPILOT_PUBSUB_VERIFY_TOKEN;

  // Bearer-token verification (set when creating the Pub/Sub subscription)
  if (verifyToken) {
    const header = req.header("authorization") || "";
    const matched = header.startsWith("Bearer ") && header.slice(7) === verifyToken;
    const queryTokenValue = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
    const queryToken = typeof queryTokenValue === "string" && queryTokenValue === verifyToken;
    if (!matched && !queryToken) {
      console.warn("[MailPilot] Pub/Sub push rejected: bad verify token");
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const envelope = req.body;
  const messageData = envelope?.message?.data;
  if (!messageData) {
    // Acknowledge malformed pushes so Pub/Sub doesn't retry forever
    return res.status(204).end();
  }

  let decoded: { emailAddress?: string; historyId?: string | number };
  try {
    const json = Buffer.from(messageData, "base64").toString("utf8");
    decoded = JSON.parse(json);
  } catch (err) {
    console.warn("[MailPilot] Failed to decode Pub/Sub payload:", err);
    return res.status(204).end();
  }

  const emailAddress = decoded.emailAddress?.toLowerCase();
  const notificationHistoryId = decoded.historyId ? String(decoded.historyId) : null;
  if (!emailAddress) {
    return res.status(204).end();
  }

  // Fire-and-acknowledge: process asynchronously so Pub/Sub doesn't wait
  res.status(204).end();

  processNotification(emailAddress, notificationHistoryId).catch((err) => {
    console.error("[MailPilot] processNotification failed:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, {
      job: "mailpilot_pubsub",
      emailAddress,
    });
  });
});

async function processNotification(
  studentEmail: string,
  notificationHistoryId: string | null
): Promise<void> {
  const watch = await getMailpilotWatchByEmail(studentEmail);
  if (!watch) {
    console.warn(`[MailPilot] Received notification for unknown mailbox: ${studentEmail}`);
    return;
  }
  if (watch.status !== "active") {
    return;
  }

  // Lightweight duplicate-burst suppression: if another worker polled this
  // mailbox in the last 5s, skip. Alert dedup is already guaranteed by the
  // UNIQUE index on email_alerts.gmail_message_id — this just avoids wasted
  // Gmail/Claude calls when Pub/Sub fans out redundant notifications.
  if (watch.lastPollAt && Date.now() - new Date(watch.lastPollAt).getTime() < 5000) {
    return;
  }

  // Verify the school still has email monitoring enabled
  const school = await getSchoolById(watch.schoolId);
  if (!school || !school.classpilotEmailMonitoring) {
    console.log(`[MailPilot] School ${watch.schoolId} no longer has monitoring enabled — skipping`);
    return;
  }

  const startHistoryId = watch.historyId || notificationHistoryId;
  if (!startHistoryId) {
    console.warn(`[MailPilot] No historyId cursor for ${studentEmail} — re-bootstrapping watch`);
    try {
      const result = await startWatch(studentEmail);
      await upsertMailpilotWatch({
        schoolId: watch.schoolId,
        studentId: watch.studentId,
        studentEmail: watch.studentEmail,
        historyId: result.historyId,
        expiresAt: result.expiration,
        status: "active",
      });
    } catch (err) {
      await updateMailpilotWatchError(watch.id, (err as Error).message);
    }
    return;
  }

  let messageIds: string[];
  let newHistoryId: string;
  try {
    const result = await listHistorySince(studentEmail, startHistoryId);
    messageIds = result.messageIds;
    newHistoryId = result.newHistoryId;
  } catch (err: any) {
    if (err?.message === "history_expired") {
      // Re-bootstrap: start a new watch to get a fresh historyId
      console.warn(`[MailPilot] History expired for ${studentEmail} — re-bootstrapping`);
      try {
        const result = await startWatch(studentEmail);
        await upsertMailpilotWatch({
          schoolId: watch.schoolId,
          studentId: watch.studentId,
          studentEmail: watch.studentEmail,
          historyId: result.historyId,
          expiresAt: result.expiration,
          status: "active",
        });
      } catch (bootErr) {
        await updateMailpilotWatchError(watch.id, (bootErr as Error).message);
      }
      return;
    }
    await updateMailpilotWatchError(watch.id, err.message || String(err));
    throw err;
  }

  if (messageIds.length === 0) {
    await updateMailpilotWatchHistoryId(watch.id, newHistoryId, new Date());
    return;
  }

  const timezone = school.schoolTimezone || "America/New_York";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: timezone });

  let alertsRaised = 0;
  let errors = 0;
  for (const msgId of messageIds) {
    try {
      const processed = await processSingleMessage(
        studentEmail,
        msgId,
        watch.schoolId,
        watch.studentId,
        school.name,
        timezone
      );
      if (processed === "alert") alertsRaised++;
    } catch (err) {
      errors++;
      console.error(`[MailPilot] Message processing failed (${msgId}):`, err);
    }
  }

  await upsertEmailScanLog({
    schoolId: watch.schoolId,
    date: todayStr,
    messagesScanned: messageIds.length,
    alertsRaised,
    errors,
  });

  await updateMailpilotWatchHistoryId(watch.id, newHistoryId, new Date());
}

async function processSingleMessage(
  studentEmail: string,
  messageId: string,
  schoolId: string,
  studentId: string,
  schoolName: string,
  timezone: string
): Promise<"alert" | "benign" | "skipped"> {
  const message = await fetchMessage(studentEmail, messageId);
  if (!message) return "skipped";

  const direction = determineDirection(studentEmail, message.labelIds, message.from);

  // Skip drafts and chats (we only want INBOX + SENT)
  if (!message.labelIds.includes("INBOX") && !message.labelIds.includes("SENT")) {
    return "skipped";
  }

  const classification = await classifyEmail({
    subject: message.subject,
    from: message.from,
    to: message.to,
    body: message.body || message.snippet,
    direction,
  });

  if (!classification) return "skipped";

  const flagged = Boolean(classification.safetyAlert || classification.bullying);
  if (!flagged) return "benign";

  // Persist the alert
  const safetyType = classification.safetyAlert
    || (classification.bullying ? "bullying" : null);
  const alert = await createEmailAlert({
    schoolId,
    studentId,
    studentEmail,
    gmailMessageId: messageId,
    gmailThreadId: message.threadId,
    direction,
    sender: message.from,
    recipients: message.to,
    subject: message.subject,
    snippet: (message.body || message.snippet || "").slice(0, 600),
    category: classification.category,
    safetyAlert: safetyType,
    bullying: classification.bullying ? "true" : "false",
    confidence: classification.confidence,
    severity: classification.severity,
    reasoning: classification.reasoning,
    messageDate: message.date || null,
  });

  if (!alert) return "skipped"; // duplicate

  // Notify school admins for medium+ severity
  if (["medium", "high", "critical"].includes(classification.severity)) {
    try {
      const recipients = await getSchoolAdminAndLeadershipEmails(schoolId);
      if (recipients.length > 0) {
        const student = await getStudentById(studentId);
        const studentName = student ? `${student.firstName || ""} ${student.lastName || ""}`.trim() : undefined;
        await sendEmailSafetyAlert({
          recipients,
          studentEmail,
          studentName,
          schoolName,
          schoolTimezone: timezone,
          direction,
          safetyAlert: safetyType || "bullying",
          severity: classification.severity,
          subject: message.subject,
          sender: message.from,
          snippet: (message.body || message.snippet || "").slice(0, 500),
          alertId: alert.id,
        });
      }
    } catch (err) {
      console.error("[MailPilot] Admin notification failed:", err);
      errorMonitor.trackError("email_failure", err as Error, { job: "mailpilot_admin_alert", schoolId });
    }
  }

  return "alert";
}

export default router;
