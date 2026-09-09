import { createHash } from "node:crypto";

export const MONITORING_HISTORY_PAGE_SIZE = 50;
export type MonitoringHistoryFilter = "open" | "recent";
type Cursor = { version: 1; scope: string; filter: MonitoringHistoryFilter; asOf: string; detectedAt: string; id: string };
export const monitoringHistoryScope = (schoolId: string, actorId: string, isAdmin: boolean) =>
  createHash("sha256").update(JSON.stringify([schoolId, actorId, isAdmin])).digest("hex");
export function invalidMonitoringHistory() {
  return Object.assign(new Error("This history request is invalid or expired. Refresh the history and try again."), { status: 400, code: "MONITORING_HISTORY_INVALID" });
}
export function decodeMonitoringHistoryCursor(value: string | undefined, scope: string, filter: MonitoringHistoryFilter, now: Date): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidMonitoringHistory();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date;
    if (cursor.version !== 1 || cursor.scope !== scope || cursor.filter !== filter || !validDate(cursor.asOf) || !validDate(cursor.detectedAt)
      || typeof cursor.id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(cursor.id)
      || Date.parse(cursor.asOf) > now.getTime() || now.getTime() - Date.parse(cursor.asOf) > 15 * 60_000
      || Date.parse(cursor.detectedAt) > Date.parse(cursor.asOf)) throw invalidMonitoringHistory();
    return cursor;
  } catch { throw invalidMonitoringHistory(); }
}
export function encodeMonitoringHistoryCursor(cursor: Omit<Cursor, "version">): string {
  return Buffer.from(JSON.stringify({ version: 1, ...cursor })).toString("base64url");
}
