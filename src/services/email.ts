import sgMail from "@sendgrid/mail";

// Lazy import to avoid circular dep (errorMonitor imports email.ts)
let _errorMonitor: any = null;
async function getErrorMonitor() {
  if (!_errorMonitor) {
    const mod = await import("./errorMonitor.js");
    _errorMonitor = mod.default;
  }
  return _errorMonitor;
}

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM || "noreply@school-pilot.net";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bzinkan@school-pilot.net";

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

export type EmailSendOptions = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  customArgs?: Record<string, string>;
};

export type EmailSendResult =
  | { status: "sent"; providerMessageId?: string }
  | { status: "transient_failure" | "permanent_failure" | "unknown"; error: string; providerStatus?: number; providerCode?: string };

function safeProviderError(error: any): { message: string; status?: number; code?: string } {
  const status = Number(error?.code || error?.response?.statusCode || error?.response?.status);
  const code = typeof error?.code === "string" ? error.code.slice(0, 64) : undefined;
  return {
    message: status
      ? `Email provider returned HTTP ${status}`
      : code
        ? `Email provider transport failed (${code})`
        : "Email provider transport failed",
    status: Number.isFinite(status) ? status : undefined,
    code,
  };
}

export async function sendEmailWithResult(options: EmailSendOptions): Promise<EmailSendResult> {
  if (!SENDGRID_API_KEY) {
    console.log("[Email] Development delivery accepted");
    return { status: "sent", providerMessageId: "development-noop" };
  }

  try {
    const msg: any = {
      to: options.to,
      from: FROM_EMAIL,
      subject: options.subject,
    };
    if (options.html) msg.html = options.html;
    if (options.text) msg.text = options.text;
    if (options.customArgs) msg.customArgs = options.customArgs;
    if (!msg.html && !msg.text) msg.text = options.subject;
    const [response] = await sgMail.send(msg);
    const rawMessageId = response?.headers?.["x-message-id"];
    const providerMessageId = Array.isArray(rawMessageId) ? rawMessageId[0] : rawMessageId;
    return { status: "sent", providerMessageId: providerMessageId ? String(providerMessageId) : undefined };
  } catch (error: any) {
    const safe = safeProviderError(error);
    console.error("[Email] Send failed:", safe.message);
    // Track in error monitor (skip if this IS an alert email to avoid recursion)
    if (!options.subject.startsWith("[SchoolPilot ALERT]")) {
      try {
        const monitor = await getErrorMonitor();
        // Pass only a synthesized provider classification. Raw SendGrid
        // errors can contain recipient addresses and must not enter monitoring.
        monitor.trackError("email_failure", new Error(safe.message), {
          errorCode: safe.code || (safe.status ? String(safe.status) : "EMAIL_TRANSPORT"),
          messageType: "email_provider_delivery",
        });
      } catch { /* avoid recursion */ }
    }

    if (safe.status) {
      if (safe.status >= 400 && safe.status < 500 && safe.status !== 429) {
        return { status: "permanent_failure", error: safe.message, providerStatus: safe.status, providerCode: safe.code };
      }
      return { status: "transient_failure", error: safe.message, providerStatus: safe.status, providerCode: safe.code };
    }

    const ambiguousCodes = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "EPIPE"]);
    if (safe.code && !ambiguousCodes.has(safe.code)) {
      return { status: "transient_failure", error: safe.message, providerCode: safe.code };
    }
    return { status: "unknown", error: safe.message, providerCode: safe.code };
  }
}

export async function sendEmail(options: EmailSendOptions): Promise<boolean> {
  return (await sendEmailWithResult(options)).status === "sent";
}

export async function sendWelcomeEmail(to: string, schoolName: string, tempPassword: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `Welcome to SchoolPilot - ${schoolName}`,
    html: `
      <h2>Welcome to SchoolPilot!</h2>
      <p>Your school <strong>${schoolName}</strong> has been set up.</p>
      <p>Your temporary password is: <code>${tempPassword}</code></p>
      <p>Please log in and change your password immediately.</p>
      <p>Login at: ${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}</p>
    `,
  });
}

