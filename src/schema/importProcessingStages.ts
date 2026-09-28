import { sql } from "drizzle-orm";
import { pgTable, varchar, text, integer, boolean, timestamp, uuid, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { mydeskImports } from "./mydeskImports.js";
import { studentInformationImports } from "./studentInformation.js";

export type ImportProcessingKind = "paperwork" | "student-information";
export const importProcessingStages = pgTable("import_processing_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: text("school_id").notNull().references(() => schools.id),
  authorId: varchar("author_id").notNull().references(() => users.id),
  kind: text("kind").$type<ImportProcessingKind>().notNull(),
  importId: varchar("import_id").notNull(),
  paperworkImportId: varchar("paperwork_import_id"),
  informationImportId: varchar("information_import_id"),
  stageKey: text("stage_key").notNull(),
  generation: integer("generation").notNull(),
  provider: boolean("provider").notNull(),
  status: text("status").$type<"queued" | "running" | "completed" | "retry" | "failed" | "cancelled">().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseId: uuid("lease_id"),
  parentLeaseId: uuid("parent_lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  requestDeadline: timestamp("request_deadline", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("import_processing_stages_identity").on(t.schoolId, t.authorId, t.kind, t.importId, t.stageKey, t.generation),
  index("import_processing_stages_provider").on(t.provider, t.leaseUntil),
  index("import_processing_stages_run").on(t.schoolId, t.authorId, t.kind, t.importId, t.status),
  foreignKey({ name: "import_processing_stages_paperwork_fk", columns: [t.schoolId,t.authorId,t.paperworkImportId], foreignColumns: [mydeskImports.schoolId,mydeskImports.authorId,mydeskImports.id] }),
  foreignKey({ name: "import_processing_stages_information_fk", columns: [t.schoolId,t.authorId,t.informationImportId], foreignColumns: [studentInformationImports.schoolId,studentInformationImports.authorId,studentInformationImports.id] }),
  check("import_processing_stages_parent", sql`(${t.kind}='paperwork' AND ${t.paperworkImportId} IS NOT NULL AND ${t.paperworkImportId}=${t.importId} AND ${t.informationImportId} IS NULL) OR (${t.kind}='student-information' AND ${t.informationImportId} IS NOT NULL AND ${t.informationImportId}=${t.importId} AND ${t.paperworkImportId} IS NULL)`),
  check("import_processing_stages_bounds", sql`${t.generation}>0 AND ${t.attempts} BETWEEN 0 AND 3 AND char_length(${t.stageKey}) BETWEEN 1 AND 200 AND ${t.stageKey} ~ '^[A-Za-z0-9:_-]+$' AND ${t.status} IN ('queued','running','completed','retry','failed','cancelled') AND (${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[A-Za-z0-9_]{1,64}$') AND ((${t.leaseId} IS NULL)=(${t.leaseUntil} IS NULL)) AND (${t.status}<>'running' OR (${t.leaseId} IS NOT NULL AND ${t.parentLeaseId} IS NOT NULL AND ${t.requestDeadline} IS NOT NULL))`),
]);
export type ImportProcessingStage = typeof importProcessingStages.$inferSelect;
