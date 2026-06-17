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

export async function sendEmail(options: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.log(`[Email] Would send to ${options.to}: ${options.subject}`);
    return true;
  }

  try {
    const msg: any = {
      to: options.to,
      from: FROM_EMAIL,
      subject: options.subject,
    };
    if (options.html) msg.html = options.html;
    if (options.text) msg.text = options.text;
    if (!msg.html && !msg.text) msg.text = options.subject;
    await sgMail.send(msg);
    return true;
  } catch (error: any) {
    console.error("[Email] Send failed:", error?.message || error);
    if (error?.response?.body) {
      console.error("[Email] SendGrid response:", JSON.stringify(error.response.body));
    }
    // Track in error monitor (skip if this IS an alert email to avoid recursion)
    if (!options.subject.startsWith("[SchoolPilot ALERT]")) {
      try {
        const monitor = await getErrorMonitor();
        // Do NOT pass the recipient address — it's PII and not needed to debug
        // a send failure. The error message itself carries the actionable cause.
        monitor.trackError("email_failure", error);
      } catch { /* avoid recursion */ }
    }
    return false;
  }
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
  alertType: string;
  url: string;
  title: string;
  schoolName: string;
}): Promise<number> {
  const { recipients, studentEmail, alertType, url, title, schoolName } = options;
  const alertLabel = alertType.charAt(0).toUpperCase() + alertType.slice(1).replace("-", " ");
  const subject = `⚠️ Safety Alert: ${alertLabel} detected — ${schoolName}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">⚠️ AI Safety Alert</h2>
      <p>ClassPilot detected potentially dangerous content on a student device.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Alert Type</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #dc2626;">${alertLabel}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Student</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${studentEmail}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Page Title</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${title || "Unknown"}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">URL</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; word-break: break-all;">${url}</td></tr>
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

export async function sendSessionSummaryEmail(options: {
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
    safetyAlerts?: string[];
    safetyUrls?: string[];
  }>;
}): Promise<boolean> {
  const { to, teacherName, className, date, startTime, endTime, duration, studentCount, students } = options;

  // Build safety incidents section if any exist
  const safetyIncidents = students
    .filter(s => s.safetyAlerts && s.safetyAlerts.length > 0)
    .map(s => `<tr><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca;">${s.name}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; color: #dc2626; font-weight: bold;">${s.safetyAlerts!.join(", ")}</td><td style="padding: 6px 8px; border-bottom: 1px solid #fecaca; font-size: 13px;">${s.safetyUrls?.join(", ") || ""}</td></tr>`)
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
        .map((d) => `${d.domain} (${d.minutes}m)`)
        .join(", ");
      const offTaskMinutes = Math.round(((s.offTaskCount || 0) * 10) / 60);
      const offTaskCell = offTaskMinutes > 0
        ? `<span style="color: #dc2626; font-weight: bold;">${offTaskMinutes}m</span>`
        : `<span style="color: #16a34a;">0m</span>`;
      const safetyCell = s.safetyAlerts && s.safetyAlerts.length > 0
        ? `<span style="color: #dc2626; font-weight: bold;">${s.safetyAlerts.join(", ")}</span>`
        : "";
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${s.name}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${s.totalMinutes}m</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${offTaskCell}${safetyCell ? ` ${safetyCell}` : ""}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${domains || "No activity"}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1e293b;">📋 ClassPilot Session Summary</h2>
      <p>Hi ${teacherName},</p>
      <p>Here's your session summary for <strong>${className}</strong>.</p>
      ${safetySection}
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #f8fafc; border-radius: 6px;">
        <tr><td style="padding: 8px 12px; font-weight: bold;">Date</td><td style="padding: 8px 12px;">${date}</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Time</td><td style="padding: 8px 12px;">${startTime} — ${endTime} (${duration})</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Students</td><td style="padding: 8px 12px;">${studentCount}</td></tr>
      </table>
      <h3 style="margin-top: 24px; color: #1e293b;">Student Activity</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f1f5f9;">
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Student</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Active Time</th>
            <th style="padding: 8px; text-align: center; border-bottom: 2px solid #e2e8f0;">Off-Task</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0;">Top Sites</th>
          </tr>
        </thead>
        <tbody>${studentRows}</tbody>
      </table>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">Generated by ClassPilot · SchoolPilot</p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `ClassPilot Session Summary — ${className} (${date})`,
    html,
  });
}
