import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";

export const classpilotAppButtons = pgTable("classpilot_app_buttons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  ownerTeacherId: text("owner_teacher_id").references(() => users.id),
  scope: text("scope").$type<"personal" | "school">().notNull(),
  name: text("name").notNull(),
  launchUrl: text("launch_url").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("classpilot_app_buttons_school_owner_idx").on(table.schoolId, table.ownerTeacherId),
  check("classpilot_app_buttons_scope_check", sql`(${table.scope} = 'personal' AND ${table.ownerTeacherId} IS NOT NULL) OR (${table.scope} = 'school' AND ${table.ownerTeacherId} IS NULL)`),
  check("classpilot_app_buttons_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 120`),
  check("classpilot_app_buttons_launch_url_check", sql`char_length(${table.launchUrl}) BETWEEN 1 AND 4096`),
  check("classpilot_app_buttons_revision_check", sql`${table.revision} > 0`),
]);

export const classpilotAppButtonPreferences = pgTable("classpilot_app_button_preferences", {
  schoolId: text("school_id").notNull().references(() => schools.id),
  teacherId: text("teacher_id").notNull().references(() => users.id),
  appKey: text("app_key").notNull(),
  saved: boolean("saved").notNull().default(false),
  favorite: boolean("favorite").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.schoolId, table.teacherId, table.appKey] }),
  check("classpilot_app_button_preferences_favorite_check", sql`NOT ${table.favorite} OR ${table.saved}`),
]);
