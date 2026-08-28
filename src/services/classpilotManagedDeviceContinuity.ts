/**
 * Stateless managed-device continuity for ClassPilot shared sign-in.
 *
 * The enterprise directory identifier crosses exactly one authenticated
 * issuance request and is immediately reduced to a dedicated school-scoped
 * managed-device UUID projection. Only that opaque binding enters signed
 * proofs, database rows, responses, and downstream session authority.
 */
import crypto from "node:crypto";
import { z } from "zod";
import {
  classpilotManagedDeviceHmac,
} from "./classpilotKioskLaunchTicket.js";
import {
  CLASSPILOT_SESSION_RECOVERY_TOKEN_PATTERN,
  hashStudentSessionRecoveryToken,
  normalizeStudentSessionRecoveryToken,
} from "./classpilotStudentSessionAuthority.js";

export const CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY =
  "managedDeviceContinuityV1" as const;
export const CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS = 60;
export const CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS = 600;
export const CLASSPILOT_MANAGED_DEVICE_CONTINUITY_REQUESTS_PER_MINUTE = 3_000;
export const CLASSPILOT_MANAGED_DEVICE_CONTINUITY_IP_REQUESTS_PER_MINUTE = 6_000;

const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_SIGNED_PAYLOAD_LENGTH = 512;
const MAX_AUDIENCE_LENGTH = 128;
const SCHOOL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DIRECTORY_DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const OPAQUE_DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFLIGHT_TOKEN_PATTERN =
  /^cpmp1\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;
const DEVICE_PROOF_PATTERN =
  /^cpmd1\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;

export const classpilotManagedDevicePreflightRequestSchema = z
  .object({
    clientProtocolVersion: z.literal(3),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.capabilities.includes("scopedAuthorityChecksV1")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Scoped authority capability is required",
      });
    }
    if (!value.capabilities.includes("kioskLaunchTicketV2")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Managed enterprise-device capability is required",
      });
    }
    if (!value.capabilities.includes(CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Managed-device continuity capability is required",
      });
    }
  });

export const classpilotManagedDeviceIssuanceRequestSchema = z
  .object({
    directoryDeviceId: z.string().trim().regex(DIRECTORY_DEVICE_ID_PATTERN),
    recoveryToken: z.string().trim().regex(CLASSPILOT_SESSION_RECOVERY_TOKEN_PATTERN).optional(),
  })
  .strict();

const preflightPayloadSchema = z
  .object({
    v: z.literal(1),
    t: z.literal("preflight"),
    s: z.string().regex(SCHOOL_ID_PATTERN),
    a: z.string().min(1).max(MAX_AUDIENCE_LENGTH),
    i: z.number().int().nonnegative(),
    e: z.number().int().positive(),
    j: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

const deviceProofPayloadSchema = z
  .object({
    v: z.literal(1),
    t: z.literal("device"),
    s: z.string().regex(SCHOOL_ID_PATTERN),
    a: z.string().min(1).max(MAX_AUDIENCE_LENGTH),
    d: z.string().regex(OPAQUE_DEVICE_ID_PATTERN),
    r: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    i: z.number().int().nonnegative(),
    e: z.number().int().positive(),
    j: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

type PreflightPayload = z.infer<typeof preflightPayloadSchema>;
type DeviceProofPayload = z.infer<typeof deviceProofPayloadSchema>;

export type ClasspilotManagedDeviceContinuityProof = {
  schoolId: string;
  deviceId: string;
  recoveryTokenHash: string | null;
  issuedAt: Date;
  expiresAt: Date;
};

function epochSeconds(now: number): number {
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Invalid continuity proof clock");
  return Math.floor(now / 1_000);
}

function nonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function continuityConfigurationUnavailable(): Error & {
  status: number;
  code: string;
  expose: boolean;
} {
  return Object.assign(new Error("Managed-device continuity is unavailable"), {
    status: 503,
    code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE",
    expose: true,
  });
}

function configuredAudience(env: NodeJS.ProcessEnv): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") {
      throw continuityConfigurationUnavailable();
    }
    return "http://localhost:4000";
  }
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw continuityConfigurationUnavailable();
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const audience = `${parsed.origin}${pathname}`;
    if (audience.length > MAX_AUDIENCE_LENGTH) {
      throw continuityConfigurationUnavailable();
    }
    return audience;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE"
    ) {
      throw error;
    }
    throw continuityConfigurationUnavailable();
  }
}