export async function sendSchoolInquiryNotification(request: {
  schoolName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  preferredContactMethod?: string | null;
  adminItEmail?: string | null;
  billingEmail?: string | null;
  estimatedStudents?: string | null;
  interestedProducts?: string | null;
  questions?: string | null;
}): Promise<boolean> {
  return sendEmail({
    to: ADMIN_EMAIL,
    subject: `New School Inquiry: ${request.schoolName}`,
    html: `
      <h2>New School Inquiry</h2>
      <p><strong>School:</strong> ${request.schoolName}</p>
      <p><strong>Contact:</strong> ${request.contactName} (${request.contactEmail})</p>
      <p><strong>Phone:</strong> ${request.contactPhone || "Not provided"}</p>
      <p><strong>Preferred contact:</strong> ${request.preferredContactMethod || "Not specified"}</p>
      <p><strong>Admin/IT email:</strong> ${request.adminItEmail || "Not provided"}</p>
      <p><strong>Billing email:</strong> ${request.billingEmail || "Not provided"}</p>
      <p><strong>Estimated students:</strong> ${request.estimatedStudents || "Not provided"}</p>
      <p><strong>Interested products:</strong> ${request.interestedProducts || "Not specified"}</p>
      ${request.questions ? `<p><strong>Questions:</strong><br/>${request.questions}</p>` : ""}
    `,
  });
}

