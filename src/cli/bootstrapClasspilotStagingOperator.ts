import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import pg from "pg";
import { buildPgSslConfig } from "../db/ssl.js";

const ORIGIN = "https://staging.school-pilot.net";
const EMAIL = "operator@classpilot-staging.invalid";
const MARKER = "SYNTHETIC STAGING BOOTSTRAP OPERATOR";

/** A fresh isolated staging database only; never imports application startup. */
export function stagingOperatorEnvironment(environment: NodeJS.ProcessEnv): { databaseUrl: string; password: string } {
  if (environment.APP_ENV !== "staging" || environment.PUBLIC_BASE_URL !== ORIGIN
      || environment.RLS_GUC_ENABLED !== "true"
      || environment.CLP_STAGING_BOOTSTRAP_ACK !== "FRESH_ISOLATED_STAGING_NO_CUSTOMER_DATA") {
    throw new Error("Explicit isolated staging environment and acknowledgement required");
  }
  const databaseUrl = environment.DATABASE_URL || "";
  let database: URL;
  try { database = new URL(databaseUrl); } catch { throw new Error("Explicit staging database required"); }
  const expectedHost = environment.CLP_STAGING_DATABASE_HOST || "";
  if (!expectedHost || database.hostname !== expectedHost
      || !/^schoolpilot-staging-db\.[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(expectedHost)
      || !["postgres:", "postgresql:"].includes(database.protocol)
      || database.pathname !== "/schoolpilot_staging" || database.hash
      || (database.port !== "" && database.port !== "5432")
      || [...database.searchParams.keys()].length !== 1
      || database.searchParams.getAll("sslmode").length !== 1
      || database.searchParams.get("sslmode") !== "verify-full"
      || environment.CLP_STAGING_DATABASE_NAME !== "schoolpilot_staging") {
    throw new Error("Database must match the explicitly bound isolated staging RDS database");
  }
  const password = environment.CLP_SUPER_ADMIN_PASSWORD || "";
  if (environment.CLP_SUPER_ADMIN_EMAIL !== EMAIL || password.length < 24 || password.length > 128) {
    throw new Error("Exact synthetic operator identity and a process-only 24..128 character password required");
  }
  if (["SENDGRID_API_KEY", "SMTP_PASSWORD", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY",
    "TELEGRAM_BOT_TOKEN", "GOOGLE_CLIENT_SECRET", "GOOGLE_SERVICE_ACCOUNT_KEY", "MICROSOFT_CLIENT_SECRET"]
      .some(key => Boolean(environment[key]))) {
    throw new Error("External email, billing and AI providers must be absent from staging bootstrap");
  }
  return { databaseUrl, password };
}

export async function bootstrapStagingOperator(environment = process.env): Promise<void> {
  const { databaseUrl, password } = stagingOperatorEnvironment(environment);
  const client = new pg.Client(stagingOperatorConnection(databaseUrl));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('classpilot-staging-operator-bootstrap'))");
    const role = (await client.query<{ super: boolean; bypass: boolean; owner: boolean }>(`
      SELECT r.rolsuper AS super, r.rolbypassrls AS bypass,
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r' AND c.relowner = r.oid) AS owner
      FROM pg_roles r WHERE r.rolname = current_user
    `)).rows[0];
    if (!role || role.super || role.bypass || role.owner) throw new Error("Restricted non-owner runtime role required");
    await client.query("SELECT set_config('app.is_super', 'on', true)");
    const counts = (await client.query<{ schools: string; users: string }>(
      "SELECT (SELECT count(*) FROM schools)::text AS schools, (SELECT count(*) FROM users)::text AS users",
    )).rows[0];
    if (!counts || counts.schools !== "0") throw new Error("Bootstrap requires an empty staging school inventory");
    if (counts.users === "1") {
      const existing = (await client.query<{ password: string }>(
        "SELECT password FROM users WHERE email = $1 AND is_super_admin = true AND display_name = $2",
        [EMAIL, MARKER],
      )).rows[0];
      if (!existing || !(await bcrypt.compare(password, existing.password))) {
        throw new Error("Existing bootstrap identity does not match; no credentials were changed");
      }
    } else {
      if (counts.users !== "0") throw new Error("Bootstrap requires an empty or exact bootstrap-only user inventory");
      await client.query(
        "INSERT INTO users (email, password, first_name, last_name, display_name, is_super_admin) VALUES ($1, $2, 'Synthetic', 'Operator', $3, true)",
        [EMAIL, await bcrypt.hash(password, 12), MARKER],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

/** Do not pass a connectionString: pg would reparse sslmode and replace the CA. */
export function stagingOperatorConnection(databaseUrl: string): pg.ClientConfig {
  const database = new URL(databaseUrl);
  return { host: database.hostname, port: 5432, database: "schoolpilot_staging",
    user: decodeURIComponent(database.username), password: decodeURIComponent(database.password),
    ssl: buildPgSslConfig(databaseUrl), connectionTimeoutMillis: 5000, statement_timeout: 15000 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    console.log("Usage: node dist/cli/bootstrapClasspilotStagingOperator.js (no arguments). Requires APP_ENV=staging, exact staging PUBLIC_BASE_URL, restricted DATABASE_URL, CLP_STAGING_DATABASE_HOST, CLP_STAGING_DATABASE_NAME=schoolpilot_staging, RLS_GUC_ENABLED=true, CLP_STAGING_BOOTSTRAP_ACK=FRESH_ISOLATED_STAGING_NO_CUSTOMER_DATA, CLP_SUPER_ADMIN_EMAIL and CLP_SUPER_ADMIN_PASSWORD in process environment. Creates only the synthetic staging operator; normal HTTP fixture APIs create schools and fleet.");
  } else if (process.argv.length !== 2) {
    console.error("[staging-bootstrap] Unexpected arguments"); process.exitCode = 1;
  } else {
    bootstrapStagingOperator().then(
      () => console.log("[staging-bootstrap] Exact synthetic operator ready; no schools or fleet seeded"),
      () => { console.error("[staging-bootstrap] Refused or failed; no credentials or database details emitted"); process.exitCode = 1; },
    );
  }
}
