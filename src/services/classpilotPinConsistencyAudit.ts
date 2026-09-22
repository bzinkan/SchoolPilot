import type { ClasspilotPinAuditRow } from "./storage.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

export type TenantPinAuditStore = {
  listBatch(afterId: string | undefined, batchSize: number): Promise<ClasspilotPinAuditRow[]>;
  /** Compare-and-swap the bcrypt hash; false when the row changed underneath. */
  replaceHash(rowId: string, expectedHash: string | null, replacementHash: string): Promise<boolean>;
};

export type ClasspilotPinAuditStore = {
  listSchoolIds(): Promise<string[]>;
  withSchoolTenant<T>(
    schoolId: string,
    operation: (store: TenantPinAuditStore) => Promise<T>
  ): Promise<T>;
};

/** Counts only. No tenant, student, PIN, hash or ciphertext values. */
export type ClasspilotPinAuditCounts = {
  schoolsTotal: number;
  schoolsVisited: number;
  batches: number;
  examined: number;
  /** Both columns present and the ciphertext decrypts to the PIN the hash verifies. */
  consistent: number;
  /** Both present but the decrypted PIN does not verify against the hash. */
  disagreeing: number;
  /** Hash only: fast-path verification falls back to bcrypt and backfills on success. */
  hashOnly: number;
  /** Ciphertext only: already fast; no bcrypt fallback exists for a wrong PIN. */
  encryptedOnly: number;
  /** Ciphertext present but undecryptable or not four digits. */
  undecryptable: number;
  /** Disagreeing rows whose hash was re-derived from the ciphertext (--execute). */
  repaired: number;
  /** Rows that changed between read and repair; left untouched. */
  conflicted: number;
  failed: number;
};

export type ClasspilotPinAuditFailureCode = "operation_failed";

export class ClasspilotPinAuditFailure extends Error {
  readonly code: ClasspilotPinAuditFailureCode;
  readonly counts: ClasspilotPinAuditCounts;

  constructor(code: ClasspilotPinAuditFailureCode, counts: ClasspilotPinAuditCounts) {
    super(`ClassPilot PIN consistency audit stopped (${code}).`);
    this.name = "ClasspilotPinAuditFailure";
    this.code = code;
    this.counts = { ...counts };
  }
}

export function zeroClasspilotPinAuditCounts(): ClasspilotPinAuditCounts {
  return {
    schoolsTotal: 0, schoolsVisited: 0, batches: 0, examined: 0,
    consistent: 0, disagreeing: 0, hashOnly: 0, encryptedOnly: 0, undecryptable: 0,
    repaired: 0, conflicted: 0, failed: 0,
  };
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return value;
}

/**
 * Audit every active student's two PIN columns. The admin-visible encrypted PIN
 * is the value a teacher reads out, so when the two disagree it wins: with
 * `execute`, the bcrypt hash is re-derived from the decrypted PIN under a
 * compare-and-swap so a concurrent admin PIN change is never overwritten.
 */
export async function auditClasspilotPinConsistency(options: {
  store: ClasspilotPinAuditStore;
  decryptPin: (ciphertext: string) => string | null;
  hashPin: (pin: string) => Promise<string>;
  comparePin: (pin: string, hash: string) => Promise<boolean>;
  execute?: boolean;
  batchSize?: number;
}): Promise<ClasspilotPinAuditCounts> {
  const batchSize = normalizeBatchSize(options.batchSize);
  const counts = zeroClasspilotPinAuditCounts();
  try {
    const schoolIds = await options.store.listSchoolIds();
    counts.schoolsTotal = schoolIds.length;
    for (const schoolId of schoolIds) {
      counts.schoolsVisited += 1;
      await options.store.withSchoolTenant(schoolId, async (tenantStore) => {
        let afterId: string | undefined;
        for (;;) {
          const rows = await tenantStore.listBatch(afterId, batchSize);
          if (rows.length === 0) break;
          counts.batches += 1;
          for (const row of rows) {
            counts.examined += 1;
            afterId = row.id;
            if (!row.ciphertext) {
              counts.hashOnly += 1;
              continue;
            }
            const pin = options.decryptPin(row.ciphertext);
            if (pin === null) {
              counts.undecryptable += 1;
              continue;
            }
            if (!row.pinHash) {
              counts.encryptedOnly += 1;
              continue;
            }
            if (await options.comparePin(pin, row.pinHash)) {
              counts.consistent += 1;
              continue;
            }
            counts.disagreeing += 1;
            if (!options.execute) continue;
            const replaced = await tenantStore.replaceHash(row.id, row.pinHash, await options.hashPin(pin));
            if (replaced) counts.repaired += 1;
            else counts.conflicted += 1;
          }
          if (rows.length < batchSize) break;
        }
      });
    }
    return counts;
  } catch {
    counts.failed += 1;
    throw new ClasspilotPinAuditFailure("operation_failed", counts);
  }
}
