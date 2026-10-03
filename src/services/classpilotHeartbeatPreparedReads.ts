import { sql } from "drizzle-orm";
import type db from "../db.js";
import { rlsGucEnabled, type TenantStore } from "../db/tenantContext.js";
import { getOwnedTenantStore } from "../middleware/tenantContext.js";
import {
  heartbeatSchoolQuery, heartbeatLicenseQuery, heartbeatSessionQuery,
  heartbeatControlQuery, heartbeatCandidateQuery,
} from "./classpilotHeartbeatReadQueries.js";
import {
  heartbeatScreenshotEvidenceQuery, decodeHeartbeatScreenshotEvidence, type HeartbeatScreenshotEvidence,
} from "./classpilotHeartbeatScreenshotEvidence.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SelectDatabase = Pick<typeof db, "select">;
type Binding = { schoolId: string; studentId: string; studentSessionId: string; deviceId: string };
type PreparedCache = {
  database: TenantStore["db"];
  school?: ReturnType<ReturnType<typeof heartbeatSchoolQuery>["prepare"]>;
  license?: ReturnType<ReturnType<typeof heartbeatLicenseQuery>["prepare"]>;
  session?: ReturnType<ReturnType<typeof heartbeatSessionQuery>["prepare"]>;
  control?: ReturnType<ReturnType<typeof heartbeatControlQuery>["prepare"]>;
  candidate?: ReturnType<ReturnType<typeof heartbeatCandidateQuery>["prepare"]>;
  screenshot?: ReturnType<ReturnType<typeof heartbeatScreenshotEvidenceQuery>["prepare"]>;
};
type Token = {
  store: TenantStore; client: TenantStore["client"]; database: TenantStore["db"]; schoolId: string;
  state: "preparing" | "sealed" | "closed";
  pending: Set<Promise<unknown>>; failed: boolean; failure?: unknown;
};
// Weak keys retain only bounded immutable query/mapping definitions per physical
// client/database. Empty names deliberately leave PostgreSQL plans unnamed.
const caches = new WeakMap<TenantStore["client"], PreparedCache>();
// Closed tokens remain recognizable while a retained transaction is reachable.
// They must never fall through to an unguarded reference query.
const tokens = new WeakMap<object, Token>();
const roots = new WeakSet<TenantStore["client"]>();

function fail(token: Token, message: string): never {
  const error = new Error(message);
  if (!token.failed) { token.failed = true; token.failure = error; }
  throw error;
}
function assertOwned(token: Token): void {
  if (getOwnedTenantStore() !== token.store || token.store.client !== token.client
    || token.store.db !== token.database || token.store.schoolId !== token.schoolId
    || token.store.isSuper || token.client.getTransactionStatus() !== "T") {
    fail(token, "Heartbeat prepared-read transaction is no longer owned");
  }
  if (token.failed) throw token.failure;
}
function track<T>(token: Token, work: () => Promise<T>): Promise<T> {
  let promise: Promise<T>;
  try { promise = Promise.resolve(work()); }
  catch (error) { promise = Promise.reject(error); }
  token.pending.add(promise);
  void promise.then(() => token.pending.delete(promise), error => {
    if (!token.failed) { token.failed = true; token.failure = error; }
    token.pending.delete(promise);
  });
  return promise;
}
async function drain(token: Token): Promise<void> {
  while (token.pending.size) await Promise.allSettled([...token.pending]);
}
function read<T>(database: SelectDatabase, schoolId: string, work: (cache?: PreparedCache) => Promise<T>): Promise<T> {
  const token = tokens.get(database);
  if (!token) return work();
  assertOwned(token);
  if (token.state !== "preparing") fail(token, "Heartbeat prepared-read phase is closed");
  if (schoolId !== token.schoolId) fail(token, "Heartbeat prepared-read tenant mismatch");
  let cache = caches.get(token.client);
  if (!cache || cache.database !== token.database) {
    cache = { database: token.database }; caches.set(token.client, cache);
  }
  return track(token, () => work(cache));
}

/** Only the private heartbeat root calls this. Generic/WS/super/RLS-off paths
 * keep the reference transaction. Public pg status fences acknowledged nesting;
 * the private caller must retain exclusive use of its owned client. */
export async function withHeartbeatPreparedReadTransaction<T>(
  reference: typeof db, schoolId: string, work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const store = getOwnedTenantStore();
  if (!rlsGucEnabled() || !store || store.isSuper) return reference.transaction(work);
  const client = store.client, database = store.db;
  if (store.schoolId !== schoolId || client.getTransactionStatus() !== "I" || roots.has(client)) {
    throw new Error("Heartbeat prepared reads require an exclusive owned root transaction");
  }
  roots.add(client);
  try {
    return await database.transaction(async tx => {
      const token: Token = { store, client, database, schoolId, state: "preparing", pending: new Set(), failed: false };
      tokens.set(tx, token);
      let primaryFailed = false;
      try { assertOwned(token); return await work(tx); }
      catch (error) { primaryFailed = true; throw error; }
      finally {
        token.state = "closed";
        await drain(token);
        if (!primaryFailed && token.failed) throw token.failure;
      }
    });
  } finally { roots.delete(client); }
}

