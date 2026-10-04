import { z } from "zod";
import { PASSPILOT_RULE_CODES } from "../schema/passpilot.js";
import type { SchoolSchedulingConfig } from "./classpilotSchedulingRules.js";
import { addLocalDays, localDateInTimeZone, localDateStartUtc } from "../util/schoolTime.js";

export function appointmentError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code, expose: true as const });
}

// Requiring an offset makes both occurrences of a fall-back wall time explicit;
// no local-Date parsing or silent spring-forward adjustment is performed.
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const fields = {
  studentId: z.string().min(1).max(128),
  destination: z.enum(["bathroom", "nurse", "office", "counselor", "other_classroom", "custom"]),
  customDestination: z.string().trim().min(1).max(200).nullable().default(null),
  staffNotes: z.string().trim().max(2000).nullable().default(null),
  startsAt: instant,
  endsAt: instant,
  duration: z.number().int().min(1).max(120).default(5),
};
export const createAppointmentSchema = z.object({ ...fields, requestId: z.string().uuid() }).strict();
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export const editAppointmentSchema = z.object({
  expectedRevision: z.number().int().positive(),
  studentId: fields.studentId.optional(), destination: fields.destination.optional(),
  customDestination: fields.customDestination.optional(), staffNotes: fields.staffNotes.optional(),
  startsAt: fields.startsAt.optional(), endsAt: fields.endsAt.optional(), duration: fields.duration.optional(),
}).strict().refine((body) => Object.keys(body).some((key) => key !== "expectedRevision"), "Choose an appointment field to update.");
export type EditAppointmentInput = z.infer<typeof editAppointmentSchema>;
export const cancelAppointmentSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const activateAppointmentSchema = z.object({
  expectedRevision: z.number().int().positive(), classId: z.string().min(1).max(128),
  overrideRuleCode: z.enum(PASSPILOT_RULE_CODES).optional(),
}).strict();
export type ActivateAppointmentInput = z.infer<typeof activateAppointmentSchema>;

export type AppointmentWindow = { destination: string; customDestination: string | null; startsAt: Date; endsAt: Date };
export function validateAppointmentWindow(input: AppointmentWindow) {
  const elapsed = input.endsAt.getTime() - input.startsAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 24 * 60 * 60 * 1000) {
    throw appointmentError(400, "APPOINTMENT_WINDOW_INVALID", "Choose an explicit appointment window of no more than 24 hours.");
  }
  if (input.destination === "custom" ? !input.customDestination : input.customDestination !== null) {
    throw appointmentError(400, "APPOINTMENT_DESTINATION_INVALID", "Choose a custom destination only for a custom appointment.");
  }
}

export function appointmentSchoolYearCutoff(config: Pick<SchoolSchedulingConfig, "yearStart" | "yearEnd">, timeZone: string,
  startsAt: Date, endsAt: Date): Date {
  if (!config.yearStart || !config.yearEnd) {
    throw appointmentError(409, "APPOINTMENT_SCHOOL_YEAR_REQUIRED", "Configure the school's year start and end before scheduling appointments.");
  }
  const localDate = localDateInTimeZone(startsAt, timeZone);
  const retainedUntil = localDateStartUtc(addLocalDays(config.yearEnd, 1), timeZone);
  if (localDate < config.yearStart || localDate > config.yearEnd || endsAt > retainedUntil) {
    throw appointmentError(400, "APPOINTMENT_OUTSIDE_SCHOOL_YEAR", "Choose an appointment within the configured school year.");
  }
  return retainedUntil;
}
