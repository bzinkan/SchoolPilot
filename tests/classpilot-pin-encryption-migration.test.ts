import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { createSecretCipher } from "../src/services/crypto.ts";
import {
  ClasspilotPinMigrationFailure,
  migrateClasspilotPinEncryption,
  type ClasspilotPinMigrationStore,
  type TenantPinMigrationStore,
} from "../src/services/classpilotPinEncryptionMigration.ts";

type FakeRow = {
  id: string;
  schoolId: string;
  ciphertext: string;
};

class FakePinStore implements ClasspilotPinMigrationStore {
  readonly rows: FakeRow[];
  readonly tenantContexts: string[] = [];
  listSchoolIdsCalls = 0;
  failReplaceOnceForId?: string;
  conflictOnceForId?: string;

  constructor(rows: FakeRow[]) {
    this.rows = rows;
  }

  async listSchoolIds(): Promise<string[]> {
    this.listSchoolIdsCalls += 1;
    return [...new Set(this.rows.map((row) => row.schoolId))].sort();
  }

  async withSchoolTenant<T>(
    schoolId: string,
    operation: (store: TenantPinMigrationStore) => Promise<T>
  ): Promise<T> {
    this.tenantContexts.push(schoolId);
    return operation({
      listBatch: async (afterId, batchSize) =>
        this.rows
          .filter(
            (row) =>
              row.schoolId === schoolId && (!afterId || row.id > afterId)
          )
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, batchSize)
          .map((row) => ({ id: row.id, ciphertext: row.ciphertext })),
      replaceCiphertext: async (rowId, expected, replacement) => {
        if (this.failReplaceOnceForId === rowId) {
          this.failReplaceOnceForId = undefined;
          throw new Error(`database failure for ${rowId}`);
        }
        if (this.conflictOnceForId === rowId) {
          this.conflictOnceForId = undefined;
          return false;
        }
        const row = this.rows.find(
          (candidate) =>
            candidate.schoolId === schoolId &&
            candidate.id === rowId &&
            candidate.ciphertext === expected
        );
        if (!row) return false;
        row.ciphertext = replacement;
        return true;
      },
    });
  }
}

function rotation() {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  return {
    oldCipher: createSecretCipher({ currentKey: oldKey, production: true }),
    stagedCipher: createSecretCipher({
      currentKey: newKey,
      previousKey: oldKey,
      production: true,
    }),
  };
}

