import { z } from "zod";
import { addLocalDays, localDateTimeUtc } from "../util/schoolTime.js";
import { isSchedulingDate, type SchedulingCalendar } from "./classpilotSchedulingRules.js";

export const KIOSK_ACTIVITY_CAPABILITY = "scheduled-activities-v1";
export const kioskModeSchema = z.enum(["manual", "passpilot", "classpilot"]);
export type KioskMode = z.infer<typeof kioskModeSchema>;
const date = z.string().refine(isSchedulingDate, "Choose a valid date.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM.");
const block = z.object({
  id: z.string().min(1).max(80), classId: z.string().min(1).max(128),
  startTime: time, endTime: time,
}).strict();
const weeklyBlock = block.extend({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startsOn: date.nullable().default(null), endsOn: date.nullable().default(null),
}).strict();
export const kioskScheduleSchema = z.object({
  blocks: z.array(weeklyBlock).max(100),
  exceptions: z.array(z.object({ date, blocks: z.array(block).max(100) }).strict()).max(366),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const validateBlocks = (blocks: z.infer<typeof block>[]) => {
    if (new Set(blocks.map(b => b.id)).size !== blocks.length) fail("Block IDs must be unique.");
    if (blocks.some(b => b.startTime >= b.endTime)) fail("Each block must end after it starts on the same day.");
  };
  validateBlocks(value.blocks);
  for (const b of value.blocks) {
    if (new Set(b.weekdays).size !== b.weekdays.length) fail("Weekdays must be unique.");
    if (b.startsOn && b.endsOn && b.startsOn > b.endsOn) fail("The end date must follow the start date.");
  }
  if (new Set(value.exceptions.map(e => e.date)).size !== value.exceptions.length) fail("Choose only one replacement schedule per date.");
  for (const exception of value.exceptions) {
    validateBlocks(exception.blocks);
    for (let i = 0; i < exception.blocks.length; i++) for (const other of exception.blocks.slice(i + 1)) {
      if (overlaps(exception.blocks[i]!, other)) fail(`Blocks overlap on ${exception.date}.`);
    }
  }
  for (let i = 0; i < value.blocks.length; i++) for (const other of value.blocks.slice(i + 1)) {
    const a = value.blocks[i]!;
    const start = [a.startsOn || "0001-01-01", other.startsOn || "0001-01-01"].sort()[1]!;
    const end = [a.endsOn || "9999-12-31", other.endsOn || "9999-12-31"].sort()[0]!;
    if (start > end || !overlaps(a, other)) continue;
    const weekdays = a.weekdays.filter(day => other.weekdays.includes(day));
    const firstWeekday = new Date(`${start}T12:00:00Z`).getUTCDay();
    if (weekdays.some(day => addLocalDays(start, (day - firstWeekday + 7) % 7) <= end)) fail("Weekly blocks overlap.");
  }
});
export type KioskSchedule = z.infer<typeof kioskScheduleSchema>;
export const emptyKioskSchedule = (): KioskSchedule => ({ blocks: [], exceptions: [] });
function overlaps(a: { startTime: string; endTime: string }, b: { startTime: string; endTime: string }) {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}
export function kioskError(message: string, code = "PASSPILOT_KIOSK_ASSIGNMENT_CHANGED", status = 409) {
  return Object.assign(new Error(message), { code, status, expose: true });
}
export type KioskAssignment = {
  id: string; kind: "class" | "testing" | "coverage"; name: string;
  classId: string | null; supervisionContextId: string | null; teachingSessionId?: string; authorityRevision?: number;
  startsAt: string; endsAt: string; state: "ready" | "pending" | "failed";
};
export function standaloneKioskWindows(schedule: KioskSchedule, localDate: string, timezone: string, calendar: SchedulingCalendar): KioskAssignment[] {
  if (calendar[localDate.slice(0, 7)]?.nonInstructionalDates?.includes(localDate)) return [];
  const replacement = schedule.exceptions.find(e => e.date === localDate);
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  const blocks = replacement?.blocks ?? schedule.blocks.filter(b => b.weekdays.includes(weekday)
    && (!b.startsOn || b.startsOn <= localDate) && (!b.endsOn || b.endsOn >= localDate));
  return blocks.map(b => ({ id: `passpilot:${localDate}:${b.id}`, kind: "class", name: "Class",
    classId: b.classId, supervisionContextId: null, state: "ready",
    startsAt: localDateTimeUtc(localDate, b.startTime, timezone).toISOString(),
    endsAt: localDateTimeUtc(localDate, b.endTime, timezone).toISOString() }));
}
export function selectKioskAssignment(candidates: KioskAssignment[], now: Date, midnight: Date) {
  const instant = now.getTime();
  const eligibleAt = (at: number) => {
    const present = candidates.filter(c => Date.parse(c.startsAt) <= at && Date.parse(c.endsAt) > at);
    const supervision = present.filter(c => c.kind !== "class");
    return (supervision.length ? supervision : present).sort((a, b) => a.id.localeCompare(b.id));
  };
  const eligible = eligibleAt(instant);
  const current = eligible.length === 1 ? eligible[0]! : null;
  const signature = (items: KioskAssignment[]) => items.map(c => c.id).join("|");
  const boundaries = [...new Set(candidates.flatMap(c => [Date.parse(c.startsAt), Date.parse(c.endsAt)]))].sort((a, b) => a - b);
  const transitions = boundaries.filter(t => t > instant && signature(eligibleAt(t)) !== signature(eligibleAt(t - 1)));
  const nextAt = transitions.find(t => eligibleAt(t).length === 1);
  const next = nextAt === undefined ? null : { ...eligibleAt(nextAt)[0]!, startsAt: new Date(nextAt).toISOString() };
  return { current, next, status: eligible.length > 1 ? "conflict" as const
    : current ? current.state : "idle" as const,
    nextBoundaryAt: new Date(Math.min(midnight.getTime(), ...transitions)).toISOString() };
}