export async function sendSchoolInquiryConfirmation(request: {
  contactName: string;
  contactEmail: string;
  schoolName: string;
}): Promise<boolean> {
  return sendEmail({
    to: request.contactEmail,
    subject: "SchoolPilot — we received your information",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Thanks for reaching out to SchoolPilot!</h2>
        <p>Hi ${request.contactName},</p>
        <p>We received the information for <strong>${request.schoolName}</strong>. We'll review your setup needs and follow up with next steps for onboarding, billing, and any IT questions.</p>
        <p>SchoolPilot includes:</p>
        <ul>
          <li><strong>ClassPilot</strong> — real-time Chromebook monitoring</li>
          <li><strong>PassPilot</strong> — digital hall passes</li>
          <li><strong>GoPilot</strong> — dismissal management</li>
        </ul>
        <p>Questions? Just reply to this email.</p>
        <p style="margin-top: 24px;">— The SchoolPilot Team</p>
      </div>
    `,
  });
}

export async function sendSafetyAlertEmail(options: {
  recipients: string[];
  studentEmail: string;
  studentName?: string | null;
  alertType: string;
  url: string;
  title: string;
  schoolName: string;
  /** URL-derived lexicon label or list entry that triggered the alert. */
  matchedTerm?: string | null;
}): Promise<number> {
  const { recipients, studentEmail, studentName, alertType, url, title, schoolName, matchedTerm } = options;
  const alertLabel = alertType.charAt(0).toUpperCase() + alertType.slice(1).replace("-", " ");
  const displayDomain = safetyAlertDisplayDomain(url);
  const studentDisplay = studentName ? `${studentName} (${studentEmail})` : studentEmail;
  const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character]!);
  const subject = `⚠️ Safety Alert: ${alertLabel} detected — ${schoolName}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">⚠️ AI Safety Alert</h2>
      <p>ClassPilot detected potentially dangerous content on a student device.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Alert Type</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #dc2626;">${escapeHtml(alertLabel)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Student</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(studentDisplay)}</td></tr>
        ${matchedTerm ? `<tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Matched</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(matchedTerm)}</td></tr>` : ""}
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Page Title</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(title || "Unknown")}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Domain</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; word-break: break-all;">${escapeHtml(displayDomain)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Time</td><td style="padding: 8px;">${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}</td></tr>
      </table>
      <p style="color: #6b7280; font-size: 14px;">This alert was generated by ClassPilot's AI content classification system. Please review and take appropriate action.</p>
      <p style="color: #6b7280; font-size: 12px;">To disable these emails, go to Admin Settings → AI Safety Alert Emails.</p>
    </div>
  `;

  let sent = 0;
  for (const to of recipients) {
    const ok = await sendEmail({ to, subject, html });
    if (ok) sent++;
  }
  console.log(`[Email] Safety alert sent to ${sent}/${recipients.length} recipients`);
  return sent;
}

/** Teacher/admin email surfaces never receive query strings, fragments, paths, or credentials. */
export function safetyAlertDisplayDomain(value: string): string {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Unavailable";
    return parsed.hostname.toLowerCase().replace(/^www\./, "").slice(0, 253) || "Unavailable";
  } catch {
    return "Unavailable";
  }
}

export async function sendEmailSafetyAlert(options: {
  recipients: string[];
  studentEmail: string;
  studentName?: string;
  schoolName: string;
  schoolTimezone?: string;
  direction: "inbound" | "outbound";
  safetyAlert: string;
  severity: string;
  subject: string;
  sender: string;
  snippet: string;
  alertId: string;
  clientBaseUrl?: string;
}): Promise<number> {
  const {
    recipients,
    studentEmail,
    studentName,
    schoolName,
    schoolTimezone = "America/New_York",
    direction,
    safetyAlert,
    severity,
    subject,
    sender,
    snippet,
    alertId,
    clientBaseUrl = process.env.CLIENT_URL || "https://school-pilot.net",
  } = options;

  const alertLabel = safetyAlert.charAt(0).toUpperCase() + safetyAlert.slice(1).replace("-", " ");
  const severityColor = severity === "critical" ? "#7f1d1d" : severity === "high" ? "#dc2626" : severity === "medium" ? "#d97706" : "#6b7280";
  const directionLabel = direction === "outbound" ? "Sent by student" : "Received by student";
  const emailSubject = `${severity === "critical" ? "🚨" : "⚠️"} Email Safety Alert: ${alertLabel} — ${schoolName}`;
  const reviewUrl = `${clientBaseUrl}/classpilot/admin/email-monitoring?alert=${encodeURIComponent(alertId)}`;
  const timeStr = new Date().toLocaleString("en-US", { timeZone: schoolTimezone });
  const snippetSafe = (snippet || "").slice(0, 600)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const subjectSafe = (subject || "(no subject)").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const senderSafe = sender.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const html = `
    <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="color: ${severityColor};">${severity === "critical" ? "🚨" : "⚠️"} Email Safety Alert</h2>
      <p>MailPilot detected potentially concerning content in a student's Gmail message.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Alert Type</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: ${severityColor};">${alertLabel}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Severity</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: ${severityColor}; font-weight: bold;">${severity.toUpperCase()}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Student</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${studentName ? `${studentName} &lt;${studentEmail}&gt;` : studentEmail}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Direction</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${directionLabel}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">From</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${senderSafe}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Subject</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${subjectSafe}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Time</td><td style="padding: 8px;">${timeStr}</td></tr>
      </table>
      <div style="background: #f9fafb; border-left: 4px solid ${severityColor}; padding: 12px; margin: 12px 0; font-size: 14px; white-space: pre-wrap;">${snippetSafe || "(no snippet)"}</div>
      <p style="margin: 16px 0;"><a href="${reviewUrl}" style="display: inline-block; background: ${severityColor}; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none;">Review in ClassPilot Admin</a></p>
      <p style="color: #6b7280; font-size: 13px;">This alert was generated by ClassPilot Email Monitoring. Please review promptly and follow your school's mental-health and safety escalation procedures.</p>
      <p style="color: #9ca3af; font-size: 12px;">To adjust notification recipients or disable monitoring, go to ClassPilot Admin → Email Monitoring → Settings.</p>
    </div>
  `;

  let sent = 0;
  for (const to of recipients) {
    const ok = await sendEmail({ to, subject: emailSubject, html });
    if (ok) sent++;
  }
  console.log(`[Email] MailPilot safety alert (${safetyAlert}/${severity}) sent to ${sent}/${recipients.length} recipients`);
  return sent;
}

export async function sendBroadcastEmail(recipients: string[], subject: string, message: string): Promise<number> {
  let sent = 0;
  for (const to of recipients) {
    const ok = await sendEmail({ to, subject, html: message });
    if (ok) sent++;
  }
  return sent;
}

export async function sendTaxCertificateRequestEmail(to: string, schoolName: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: "Tax Exemption Certificate Request — SchoolPilot",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Tax Exemption Certificate Request</h2>
        <p>Hello,</p>
        <p>Thank you for choosing SchoolPilot for <strong>${schoolName}</strong>.</p>
        <p>To ensure proper tax handling on your invoices, we kindly request a copy of your organization's tax exemption documentation. This may include:</p>
        <ul>
          <li>IRS 501(c)(3) determination letter</li>
          <li>State sales tax exemption certificate</li>
          <li>Government entity documentation (for public schools)</li>
        </ul>
        <p>You can reply to this email with the document attached (PDF, PNG, or JPG format).</p>
        <p>Once received, your account will be marked as tax-exempt and future invoices will reflect this status.</p>
        <p>If you have any questions, please don't hesitate to reach out.</p>
        <p style="margin-top: 24px;">Best regards,<br/>SchoolPilot Team</p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">This email was sent by SchoolPilot. Reply directly to provide your certificate.</p>
      </div>
    `,
  });
}

