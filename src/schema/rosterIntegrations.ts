import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { groups } from "./classpilot.js";
import type { RosterMapping, RosterPackage, RosterProvider } from "../services/rosterIntegrationModel.js";

export const rosterIntegrationConnections = pgTable("roster_integration_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull().references(()=>schools.id), provider: text("provider").notNull().$type<RosterProvider>(),
  name: text("name").notNull(), providerIdentity: text("provider_identity").notNull(), encryptedToken: text("encrypted_token"),
  status: text("status").notNull().default("active"), mapping: jsonb("mapping").$type<RosterMapping>().notNull().default(sql`'{"organizationIds":[]}'::jsonb`),
  revision: integer("revision").notNull().default(0), automaticSync: boolean("automatic_sync").notNull().default(false), initialReviewedAt: timestamp("initial_reviewed_at", { withTimezone: true }),
  lastAttemptLocalDate: text("last_attempt_local_date"), lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }), lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"), createdBy: text("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [unique("roster_connections_school_id_unique").on(table.schoolId, table.id), uniqueIndex("roster_connections_source_unique").on(table.schoolId, table.provider, table.providerIdentity), index("roster_connections_due_idx").on(table.status, table.automaticSync)]);

export const rosterIntegrationRuns = pgTable("roster_integration_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull(), connectionId: text("connection_id").notNull(),
  status: text("status").notNull().default("staged"), requestedBy: text("requested_by"), automatic: boolean("automatic").notNull().default(false),
  snapshot: jsonb("snapshot").$type<RosterPackage>(), mapping: jsonb("mapping").$type<RosterMapping>(), plan: jsonb("plan"),
  planHash: text("plan_hash"), baseRevision: integer("base_revision"), cursor: integer("cursor").notNull().default(0), totalSteps: integer("total_steps").notNull().default(0),
  summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`), errorCode: text("error_code"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [unique("roster_runs_school_id_unique").on(table.schoolId, table.id), index("roster_runs_connection_idx").on(table.schoolId, table.connectionId, table.createdAt), index("roster_runs_status_idx").on(table.status, table.updatedAt), uniqueIndex("roster_runs_one_applying").on(table.schoolId,table.connectionId).where(sql`${table.status} IN ('fetching','applying')`), foreignKey({name:"roster_runs_connection_fk",columns:[table.schoolId,table.connectionId],foreignColumns:[rosterIntegrationConnections.schoolId,rosterIntegrationConnections.id]}),check("roster_runs_state_check",sql`${table.status} IN ('fetching','staged','preview','held','applying','completed','failed','expired')`)]);

export const rosterIntegrationIdentities = pgTable("roster_integration_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull(), connectionId: text("connection_id").notNull(),
  entityType: text("entity_type").notNull().$type<"student" | "teacher" | "class">(), externalId: text("external_id").notNull(), internalId: text("internal_id").notNull(),
  ownedFields: jsonb("owned_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`), lastApplied: jsonb("last_applied").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  sourceCreated: boolean("source_created").notNull().default(false), sourcePresent: boolean("source_present").notNull().default(true), lastRunId: text("last_run_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("roster_identities_external_unique").on(table.schoolId, table.connectionId, table.entityType, table.externalId), uniqueIndex("roster_identities_internal_unique").on(table.schoolId, table.connectionId, table.entityType, table.internalId), index("roster_identities_internal_idx").on(table.schoolId, table.entityType, table.internalId), foreignKey({name:"roster_identities_connection_fk",columns:[table.schoolId,table.connectionId],foreignColumns:[rosterIntegrationConnections.schoolId,rosterIntegrationConnections.id]}),foreignKey({name:"roster_identities_run_fk",columns:[table.schoolId,table.lastRunId],foreignColumns:[rosterIntegrationRuns.schoolId,rosterIntegrationRuns.id]})]);

export const rosterIntegrationMemberships = pgTable("roster_integration_memberships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull(), connectionId: text("connection_id").notNull(),
  groupId: text("group_id").notNull(), memberId: text("member_id").notNull(), memberType: text("member_type").notNull().$type<"student" | "teacher">(), role: text("role").notNull(),
  ownsMembership: boolean("owns_membership").notNull().default(false), manualPreserved: boolean("manual_preserved").notNull().default(false),
  sourcePresent: boolean("source_present").notNull().default(true), physicalRowId: text("physical_row_id"), lastRunId: text("last_run_id").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("roster_memberships_source_unique").on(table.schoolId, table.connectionId, table.groupId, table.memberType, table.memberId), index("roster_memberships_target_idx").on(table.schoolId, table.groupId, table.memberType, table.memberId),foreignKey({name:"roster_memberships_connection_fk",columns:[table.schoolId,table.connectionId],foreignColumns:[rosterIntegrationConnections.schoolId,rosterIntegrationConnections.id]}),foreignKey({name:"roster_memberships_run_fk",columns:[table.schoolId,table.lastRunId],foreignColumns:[rosterIntegrationRuns.schoolId,rosterIntegrationRuns.id]}),foreignKey({name:"roster_memberships_group_fk",columns:[table.schoolId,table.groupId],foreignColumns:[groups.schoolId,groups.id]})]);
