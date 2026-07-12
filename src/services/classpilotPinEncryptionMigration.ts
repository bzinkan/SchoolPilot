import type { SecretCipher } from "./crypto.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

export type EncryptedClasspilotPinRow = {
  id: string;
  ciphertext: string;
};

export type TenantPinMigrationStore = {
  listBatch(
    afterId: string | undefined,
    batchSize: number
  ): Promise<EncryptedClasspilotPinRow[]>;
  replaceCiphertext(
    rowId: string,
    expectedCiphertext: string,
    replacementCiphertext: string
  ): Promise<boolean>;
};

export type ClasspilotPinMigrationStore = {
  listSchoolIds(): Promise<string[]>;
  withSchoolTenant<T>(
    schoolId: string,
    operation: (store: TenantPinMigrationStore) => Promise<T>
  ): Promise<T>;
};

export type ClasspilotPinMigrationCounts = {
  schoolsTotal: number;
  schoolsVisited: number;
  batches: number;
  examined: number;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
  conflicted: number;
};

export type ClasspilotPinMigrationFailureCode =
  | "rotation_not_ready"
  | "invalid_plaintext"
  | "concurrent_change"
  | "decrypt_failed"
  | "operation_failed";

export class ClasspilotPinMigrationFailure extends Error {
  readonly code: ClasspilotPinMigrationFailureCode;
  readonly counts: ClasspilotPinMigrationCounts;

  constructor(
    code: ClasspilotPinMigrationFailureCode,
    counts: ClasspilotPinMigrationCounts
  ) {
    super(`ClassPilot PIN encryption migration stopped (${code}).`);
    this.name = "ClasspilotPinMigrationFailure";
    this.code = code;
    this.counts = { ...counts };
  }
}

function emptyCounts(): ClasspilotPinMigrationCounts {
  return {
    schoolsTotal: 0,
    schoolsVisited: 0,
    batches: 0,
    examined: 0,
    migrated: 0,
    alreadyCurrent: 0,
    failed: 0,
    conflicted: 0,
  };
}

function migrationFailure(
  code: ClasspilotPinMigrationFailureCode,
  counts: ClasspilotPinMigrationCounts
): ClasspilotPinMigrationFailure {
  return new ClasspilotPinMigrationFailure(code, counts);
}

export async function migrateClasspilotPinEncryption(options: {
  cipher: SecretCipher;
  store: ClasspilotPinMigrationStore;
  batchSize?: number;
}): Promise<ClasspilotPinMigrationCounts> {
  const counts = emptyCounts();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE
  ) {
    counts.failed = 1;
    throw migrationFailure("operation_failed", counts);
  }
  if (!options.cipher.rotationReady) {
    counts.failed = 1;
    throw migrationFailure("rotation_not_ready", counts);
  }

  try {
    const schoolIds = await options.store.listSchoolIds();
    counts.schoolsTotal = schoolIds.length;

    for (const schoolId of schoolIds) {
      counts.schoolsVisited += 1;
      await options.store.withSchoolTenant(schoolId, async (tenantStore) => {
        let afterId: string | undefined;

        while (true) {
          const rows = await tenantStore.listBatch(afterId, batchSize);
          if (rows.length === 0) break;
          counts.batches += 1;

          for (const row of rows) {
            counts.examined += 1;
            let decrypted;
            try {
              decrypted = options.cipher.decrypt(row.ciphertext);
            } catch {
              counts.failed += 1;
              throw migrationFailure("decrypt_failed", counts);
            }

            if (!/^\d{4}$/.test(decrypted.plaintext)) {
              counts.failed += 1;
              throw migrationFailure("invalid_plaintext", counts);
            }

            if (decrypted.keySource === "current") {
              counts.alreadyCurrent += 1;
              afterId = row.id;
              continue;
            }

            const replacement = options.cipher.encrypt(decrypted.plaintext);
            const replacementCheck = options.cipher.decrypt(replacement);
            if (
              replacementCheck.keySource !== "current" ||
              replacementCheck.plaintext !== decrypted.plaintext
            ) {
              counts.failed += 1;
              throw migrationFailure("operation_failed", counts);
            }

            const replaced = await tenantStore.replaceCiphertext(
              row.id,
              row.ciphertext,
              replacement
            );
            if (!replaced) {
              counts.conflicted += 1;
              counts.failed += 1;
              throw migrationFailure("concurrent_change", counts);
            }

            counts.migrated += 1;
            afterId = row.id;
          }
        }
      });
    }

    return { ...counts };
  } catch (error) {
    if (error instanceof ClasspilotPinMigrationFailure) throw error;
    counts.failed += 1;
    throw migrationFailure("operation_failed", counts);
  }
}