export async function sendChatEscalationEmail(options: {
  summary: string;
  category: string;
  severity: string;
  stepsAttempted: string;
  userName: string;
  userRole: string;
  schoolName: string;
  chatTranscript: string;
}): Promise<boolean> {
  const { summary, category, severity, stepsAttempted, userName, userRole, schoolName, chatTranscript } = options;
  const severityColor = severity === "high" ? "#dc2626" : severity === "medium" ? "#d97706" : "#6b7280";
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${severityColor};">🤖 AI Assistant Escalation</h2>
      <p>The SchoolPilot AI Assistant has escalated an issue that could not be resolved through troubleshooting.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Summary</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${summary}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Category</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${category}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Severity</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: ${severityColor}; font-weight: bold;">${severity.toUpperCase()}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">User</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${userName} (${userRole})</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">School</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${schoolName}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Steps Attempted</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${stepsAttempted}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Time</td><td style="padding: 8px;">${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}</td></tr>
      </table>
      <h3 style="margin-top: 24px;">Chat Transcript (last messages)</h3>
      <pre style="background: #f3f4f6; padding: 12px; border-radius: 6px; font-size: 13px; white-space: pre-wrap; overflow-x: auto;">${chatTranscript}</pre>
    </div>
  `;

  return sendEmail({
    to: ADMIN_EMAIL,
    subject: `🤖 AI Escalation [${severity.toUpperCase()}]: ${summary}`,
    html,
  });
}

function escapeEmailHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeEmailSubject(value: string): string {
  return String(value).replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export type SessionSummaryEmailOptions = {
  reportVersion?: number;
  to: string;
  teacherName: string;
  className: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: string;
  studentCount: number;
  students: Array<{
    name: string;
    totalMinutes: number;
    topDomains: Array<{ domain: string; minutes: number }>;
    offTaskCount?: number;
    offTaskMinutes?: number;
    unclassifiedMinutes?: number;
    safetyAlerts?: string[];
    safetyUrls?: string[];
    safetyReviewStatuses?: string[];
    coverageStatus?: "complete" | "partial" | "none" | "not_expected" | "unavailable";
    coveragePercent?: number | null;
    gapMinutes?: number;
  }>;
  copyNotice?: string;
  deliveryId?: string;
};

function buildSessionSummaryEmailV1(options: SessionSummaryEmailOptions): { subject: string; html: string } {
  const { teacherName, className, date, startTime, endTime, duration, studentCount, students, copyNotice } = options;
  const safeTeacherName = escapeEmailHtml(teacherName);
  const safeClassName = escapeEmailHtml(className);
  const safeDate = escapeEmailHtml(date);
  const safeStartTime = escapeEmailHtml(startTime);
  const safeEndTime = escapeEmailHtml(endTime);
  const safeDuration = escapeEmailHtml(duration);
  const copyNoticeHtml = copyNotice
    ? `<p style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; color: #475569; font-size: 13px;">${escapeEmailHtml(copyNotice)}</p>`
    : "";

  const safetyIncidents = students
    .filter(s => s.safetyAlerts && s.safetyAlerts.length > 0)
    .map(s => `<tr><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca;">${escapeEmailHtml(s.name)}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; color: #dc2626; font-weight: bold;">${s.safetyAlerts!.map(escapeEmailHtml).join(", ")}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; font-size: 13px;">${s.safetyUrls?.map(escapeEmailHtml).join(", ") || ""}</td></tr>`)
    .join("");
  const safetySection = safetyIncidents ? `
    <div style="margin: 20px 0; padding: 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
      <h3 style="color: #dc2626; margin: 0 0 12px 0;">&#9888; Safety Alerts</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead><tr style="background: #fee2e2;"><th style="padding: 6px 8px; text-align: left;">Student</th><th style="padding: 6px 8px; text-align: left;">Alert Type</th><th style="padding: 6px 8px; text-align: left;">Site</th></tr></thead>
        <tbody>${safetyIncidents}</tbody>
      </table>
    </div>` : "";

  const studentRows = students
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .map((s) => {
      const domains = s.topDomains
        .slice(0, 5)
        .map((d) => `${escapeEmailHtml(d.domain)} (${Number(d.minutes) || 0}m)`)
        .join(", ");
      const coverageLabel = s.coverageStatus === "not_expected"
        ? "Not expected"
        : s.coverageStatus === "unavailable"
          ? "Unavailable"
          : `${Math.max(0, Math.min(100, Number(s.coveragePercent) || 0))}%${s.gapMinutes ? ` (${s.gapMinutes}m gap)` : ""}`;
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeEmailHtml(s.name)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${s.totalMinutes}m</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${escapeEmailHtml(coverageLabel)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${domains || "No observed browser telemetry"}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1e293b;">📋 ClassPilot Session Summary</h2>
      ${copyNoticeHtml}
      <p>Hi ${safeTeacherName},</p>
      <p>Here's your session summary for <strong>${safeClassName}</strong>.</p>
      ${safetySection}
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #f8fafc; border-radius: 6px;">
        <tr><td style="padding: 8px 12px; font-weight: bold;">Date</td><td style="padding: 8px 12px;">${safeDate}</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Time</td><td style="padding: 8px 12px;">${safeStartTime} — ${safeEndTime} (${safeDuration})</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Students</td><td style="padding: 8px 12px;">${Number(studentCount) || 0}</td></tr>
      </table>
      <h3 style="margin-top: 24px; color: #1e293b;">Observed browser telemetry</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f1f5f9;">
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Student</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Observed Time</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Monitoring coverage</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Top Sites</th>
          </tr>
        </thead>
        <tbody>${studentRows}</tbody>
      </table>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">Generated by ClassPilot · SchoolPilot</p>
    </div>
  `;

  return {
    subject: sanitizeEmailSubject(`ClassPilot Session Summary — ${className} (${date})`),
    html,
  };
}

function buildSessionSummaryEmailV2(options: SessionSummaryEmailOptions): { subject: string; html: string } {
  const { teacherName, className, date, startTime, endTime, duration, studentCount, students, copyNotice } = options;
  const safeTeacherName = escapeEmailHtml(teacherName);
  const safeClassName = escapeEmailHtml(className);
  const safeDate = escapeEmailHtml(date);
  const safeStartTime = escapeEmailHtml(startTime);
  const safeEndTime = escapeEmailHtml(endTime);
  const safeDuration = escapeEmailHtml(duration);
  const copyNoticeHtml = copyNotice
    ? `<p style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; color: #475569; font-size: 13px;">${escapeEmailHtml(copyNotice)}</p>`
    : "";

  // Build safety incidents section if any exist
  const safetyIncidents = students
    .filter(s => s.safetyAlerts && s.safetyAlerts.length > 0)
    .map(s => `<tr><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca;">${escapeEmailHtml(s.name)}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; color: #dc2626; font-weight: bold;">${s.safetyAlerts!.map(escapeEmailHtml).join(", ")}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; font-size: 13px;">${s.safetyUrls?.map(escapeEmailHtml).join(", ") || "Unavailable"}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; font-size: 13px;">${s.safetyReviewStatuses?.map(escapeEmailHtml).join(", ") || "Automated"}</td></tr>`)
    .join("");
  const safetySection = safetyIncidents ? `
    <div style="margin: 20px 0; padding: 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
      <h3 style="color: #dc2626; margin: 0 0 12px 0;">&#9888; Safety Alerts</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead><tr style="background: #fee2e2;"><th style="padding: 6px 8px; text-align: left;">Student</th><th style="padding: 6px 8px; text-align: left;">Alert Type</th><th style="padding: 6px 8px; text-align: left;">Domain</th><th style="padding: 6px 8px; text-align: left;">Review status</th></tr></thead>
        <tbody>${safetyIncidents}</tbody>
      </table>
    </div>` : "";

  const studentRows = students
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .map((s) => {
      const domains = s.topDomains
        .slice(0, 5)
        .map((d) => `${escapeEmailHtml(d.domain)} (${Number(d.minutes) || 0}m)`)
        .join(", ");
      const coverageLabel = s.coverageStatus === "not_expected"
        ? "Not expected"
        : s.coverageStatus === "unavailable"
          ? "Unavailable"
          : `${Math.max(0, Math.min(100, Number(s.coveragePercent) || 0))}%${s.gapMinutes ? ` (${s.gapMinutes}m gap)` : ""}`;
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeEmailHtml(s.name)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${s.totalMinutes}m</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${escapeEmailHtml(coverageLabel)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Math.max(0, Number(s.unclassifiedMinutes) || 0)}m</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Math.max(0, Number(s.offTaskMinutes) || 0)}m / ${Math.max(0, Number(s.offTaskCount) || 0)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${domains || "No observed browser telemetry"}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1e293b;">📋 ClassPilot Session Summary</h2>
      ${copyNoticeHtml}
      <p>Hi ${safeTeacherName},</p>
      <p>Here's your session summary for <strong>${safeClassName}</strong>.</p>
      ${safetySection}
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #f8fafc; border-radius: 6px;">
        <tr><td style="padding: 8px 12px; font-weight: bold;">Date</td><td style="padding: 8px 12px;">${safeDate}</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Time</td><td style="padding: 8px 12px;">${safeStartTime} — ${safeEndTime} (${safeDuration})</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Students</td><td style="padding: 8px 12px;">${Number(studentCount) || 0}</td></tr>
      </table>
      <h3 style="margin-top: 24px; color: #1e293b;">Observed browser telemetry</h3>
      <p style="color: #64748b; font-size: 13px;">Activity and time calculations are derived from authenticated 10-second heartbeats. Screenshots are not used to calculate monitored, domain, unclassified, or off-task time.</p>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f1f5f9;">
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Student</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Observed Time</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Monitoring coverage</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Unclassified</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Off-task / events</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Top Sites</th>
          </tr>
        </thead>
        <tbody>${studentRows}</tbody>
      </table>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">Generated by ClassPilot · SchoolPilot</p>
    </div>
  `;

  return {
    subject: sanitizeEmailSubject(`ClassPilot Session Summary — ${className} (${date})`),
    html,
  };
}

export function buildSessionSummaryEmail(options: SessionSummaryEmailOptions): { subject: string; html: string } {
  return (options.reportVersion || 1) >= 2
    ? buildSessionSummaryEmailV2(options)
    : buildSessionSummaryEmailV1(options);
}

export async function sendSessionSummaryEmailWithResult(
  options: SessionSummaryEmailOptions
): Promise<EmailSendResult> {
  const message = buildSessionSummaryEmail(options);
  return sendEmailWithResult({
    to: options.to,
    ...message,
    customArgs: options.deliveryId
      ? { classpilot_summary_delivery_id: options.deliveryId }
      : undefined,
  });
}

export async function sendSessionSummaryEmail(options: SessionSummaryEmailOptions): Promise<boolean> {
  return (await sendSessionSummaryEmailWithResult(options)).status === "sent";
}
