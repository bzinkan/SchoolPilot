import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildPgSslConfig } from "../db/ssl.js";
import { inspectMyDeskReadiness } from "../db/mydeskReadiness.js";

export async function runMyDeskReadinessCli(args: string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("Usage: node dist/cli/inspectMyDeskReadiness.js\n" +
      "Read-only My Desk migration, catalog, RLS and aggregate-count inventory.\n" +
      "Uses DATABASE_URL and existing RDS TLS configuration. Never applies migrations.\n" +
      "A successful inventory is not runtime/storage readiness or deployment approval.\n");
    return 0;
  }
  if (args.length > 0 || !process.env.DATABASE_URL) {
    process.stderr.write('{"status":"failed","code":"MYDESK_PREFLIGHT_CONFIGURATION"}\n');
    return 2;
  }
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: buildPgSslConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "mydesk-read-only-preflight",
  });
  try {
    await connection.connect();
    process.stdout.write(`${JSON.stringify(await inspectMyDeskReadiness(connection))}\n`);
    return 0;
  } catch {
    // SQL and connection errors can contain credentials, keys or row values.
    process.stderr.write('{"status":"failed","code":"MYDESK_PREFLIGHT_FAILED"}\n');
    return 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runMyDeskReadinessCli(process.argv.slice(2));
}