describe("ClassPilot PIN encryption migration", () => {
  it("migrates previous-key rows tenant-by-tenant and skips current rows", async () => {
    const { oldCipher, stagedCipher } = rotation();
    const store = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: oldCipher.encrypt("1001") },
      { id: "002", schoolId: "school-a", ciphertext: stagedCipher.encrypt("1002") },
      { id: "003", schoolId: "school-b", ciphertext: oldCipher.encrypt("1003") },
    ]);

    const counts = await migrateClasspilotPinEncryption({
      cipher: stagedCipher,
      store,
      batchSize: 1,
    });

    assert.deepEqual(counts, {
      schoolsTotal: 2,
      schoolsVisited: 2,
      batches: 3,
      examined: 3,
      migrated: 2,
      alreadyCurrent: 1,
      failed: 0,
      conflicted: 0,
    });
    assert.deepEqual(store.tenantContexts, ["school-a", "school-b"]);
    assert.deepEqual(
      store.rows.map((row) => stagedCipher.decrypt(row.ciphertext).keySource),
      ["current", "current", "current"]
    );
  });

  it("is idempotent after a complete pass", async () => {
    const { oldCipher, stagedCipher } = rotation();
    const store = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: oldCipher.encrypt("2001") },
      { id: "002", schoolId: "school-a", ciphertext: oldCipher.encrypt("2002") },
    ]);

    const first = await migrateClasspilotPinEncryption({ cipher: stagedCipher, store });
    const second = await migrateClasspilotPinEncryption({ cipher: stagedCipher, store });

    assert.equal(first.migrated, 2);
    assert.equal(second.migrated, 0);
    assert.equal(second.alreadyCurrent, 2);
    assert.equal(second.failed, 0);
  });

  it("resumes safely after an operational failure without re-encrypting completed rows", async () => {
    const { oldCipher, stagedCipher } = rotation();
    const store = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: oldCipher.encrypt("3001") },
      { id: "002", schoolId: "school-a", ciphertext: oldCipher.encrypt("3002") },
      { id: "003", schoolId: "school-a", ciphertext: oldCipher.encrypt("3003") },
    ]);
    store.failReplaceOnceForId = "002";

    await assert.rejects(
      migrateClasspilotPinEncryption({ cipher: stagedCipher, store, batchSize: 3 }),
      (error: unknown) => {
        assert.ok(error instanceof ClasspilotPinMigrationFailure);
        assert.equal(error.code, "operation_failed");
        assert.equal(error.counts.migrated, 1);
        assert.equal(error.counts.failed, 1);
        assert.doesNotMatch(error.message, /002|3002/);
        return true;
      }
    );

    const resumed = await migrateClasspilotPinEncryption({
      cipher: stagedCipher,
      store,
      batchSize: 2,
    });
    assert.equal(resumed.alreadyCurrent, 1);
    assert.equal(resumed.migrated, 2);
    assert.equal(resumed.failed, 0);

    const verification = await migrateClasspilotPinEncryption({
      cipher: stagedCipher,
      store,
    });
    assert.equal(verification.migrated, 0);
    assert.equal(verification.alreadyCurrent, 3);
  });

  it("fails closed on undecryptable or invalid PIN plaintext", async () => {
    const { oldCipher, stagedCipher } = rotation();
    const undecryptable = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: "invalid.ciphertext.value" },
    ]);
    await assert.rejects(
      migrateClasspilotPinEncryption({ cipher: stagedCipher, store: undecryptable }),
      (error: unknown) =>
        error instanceof ClasspilotPinMigrationFailure &&
        error.code === "decrypt_failed" &&
        error.counts.failed === 1
    );

    const invalidPlaintext = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: oldCipher.encrypt("not-a-pin") },
    ]);
    await assert.rejects(
      migrateClasspilotPinEncryption({ cipher: stagedCipher, store: invalidPlaintext }),
      (error: unknown) =>
        error instanceof ClasspilotPinMigrationFailure &&
        error.code === "invalid_plaintext" &&
        error.counts.failed === 1
    );
  });

  it("uses compare-and-swap and stops on a concurrent PIN change", async () => {
    const { oldCipher, stagedCipher } = rotation();
    const store = new FakePinStore([
      { id: "001", schoolId: "school-a", ciphertext: oldCipher.encrypt("4001") },
    ]);
    store.conflictOnceForId = "001";

    await assert.rejects(
      migrateClasspilotPinEncryption({ cipher: stagedCipher, store }),
      (error: unknown) =>
        error instanceof ClasspilotPinMigrationFailure &&
        error.code === "concurrent_change" &&
        error.counts.conflicted === 1 &&
        error.counts.failed === 1
    );
    assert.equal(stagedCipher.decrypt(store.rows[0]!.ciphertext).keySource, "previous");
  });

  it("checks distinct current/previous keys before reading any tenant", async () => {
    const sameKey = randomBytes(32).toString("base64");
    const store = new FakePinStore([]);
    const cipher = createSecretCipher({
      currentKey: sameKey,
      previousKey: sameKey,
      production: true,
    });

    await assert.rejects(
      migrateClasspilotPinEncryption({ cipher, store }),
      (error: unknown) =>
        error instanceof ClasspilotPinMigrationFailure &&
        error.code === "rotation_not_ready"
    );
    assert.equal(store.listSchoolIdsCalls, 0);
  });
});
