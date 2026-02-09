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

export async function sendBroadcastEmail(recipients: string[], subject: string, message: string): Promise<number> {
  let sent = 0;
  for (const to of recipients) {
    const ok = await sendEmail({ to, subject, html: message });
    if (ok) sent++;
  }
  return sent;
}
