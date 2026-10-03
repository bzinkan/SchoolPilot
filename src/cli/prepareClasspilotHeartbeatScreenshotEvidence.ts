import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  assertClasspilotHeartbeatScreenshotEvidence,
  grantClasspilotHeartbeatScreenshotEvidence,
  installClasspilotHeartbeatScreenshotEvidence,
} from "../db/classpilotHeartbeatScreenshotEvidenceInstallation.js";

/** Disposable local fixtures only. Production uses the checksum-ledger migration. */
export function assertLocalScreenshotEvidenceFixture(environment: NodeJS.ProcessEnv): { adminUrl: string; appUrl: string } {
  if (environment.NODE_ENV === "production") throw new Error("Local fixture bootstrap forbids production");
  const adminUrl = environment.ADMIN_DATABASE_URL;
  const appUrl = environment.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error("Explicit admin and application fixture URLs are required");
  const admin = new URL(adminUrl), app = new URL(appUrl);
  for (const url of [admin, app]) {
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash ||
        !/^\/(?:sptest|schoolpilot_(?:test|redesign_usage_(?:restore|scale)_[a-f0-9]{12}))$/.test(url.pathname)) {
      throw new Error("Only a named disposable loopback test database is allowed");
    }
  }
  if (admin.hostname !== app.hostname || (admin.port || "5432") !== (app.port || "5432") || admin.pathname !== app.pathname) {
    throw new Error("Fixture admin and runtime must address the exact same local database");
  }
  return { adminUrl, appUrl };
}

export async function prepareLocalScreenshotEvidenceFixture(environment = process.env, install = false): Promise<void> {
  const { adminUrl, appUrl } = assertLocalScreenshotEvidenceFixture(environment);
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new pg.Client({ connectionString: appUrl });
  try {
    await admin.connect(); await app.connect();
    // Read the actual runtime identity; never assume it is the migration owner.
    const role = (await app.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role;
    await admin.query("BEGIN");
    try {
      if (install) await installClasspilotHeartbeatScreenshotEvidence(admin);
      await grantClasspilotHeartbeatScreenshotEvidence(admin, role);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    await assertClasspilotHeartbeatScreenshotEvidence(app);
  } finally {
    const closed = await Promise.allSettled([app.end(), admin.end()]);
    if (closed.some(result => result.status !== "fulfilled")) throw new Error("Fixture client closure failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--install")) {
    throw new Error("Usage: prepareClasspilotHeartbeatScreenshotEvidence [--install]");
  }
  prepareLocalScreenshotEvidenceFixture(process.env, arguments_[0] === "--install").then(
    () => console.log("[fixture] screenshot evidence exact contract and runtime EXECUTE verified"),
    () => { console.error("[fixture] screenshot evidence preparation failed"); process.exitCode = 1; },
  );
}
