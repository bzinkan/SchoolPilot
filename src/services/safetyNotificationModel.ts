import type { EmailSendResult } from "./email.js";

type Row = Record<string, any>;
export const SAFETY_NOTIFICATION_BUNDLES_PER_PASS = 20;
export const SAFETY_EMAIL_DETAIL_LIMIT = 20;
export const SAFETY_EMAIL_REPORT_LIMIT = 20;

export function safetyNotificationBundleKey(entry: Row): string {
  return JSON.stringify([entry.school_id, entry.recipient, entry.kind, entry.kind === "initial" ? entry.case_id : null]);
}
export function safetyNotificationRetry(attempts: number, status: EmailSendResult["status"]): { status: string; delaySeconds: number } {
  if (status === "sent") return { status: "sent", delaySeconds: 0 };
  if (status === "unknown") return { status: "unknown", delaySeconds: 0 };
  if (status === "permanent_failure" || attempts >= 5) return { status: "failed", delaySeconds: 0 };
  return { status: "pending", delaySeconds: Math.min(3600, 30 * 2 ** attempts) };
}

/** Bound message size, not the delivery cohort. Every accepted row shares the one provider outcome. */
export function safetyEmailText(items: Row[], timezone: string, origin: string): string {
  const format = (value: any) => {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
    catch { return new Date(value).toISOString(); }
  };
  const rank = (row: Row) => ({ critical: 4, high: 3, medium: 2, low: 1 }[String(row.severity)] || 0);
  const reports = new Map<string, Row[]>();
  for (const item of items) {
    const entries = reports.get(item.case_id) || [];
    entries.push(item); reports.set(item.case_id, entries);
  }
  for (const alerts of reports.values()) alerts.sort((a, b) => rank(b) - rank(a) || String(a.first_seen_at).localeCompare(String(b.first_seen_at)) || String(a.id).localeCompare(String(b.id)));
  const ordered = [...reports.entries()].sort(([idA, a], [idB, b]) => rank(b[0]!) - rank(a[0]!) || idA.localeCompare(idB));
  let remainingDetails = SAFETY_EMAIL_DETAIL_LIMIT;
  const sections = ordered.slice(0, SAFETY_EMAIL_REPORT_LIMIT).map(([caseId, alerts]) => {
    const student = ([alerts[0]?.first_name, alerts[0]?.last_name].filter(Boolean).join(" ") || "Student").slice(0, 160);
    const details = alerts.slice(0, remainingDetails); remainingDetails -= details.length;
    const omitted = alerts.length - details.length;
    return `${student} — ${alerts.length} alert(s)\n${details.map(a => `• ${String(a.concern).slice(0, 120)} (${String(a.severity).slice(0, 40)}) — ${format(a.first_seen_at)} ${timezone}${a.reason ? `\n  ${String(a.reason).slice(0, 300)}` : ""}`).join("\n")}${omitted ? `\n${omitted} additional alert(s) are included in this notification. See the complete report for their details.` : ""}\nReview the authenticated student report: ${origin}/classpilot/admin/safety?case=${encodeURIComponent(caseId)}`;
  });
  const omittedReports = ordered.slice(SAFETY_EMAIL_REPORT_LIMIT);
  if (omittedReports.length) sections.push(`${omittedReports.reduce((count, [, alerts]) => count + alerts.length, 0)} additional alert(s) across ${omittedReports.length} more student report(s) are included in this notification.\nReview all authenticated student reports: ${origin}/classpilot/admin/safety`);
  return `${items.length} safety alert(s) across ${reports.size} student report(s).\n\n${sections.join("\n\n")}\n\nAdministrators determine whether action is appropriate. Repeated observations do not create repeated initial emails.`;
}
