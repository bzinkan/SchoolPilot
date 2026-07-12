import { intEnv, schedulerEnabled } from "./runtime.js";

export type DatabaseProcessRole = "api" | "worker";

const DEFAULT_POOL_IDLE_TIMEOUT_MS = 10_000;
const API_MAIN_POOL_IDLE_TIMEOUT_MS = 75_000;

export const DATABASE_POOL_CAPS = Object.freeze({
  api: Object.freeze({ main: 18, session: 2, scheduler: 1, schedulerLock: 1 }),
  worker: Object.freeze({ main: 2, session: 1, scheduler: 5, schedulerLock: 8 }),
});

export function databaseProcessRole(
  env: NodeJS.ProcessEnv = process.env
): DatabaseProcessRole {
  return schedulerEnabled(env) ? "worker" : "api";
}

export function databasePoolLimits(env: NodeJS.ProcessEnv = process.env) {
  const role = databaseProcessRole(env);
  const caps = DATABASE_POOL_CAPS[role];
  return {
    role,
    main: Math.min(intEnv("DB_POOL_MAX", caps.main, env), caps.main),
    session: Math.min(
      intEnv("SESSION_DB_POOL_MAX", caps.session, env),
      caps.session
    ),
    scheduler: Math.min(
      intEnv("SCHEDULER_DB_POOL_MAX", caps.scheduler, env),
      caps.scheduler
    ),
    schedulerLock: Math.min(
      intEnv("SCHEDULER_LOCK_POOL_MAX", caps.schedulerLock, env),
      caps.schedulerLock
    ),
  };
}

export function databasePoolMinimums(env: NodeJS.ProcessEnv = process.env) {
  const limits = databasePoolLimits(env);
  return {
    // node-postgres uses `min` only as an idle-retention floor; the API startup
    // path separately opens and verifies every retained main-pool connection.
    // Workers keep their existing lazy-connection behavior.
    main: limits.role === "api" ? limits.main : 0,
  };
}

export interface PrewarmPoolClient {
  query(queryText: string): Promise<unknown>;
  release(error?: Error | boolean): void;
}

export interface PrewarmPool {
  connect(): Promise<PrewarmPoolClient>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function prewarmDatabasePool(
  targetPool: PrewarmPool,
  connectionCount: number
): Promise<void> {
  if (!Number.isInteger(connectionCount) || connectionCount < 0) {
    throw new RangeError("Database prewarm connection count must be a non-negative integer");
  }

  const acquired: Array<{
    client: PrewarmPoolClient;
    queryError?: Error;
  }> = [];

  // Start every checkout together and retain each client until every attempt
  // settles. This makes startup prove that the full arrival-capacity cohort can
  // be open at once instead of serially verifying one reusable connection.
  const attempts = Array.from({ length: connectionCount }, async () => {
    const client = await targetPool.connect();
    const state: { client: PrewarmPoolClient; queryError?: Error } = { client };
    acquired.push(state);
    try {
      await client.query("SELECT 1");
    } catch (error) {
      state.queryError = asError(error);
      throw state.queryError;
    }
  });

  const results = await Promise.allSettled(attempts);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [asError(result.reason)] : []
  );

  // Wait for all checkouts before releasing so a late successful checkout can
  // never escape cleanup after an earlier attempt fails. A client whose probe
  // failed is released with that error so node-postgres discards it.
  for (const state of acquired) {
    try {
      state.client.release(state.queryError);
    } catch (error) {
      failures.push(asError(error));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to prewarm ${connectionCount} database connections`
    );
  }
}

export function databasePoolIdleTimeouts(
  env: NodeJS.ProcessEnv = process.env
) {
  return {
    // ClassPilot tile cohorts repeat every 30 seconds. Retaining the API's RLS
    // connections across that interval avoids a burst of verify-full TLS
    // handshakes to RDS without increasing the existing connection ceiling.
    main:
      databaseProcessRole(env) === "api"
        ? API_MAIN_POOL_IDLE_TIMEOUT_MS
        : DEFAULT_POOL_IDLE_TIMEOUT_MS,
    session: DEFAULT_POOL_IDLE_TIMEOUT_MS,
  };
}

export function maximumLaunchDatabaseConnections(
  apiTasks = 6,
  workerTasks = 1
): number {
  const api = DATABASE_POOL_CAPS.api;
  const worker = DATABASE_POOL_CAPS.worker;
  return apiTasks * databaseConnectionsPerProcess(api) +
    workerTasks * databaseConnectionsPerProcess(worker);
}

function databaseConnectionsPerProcess(limits: {
  main: number;
  session: number;
  scheduler: number;
  schedulerLock: number;
}): number {
  return limits.main + limits.session + limits.scheduler + limits.schedulerLock;
}

export function maximumRollingDeploymentDatabaseConnections(
  apiDesiredTasks: number,
  workerDesiredTasks = 1,
  maximumPercent = 200
): number {
  for (const [name, value] of Object.entries({
    apiDesiredTasks,
    workerDesiredTasks,
    maximumPercent,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  const rollingTasks = (desired: number) =>
    Math.ceil((desired * maximumPercent) / 100);
  return rollingTasks(apiDesiredTasks) *
    databaseConnectionsPerProcess(DATABASE_POOL_CAPS.api) +
    rollingTasks(workerDesiredTasks) *
    databaseConnectionsPerProcess(DATABASE_POOL_CAPS.worker);
}
