import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { createSecretCipher } from "../src/services/crypto.ts";

function key(): string {
  return randomBytes(32).toString("base64");
}

function legacyEncrypt(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(base64Key, "base64"),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

describe("staged secret encryption rotation", () => {
  it("decrypts historical ciphertext with the previous key without changing its format", () => {
    const oldKey = key();
    const newKey = key();
    const historical = legacyEncrypt("0427", oldKey);
    const staged = createSecretCipher({
      currentKey: newKey,
      previousKey: oldKey,
      production: true,
    });

    assert.equal(historical.split(".").length, 3);
    assert.deepEqual(staged.decrypt(historical), {
      plaintext: "0427",
      keySource: "previous",
    });
    assert.equal(staged.hasPreviousKey, true);
    assert.equal(staged.rotationReady, true);
  });

  it("always encrypts with the current key", () => {
    const oldKey = key();
    const newKey = key();
    const staged = createSecretCipher({
      currentKey: newKey,
      previousKey: oldKey,
      production: true,
    });
    const oldOnly = createSecretCipher({ currentKey: oldKey, production: true });
    const currentOnly = createSecretCipher({ currentKey: newKey, production: true });

    const ciphertext = staged.encrypt("9012");
    assert.deepEqual(staged.decrypt(ciphertext), {
      plaintext: "9012",
      keySource: "current",
    });
    assert.deepEqual(currentOnly.decrypt(ciphertext), {
      plaintext: "9012",
      keySource: "current",
    });
    assert.throws(() => oldOnly.decrypt(ciphertext), /current key/);
  });

  it("tries current before previous for already-migrated ciphertext", () => {
    const currentKey = key();
    const previousKey = key();
    const currentCipher = createSecretCipher({ currentKey, production: true });
    const staged = createSecretCipher({
      currentKey,
      previousKey,
      production: true,
    });

    assert.equal(staged.decrypt(currentCipher.encrypt("1111")).keySource, "current");
  });

  it("refuses a rotation when current and previous keys are identical", () => {
    const sameKey = key();
    const cipher = createSecretCipher({
      currentKey: sameKey,
      previousKey: sameKey,
      production: true,
    });

    assert.equal(cipher.hasPreviousKey, true);
    assert.equal(cipher.rotationReady, false);
  });

  it("fails closed for malformed or unknown-key ciphertext", () => {
    const cipher = createSecretCipher({
      currentKey: key(),
      previousKey: key(),
      production: true,
    });
    const foreign = createSecretCipher({ currentKey: key(), production: true });

    assert.throws(() => cipher.decrypt("not-ciphertext"), /format/);
    assert.throws(
      () => cipher.decrypt(foreign.encrypt("1234")),
      /configured keys/
    );
  });
});
