import { createHash } from "node:crypto";

export const ROSTER_LIMITS = Object.freeze({ compressedBytes: 25 * 1024 * 1024, expandedBytes: 250 * 1024 * 1024, entries: 100, rows: 250_000, fieldBytes: 16_384 });
export type RosterProvider = "oneroster" | "clever";
export type RosterPerson = { id: string; firstName: string; lastName: string; email: string | null; studentNumber: string | null; grade: string | null; schoolIds: string[]; roles: Array<"student" | "teacher"> };
export type RosterClass = { id: string; schoolId: string; name: string; grade: string | null; term: string | null; primaryTeacherId: string; coTeacherIds: string[]; studentIds: string[] };
export type RosterPackage = { provider: RosterProvider; version: string; complete: boolean; organizations: Array<{ id: string; name: string; type: string }>; people: RosterPerson[]; classes: RosterClass[]; warnings: string[] };
export type RosterMapping = { organizationIds: string[]; people?: Record<string, string>; classes?: Record<string, string>; adoptPeople?: string[]; adoptClasses?: string[] };
export function rosterError(code: string, message: string, status = 400): Error & { code: string; status: number; expose: boolean } { return Object.assign(new Error(message), { code, status, expose: true }); }
export function rosterHash(value: unknown): string {
  const canonical=(item:unknown):unknown=>item instanceof Date?item.toISOString():Array.isArray(item)?item.map(canonical):item&&typeof item==="object"?Object.fromEntries(Object.keys(item).sort().filter(key=>(item as Record<string,unknown>)[key]!==undefined).map(key=>[key,canonical((item as Record<string,unknown>)[key])])):item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function normalizedRosterEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw rosterError("ROSTER_EMAIL_INVALID", "A roster email address is invalid.");
  return email;
}
export function normalizedRosterGrade(value: unknown): string | null {
  const grade = String(value ?? "").trim();
  if (!grade) return null;
  if (/^(PK|prekindergarten|preschool)$/i.test(grade)) return "PK";
  if (/^(K|KG|kindergarten|transitionalkindergarten)$/i.test(grade)) return "K";
  if (/^\d{1,2}$/.test(grade) && Number(grade) >= 1 && Number(grade) <= 12) return String(Number(grade));
  return null;
}
export function rosterRemovalHeld(removed: number, previous: number): boolean { return removed > 50 || (previous > 0 && removed / previous > 0.10); }
export function rosterLocalSchedule(now: Date, timeZone: string): { date: string; due: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)?.value || "";
  // Spring-forward runs at the first available hour after 02:00; the local date claim prevents a fall-back duplicate.
  return { date: `${value("year")}-${value("month")}-${value("day")}`, due: Number(value("hour")) >= 2 };
}
export function selectRosterSchool(snapshot: RosterPackage, mapping: RosterMapping): RosterPackage {
  const selected = new Set(mapping.organizationIds);
  if (!selected.size || [...selected].some(id => !snapshot.organizations.some(org => org.id === id && org.type === "school"))) throw rosterError("ROSTER_ORG_MAPPING_REQUIRED", "Select the external school organizations that belong to this school.");
  const classes = snapshot.classes.filter(row => selected.has(row.schoolId));
  const referenced = new Set(classes.flatMap(row => [row.primaryTeacherId, ...row.coTeacherIds, ...row.studentIds]));
  return { ...snapshot, classes, people: snapshot.people.filter(row => row.schoolIds.some(id => selected.has(id)) || referenced.has(row.id)) };
}
