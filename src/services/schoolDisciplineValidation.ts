import { z } from "zod";
import { myDeskCategory, myDeskDate, myDeskId } from "./mydeskValidation.js";
export const disciplineId = myDeskId;
const attachments = z.array(disciplineId).max(5).refine(ids => new Set(ids).size === ids.length, "Choose each attachment once");
const mutation = { clientRequestId: z.string().uuid(), revision: z.number().int().nonnegative() };
export const disciplineSubmitInput = z.object({ clientRequestId: mutation.clientRequestId, noteId: disciplineId,
  noteRevision: z.number().int().positive(), attachmentIds: attachments }).strict();
export const disciplineCorrectInput = z.object({ ...mutation, reason: z.string().trim().min(1).max(2000),
  groupId: disciplineId.nullable().optional(), studentId: disciplineId, category: myDeskCategory, title: z.string().trim().max(160),
  body: z.string().trim().max(5000), entryDate: myDeskDate, attachmentIds: attachments,
  referralRecorded: z.boolean().optional(), detentionAssigned: z.boolean().optional(), detentionDates: z.array(myDeskDate).max(30).optional(),
  sourceNoteId: disciplineId.optional(), sourceNoteRevision: z.number().int().positive().optional(),
}).strict().refine(x => Boolean(x.sourceNoteId) === Boolean(x.sourceNoteRevision), "Provide the source note and its revision together");
export const disciplineWithdrawInput = z.object({ ...mutation, reason: z.string().trim().min(1).max(2000) }).strict();
export const disciplineAccessInput = z.object({ ...mutation, enabled: z.boolean() }).strict();
export const disciplineSearchInput = z.object({ scope: z.enum(["own", "assigned", "school"]).default("assigned"),
  status: z.enum(["submitted", "withdrawn", "all"]).default("submitted"), studentId: disciplineId.optional(), submitterId: disciplineId.optional(),
  sourceNoteId: disciplineId.optional(), category: myDeskCategory.optional(), from: myDeskDate.optional(), to: myDeskDate.optional(),
  studentName: z.string().trim().max(200).optional(), submitterName: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  gradeLevel: z.string().trim().max(30).optional(), groupId: disciplineId.optional(),
  incidentType: z.enum(["referral", "detention"]).optional(),
}).strict().refine(x => !x.from || !x.to || x.from <= x.to, "End date precedes start date")
  .refine(x => !x.sourceNoteId || x.scope === "own", "Private note links require your own records");
export type DisciplineSubmit = z.infer<typeof disciplineSubmitInput>;
export type DisciplineCorrect = z.infer<typeof disciplineCorrectInput>;
export type DisciplineWithdraw = z.infer<typeof disciplineWithdrawInput>;
export type DisciplineSearch = z.infer<typeof disciplineSearchInput>;
export const disciplineError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code: `DISCIPLINE_${code}`, expose: true });

const directFields = { studentId: disciplineId, groupId: disciplineId.nullable().optional(),
  category: myDeskCategory.default("referral"), title: z.string().trim().max(160).default(""), body: z.string().trim().max(5000).default(""),
  entryDate: myDeskDate, referralRecorded: z.boolean(), detentionAssigned: z.boolean(), detentionDates: z.array(myDeskDate).max(30).default([]) };
export const disciplineDraftInput = z.object({ clientRequestId: mutation.clientRequestId, ...directFields }).strict();
export const disciplineDraftUpdateInput = z.object({ ...mutation, ...directFields }).strict();
export const disciplineFinalizeInput = z.object({ ...mutation, attachmentIds: attachments,
  reviewed: z.literal(true), acknowledgedDuplicateIds: z.array(disciplineId).max(100).default([]),
  acknowledgedDuplicates: z.array(z.object({ id: disciplineId, revision: z.number().int().positive() }).strict()).max(100).default([]),
  duplicateAction: z.enum(["separate", "add_evidence"]).default("separate"), existingRecordId: disciplineId.optional(),
  existingRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict()
  .refine(input => input.duplicateAction !== "add_evidence" || Boolean(input.existingRecordId && input.existingRevision && input.reason), "Choose an existing incident and a correction reason");
export const disciplineDraftCancelInput = z.object(mutation).strict();
export const disciplineAttachmentInput = z.object({ clientRequestId: mutation.clientRequestId, revision: mutation.revision,
  filename: z.string().trim().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f/\\]/.test(value)),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().min(1).max(10485760), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const disciplineStudentsInput = z.object({ scope: z.enum(["assigned", "school"]).default("assigned"),
  gradeLevel: z.string().trim().max(30).optional(), groupId: disciplineId.optional(), q: z.string().trim().max(200).default(""),
  from: myDeskDate.optional(), to: myDeskDate.optional(), period: z.enum(["school_year", "all", "custom"]).default("school_year"),
  cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  incidentType: z.enum(["referral", "detention"]).optional(), submitterId: disciplineId.optional(), submitterName: z.string().trim().max(200).optional(),
  includeInactive: z.boolean().default(false) }).strict().refine(input => !input.from || !input.to || input.from <= input.to, "End date precedes start date");
export type DisciplineDraft = z.infer<typeof disciplineDraftInput>;
export type DisciplineStudentsQuery = z.infer<typeof disciplineStudentsInput>;
