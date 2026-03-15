import sgMail from "@sendgrid/mail";

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
    await sgMail.send({
      to: options.to,
      from: FROM_EMAIL,
      subject: options.subject,
      text: options.text || "",
      html: options.html || "",
    });
    return true;
  } catch (error) {
    console.error("[Email] Send failed:", error);
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

export async function sendTrialRequestNotification(request: {
  schoolName: string;
  contactName: string;
  contactEmail: string;
  product?: string;
}): Promise<boolean> {
  return sendEmail({
    to: ADMIN_EMAIL,
    subject: `New Trial Request: ${request.schoolName}`,
    html: `
      <h2>New Trial Request</h2>
      <p><strong>School:</strong> ${request.schoolName}</p>
      <p><strong>Contact:</strong> ${request.contactName} (${request.contactEmail})</p>
      <p><strong>Product:</strong> ${request.product || "Not specified"}</p>
    `,
  });
}

export async function sendTrialRequestConfirmation(request: {
  contactName: string;
  contactEmail: string;
  schoolName: string;
}): Promise<boolean> {
  return sendEmail({
    to: request.contactEmail,
    subject: "Welcome to SchoolPilot — we're setting you up",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to SchoolPilot!</h2>
        <p>Hi ${request.contactName},</p>
        <p>Thanks for signing up! We're getting <strong>${request.schoolName}</strong> set up now — you'll receive a confirmation within 24 hours to begin your free SchoolPilot trial (good through June 1st).</p>
        <p>Once activated, you'll log in with your school Google account — no extra passwords needed.</p>
        <p>Here's what you'll get access to:</p>
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

export async function sendTrialExpirationEmail(options: {
  to: string;
  contactName: string;
  schoolName: string;
  trialEndsAt: string;
}): Promise<boolean> {
  return sendEmail({
    to: options.to,
    subject: "Your SchoolPilot trial is ending soon",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Your trial is ending soon</h2>
        <p>Hi ${options.contactName},</p>
        <p>Your free trial for <strong>${options.schoolName}</strong> ends on <strong>${options.trialEndsAt}</strong>.</p>
        <p>If you'd like to keep using SchoolPilot, we'd love to set you up on an annual plan — just $3/student/year for any single app, $5/student for two, or $7/student for all three.</p>
        <p>Reply to this email and we'll get you sorted.</p>
        <p style="margin-top: 24px;">— The SchoolPilot Team</p>
      </div>
    `,
  });
}

export async function sendTrialWelcomeEmail(options: {
  to: string;
  contactName: string;
  schoolName: string;
  products: string[];
  trialEndsAt?: string;
}): Promise<boolean> {
  const productDescriptions: Record<string, { name: string; desc: string }> = {
    CLASSPILOT: { name: "ClassPilot", desc: "Real-time Chromebook monitoring. View student screens, control web access, and keep your class on task." },
    PASSPILOT: { name: "PassPilot", desc: "Digital hall passes. Track student movement, set limits, and eliminate paper passes." },
    GOPILOT: { name: "GoPilot", desc: "Dismissal management. Coordinate car riders, buses, and walkers with real-time notifications." },
  };

  const productList = options.products
    .map((p) => productDescriptions[p])
    .filter((p): p is { name: string; desc: string } => Boolean(p))
    .map((p) => `<li><strong>${p.name}</strong> — ${p.desc}</li>`)
    .join("");

  const trialNote = options.trialEndsAt
    ? `Your free trial runs through <strong>${options.trialEndsAt}</strong>.`
    : "Your free trial runs through the end of the school year.";

  return sendEmail({
    to: options.to,
    subject: "Welcome to SchoolPilot — Your trial is ready!",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to SchoolPilot!</h2>
        <p>Hi ${options.contactName},</p>
        <p>Great news — your trial for <strong>${options.schoolName}</strong> is set up and ready to go!</p>
        <p>Here's what's included in your trial:</p>
        <ul>${productList}</ul>
        <h3>Getting Started</h3>
        <ol>
          <li>Go to <a href="https://school-pilot.net">school-pilot.net</a></li>
          <li>Click <strong>Sign In</strong> and log in with your school Google account</li>
          <li>You're in! Start exploring your dashboard.</li>
        </ol>
        <p>${trialNote}</p>
        <p>Questions? Just reply to this email — we're happy to help.</p>
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
  }>;
}): Promise<boolean> {
  const { to, teacherName, className, date, startTime, endTime, duration, studentCount, students } = options;

  const studentRows = students
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .map((s) => {
      const domains = s.topDomains
        .slice(0, 5)
        .map((d) => `${d.domain} (${d.minutes}m)`)
        .join(", ");
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${s.name}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${s.totalMinutes}m</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${domains || "No activity"}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1e293b;">📋 ClassPilot Session Summary</h2>
      <p>Hi ${teacherName},</p>
      <p>Here's your session summary for <strong>${className}</strong>.</p>
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
