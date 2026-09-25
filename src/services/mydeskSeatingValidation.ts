import { z } from "zod";
import { myDeskId, myDeskRevision } from "./mydeskValidation.js";

export const SEATING_ROOM_WIDTH = 1200;
export const SEATING_ROOM_HEIGHT = 900;
export const SEATING_DESK_WIDTH = 100;
export const SEATING_DESK_HEIGHT = 60;
export const SEATING_GRID = 10;
export const SEATING_MAX_DESKS = 100;

const seat = z.object({
  id: z.string().uuid(),
  x: z.number().int().min(0).max(SEATING_ROOM_WIDTH - SEATING_DESK_WIDTH).multipleOf(SEATING_GRID),
  y: z.number().int().min(0).max(SEATING_ROOM_HEIGHT - SEATING_DESK_HEIGHT).multipleOf(SEATING_GRID),
  studentId: myDeskId.nullable(),
  locked: z.boolean(),
}).strict();

export const seatingLayout = z.object({
  version: z.literal(1), seats: z.array(seat).max(SEATING_MAX_DESKS),
}).strict().superRefine((layout, context) => {
  const ids = new Set<string>();
  const students = new Set<string>();
  layout.seats.forEach((item, index) => {
    const issue = (message: string) => context.addIssue({ code: "custom", path: ["seats", index], message });
    if (ids.has(item.id)) issue("Each desk must have a unique ID");
    ids.add(item.id);
    if (item.studentId && students.has(item.studentId)) issue("A student may occupy only one desk");
    if (item.studentId) students.add(item.studentId);
    if (item.locked && !item.studentId) issue("Only an assigned seat can be locked");
    if (layout.seats.slice(0, index).some(other =>
      item.x < other.x + SEATING_DESK_WIDTH && item.x + SEATING_DESK_WIDTH > other.x &&
      item.y < other.y + SEATING_DESK_HEIGHT && item.y + SEATING_DESK_HEIGHT > other.y)) issue("Desks cannot overlap");
  });
});

const name = z.string().trim().min(1, "Name your chart").max(120);
const rosterRevision = z.string().regex(/^[a-f0-9]{64}$/, "Reload the class roster before saving");
export const seatingCreateInput = z.object({
  clientRequestId: z.string().uuid(), classId: myDeskId, name, layout: seatingLayout, rosterRevision,
}).strict();
export const seatingUpdateInput = z.object({
  requestId: z.string().uuid(), revision: myDeskRevision, name, layout: seatingLayout, rosterRevision,
}).strict();
export const seatingDuplicateInput = z.object({
  clientRequestId: z.string().uuid(), sourceRevision: myDeskRevision, targetClassId: myDeskId,
  mode: z.enum(["chart", "layout"]), name, rosterRevision,
}).strict();
export const seatingMutationInput = z.object({ requestId: z.string().uuid(), revision: myDeskRevision }).strict();
export const seatingListQuery = z.object({
  scope: z.enum(["current", "past"]).default("current"), classId: myDeskId.optional(),
  cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type SeatingLayout = z.infer<typeof seatingLayout>;
export type SeatingRosterEntry = { id: string; name: string };
