import { and, eq, inArray } from "drizzle-orm";
import type db from "../db.js";
import { rosterIntegrationMemberships } from "../schema/rosterIntegrations.js";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A manual add is a contribution even if INSERT ... ON CONFLICT does not insert a row. */
export async function preserveManualRosterMemberships(tx: Transaction, groupId: string, memberType: "student" | "teacher", memberIds: string[]): Promise<void> {
  if (!memberIds.length) return;
  await tx.update(rosterIntegrationMemberships).set({ manualPreserved: true, updatedAt: new Date() }).where(and(eq(rosterIntegrationMemberships.groupId, groupId), eq(rosterIntegrationMemberships.memberType, memberType), inArray(rosterIntegrationMemberships.memberId, memberIds)));
}
