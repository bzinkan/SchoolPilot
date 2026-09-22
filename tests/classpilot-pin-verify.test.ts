import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";
import {
  CLASSPILOT_PIN_VERIFY_MODE_ENV,
  classpilotPinVerifyMode,
  decryptClassPilotPin,
  encryptClassPilotPin,
  verifyClassPilotPin,
} from "../src/services/classpilotPins.ts";

// Cost 4 keeps the legacy-path fixtures fast; production hashes are cost 12.
const HASH_1234 = await bcrypt.hash("1234", 4);

function observedCompare() {
  const calls: Array<[string, string]> = [];
  const compare = async (pin: string, hash: string) => {
    calls.push([pin, hash]);
    return bcrypt.compare(pin, hash);
  };
  return { calls, compare };
}

describe("verifyClassPilotPin", () => {
  it("accepts the encrypted PIN without touching bcrypt", async () => {
    const { calls, compare } = observedCompare();
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: encryptClassPilotPin("1234") };
    assert.deepEqual(await verifyClassPilotPin(student, "1234", { compare }), { ok: true, via: "encrypted" });
    assert.deepEqual(calls, []);
  });

  it("rejects a wrong PIN from the encrypted value and never falls back to bcrypt", async () => {
    const { calls, compare } = observedCompare();
    // The hash would accept 1234; the decrypted PIN is the source of truth.
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: encryptClassPilotPin("5678") };
    assert.deepEqual(await verifyClassPilotPin(student, "1234", { compare }), { ok: false, reason: "PIN_MISMATCH" });
    assert.deepEqual(calls, [], "a decrypted mismatch must not spend a bcrypt compare");
  });

  it("uses bcrypt for a hash-only row and returns a backfill ciphertext on success", async () => {
    const { calls, compare } = observedCompare();
    const result = await verifyClassPilotPin({ classpilotPinHash: HASH_1234, classpilotPinEncrypted: null }, "1234", { compare });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.via, "bcrypt");
    assert.ok(result.ok && result.backfillEncrypted, "legacy row must offer a ciphertext to backfill");
    assert.equal(decryptClassPilotPin(result.ok ? result.backfillEncrypted : null), "1234");
    assert.equal(calls.length, 1);
  });

  it("rejects a wrong PIN on a hash-only row with exactly one bcrypt compare", async () => {
    const { calls, compare } = observedCompare();
    assert.deepEqual(
      await verifyClassPilotPin({ classpilotPinHash: HASH_1234, classpilotPinEncrypted: null }, "0000", { compare }),
      { ok: false, reason: "PIN_MISMATCH" }
    );
    assert.equal(calls.length, 1);
  });

  it("reports an unconfigured PIN when neither column is present", async () => {
    const { calls, compare } = observedCompare();
    assert.deepEqual(
      await verifyClassPilotPin({ classpilotPinHash: null, classpilotPinEncrypted: null }, "1234", { compare }),
      { ok: false, reason: "PIN_NOT_CONFIGURED" }
    );
    assert.deepEqual(calls, []);
  });

  it("falls back to bcrypt when the ciphertext is undecryptable, without re-encrypting over it", async () => {
    const { calls, compare } = observedCompare();
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: "not-a-ciphertext" };
    assert.deepEqual(await verifyClassPilotPin(student, "1234", { compare }), { ok: true, via: "bcrypt" });
    assert.equal(calls.length, 1);
  });

  it("rejects a malformed entered PIN before any work", async () => {
    const { calls, compare } = observedCompare();
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: encryptClassPilotPin("1234") };
    assert.deepEqual(await verifyClassPilotPin(student, "12345", { compare }), { ok: false, reason: "PIN_MISMATCH" });
    assert.deepEqual(await verifyClassPilotPin(student, "12a4", { compare }), { ok: false, reason: "PIN_MISMATCH" });
    assert.deepEqual(calls, []);
  });

  it("honours the bcrypt kill switch even when an encrypted PIN is present", async () => {
    const { calls, compare } = observedCompare();
    const env = { [CLASSPILOT_PIN_VERIFY_MODE_ENV]: "bcrypt" };
    assert.equal(classpilotPinVerifyMode(env), "bcrypt");
    assert.equal(classpilotPinVerifyMode({}), "encrypted");
    assert.equal(classpilotPinVerifyMode({ [CLASSPILOT_PIN_VERIFY_MODE_ENV]: "anything-else" }), "encrypted");
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: encryptClassPilotPin("1234") };
    assert.deepEqual(await verifyClassPilotPin(student, "1234", { compare, env }), { ok: true, via: "bcrypt" });
    assert.equal(calls.length, 1);
  });

  it("verifies encrypted PINs in microseconds, not bcrypt time", async () => {
    const { compare } = observedCompare();
    const student = { classpilotPinHash: HASH_1234, classpilotPinEncrypted: encryptClassPilotPin("1234") };
    const startedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      const pin = index % 2 === 0 ? "1234" : "4321";
      const result = await verifyClassPilotPin(student, pin, { compare });
      assert.equal(result.ok, index % 2 === 0);
    }
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 1_000, `1,000 verifications took ${elapsedMs.toFixed(0)} ms`);
  });
});
