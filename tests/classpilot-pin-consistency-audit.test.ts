import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { parseClasspilotPinAuditCliArgs } from "../src/cli/auditClasspilotPinConsistency.ts";
import {
  ClasspilotPinAuditFailure,
  auditClasspilotPinConsistency,
  type ClasspilotPinAuditStore,
  type TenantPinAuditStore,
} from "../src/services/classpilotPinConsistencyAudit.ts";
import { decryptClassPilotPin, encryptClassPilotPin } from "../src/services/classpilotPins.ts";

type FakeRow = { id: string; schoolId: string; pinHash: string | null; ciphertext: string | null };

class FakeAuditStore implements ClasspilotPinAuditStore {
  readonly tenantContexts: string[] = [];
  readonly replacements: Array<[string, string | null, string]> = [];
  conflictOnceForId?: string;
  failListOnce = false;

  constructor(readonly rows: FakeRow[]) {}

  async listSchoolIds(): Promise<string[]> {
    return [...new Set(this.rows.map((row) => row.schoolId))].sort();
  }

  async withSchoolTenant<T>(schoolId: string, operation: (store: TenantPinAuditStore) => Promise<T>): Promise<T> {
    this.tenantContexts.push(schoolId);
    return operation({
      listBatch: async (afterId, batchSize) => {
        if (this.failListOnce) { this.failListOnce = false; throw new Error("database failure"); }
        return this.rows
          .filter((row) => row.schoolId === schoolId && (!afterId || row.id > afterId))
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, batchSize)
          .map(({ id, pinHash, ciphertext }) => ({ id, pinHash, ciphertext }));
      },
      replaceHash: async (rowId, expectedHash, replacementHash) => {
        this.replacements.push([rowId, expectedHash, replacementHash]);
        if (this.conflictOnceForId === rowId) { this.conflictOnceForId = undefined; return false; }
        const row = this.rows.find((candidate) => candidate.schoolId === schoolId && candidate.id === rowId);
        if (!row || row.pinHash !== expectedHash) return false;
        row.pinHash = replacementHash;
        return true;
      },
    });
  }
}

const hashPin = (pin: string) => bcrypt.hash(pin, 4);
const comparePin = (pin: string, hash: string) => bcrypt.compare(pin, hash);
const audit = (store: FakeAuditStore, options: { execute?: boolean; batchSize?: number } = {}) =>
  auditClasspilotPinConsistency({ store, decryptPin: decryptClassPilotPin, hashPin, comparePin, ...options });

describe("ClassPilot PIN consistency audit", () => {
  it("classifies every row shape with counts only and changes nothing in report mode", async () => {
    const store = new FakeAuditStore([
      { id: "a1", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("1234") },
      { id: "a2", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("9999") },
      { id: "a3", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: null },
      { id: "b1", schoolId: "school-b", pinHash: null, ciphertext: encryptClassPilotPin("4321") },
      { id: "b2", schoolId: "school-b", pinHash: await hashPin("1234"), ciphertext: "garbage" },
    ]);
    const before = store.rows.map((row) => row.pinHash);
    const counts = await audit(store, { batchSize: 2 });
    assert.deepEqual(counts, {
      schoolsTotal: 2, schoolsVisited: 2, batches: 3, examined: 5,
      consistent: 1, disagreeing: 1, hashOnly: 1, encryptedOnly: 1, undecryptable: 1,
      repaired: 0, conflicted: 0, failed: 0,
    });
    assert.deepEqual(store.tenantContexts, ["school-a", "school-b"]);
    assert.deepEqual(store.replacements, []);
    assert.deepEqual(store.rows.map((row) => row.pinHash), before);
  });

  it("re-derives the hash from the encrypted PIN only for disagreeing rows under --execute", async () => {
    const store = new FakeAuditStore([
      { id: "a1", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("1234") },
      { id: "a2", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("9999") },
      { id: "a3", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("8888") },
    ]);
    store.conflictOnceForId = "a3";
    const counts = await audit(store, { execute: true });
    assert.equal(counts.disagreeing, 2);
    assert.equal(counts.repaired, 1);
    assert.equal(counts.conflicted, 1);
    assert.equal(store.replacements.length, 2);
    const repaired = store.rows.find((row) => row.id === "a2")!;
    assert.equal(await bcrypt.compare("9999", repaired.pinHash!), true, "encrypted PIN wins");
    assert.equal(await bcrypt.compare("1234", store.rows.find((row) => row.id === "a1")!.pinHash!), true, "consistent row untouched");
  });

  it("stops with counts so far when the database fails", async () => {
    const store = new FakeAuditStore([
      { id: "a1", schoolId: "school-a", pinHash: await hashPin("1234"), ciphertext: encryptClassPilotPin("1234") },
    ]);
    store.failListOnce = true;
    await assert.rejects(audit(store), (error: unknown) => {
      assert.ok(error instanceof ClasspilotPinAuditFailure);
      assert.equal(error.code, "operation_failed");
      assert.equal(error.counts.failed, 1);
      assert.equal(error.counts.schoolsVisited, 1);
      return true;
    });
  });

  it("rejects an out-of-range batch size", async () => {
    await assert.rejects(audit(new FakeAuditStore([]), { batchSize: 0 }), /batchSize/);
    await assert.rejects(audit(new FakeAuditStore([]), { batchSize: 1_001 }), /batchSize/);
  });
});

describe("ClassPilot PIN consistency audit CLI", () => {
  it("parses execute, batch size and report path, and rejects unknown arguments", () => {
    assert.deepEqual(parseClasspilotPinAuditCliArgs([]), { execute: false, help: false });
    assert.deepEqual(
      parseClasspilotPinAuditCliArgs(["--execute", "--batch-size", "250", "--report-path", "report.json"]),
      { execute: true, help: false, batchSize: 250, reportPath: "report.json" }
    );
    assert.deepEqual(parseClasspilotPinAuditCliArgs(["--help"]), { execute: false, help: true });
    assert.throws(() => parseClasspilotPinAuditCliArgs(["--unknown", "secret-sentinel"]), /^Error: Unknown audit CLI argument\.$/);
    assert.throws(() => parseClasspilotPinAuditCliArgs(["--batch-size"]), /requires a value/);
  });
});
