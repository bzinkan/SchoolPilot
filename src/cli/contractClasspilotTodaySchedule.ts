import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildPgSslConfig } from "../db/ssl.js";
import { runSchoolPilotMigrationLedger } from "../db/migrationLedger.js";
import { classpilotTodayScheduleContractMigration, verifyClasspilotTodayScheduleContract } from "../db/classpilotTodayScheduleContractMigration.js";

type Environment = Readonly<Record<string, string | undefined>>;
export type TodayContractOptions = { execute: boolean; help: boolean; expectedSourceSha?: string };

const refusal = () => Object.assign(new Error("Today schedule contraction requires an exact source, disabled writes and explicit execution."), {
  code: "TODAY_SCHEDULE_CONTRACT_REFUSED",
});

export function parseTodayScheduleContractArgs(args: string[]): TodayContractOptions {
  const options: TodayContractOptions = { execute: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (seen.has(argument)) throw refusal();
    seen.add(argument);
    if (argument === "--execute") options.execute = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--expected-source-sha") {
      const value = args[++index];
      if (!value || !/^[0-9a-f]{40}$/.test(value)) throw refusal();
      options.expectedSourceSha = value;
    } else throw refusal();
  }
  return options;
}

export function assertTodayScheduleContractExecution(options: TodayContractOptions, env: Environment): string {
  if (!options.execute || !options.expectedSourceSha || options.expectedSourceSha !== env.GIT_SHA
    || !/^[0-9a-f]{40}$/.test(options.expectedSourceSha)
    || env.CLASSPILOT_TODAY_SCHEDULE_MODE !== undefined && env.CLASSPILOT_TODAY_SCHEDULE_MODE !== "off"
    || !env.DATABASE_URL) throw refusal();
  return options.expectedSourceSha;
}

function connectionConfig(connectionString: string, max: number): pg.PoolConfig {
  const ssl = buildPgSslConfig(connectionString);
  const host = new URL(connectionString).hostname;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!local && (!ssl || typeof ssl === "object" && ssl.rejectUnauthorized === false)) throw refusal();
  return { connectionString, ssl, max, connectionTimeoutMillis: 5000, statement_timeout: 15000 };
}

export async function runTodayScheduleContractCli(args: string[], env: Environment = process.env): Promise<number> {
  let pool: pg.Pool | undefined;
  try {
    const options = parseTodayScheduleContractArgs(args);
    if (options.help) {
      console.log("Usage: node dist/cli/contractClasspilotTodaySchedule.js --execute --expected-source-sha <40 lowercase hex>\nRun only after the reviewed API and worker images have converged with Today writes off. This records the separate immutable contraction migration; it never enables the feature.");
      return 0;
    }
    const sourceSha = assertTodayScheduleContractExecution(options, env);
    const runtimeUrl = env.DATABASE_URL!;
    const connectionString = env.DATABASE_URL_PRIVILEGED || runtimeUrl;
    const target = (value: string) => { const url = new URL(value); return [url.hostname, url.port || "5432", url.pathname].join("|"); };
    if (target(connectionString) !== target(runtimeUrl)) throw refusal();
    pool = new pg.Pool(connectionConfig(connectionString, 2));
    const results = await runSchoolPilotMigrationLedger({ pool, migrations: [classpilotTodayScheduleContractMigration], applicationSha: sourceSha });
    await verifyClasspilotTodayScheduleContract(pool);
    if (connectionString !== runtimeUrl) {
      await pool.end();
      pool = undefined;
      // Prove the actual application role can read the readiness marker and
      // catalog. Never auto-grant a role supplied by an operator.
      pool = new pg.Pool(connectionConfig(runtimeUrl, 1));
      await verifyClasspilotTodayScheduleContract(pool);
    }
    console.log(JSON.stringify({ status: results[0]?.status, migration: classpilotTodayScheduleContractMigration.id,
      sourceSha, writesEnabled: false }));
    return 0;
  } catch {
    // No SQL, connection strings, school identifiers or environment values.
    console.error(JSON.stringify({ status: "failed", code: "TODAY_SCHEDULE_CONTRACT_REFUSED" }));
    return 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runTodayScheduleContractCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
