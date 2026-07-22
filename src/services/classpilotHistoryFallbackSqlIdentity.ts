import { createHash } from "node:crypto";

export const CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION =
  "history-fallback-queryid-v1" as const;

export const CLASSPILOT_HISTORY_FALLBACK_PI_STATEMENT_PREVIEW_CHARACTERS = 500;

const HISTORY_FALLBACK_PI_STATEMENT_MARKERS = [
  "requested_tiles",
  "heartbeats",
  "lateral",
] as const;

const HISTORY_FALLBACK_PARAMETER_TYPE_SIGNATURE = [
  "$1:text[]:student_ids",
  "$2:text[]:device_ids",
  "$3:text:school_id",
  "$4:bigint:history_limit",
] as const;

const SIGNED_BIGINT_MIN = -(1n << 63n);
const SIGNED_BIGINT_MAX = (1n << 63n) - 1n;
const OID_MAX = 4_294_967_295n;

export const CLASSPILOT_HISTORY_FALLBACK_PARAMETER_TYPE_SIGNATURE_SHA256 =
  sha256(JSON.stringify(HISTORY_FALLBACK_PARAMETER_TYPE_SIGNATURE));

export type ClasspilotHistoryFallbackSqlShapeIdentity = {
  version: typeof CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION;
  compiledSqlSha256: string;
  parameterTypeSignatureSha256: string;
};

export type ClasspilotHistoryFallbackSchemaMetadata = {
  trackIoTiming: true;
  engineVersion: string;
  databaseName: string;
  schemaName: string;
  searchPath: string;
  heartbeatsRelationOid: string;
  heartbeatsRelationName: string;
  heartbeatsColumnSignature: string;
  historyIndexOid: string;
  historyIndexName: string;
  historyIndexDefinition: string;
};

