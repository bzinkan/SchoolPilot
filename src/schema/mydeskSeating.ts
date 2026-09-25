import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { groups } from "./classpilot.js";

export type MyDeskSeat = { id: string; x: number; y: number; studentId: string | null; locked: boolean };
export type MyDeskSeatingLayout = { version: 1; seats: MyDeskSeat[] };
export type MyDeskSeatingRosterStudent = { id: string; name: string };
export type MyDeskSeatingMutationReceipt = { id: string; fingerprint: string; revision: number; kind: string };

export const mydeskSeatingCharts = pgTable("mydesk_seating_charts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  authorId: varchar("author_id").notNull().references(() => users.id),
  clientRequestId: uuid("client_request_id").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  // Canonical migration repairs this to ON DELETE SET NULL (group_id), preserving school and filing snapshots.
  groupId: varchar("group_id"),
  filingGroupId: varchar("filing_group_id").notNull(),
  groupName: text("group_name").notNull(),
  name: text("name").notNull(),
  layout: jsonb("layout").$type<MyDeskSeatingLayout>().notNull().default({ version: 1, seats: [] }),
  rosterSnapshot: jsonb("roster_snapshot").$type<MyDeskSeatingRosterStudent[]>().notNull().default([]),
  rosterRevision: text("roster_revision").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  mutationReceipts: jsonb("mutation_receipts").$type<MyDeskSeatingMutationReceipt[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, table => [
  uniqueIndex("mydesk_seating_charts_request").on(table.schoolId, table.authorId, table.clientRequestId),
  uniqueIndex("mydesk_seating_charts_current").on(table.schoolId, table.authorId, table.filingGroupId)
    .where(sql`${table.isCurrent} AND ${table.deletedAt} IS NULL`),
  foreignKey({ name: "mydesk_seating_charts_group_fk", columns: [table.schoolId, table.groupId], foreignColumns: [groups.schoolId, groups.id] }),
  check("mydesk_seating_charts_fingerprint", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_seating_charts_revision", sql`${table.revision} > 0`),
  check("mydesk_seating_charts_name", sql`${table.deletedAt} IS NOT NULL OR char_length(btrim(${table.name})) BETWEEN 1 AND 120`),
  check("mydesk_seating_charts_group_name", sql`char_length(${table.groupName}) <= 500`),
  check("mydesk_seating_charts_roster_revision", sql`${table.deletedAt} IS NOT NULL OR ${table.rosterRevision} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_seating_charts_layout", sql`jsonb_typeof(${table.layout}) = 'object' AND (${table.layout}->'version' = '1'::jsonb) IS TRUE AND CASE WHEN jsonb_typeof(${table.layout}->'seats') = 'array' THEN jsonb_array_length(${table.layout}->'seats') <= 100 ELSE false END`),
  check("mydesk_seating_charts_roster", sql`octet_length(${table.rosterSnapshot}::text) <= 1048576 AND CASE WHEN jsonb_typeof(${table.rosterSnapshot}) = 'array' THEN jsonb_array_length(${table.rosterSnapshot}) <= 1000 ELSE false END`),
  check("mydesk_seating_charts_receipts", sql`CASE WHEN jsonb_typeof(${table.mutationReceipts}) = 'array' THEN jsonb_array_length(${table.mutationReceipts}) <= 100 ELSE false END`),
  check("mydesk_seating_charts_deleted", sql`${table.deletedAt} IS NULL OR (NOT ${table.isCurrent} AND ${table.groupId} IS NULL AND ${table.name} = '' AND ${table.groupName} = '' AND ${table.rosterRevision} = '' AND ${table.layout} = '{"version":1,"seats":[]}'::jsonb AND ${table.rosterSnapshot} = '[]'::jsonb)`),
  index("mydesk_seating_charts_owner_class").on(table.schoolId, table.authorId, table.filingGroupId, table.updatedAt.desc(), table.id).where(sql`${table.deletedAt} IS NULL`),
]);

export type MyDeskSeatingChart = typeof mydeskSeatingCharts.$inferSelect;
export type NewMyDeskSeatingChart = typeof mydeskSeatingCharts.$inferInsert;
