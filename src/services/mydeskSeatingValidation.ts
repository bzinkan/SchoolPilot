import { z } from "zod";
import { myDeskId, myDeskRevision } from "./mydeskValidation.js";
import { measuredLayoutProblem } from "../shared/mydeskSeatingGeometry.js";

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

const legacyLayout = z.object({
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

const dimension = z.number().int().min(10).max(50000);
const coordinate = z.number().int().min(0).max(50000);
const rect = { id: z.string().uuid(), x: coordinate, y: coordinate, width: dimension, height: dimension,
  rotation: z.number().min(0).lt(360).multipleOf(0.1) };
const measuredSeat = z.object({ ...rect, studentId: myDeskId.nullable(), locked: z.boolean() }).strict();
const solid = z.object({ ...rect, kind: z.enum(["teacherDesk", "cabinet", "lockers", "interiorWall"]), label: z.string().trim().max(60).optional() }).strict();
const opening = z.object({ id: z.string().uuid(), kind: z.enum(["door", "window"]), wallId: z.string().uuid(),
  offset: coordinate, width: dimension, hinge: z.enum(["start", "end"]), swing: z.enum(["in", "out"]), label: z.string().trim().max(60).optional() }).strict();
export const measuredSeatingLayout = z.object({
  version: z.literal(2), units: z.literal("mm"), displayUnit: z.enum(["imperial", "metric"]),
  room: z.object({ vertices: z.array(z.object({ id: z.string().uuid(), wallId: z.string().uuid(), x: coordinate, y: coordinate }).strict()).min(3).max(24), frontWallId: z.string().uuid() }).strict(),
  seats: z.array(measuredSeat).max(100), features: z.array(z.union([solid, opening])).max(100),
}).strict().superRefine((layout, context) => {
  const problem = measuredLayoutProblem(layout);
  if (problem) context.addIssue({ code: "custom", message: problem });
  const students = layout.seats.map(s => s.studentId).filter(Boolean);
  if (new Set(students).size !== students.length) context.addIssue({ code: "custom", message: "A student may occupy only one desk" });
  if (layout.seats.some(s => s.locked && !s.studentId)) context.addIssue({ code: "custom", message: "Only an assigned seat can be locked" });
});
export const seatingLayout = z.union([legacyLayout, measuredSeatingLayout]);

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
