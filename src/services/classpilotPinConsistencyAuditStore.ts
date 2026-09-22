import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getAllSchoolIdsForClasspilotPinMigration,
  getClasspilotPinAuditBatch,
  replaceClasspilotPinHash,
} from "./storage.js";
import type {
  ClasspilotPinAuditStore,
  TenantPinAuditStore,
} from "./classpilotPinConsistencyAudit.js";

/**
 * Production store for the PIN consistency audit. Every student read/write runs
 * inside one explicit school GUC context and carries the same school id in its
 * SQL predicate; the global pre-pass returns only opaque school ids.
 */
export function createDatabaseClasspilotPinAuditStore(): ClasspilotPinAuditStore {
  return {
    listSchoolIds: getAllSchoolIdsForClasspilotPinMigration,

    async withSchoolTenant<T>(
      schoolId: string,
      operation: (store: TenantPinAuditStore) => Promise<T>
    ): Promise<T> {
      return runWithTenantContext({ schoolId }, () =>
        operation({
          listBatch: (afterId, batchSize) =>
            getClasspilotPinAuditBatch(schoolId, afterId, batchSize),
          replaceHash: (rowId, expectedHash, replacementHash) =>
            replaceClasspilotPinHash(schoolId, rowId, expectedHash, replacementHash),
        })
      );
    },
  };
}
