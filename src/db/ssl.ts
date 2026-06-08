import { existsSync, readFileSync } from "fs";
import type { ClientConfig } from "pg";

const DEFAULT_RDS_CA_PATH = "/app/rds-ca.pem";

function sslModeFor(connectionString?: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).searchParams.get("sslmode") ?? undefined;
  } catch {
    return connectionString.match(/[?&]sslmode=([^&]+)/)?.[1];
  }
}

function hostFor(connectionString?: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
}

function rdsCa(): string | undefined {
  const caPath = process.env.RDS_CA_PATH || DEFAULT_RDS_CA_PATH;
  return existsSync(caPath) ? readFileSync(caPath, "utf8") : undefined;
}

export function buildPgSslConfig(connectionString?: string): ClientConfig["ssl"] {
  const mode = sslModeFor(connectionString);
  if (!mode) return undefined;

  const ca = rdsCa();
  if (mode === "verify-full" || mode === "verify-ca") {
    return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
  }

  if (mode === "require") {
    const host = hostFor(connectionString);
    if (ca && host?.endsWith(".rds.amazonaws.com")) {
      return { ca, rejectUnauthorized: true };
    }
    return { rejectUnauthorized: false };
  }

  if (mode === "no-verify") {
    return { rejectUnauthorized: false };
  }

  return undefined;
}
