import { intEnv, schedulerEnabled } from "./runtime.js";

export type DatabaseProcessRole = "api" | "worker";

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

export function maximumLaunchDatabaseConnections(
  apiTasks = 6,
  workerTasks = 1
): number {
  const api = DATABASE_POOL_CAPS.api;
  const worker = DATABASE_POOL_CAPS.worker;
  const sum = (limits: {
    main: number;
    session: number;
    scheduler: number;
    schedulerLock: number;
  }) =>
    limits.main + limits.session + limits.scheduler + limits.schedulerLock;
  return apiTasks * sum(api) + workerTasks * sum(worker);
}
