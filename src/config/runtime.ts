export function envFlag(
  name: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function intEnv(
  name: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("SCHEDULER_ENABLED", true, env);
}

export function migrationsOnStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("RUN_MIGRATIONS_ON_STARTUP", false, env);
}

export function migrationsOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("RUN_MIGRATIONS_ONLY", false, env);
}

export function legacyMigrationsOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("RUN_LEGACY_MIGRATIONS_ONLY", false, env);
}

// Legacy Live View WebSocket signaling (request-stream, offer, answer, ice).
// Live View is retired, so this defaults off and has no production setter:
// enable it only in a local or test environment, never in production.
export function classpilotLiveViewSignalingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED", false, env);
}