/** Track the complete multi-query projection, including its continuations. */
export function trackHeartbeatPreparedReadTask<T>(database: SelectDatabase, work: () => Promise<T>): Promise<T> {
  const token = tokens.get(database);
  if (!token) return work();
  assertOwned(token);
  if (token.state !== "preparing") fail(token, "Heartbeat prepared-read task started after sealing");
  return track(token, work);
}
export async function sealHeartbeatPreparedReads(database: SelectDatabase): Promise<void> {
  const token = tokens.get(database);
  if (!token) return;
  assertOwned(token);
  if (token.state !== "preparing") fail(token, "Heartbeat prepared-read phase already sealed");
  token.state = "sealed";
  await drain(token);
  assertHeartbeatPreparedReadsSettled(database);
}
/** Synchronous: never add an await after the final database-clock fence. */
export function assertHeartbeatPreparedReadsSettled(database: SelectDatabase): void {
  const token = tokens.get(database);
  if (!token) return;
  assertOwned(token);
  if (token.state !== "sealed" || token.pending.size !== 0) fail(token, "Heartbeat prepared reads have not settled");
}

export function readHeartbeatSchool(database: SelectDatabase, schoolId: string) {
  return read(database, schoolId, cache => {
    if (!cache) return heartbeatSchoolQuery(database, { schoolId }).execute();
    cache.school ??= heartbeatSchoolQuery(cache.database, { schoolId: sql.placeholder("schoolId") }).prepare("");
    return cache.school.execute({ schoolId });
  });
}
export function readHeartbeatLicense(database: SelectDatabase, schoolId: string) {
  return read(database, schoolId, cache => {
    if (!cache) return heartbeatLicenseQuery(database, { schoolId }).execute();
    cache.license ??= heartbeatLicenseQuery(cache.database, { schoolId: sql.placeholder("schoolId") }).prepare("");
    return cache.license.execute({ schoolId });
  });
}
export function readHeartbeatSession(database: SelectDatabase, options: Binding) {
  const values = { schoolId: options.schoolId, studentId: options.studentId, studentSessionId: options.studentSessionId, deviceId: options.deviceId };
  return read(database, values.schoolId, cache => {
    if (!cache) return heartbeatSessionQuery(database, values).execute();
    cache.session ??= heartbeatSessionQuery(cache.database, {
      schoolId: sql.placeholder("schoolId"), studentId: sql.placeholder("studentId"),
      studentSessionId: sql.placeholder("studentSessionId"), deviceId: sql.placeholder("deviceId"),
    }).prepare("");
    return cache.session.execute(values);
  });
}
export function readHeartbeatControl(database: SelectDatabase, options: Pick<Binding, "schoolId" | "studentId">) {
  const values = { schoolId: options.schoolId, studentId: options.studentId };
  return read(database, values.schoolId, cache => {
    if (!cache) return heartbeatControlQuery(database, values).execute();
    cache.control ??= heartbeatControlQuery(cache.database, { schoolId: sql.placeholder("schoolId"), studentId: sql.placeholder("studentId") }).prepare("");
    return cache.control.execute(values);
  });
}
export function readHeartbeatCandidate(database: SelectDatabase, options: Pick<Binding, "schoolId" | "studentId"> & { teachingSessionId: string }) {
  const values = { schoolId: options.schoolId, studentId: options.studentId, teachingSessionId: options.teachingSessionId };
  return read(database, values.schoolId, cache => {
    if (!cache) return heartbeatCandidateQuery(database, values).execute();
    cache.candidate ??= heartbeatCandidateQuery(cache.database, { schoolId: sql.placeholder("schoolId"), studentId: sql.placeholder("studentId"), teachingSessionId: sql.placeholder("teachingSessionId") }).prepare("");
    return cache.candidate.execute(values);
  });
}

/** Undefined means this is an unregistered reference transaction, never an
 * optimization failure. Recognized tombstones must enter the mandatory guard. */
export function readHeartbeatScreenshotEvidenceIfOwned(
  database: SelectDatabase, options: Binding,
): Promise<HeartbeatScreenshotEvidence> | undefined {
  if (!tokens.has(database)) return undefined;
  const values = { schoolId: options.schoolId, studentId: options.studentId,
    studentSessionId: options.studentSessionId, deviceId: options.deviceId };
  return read(database, values.schoolId, async cache => {
    if (!cache) throw new Error("Heartbeat screenshot evidence requires an owned transaction");
    cache.screenshot ??= heartbeatScreenshotEvidenceQuery(cache.database, {
      schoolId: sql.placeholder("schoolId"), studentId: sql.placeholder("studentId"),
      studentSessionId: sql.placeholder("studentSessionId"), deviceId: sql.placeholder("deviceId"),
    }).prepare("");
    const rows = await cache.screenshot.execute(values);
    if (rows.length !== 1) throw new TypeError("Invalid heartbeat screenshot evidence row count");
    return decodeHeartbeatScreenshotEvidence(rows[0]?.evidence);
  });
}
