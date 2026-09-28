import crypto, { type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

// "organizations" admits work and school accounts from any Entra tenant; the
// per-school tenant pin decides which of those tenants may sign anyone in.
const AUTHORITY = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
const SIGNING_KEYS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
const SCOPE = "openid profile email";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HTTP_TIMEOUT_MS = 10_000;
const SIGNING_KEYS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Refetch for an unknown key id at most this often, so forged kids cannot
// turn every callback into a request to Microsoft.
const SIGNING_KEYS_MIN_REFRESH_MS = 5 * 60 * 1000;

export class MicrosoftSignInError extends Error {
  constructor(readonly reason: string) {
    super(`Microsoft sign-in failed: ${reason}`);
    this.name = "MicrosoftSignInError";
  }
}

export type MicrosoftSignInConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type VerifiedMicrosoftIdentity = {
  tenantId: string;
  objectId: string;
  email: string | null;
};

export function getMicrosoftSignInConfig(): MicrosoftSignInConfig | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri:
      process.env.MICROSOFT_CALLBACK_URL ||
      `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/api/auth/microsoft/callback`,
  };
}

function isGuid(value: unknown): value is string {
  return typeof value === "string" && GUID_RE.test(value);
}

export function isValidMicrosoftTenantId(value: unknown): value is string {
  return isGuid(value);
}

export function microsoftIdentityId(tenantId: string, objectId: string): string {
  return `${tenantId}:${objectId}`;
}

export function microsoftTenantAllowed(
  identities: ReadonlyArray<{ school: { microsoftSignInEnabled: boolean; microsoftTenantId: string | null } }>,
  tenantId: string
): boolean {
  return identities.some(
    ({ school }) => school.microsoftSignInEnabled && school.microsoftTenantId === tenantId
  );
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildMicrosoftAuthorizeUrl(
  config: MicrosoftSignInConfig,
  request: { state: string; nonce: string; codeChallenge: string }
): string {
  const url = new URL(`${AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: config.redirectUri,
    scope: SCOPE,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export async function exchangeMicrosoftAuthCode(
  config: MicrosoftSignInConfig,
  request: { code: string; codeVerifier: string }
): Promise<string> {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: config.redirectUri,
      code_verifier: request.codeVerifier,
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new MicrosoftSignInError("token_exchange_failed");
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new MicrosoftSignInError("missing_id_token");
  return body.id_token;
}

type SigningKeys = { keys: Map<string, KeyObject>; fetchedAt: number };
let signingKeys: SigningKeys | null = null;
let signingKeysRequest: Promise<SigningKeys> | null = null;

async function fetchSigningKeys(): Promise<SigningKeys> {
  const response = await fetch(SIGNING_KEYS_URL, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) throw new MicrosoftSignInError("signing_keys_unavailable");
  const body = (await response.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
  }
  return { keys, fetchedAt: Date.now() };
}

export async function getMicrosoftSigningKey(kid: string): Promise<KeyObject | undefined> {
  const age = signingKeys ? Date.now() - signingKeys.fetchedAt : Infinity;
  const refresh =
    age > SIGNING_KEYS_MAX_AGE_MS ||
    (!signingKeys?.keys.has(kid) && age > SIGNING_KEYS_MIN_REFRESH_MS);
  if (refresh) {
    signingKeysRequest ??= fetchSigningKeys().finally(() => {
      signingKeysRequest = null;
    });
    signingKeys = await signingKeysRequest;
  }
  return signingKeys?.keys.get(kid);
}

function firstEmail(...values: unknown[]): string | null {
  const found = values.find((value): value is string => typeof value === "string" && value.includes("@"));
  return found ? found.trim().toLowerCase() : null;
}

/**
 * Verifies an Entra ID v2 ID token for this app: RS256 signature from
 * Microsoft's published keys, audience, the issuer of the token's own tenant,
 * the session nonce, and expiry. The tenant is returned for the caller to pin.
 */
export async function verifyMicrosoftIdToken(
  idToken: string,
  options: {
    clientId: string;
    nonce: string;
    getSigningKey?: (kid: string) => Promise<KeyObject | undefined>;
  }
): Promise<VerifiedMicrosoftIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded.payload === "string") throw new MicrosoftSignInError("invalid_id_token");
  if (decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string") {
    throw new MicrosoftSignInError("invalid_id_token");
  }
  const claimedTenantId = decoded.payload.tid;
  if (!isValidMicrosoftTenantId(claimedTenantId)) throw new MicrosoftSignInError("invalid_tenant");

  const key = await (options.getSigningKey ?? getMicrosoftSigningKey)(decoded.header.kid);
  if (!key) throw new MicrosoftSignInError("unknown_signing_key");

  let claims: jwt.JwtPayload;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      audience: options.clientId,
      issuer: `https://login.microsoftonline.com/${claimedTenantId}/v2.0`,
      nonce: options.nonce,
      clockTolerance: 60,
    }) as jwt.JwtPayload;
  } catch {
    throw new MicrosoftSignInError("invalid_id_token");
  }
  if (claims.tid !== claimedTenantId || !isGuid(claims.oid)) {
    throw new MicrosoftSignInError("invalid_id_token");
  }
  return {
    tenantId: claimedTenantId,
    objectId: claims.oid,
    email: firstEmail(claims.email, claims.preferred_username),
  };
}
