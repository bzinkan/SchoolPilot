import { createHash } from "node:crypto";
import { z } from "zod";
import { PASSPILOT_RULE_DESTINATIONS } from "../schema/passpilot.js";

const id = z.string().min(1).max(128);
const date = z.string().datetime({ offset: true }).transform(value => new Date(value));
const fields = {
  from: date, through: date, studentId: id.optional(), classId: id.optional(), gradeId: id.optional(),
  teacherId: id.optional(), destination: z.enum([...PASSPILOT_RULE_DESTINATIONS, "custom"]).optional(),
  issuedVia: z.enum(["teacher", "kiosk"]).optional(),
};
const validRange = (value: { from: Date; through: Date; classId?: string; gradeId?: string }) =>
  value.through > value.from && value.through.getTime() - value.from.getTime() <= 366 * 86_400_000
  && !(value.classId && value.gradeId);
export const passpilotReportFiltersSchema = z.object(fields).strict().refine(validRange,
  "Choose a positive report range up to 366 elapsed days and at most one class source.");
export const passpilotReportPageSchema = z.object({ ...fields,
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(1024).optional(),
}).strict().refine(validRange);
export const passpilotReportExportSchema = z.object({ ...fields, kind: z.enum(["passes", "summary"]) }).strict().refine(validRange);
export type PasspilotReportFilters = z.infer<typeof passpilotReportFiltersSchema>;
export type PasspilotReportCursor = { issuedAtMs: string; id: string; scope: string };

const cursorSchema = z.object({ issuedAtMs: z.string().regex(/^-?\d{1,16}$/), id,
  scope: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function reportScopeFingerprint(schoolId: string, actorId: string, role: string, filters: PasspilotReportFilters) {
  return createHash("sha256").update(JSON.stringify([schoolId, actorId, role, filters.from.toISOString(),
    filters.through.toISOString(), filters.studentId ?? null, filters.classId ?? null, filters.gradeId ?? null,
    filters.teacherId ?? null, filters.destination ?? null, filters.issuedVia ?? null])).digest("hex");
}
export function decodeReportCursor(encoded: string, scope: string): PasspilotReportCursor {
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (cursor.scope !== scope) throw new Error("Report scope changed");
    return cursor;
  } catch { throw reportError(400, "PASSPILOT_REPORT_CURSOR_INVALID", "Report filters or access changed. Start from the first page."); }
}
export function encodeReportCursor(cursor: PasspilotReportCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function reportError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

/** Quote every field and prevent whitespace/control-prefixed spreadsheet formulas. */
export function encodePasspilotReportCsv(rows: readonly (readonly unknown[])[]) {
  return "\ufeff" + rows.map(row => row.map(value => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n") + "\r\n";
}
