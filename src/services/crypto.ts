import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ENCRYPTION_KEY_ENV = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY";
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let warnedEphemeralKey = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const rawKey = process.env[ENCRYPTION_KEY_ENV];

  if (rawKey) {
    const trimmed = rawKey.trim();
    if (trimmed) {
      const base64Key = Buffer.from(trimmed, "base64");
      if (base64Key.length === KEY_BYTES) {
        cachedKey = base64Key;
        return base64Key;
      }
      const rawBuffer = Buffer.from(trimmed);
      if (rawBuffer.length === KEY_BYTES) {
        cachedKey = rawBuffer;
        return rawBuffer;
      }
    }
  }

  if (isProduction()) {
    throw new Error(
      `Missing or invalid ${ENCRYPTION_KEY_ENV}. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  if (!warnedEphemeralKey) {
    console.warn(
      "[crypto] Using ephemeral dev encryption key; tokens will not decrypt across restarts."
    );
    warnedEphemeralKey = true;
  }
  cachedKey = randomBytes(KEY_BYTES);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const key = getEncryptionKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptSecret(ciphertext: string): string {
  const [ivPart, tagPart, dataPart] = ciphertext.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("Invalid encrypted secret format.");
  }

  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  const data = Buffer.from(dataPart, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error("Invalid encrypted secret IV length.");
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