/**
 * Stable only for one school and this ClassPilot shared-device purpose. The
 * configured root HMAC secret must remain stable across deployments; rotation
 * intentionally changes future bindings and must be handled as a coordinated
 * continuity reset. A dedicated domain prevents linkage to PassPilot kiosk
 * continuity even though both use the same protected root secret.
 */
export function schoolScopedManagedClasspilotDeviceId(
  schoolId: string,
  directoryDeviceId: string
): string {
  if (
    !SCHOOL_ID_PATTERN.test(schoolId)
    || !DIRECTORY_DEVICE_ID_PATTERN.test(directoryDeviceId)
  ) {
    throw new TypeError("Invalid managed-device continuity projection input");
  }
  const bytes = Buffer.from(
    classpilotManagedDeviceHmac(
      "classpilot-managed-shared-device-v1",
      [schoolId, directoryDeviceId]
    ).subarray(0, 16)
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sign(domain: string, encodedPayload: string): string {
  return classpilotManagedDeviceHmac(domain, [encodedPayload]).toString("base64url");
}

function encodeSignedPayload(
  prefix: "cpmp1" | "cpmd1",
  domain: string,
  payload: PreflightPayload | DeviceProofPayload
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > MAX_SIGNED_PAYLOAD_LENGTH) {
    throw new RangeError("Continuity proof payload is too large");
  }
  return `${prefix}.${encoded}.${sign(domain, encoded)}`;
}

function decodeVerifiedPayload<T>(options: {
  token: string;
  pattern: RegExp;
  domain: string;
  schema: z.ZodType<T>;
}): T | null {
  const match = options.pattern.exec(options.token);
  if (!match) return null;
  const encoded = match[1]!;
  const suppliedSignature = Buffer.from(match[2]!, "base64url");
  const expectedSignature = Buffer.from(sign(options.domain, encoded), "base64url");
  if (
    suppliedSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > MAX_SIGNED_PAYLOAD_LENGTH) return null;
    const parsedJson = JSON.parse(decoded) as unknown;
    const parsed = options.schema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function validLifetime(options: {
  issuedAt: number;
  expiresAt: number;
  now: number;
  maxTtlSeconds: number;
}): boolean {
  return (
    options.issuedAt <= options.now + MAX_CLOCK_SKEW_SECONDS
    && options.expiresAt > options.now
    && options.expiresAt > options.issuedAt
    && options.expiresAt - options.issuedAt <= options.maxTtlSeconds
  );
}

export function issueClasspilotManagedDevicePreflight(options: {
  schoolId: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): { preflightToken: string; expiresAt: Date; expiresInSeconds: number } {
  if (!SCHOOL_ID_PATTERN.test(options.schoolId)) {
    throw new TypeError("Invalid continuity school authority");
  }
  const issuedAt = epochSeconds(options.now ?? Date.now());
  const expiresAt = issuedAt + CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS;
  const audience = configuredAudience(options.env ?? process.env);
  const preflightToken = encodeSignedPayload(
    "cpmp1",
    "classpilot-managed-device-continuity-preflight-v1",
    {
      v: 1,
      t: "preflight",
      s: options.schoolId,
      a: audience,
      i: issuedAt,
      e: expiresAt,
      j: nonce(),
    }
  );
  return {
    preflightToken,
    expiresAt: new Date(expiresAt * 1_000),
    expiresInSeconds: CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS,
  };
}

export function verifyClasspilotManagedDevicePreflight(options: {
  token: string;
  schoolId: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const now = epochSeconds(options.now ?? Date.now());
  const payload = decodeVerifiedPayload({
    token: options.token,
    pattern: PREFLIGHT_TOKEN_PATTERN,
    domain: "classpilot-managed-device-continuity-preflight-v1",
    schema: preflightPayloadSchema,
  });
  return !!payload
    && payload.s === options.schoolId
    && payload.a === configuredAudience(options.env ?? process.env)
    && validLifetime({
      issuedAt: payload.i,
      expiresAt: payload.e,
      now,
      maxTtlSeconds: CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS,
    });
}

export function issueClasspilotManagedDeviceContinuityProof(options: {
  schoolId: string;
  directoryDeviceId: string;
  recoveryToken?: string | null;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): {
  continuityProof: string;
  expiresAt: Date;
  expiresInSeconds: number;
} {
  if (
    !SCHOOL_ID_PATTERN.test(options.schoolId)
    || !DIRECTORY_DEVICE_ID_PATTERN.test(options.directoryDeviceId)
  ) {
    throw new TypeError("Invalid managed-device continuity request");
  }
  const issuedAt = epochSeconds(options.now ?? Date.now());
  const expiresAt = issuedAt + CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS;
  const audience = configuredAudience(options.env ?? process.env);
  const deviceId = schoolScopedManagedClasspilotDeviceId(
    options.schoolId,
    options.directoryDeviceId
  );
  const recoveryToken = normalizeStudentSessionRecoveryToken(options.recoveryToken);
  if (options.recoveryToken != null && !recoveryToken) {
    throw new TypeError("Invalid managed-device recovery transition");
  }
  const continuityProof = encodeSignedPayload(
    "cpmd1",
    "classpilot-managed-device-continuity-proof-v1",
    {
      v: 1,
      t: "device",
      s: options.schoolId,
      a: audience,
      d: deviceId,
      r: recoveryToken ? hashStudentSessionRecoveryToken(recoveryToken) : null,
      i: issuedAt,
      e: expiresAt,
      j: nonce(),
    }
  );
  return {
    continuityProof,
    expiresAt: new Date(expiresAt * 1_000),
    expiresInSeconds: CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS,
  };
}

export function verifyClasspilotManagedDeviceContinuityProof(options: {
  token: string;
  schoolId: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): ClasspilotManagedDeviceContinuityProof | null {
  const now = epochSeconds(options.now ?? Date.now());
  const payload = decodeVerifiedPayload({
    token: options.token,
    pattern: DEVICE_PROOF_PATTERN,
    domain: "classpilot-managed-device-continuity-proof-v1",
    schema: deviceProofPayloadSchema,
  });
  if (
    !payload
    || payload.s !== options.schoolId
    || payload.a !== configuredAudience(options.env ?? process.env)
    || !validLifetime({
      issuedAt: payload.i,
      expiresAt: payload.e,
      now,
      maxTtlSeconds: CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS,
    })
  ) {
    return null;
  }
  return {
    schoolId: payload.s,
    deviceId: payload.d,
    recoveryTokenHash: payload.r,
    issuedAt: new Date(payload.i * 1_000),
    expiresAt: new Date(payload.e * 1_000),
  };
}

function authorizationValue(
  authorization: string | string[] | undefined
): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === "string" ? value.trim() : null;
}

export function classpilotManagedDevicePreflightTokenFromAuthorization(
  authorization: string | string[] | undefined
): string | null {
  const value = authorizationValue(authorization);
  const match = value && /^ClassPilot-Preflight (cpmp1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export function classpilotManagedDeviceProofFromAuthorization(
  authorization: string | string[] | undefined
): string | null {
  const value = authorizationValue(authorization);
  const match = value && /^ClassPilot-Device (cpmd1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export function classpilotManagedDeviceAuthorizationPresented(
  authorization: string | string[] | undefined
): boolean {
  const value = authorizationValue(authorization);
  return !!value && /^ClassPilot-Device(?:\s|$)/.test(value);
}
