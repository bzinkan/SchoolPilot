import { z } from "zod";

export const MYDESK_CATEGORIES = [
  { key: "note", label: "Note" }, { key: "detention", label: "Detention" },
  { key: "referral", label: "Referral" }, { key: "uniform", label: "Uniform" },
  { key: "positive", label: "Positive" }, { key: "parent_contact", label: "Parent contact" },
  { key: "other", label: "Other" },
] as const;
export const myDeskId = z.string().trim().min(1).max(128);
export const myDeskRevision = z.number().int().positive();
export const myDeskCategory = z.enum(["note", "detention", "referral", "uniform", "positive", "parent_contact", "other"]);
export const myDeskDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value + "T00:00:00.000Z");
  return !value.startsWith("0000-") && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "Use a real calendar date");
const fields = {
  targetKind: z.enum(["general", "class", "student"]),
  groupId: myDeskId.nullable().optional(), studentId: myDeskId.nullable().optional(),
  category: myDeskCategory, title: z.string().trim().max(160),
  body: z.string().trim().max(5000), entryDate: myDeskDate, pinned: z.boolean(),
};
export const createMyDeskNoteInput = z.object({
  ...fields, clientRequestId: z.string().uuid(), targetKind: fields.targetKind.default("general"),
  category: fields.category.default("note"), title: fields.title.default(""), body: fields.body.default(""),
  entryDate: fields.entryDate.optional(), pinned: fields.pinned.default(false),
}).strict();
const patchFields = z.object(fields).partial();
export const updateMyDeskNoteInput = patchFields.extend({ revision: myDeskRevision }).strict()
  .refine(input => Object.keys(input).some(key => key !== "revision"), "Provide a change");
export const completeMyDeskNoteInput = patchFields.extend({
  revision: myDeskRevision, attachmentIds: z.array(myDeskId).max(5).optional(),
}).strict().refine(input => !input.attachmentIds || new Set(input.attachmentIds).size === input.attachmentIds.length, "Attachment IDs must be unique");
export const deleteMyDeskNoteInput = z.object({ revision: myDeskRevision }).strict();
export const myDeskNotesQuery = z.object({
  scope: z.enum(["all", "general", "past", "class"]).default("all"),
  classId: myDeskId.optional(), studentId: myDeskId.optional(), category: myDeskCategory.optional(),
  from: myDeskDate.optional(), to: myDeskDate.optional(), q: z.string().trim().max(200).optional(),
  cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict().superRefine((input, context) => {
  if (input.scope === "class" && !input.classId) context.addIssue({ code: "custom", path: ["classId"], message: "Choose a class" });
  if (input.from && input.to && input.from > input.to) context.addIssue({ code: "custom", path: ["to"], message: "End date precedes start date" });
});
export type MyDeskCreateInput = z.infer<typeof createMyDeskNoteInput>;
export type MyDeskPatch = z.infer<typeof patchFields>;
export type MyDeskNotesQuery = z.infer<typeof myDeskNotesQuery>;

export function myDeskEnabledForSchool(schoolId: string): boolean {
  return enabledSchool(schoolId, process.env.MYDESK_ENABLED_SCHOOL_IDS);
}
export function myDeskSeatingEnabledForSchool(schoolId: string): boolean {
  return myDeskEnabledForSchool(schoolId) && enabledSchool(schoolId, process.env.MYDESK_SEATING_ENABLED_SCHOOL_IDS);
}
function enabledSchool(schoolId: string, configured: string | undefined): boolean {
  const raw = (configured || "").trim();
  if (!raw) return false;
  if (raw === "*") return process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "production";
  const ids = raw.split(",").map(value => value.trim());
  if (ids.some(value => !/^[a-zA-Z0-9_-]{1,128}$/.test(value))) return false;
  return ids.includes(schoolId);
}

export function myDeskCsvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}
