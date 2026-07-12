import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export const ENCRYPTION_KEY_ENV = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY";
export const PREVIOUS_ENCRYPTION_KEY_ENV =
  "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS";

const IV_BYTES = 12;
const KEY_BYTES = 32;

let defaultCipher: SecretCipher | null = null;
let warnedEphemeralKey = false;

export type SecretKeySource = "current" | "previous";

export type DecryptedSecret = {
  plaintext: string;
  keySource: SecretKeySource;
};

export type SecretCipher = {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): DecryptedSecret;
  hasPreviousKey: boolean;
  rotationReady: boolean;
};

export type SecretCipherOptions = {
  currentKey?: string;
  previousKey?: string;
  production?: boolean;
};

function parseConfiguredKey(rawKey: string | undefined, label: string): Buffer | null {
  const trimmed = rawKey?.trim();
  if (!trimmed) return null;

  const base64Key = Buffer.from(trimmed, "base64");
  if (base64Key.length === KEY_BYTES) return base64Key;

  const rawBuffer = Buffer.from(trimmed);
  if (rawBuffer.length === KEY_BYTES) return rawBuffer;

  throw new Error(
    `Invalid ${label}. Expected a 32-byte raw value or base64-encoded 32-byte value.`
  );
}

function encryptionKey(options: SecretCipherOptions): Buffer {
  const configured = parseConfiguredKey(options.currentKey, ENCRYPTION_KEY_ENV);
  if (configured) return configured;

  if (options.production) {
    throw new Error(
      `Missing ${ENCRYPTION_KEY_ENV}. Generate a base64-encoded 32-byte key.`
    );
  }

  if (!warnedEphemeralKey) {
    console.warn(
      "[crypto] Using ephemeral dev encryption key; encrypted values will not decrypt across restarts."
    );
    warnedEphemeralKey = true;
  }
  return randomBytes(KEY_BYTES);
}

function ciphertextParts(ciphertext: string): {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
} {
  const [ivPart, tagPart, dataPart] = ciphertext.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("Invalid encrypted secret format.");
  }

  const iv = Buffer.from(ivPart, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("Invalid encrypted secret IV length.");
  }

  return {
    iv,
    tag: Buffer.from(tagPart, "base64"),
    data: Buffer.from(dataPart, "base64"),
  };
}

function decryptWithKey(
  parts: ReturnType<typeof ciphertextParts>,
  key: Buffer
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, parts.iv);
  decipher.setAuthTag(parts.tag);
  const decrypted = Buffer.concat([
    decipher.update(parts.data),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Build a dual-read/current-write cipher for a staged key rotation.
 *
 * Ciphertext stays byte-for-byte compatible with the historical
 * `base64(iv).base64(tag).base64(ciphertext)` format. New writes always use the
 * current key. Reads try the current key first and only fall back to the optional
 * previous key, so already-migrated rows are naturally idempotent.
 */
export function createSecretCipher(
  options: SecretCipherOptions = {}
): SecretCipher {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const currentKey = encryptionKey({ ...options, production });
  const previousKey = parseConfiguredKey(
    options.previousKey,
    PREVIOUS_ENCRYPTION_KEY_ENV
  );

  return {
    hasPreviousKey: previousKey !== null,
    rotationReady: previousKey !== null && !currentKey.equals(previousKey),

    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", currentKey, iv);
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
    },

    decrypt(ciphertext: string): DecryptedSecret {
      const parts = ciphertextParts(ciphertext);
      try {
        return {
          plaintext: decryptWithKey(parts, currentKey),
          keySource: "current",
        };
      } catch {
        if (!previousKey) {
          throw new Error("Unable to decrypt secret with the current key.");
        }
      }

      try {
        return {
          plaintext: decryptWithKey(parts, previousKey),
          keySource: "previous",
        };
      } catch {
        throw new Error("Unable to decrypt secret with the configured keys.");
      }
    },
  };
}

function getDefaultCipher(): SecretCipher {
  if (!defaultCipher) {
    defaultCipher = createSecretCipher({
      currentKey: process.env[ENCRYPTION_KEY_ENV],
      previousKey: process.env[PREVIOUS_ENCRYPTION_KEY_ENV],
    });
  }
  return defaultCipher;
}

export function encryptSecret(plaintext: string): string {
  return getDefaultCipher().encrypt(plaintext);
}

export function decryptSecretWithKeySource(ciphertext: string): DecryptedSecret {
  return getDefaultCipher().decrypt(ciphertext);
}

export function decryptSecret(ciphertext: string): string {
  return decryptSecretWithKeySource(ciphertext).plaintext;
}

export function secretEncryptionRotationReady(): boolean {
  return getDefaultCipher().rotationReady;
}
