import { sql } from "drizzle-orm";
import { pgTable,text,timestamp,jsonb,bigint,integer,boolean,unique,foreignKey,index,check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { classpilotWindowsBrowsers } from "./classpilotWindows.js";
export const classpilotWindowsBrowserEvents=pgTable("classpilot_windows_browser_events",{
  id:text("id").primaryKey(),schoolId:text("school_id").notNull().references(()=>schools.id),studentId:text("student_id").notNull(),browserId:text("browser_id").notNull(),
  sourceRef:text("source_ref").notNull(),bindingRevision:integer("binding_revision").notNull(),observationId:text("observation_id").notNull(),sequence:bigint("sequence",{mode:"number"}).notNull(),
  observedAt:timestamp("observed_at",{withTimezone:true}).notNull(),usageEndsAt:timestamp("usage_ends_at",{withTimezone:true}).notNull(),browserFocused:boolean("browser_focused").notNull(),
  classification:jsonb("classification").$type<Record<string,unknown>>(),
  activeTabUrl:text("active_tab_url").notNull(),activeTabTitle:text("active_tab_title").notNull(),teachingSessionId:text("teaching_session_id"),supervisionContextId:text("supervision_context_id"),
},t=>[foreignKey({name:"cp_windows_event_browser_fk",columns:[t.schoolId,t.browserId,t.studentId],foreignColumns:[classpilotWindowsBrowsers.schoolId,classpilotWindowsBrowsers.id,classpilotWindowsBrowsers.studentId]}),
  unique("cp_windows_event_identity_unique").on(t.browserId,t.observationId),unique("cp_windows_event_sequence_unique").on(t.browserId,t.sequence),
  index("cp_windows_event_history_idx").on(t.schoolId,t.studentId,t.sourceRef,t.bindingRevision,t.observedAt,t.id),index("cp_windows_event_usage_idx").on(t.schoolId,t.studentId,t.observedAt),
  check("cp_windows_event_bounds_check",sql`${t.sequence}>0 AND ${t.bindingRevision}>0 AND ${t.usageEndsAt}>=${t.observedAt} AND ${t.usageEndsAt}<=${t.observedAt}+interval '10 seconds'`),
  check("cp_windows_event_context_check",sql`num_nonnulls(${t.teachingSessionId},${t.supervisionContextId})<=1`),check("cp_windows_event_text_check",sql`length(${t.activeTabUrl})<=4096 AND length(${t.activeTabTitle})<=512`)]);
