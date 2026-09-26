import { z } from "zod";
import { myDeskCategory, myDeskDate, myDeskId } from "./mydeskValidation.js";
export const disciplineId = myDeskId;
const attachments = z.array(disciplineId).max(5).refine(ids => new Set(ids).size === ids.length, "Choose each attachment once");
const mutation = { clientRequestId: z.string().uuid(), revision: z.number().int().nonnegative() };
export const disciplineSubmitInput = z.object({ clientRequestId: mutation.clientRequestId, noteId: disciplineId,
  noteRevision: z.number().int().positive(), attachmentIds: attachments }).strict();
export const disciplineCorrectInput = z.object({ ...mutation, reason: z.string().trim().min(1).max(2000),
  groupId: disciplineId, studentId: disciplineId, category: myDeskCategory, title: z.string().trim().max(160),
  body: z.string().trim().max(5000), entryDate: myDeskDate, attachmentIds: attachments,
  sourceNoteId: disciplineId.optional(), sourceNoteRevision: z.number().int().positive().optional(),
}).strict().refine(x => Boolean(x.sourceNoteId) === Boolean(x.sourceNoteRevision), "Provide the source note and its revision together");
export const disciplineWithdrawInput = z.object({ ...mutation, reason: z.string().trim().min(1).max(2000) }).strict();
export const disciplineAccessInput = z.object({ ...mutation, enabled: z.boolean() }).strict();
export const disciplineSearchInput = z.object({ scope: z.enum(["own", "school"]).default("own"),
  status: z.enum(["submitted", "withdrawn", "all"]).default("submitted"), studentId: disciplineId.optional(), submitterId: disciplineId.optional(),
  sourceNoteId: disciplineId.optional(), category: myDeskCategory.optional(), from: myDeskDate.optional(), to: myDeskDate.optional(),
  studentName: z.string().trim().max(200).optional(), submitterName: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict().refine(x => !x.from || !x.to || x.from <= x.to, "End date precedes start date")
  .refine(x => !x.sourceNoteId || x.scope === "own", "Private note links require your own records");
export type DisciplineSubmit = z.infer<typeof disciplineSubmitInput>;
export type DisciplineCorrect = z.infer<typeof disciplineCorrectInput>;
export type DisciplineWithdraw = z.infer<typeof disciplineWithdrawInput>;
export type DisciplineSearch = z.infer<typeof disciplineSearchInput>;
export const disciplineError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code: `DISCIPLINE_${code}`, expose: true });
