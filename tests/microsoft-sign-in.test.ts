import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import jwt from "jsonwebtoken";

import {
  MICROSOFT_SIGN_IN_EXPAND_SQL,
  microsoftSignInMigration,
} from "../src/db/microsoftSignInMigration.js";
import {
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";
import {
  MicrosoftSignInError,
  buildMicrosoftAuthorizeUrl,
  createPkcePair,
  getMicrosoftSigningKey,
  isValidMicrosoftTenantId,
  microsoftTenantAllowed,
  verifyMicrosoftIdToken,
} from "../src/services/microsoftSignIn.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_TENANT = "ffffffff-0000-1111-2222-333333333333";
const OBJECT_ID = "12345678-90ab-cdef-1234-567890abcdef";
const NONCE = "session-nonce";
const KID = "test-kid";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: strangerKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function signIdToken(
  claims: Record<string, unknown> = {},
  options: { audience?: string; issuerTenant?: string; kid?: string; key?: crypto.KeyObject } = {}
): string {
  const tid = (claims.tid as string | undefined) ?? TENANT;
  return jwt.sign(
    {
      tid,
      oid: OBJECT_ID,
      nonce: NONCE,
      email: "Teacher@District.org",
      preferred_username: "upn@district.org",
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    },
    options.key ?? privateKey,
    {
      algorithm: "RS256",
      keyid: options.kid ?? KID,
      audience: options.audience ?? CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${options.issuerTenant ?? tid}/v2.0`,
    }
  );
}

function verify(token: string, nonce = NONCE) {
  return verifyMicrosoftIdToken(token, {
    clientId: CLIENT_ID,
    nonce,
    getSigningKey: async (kid) => (kid === KID ? publicKey : undefined),
  });
}

async function assertRefused(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MicrosoftSignInError, `expected MicrosoftSignInError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("Microsoft ID token verification", () => {
  it("returns the tenant, object ID and lowercased email of a valid token", async () => {
    assert.deepEqual(await verify(signIdToken()), {
      tenantId: TENANT,
      objectId: OBJECT_ID,
      email: "teacher@district.org",
    });
  });

  it("falls back to preferred_username when the email claim is absent", async () => {
    const identity = await verify(signIdToken({ email: undefined }));
    assert.equal(identity.email, "upn@district.org");
  });

  it("refuses a token issued for another app", async () => {
    await assertRefused(verify(signIdToken({}, { audience: "another-app" })), "invalid_id_token");
  });

  it("refuses a token whose issuer is not its own tenant", async () => {
    await assertRefused(verify(signIdToken({}, { issuerTenant: OTHER_TENANT })), "invalid_id_token");
  });

  it("refuses a token minted for a different sign-in attempt", async () => {
    await assertRefused(verify(signIdToken(), "another-nonce"), "invalid_id_token");
  });

  it("refuses an expired token beyond the clock tolerance", async () => {
    await assertRefused(verify(signIdToken({ exp: Math.floor(Date.now() / 1000) - 120 })), "invalid_id_token");
  });

  it("refuses a token signed by a key Microsoft did not publish under that key ID", async () => {
    await assertRefused(verify(signIdToken({}, { key: strangerKey })), "invalid_id_token");
  });

  it("refuses an HMAC token that tries to use the public key as a shared secret", async () => {
    const forged = jwt.sign(
      { tid: TENANT, oid: OBJECT_ID, nonce: NONCE },
      publicKey.export({ type: "spki", format: "pem" }),
      { algorithm: "HS256", keyid: KID, audience: CLIENT_ID, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` }
    );
    await assertRefused(verify(forged), "invalid_id_token");
  });

  it("refuses an unknown signing key ID and a tenant that is not a GUID", async () => {
    await assertRefused(verify(signIdToken({}, { kid: "rotated-away" })), "unknown_signing_key");
    await assertRefused(verify(signIdToken({ tid: "common" })), "invalid_tenant");
  });

  it("refuses a token without a user object ID", async () => {
    await assertRefused(verify(signIdToken({ oid: undefined })), "invalid_id_token");
  });
});

describe("Microsoft sign-in request and tenant pinning", () => {
  it("asks the organizations authority for an OIDC code with PKCE", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl(
        { clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "https://school-pilot.net/api/auth/microsoft/callback" },
        { state: "state-1", nonce: NONCE, codeChallenge: "challenge-1" }
      )
    );
    assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "openid profile email");
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.equal(url.searchParams.get("nonce"), NONCE);
    assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_secret"), null);
  });

  it("derives the PKCE challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
    assert.ok(verifier.length >= 43);
  });

  it("accepts only a lowercase directory GUID as a tenant ID", () => {
    assert.equal(isValidMicrosoftTenantId(TENANT), true);
    assert.equal(isValidMicrosoftTenantId(TENANT.toUpperCase()), false);
    assert.equal(isValidMicrosoftTenantId("district.onmicrosoft.com"), false);
    assert.equal(isValidMicrosoftTenantId(null), false);
  });

  it("allows a tenant only through a school that turned Microsoft on for that tenant", () => {
    const school = (microsoftSignInEnabled: boolean, microsoftTenantId: string | null) => ({
      school: { microsoftSignInEnabled, microsoftTenantId },
    });
    assert.equal(microsoftTenantAllowed([school(true, TENANT)], TENANT), true);
    assert.equal(microsoftTenantAllowed([school(false, TENANT)], TENANT), false);
    assert.equal(microsoftTenantAllowed([school(true, OTHER_TENANT)], TENANT), false);
    assert.equal(microsoftTenantAllowed([school(false, null), school(true, TENANT)], TENANT), true);
    assert.equal(microsoftTenantAllowed([], TENANT), false);
  });

  it("caches Microsoft signing keys and refetches an unknown key ID at most every five minutes", async () => {
    const jwk = publicKey.export({ format: "jwk" });
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", use: "sig" }] }), { status: 200 })
    );
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
      assert.ok(await getMicrosoftSigningKey("k1"));
      assert.ok(await getMicrosoftSigningKey("k1"));
      assert.equal(fetchMock.mock.callCount(), 1);

      assert.equal(await getMicrosoftSigningKey("forged"), undefined);
      assert.equal(fetchMock.mock.callCount(), 1, "an unknown key ID inside five minutes must not refetch");

      mock.timers.tick(5 * 60 * 1000 + 1);
      assert.equal(await getMicrosoftSigningKey("forged"), undefined);
      assert.equal(fetchMock.mock.callCount(), 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });
});

describe("Microsoft sign-in schema rollout", () => {
  it("ships in the production expand plan before the deferred staff identity contract", () => {
    const index = schoolPilot27Migrations.findIndex((migration) => migration.id === microsoftSignInMigration.id);
    const contractIndex = schoolPilot27Migrations.findIndex(
      (migration) => migration.id === STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]
    );
    assert.ok(index >= 0 && contractIndex > index);
    assert.ok(schoolPilot27ExpandMigrations.some((migration) => migration.id === microsoftSignInMigration.id));
    assert.equal(microsoftSignInMigration.mode, "transactional");
    assert.equal(
      microsoftSignInMigration.checksum,
      crypto.createHash("sha256").update(MICROSOFT_SIGN_IN_EXPAND_SQL).digest("hex")
    );
  });

  it("is additive, off by default, and pins sign-in to a tenant", () => {
    assert.match(MICROSOFT_SIGN_IN_EXPAND_SQL, /ADD COLUMN IF NOT EXISTS microsoft_sign_in_enabled BOOLEAN NOT NULL DEFAULT false/);
    assert.match(MICROSOFT_SIGN_IN_EXPAND_SQL, /ADD CONSTRAINT schools_microsoft_sign_in_tenant_check/);
    assert.match(MICROSOFT_SIGN_IN_EXPAND_SQL, /ADD CONSTRAINT users_microsoft_id_unique UNIQUE \(microsoft_id\)/);
    assert.doesNotMatch(MICROSOFT_SIGN_IN_EXPAND_SQL, /\bDROP\b|\bUPDATE\b/);
  });

  it("is mirrored by the non-production startup bootstrap", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const start = index.indexOf("export async function runStartupMigrations");
    const end = index.indexOf("async function runMigrationsAndExit", start);
    assert.ok(start >= 0 && end > start);
    assert.match(index.slice(start, end), /pool\.query\(MICROSOFT_SIGN_IN_EXPAND_SQL\)/);
  });
});
