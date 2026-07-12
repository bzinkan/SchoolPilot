import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getAllSchoolIdsForClasspilotPinMigration,
  getEncryptedClasspilotPinBatch,
  replaceEncryptedClasspilotPin,
} from "./storage.js";
import type {
  ClasspilotPinMigrationStore,
  TenantPinMigrationStore,
} from "./classpilotPinEncryptionMigration.js";

/**
 * Production store for the PIN re-encryption job. Every student read/write runs
 * inside one explicit school GUC context and also carries the same school id in
 * its SQL predicate. The global pre-pass returns only opaque school ids and is
 * allowed because `schools` is an auth/bootstrap table without RLS.
 */
export function createDatabaseClasspilotPinMigrationStore(): ClasspilotPinMigrationStore {
  return {
    listSchoolIds: getAllSchoolIdsForClasspilotPinMigration,

    async withSchoolTenant<T>(
      schoolId: string,
      operation: (store: TenantPinMigrationStore) => Promise<T>
    ): Promise<T> {
      return runWithTenantContext({ schoolId }, () =>
        operation({
          listBatch: (afterId, batchSize) =>
            getEncryptedClasspilotPinBatch(schoolId, afterId, batchSize),
          replaceCiphertext: (rowId, expectedCiphertext, replacementCiphertext) =>
            replaceEncryptedClasspilotPin(
              schoolId,
              rowId,
              expectedCiphertext,
              replacementCiphertext
            ),
        })
      );
    },
  };
}
