import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";

export type MyDeskPreferencesSnapshot = { revision: number; preferredClasses: Record<string, string> };
export const mydeskPreferences = pgTable("mydesk_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  authorId: varchar("author_id").notNull().references(() => users.id),
  preferredClasses: jsonb("preferred_classes").$type<Record<string, string>>().notNull().default({}),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("mydesk_preferences_owner").on(table.schoolId, table.authorId),
  check("mydesk_preferences_bounds", sql`${table.revision}>0 AND jsonb_typeof(${table.preferredClasses})='object' AND octet_length(${table.preferredClasses}::text)<=8192`),
]);