export class ClasspilotHistoryFallbackSqlIdentityError extends Error {
  constructor() {
    super("history_fallback_query_identity_invalid");
    this.name = "ClasspilotHistoryFallbackSqlIdentityError";
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Performance Insights bounds the tokenized statement dimension. Keep every
 * structural marker needed by the deterministic evidence gate inside that
 * visible prefix so a formatting-only query change fails before deployment.
 */
export function assertClasspilotHistoryFallbackPiStatementDiscoverable(
  compiledSql: string
): void {
  if (typeof compiledSql !== "string" || compiledSql.length === 0) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  const preview = compiledSql
    .slice(0, CLASSPILOT_HISTORY_FALLBACK_PI_STATEMENT_PREVIEW_CHARACTERS)
    .toLowerCase();
  if (
    HISTORY_FALLBACK_PI_STATEMENT_MARKERS.some(
      (marker) => !preview.includes(marker)
    )
  ) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
}

export function createClasspilotHistoryFallbackSqlShapeIdentity(
  compiledSql: string,
  params: readonly unknown[]
): ClasspilotHistoryFallbackSqlShapeIdentity {
  if (
    compiledSql.length === 0 ||
    params.length !== HISTORY_FALLBACK_PARAMETER_TYPE_SIGNATURE.length ||
    !Array.isArray(params[0]) ||
    !Array.isArray(params[1]) ||
    params[0].some((value) => typeof value !== "string") ||
    params[1].some((value) => typeof value !== "string") ||
    typeof params[2] !== "string" ||
    !Number.isInteger(params[3])
  ) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  return {
    version: CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
    compiledSqlSha256: sha256(compiledSql),
    parameterTypeSignatureSha256:
      CLASSPILOT_HISTORY_FALLBACK_PARAMETER_TYPE_SIGNATURE_SHA256,
  };
}

export function parseClasspilotHistoryFallbackQueryIdentifier(
  rows: readonly Record<string, unknown>[]
): string {
  const identifiers: string[] = [];
  for (const row of rows) {
    const planText = row["QUERY PLAN"];
    if (typeof planText !== "string") {
      throw new ClasspilotHistoryFallbackSqlIdentityError();
    }
    for (const line of planText.split(/\r?\n/)) {
      if (!/^\s*Query Identifier\s*:/i.test(line)) continue;
      const match = /^\s*Query Identifier\s*:\s*(-?(?:0|[1-9]\d*))\s*$/.exec(
        line
      );
      if (!match) throw new ClasspilotHistoryFallbackSqlIdentityError();
      const identifier = match[1];
      if (!identifier) throw new ClasspilotHistoryFallbackSqlIdentityError();
      identifiers.push(identifier);
    }
  }
  if (identifiers.length !== 1) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  let parsed: bigint;
  try {
    parsed = BigInt(identifiers[0] as string);
  } catch {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  if (parsed === 0n || parsed < SIGNED_BIGINT_MIN || parsed > SIGNED_BIGINT_MAX) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  const canonical = parsed.toString(10);
  if (canonical !== identifiers[0]) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  return canonical;
}

function requireSafeMetadataString(value: string, maximumLength = 8_192): string {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  return value;
}

function requireOid(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  let oid: bigint;
  try {
    oid = BigInt(value);
  } catch {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  if (oid > OID_MAX) throw new ClasspilotHistoryFallbackSqlIdentityError();
  return oid.toString(10);
}

export function createClasspilotHistoryFallbackSchemaIdentitySha256(
  metadata: ClasspilotHistoryFallbackSchemaMetadata
): string {
  const canonical = {
    databaseName: requireSafeMetadataString(metadata.databaseName, 256),
    engineVersion: requireSafeMetadataString(metadata.engineVersion, 128),
    heartbeatsColumnSignature: requireSafeMetadataString(
      metadata.heartbeatsColumnSignature
    ),
    heartbeatsRelationName: requireSafeMetadataString(
      metadata.heartbeatsRelationName,
      256
    ),
    heartbeatsRelationOid: requireOid(metadata.heartbeatsRelationOid),
    historyIndexDefinition: requireSafeMetadataString(
      metadata.historyIndexDefinition
    ),
    historyIndexName: requireSafeMetadataString(metadata.historyIndexName, 256),
    historyIndexOid: requireOid(metadata.historyIndexOid),
    schemaName: requireSafeMetadataString(metadata.schemaName, 256),
    searchPath: requireSafeMetadataString(metadata.searchPath, 1_024),
    trackIoTiming:
      metadata.trackIoTiming === true
        ? true
        : (() => {
            throw new ClasspilotHistoryFallbackSqlIdentityError();
          })(),
  };
  return sha256(JSON.stringify(canonical));
}

export function createClasspilotHistoryFallbackQueryIdentifierSha256(
  queryIdentifier: string
): string {
  // Re-parse through the same strict signed-bigint boundary without accepting
  // a raw identifier in ordinary application evidence.
  const parsed = parseClasspilotHistoryFallbackQueryIdentifier([
    { "QUERY PLAN": `Query Identifier: ${queryIdentifier}` },
  ]);
  return sha256(parsed);
}

export function requireStableClasspilotHistoryFallbackQueryIdentifier(
  before: string,
  after: string
): string {
  createClasspilotHistoryFallbackQueryIdentifierSha256(before);
  createClasspilotHistoryFallbackQueryIdentifierSha256(after);
  if (before !== after) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  return before;
}

export function requireStableClasspilotHistoryFallbackSchemaIdentity(
  before: {
    engineVersion: string;
    schemaIdentitySha256: string;
    trackIoTiming: true;
  },
  after: {
    engineVersion: string;
    schemaIdentitySha256: string;
    trackIoTiming: true;
  }
): typeof before {
  if (
    before.trackIoTiming !== true ||
    after.trackIoTiming !== true ||
    before.engineVersion.length === 0 ||
    before.engineVersion !== after.engineVersion ||
    !/^[a-f0-9]{64}$/.test(before.schemaIdentitySha256) ||
    before.schemaIdentitySha256 !== after.schemaIdentitySha256
  ) {
    throw new ClasspilotHistoryFallbackSqlIdentityError();
  }
  return before;
}
