import { sql } from "drizzle-orm";
import { pgTable, varchar, text, integer, timestamp, jsonb, check, index, uniqueIndex, foreignKey, type PgColumn } from "drizzle-orm/pg-core";

import { schools, users } from "./core.js";
import { students } from "./students.js";
import { teachingSessions, classpilotSupervisionContexts, classpilotCommands } from "./classpilot.js";

type ParentColumns = { schoolId: PgColumn; teachingSessionId: PgColumn; supervisionContextId: PgColumn };
const parentConstraints = (name: string, table: ParentColumns) => [
  check(`${name}_parent_check`, sql`num_nonnulls(${table.teachingSessionId},${table.supervisionContextId})=1`),
  foreignKey({ columns: [table.schoolId, table.teachingSessionId], foreignColumns: [teachingSessions.schoolId, teachingSessions.id], name: `${name}_session_fk` }),
  foreignKey({ columns: [table.schoolId, table.supervisionContextId], foreignColumns: [classpilotSupervisionContexts.schoolId, classpilotSupervisionContexts.id], name: `${name}_context_fk` }),
  index(`${name}_activity`).on(table.schoolId, table.teachingSessionId, table.supervisionContextId),
];
const currentConstraints = (name: string, table: ParentColumns & { endedAt: PgColumn; revision: PgColumn }) => [
  ...parentConstraints(name, table), check(`${name}_revision_check`, sql`${table.revision}>0`),
  uniqueIndex(`${name}_session_current`).on(table.schoolId, table.teachingSessionId).where(sql`${table.teachingSessionId} IS NOT NULL AND ${table.endedAt} IS NULL`),
  uniqueIndex(`${name}_context_current`).on(table.schoolId, table.supervisionContextId).where(sql`${table.supervisionContextId} IS NOT NULL AND ${table.endedAt} IS NULL`),
];
const identity = () => ({ id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull().references(() => schools.id) });
const parent = () => ({ teachingSessionId: varchar("teaching_session_id"), supervisionContextId: varchar("supervision_context_id") });
const lifecycle = () => ({ revision: integer("revision").notNull().default(1), createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(), endedAt: timestamp("ended_at") });

export type LessonChecklistItem = { id: string; text: string };
export type LessonResource = { title: string; url: string };
export const classpilotTimers = pgTable("classpilot_timers", {
  ...identity(), ...parent(), ...lifecycle(), startCommandId: varchar("start_command_id").notNull().references(() => classpilotCommands.id),
  message: text("message").notNull().default(""), deadline: timestamp("deadline"), pausedRemainingMs: integer("paused_remaining_ms"),
  expiresAt: timestamp("expires_at").notNull(),
}, table => [...currentConstraints("classpilot_timers", table), check("cp_timer_remaining", sql`${table.pausedRemainingMs} BETWEEN 0 AND 3600000`), check("cp_timer_state", sql`${table.endedAt} IS NOT NULL OR num_nonnulls(${table.deadline},${table.pausedRemainingMs})=1`)]);
export const classpilotLessonActivities = pgTable("classpilot_lesson_activities", {
  ...identity(), ...parent(), ...lifecycle(), startCommandId: varchar("start_command_id").notNull().references(() => classpilotCommands.id),
  title: text("title").notNull(), instructions: text("instructions").notNull().default(""),
  resources: jsonb("resources").$type<LessonResource[]>().notNull().default([]),
  checklist: jsonb("checklist").$type<LessonChecklistItem[]>().notNull().default([]), expiresAt: timestamp("expires_at").notNull(),
}, table => [...currentConstraints("classpilot_lesson_activities", table), uniqueIndex("cp_lesson_school_id").on(table.schoolId, table.id)]);
export const classpilotLessonProgress = pgTable("classpilot_lesson_progress", {
  ...identity(), ...parent(), lessonActivityId: varchar("lesson_activity_id").notNull(), studentId: varchar("student_id").notNull().references(() => students.id),
  status: text("status").notNull().default("not_reported"), completedItemIds: jsonb("completed_item_ids").$type<string[]>().notNull().default([]),
  revision: integer("revision").notNull().default(1), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [...parentConstraints("classpilot_lesson_progress", table), uniqueIndex("cp_lesson_student").on(table.schoolId, table.lessonActivityId, table.studentId), foreignKey({ columns: [table.schoolId, table.lessonActivityId], foreignColumns: [classpilotLessonActivities.schoolId, classpilotLessonActivities.id], name: "cp_lesson_progress_activity_fk" }).onDelete("cascade"), check("cp_lesson_progress_status", sql`${table.status} IN ('not_reported','working','stuck','ready_for_review','finished')`)]);
export const classpilotQuestions = pgTable("classpilot_questions", {
  ...identity(), ...parent(), ...lifecycle(), studentId: varchar("student_id").notNull().references(() => students.id), clientRequestId: varchar("client_request_id").notNull(),
  question: text("question").notNull(), groupLabel: text("group_label"), answer: text("answer"),
}, table => [...parentConstraints("classpilot_questions", table), uniqueIndex("cp_question_submission").on(table.schoolId, table.studentId, table.clientRequestId), check("cp_question_length", sql`length(${table.question}) BETWEEN 1 AND 500`)]);
export const classpilotPickerRounds = pgTable("classpilot_picker_rounds", {
  ...identity(), ...parent(), ...lifecycle(), excludedStudentIds: jsonb("excluded_student_ids").$type<string[]>().notNull().default([]),
  usedStudentIds: jsonb("used_student_ids").$type<string[]>().notNull().default([]), selectedStudentId: varchar("selected_student_id").references(() => students.id),
}, table => currentConstraints("classpilot_picker_rounds", table));
export type RoutineStep = { kind: "instructions" | "resource" | "flight_path" | "timer" | "poll" | "exit_ticket"; title: string; payload: Record<string, unknown> };
export const classpilotToolTemplates = pgTable("classpilot_tool_templates", {
  ...identity(), teacherId: varchar("teacher_id").notNull().references(() => users.id), kind: text("kind").notNull(), name: text("name").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(), revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [index("cp_tool_templates_teacher").on(table.schoolId, table.teacherId), check("cp_tool_template_kind", sql`${table.kind} IN ('attention','poll','exit_ticket','activity','routine')`)]);
export const classpilotRoutineRuns = pgTable("classpilot_routine_runs", {
  ...identity(), ...parent(), ...lifecycle(), teacherId: varchar("teacher_id").notNull().references(() => users.id), title: text("title").notNull(),
  steps: jsonb("steps").$type<RoutineStep[]>().notNull(), currentStep: integer("current_step").notNull().default(0),
  targetStudentIds: jsonb("target_student_ids").$type<string[]>().notNull(),
  outcomes: jsonb("outcomes").$type<Array<{ step: number; commandIds: string[]; state: "prepared" | "attempted" | "skipped" }>>().notNull().default([]),
}, table => currentConstraints("classpilot_routine_runs", table));
export const classpilotToolHistory = pgTable("classpilot_tool_history", {
  ...identity(), ...parent(), actorId: varchar("actor_id").notNull(), kind: text("kind").notNull(), resourceId: varchar("resource_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [...parentConstraints("classpilot_tool_history", table), index("cp_tools_history_retention").on(table.schoolId, table.createdAt)]);
