import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { importProcessingStages as stages, type ImportProcessingKind, type ImportProcessingStage } from "../schema/importProcessingStages.js";
import { schedulerDb } from "./schedulerDb.js";
import type { MyDeskDatabase } from "./mydesk.js";
import { recordRuntimePerformanceCounter, recordRuntimePerformanceTiming, type RuntimePerformanceTiming } from "./runtimePerformanceMetrics.js";

export const IMPORT_PROVIDER_CONCURRENCY = 2;
export const IMPORT_STAGE_ATTEMPTS = 3;
export const IMPORT_PROVIDER_TIMEOUT_MS = 90_000;
export const IMPORT_STAGE_FENCE_MS = 120_000;
// Source rendering itself is bounded to 120 seconds; leave room for authenticated storage I/O.
export const IMPORT_NATIVE_STAGE_MS = 180_000;
type Actor = { schoolId: string; authorId: string };
export type ImportStageOptions = {
  runId: string; kind: ImportProcessingKind; stageKey: string; generation: number;
  provider: boolean; parentLeaseId: string; signal?: AbortSignal;
  database?: typeof schedulerDb; assertAuthority?: () => Promise<void>;
  initialAttempts?: number;
};
export type ImportStageResult<T> =
  | { status: "completed"; value: T }
  | { status: "skipped" }
  | { status: "retry" | "failed"; nextAttemptAt?: Date; errorCode: string };
type Claim = { status: "claimed"; row: ImportProcessingStage; token: string } | { status: "wait" } | Exclude<ImportStageResult<never>, { status: "completed" }>;
const cancelled = () => Object.assign(new Error("Import stage is no longer active"), { code: "MYDESK_IMPORT_JOB_CANCELLED" });
const own = (actor: Actor, options: Pick<ImportStageOptions, "runId" | "kind">) => and(eq(stages.schoolId, actor.schoolId), eq(stages.authorId, actor.authorId), eq(stages.kind, options.kind), eq(stages.importId, options.runId))!;
const parentTable = (kind: ImportProcessingKind) => sql.raw(kind === "paperwork" ? "mydesk_imports" : "student_information_imports");
const safeCode = (error: unknown) => {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : "PROCESSING_FAILED";
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "PROCESSING_FAILED";
};

/** Claims that reserve a legacy parent's unleased provider call use this same lock.
 * Acquire it before any parent row locks, including when holding the short job-claim lock.
 */
export async function lockImportProviderAdmission(tx: MyDeskDatabase) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('import-processing-provider-slots'))`);
}

/** Caller holds the admission lock. A claimed v1 parent reserves one provider slot. */
export async function availableLegacyImportProviderSlots(tx: MyDeskDatabase, now: Date): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM (
    SELECT 1 FROM import_processing_stages WHERE provider AND lease_until>${now}
    UNION ALL SELECT 1 FROM mydesk_imports WHERE processing_version=1 AND status='processing' AND lease_until>${now}
    UNION ALL SELECT 1 FROM student_information_imports WHERE processing_version=1 AND status='processing' AND lease_until>${now}
  ) occupied`);
  return Math.max(0, IMPORT_PROVIDER_CONCURRENCY - (result.rows[0]?.count ?? 0));
}

async function assertParent(tx: MyDeskDatabase, actor: Actor, options: ImportStageOptions) {
  const result = await tx.execute(sql`SELECT id FROM ${parentTable(options.kind)}
    WHERE id=${options.runId} AND school_id=${actor.schoolId} AND author_id=${actor.authorId}
    AND status='processing' AND lease_id=${options.parentLeaseId}::uuid AND lease_until>clock_timestamp()
    AND expires_at>clock_timestamp() ${options.kind === "paperwork" ? sql`AND deleted_at IS NULL` : sql``} FOR UPDATE`);
  if (result.rows.length !== 1) throw cancelled();
}

async function bumpProgress(tx: MyDeskDatabase, actor: Actor, options: Pick<ImportStageOptions,"runId"|"kind">) {
  await tx.execute(sql`UPDATE ${parentTable(options.kind)} SET progress_revision=progress_revision+1
    WHERE id=${options.runId} AND school_id=${actor.schoolId} AND author_id=${actor.authorId}`);
}

/** Cancellation fences writes immediately, but never frees an in-flight provider permit early. */
export async function cancelImportProcessingStages(tx: MyDeskDatabase, actor: Actor, runId: string, kind: ImportProcessingKind = "paperwork") {
  await tx.update(stages).set({ status: "cancelled", nextAttemptAt: null, updatedAt: new Date() })
    .where(and(own(actor, { runId, kind }), ne(stages.status, "completed")));
}

export async function invalidateImportItemStages(tx: MyDeskDatabase, actor: Actor, runId: string, itemId: string) {
  await tx.update(stages).set({ status: "cancelled", nextAttemptAt: null, updatedAt: new Date() })
    .where(and(own(actor, { runId, kind: "paperwork" }), inArray(stages.stageKey, [`extract:${itemId}`, `build:${itemId}`])));
}

/** Caller must prove the durable source/page/item checkpoint under this parent lock first.
 * Such checkpoints are written only after transport/native work settles. This reconciles
 * a crash between that atomic domain write and the separate stage-completion transaction.
 */
export async function reconcileImportStageCheckpoint(tx: MyDeskDatabase, actor: Actor,
  options: Pick<ImportStageOptions,"runId"|"kind"|"parentLeaseId"|"stageKey"> & { maxGeneration: number },
) {
  await assertParent(tx, actor, {...options,generation:options.maxGeneration,provider:false});
  await tx.update(stages).set({status:"completed",leaseId:null,leaseUntil:null,parentLeaseId:null,
    requestDeadline:null,nextAttemptAt:null,lastErrorCode:null,updatedAt:new Date()})
    .where(and(own(actor,options),eq(stages.stageKey,options.stageKey),sql`${stages.generation}<=${options.maxGeneration}`,
      ne(stages.status,"cancelled"),ne(stages.status,"completed")));
}

async function claimStage(actor: Actor, options: ImportStageOptions): Promise<Claim> {
  const database = options.database ?? schedulerDb;
  return database.transaction(async tx => {
    // This short system transaction is the only global admission point. No native/provider I/O runs inside it.
    await lockImportProviderAdmission(tx);
    await assertParent(tx, actor, options);
    await tx.update(stages).set({ status: "cancelled", nextAttemptAt: null, updatedAt: new Date() })
      .where(and(own(actor, options), eq(stages.stageKey, options.stageKey), sql`${stages.generation}<${options.generation}`, ne(stages.status,"cancelled")));
    await tx.insert(stages).values({
      schoolId: actor.schoolId, authorId: actor.authorId, kind: options.kind, importId: options.runId,
      paperworkImportId: options.kind === "paperwork" ? options.runId : null,
      informationImportId: options.kind === "student-information" ? options.runId : null,
      stageKey: options.stageKey, generation: options.generation, provider: options.provider,
      attempts: Math.max(0, Math.min(3, options.initialAttempts ?? 0)),
    }).onConflictDoNothing();
    const [row] = await tx.select().from(stages).where(and(own(actor, options), eq(stages.stageKey, options.stageKey), eq(stages.generation, options.generation))).for("update");
    if (!row || row.provider !== options.provider || row.status === "cancelled") throw cancelled();
    if (row.status === "completed") return { status: "skipped" };
    const nowResult = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const now = new Date(nowResult.rows[0]!.now);
    if (row.leaseUntil && row.leaseUntil > now) return { status: "wait" };
    if (row.attempts >= IMPORT_STAGE_ATTEMPTS || row.status === "failed") {
      await tx.update(stages).set({ status: "failed", lastErrorCode: row.lastErrorCode ?? "ATTEMPTS_EXHAUSTED", updatedAt: now }).where(eq(stages.id,row.id));
      return { status: "failed", errorCode: row.lastErrorCode ?? "ATTEMPTS_EXHAUSTED" };
    }
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { status: "retry", nextAttemptAt: row.nextAttemptAt, errorCode: row.lastErrorCode ?? "PROCESSING_RETRY" };
    await tx.update(stages).set({ parentLeaseId: options.parentLeaseId }).where(eq(stages.id,row.id));
    if (options.provider) {
      const active = await tx.select({ id: stages.id }).from(stages).where(and(eq(stages.provider,true),sql`${stages.leaseUntil}>${now}`));
      // Old worker revisions have no stage leases and issue at most one provider call per run.
      // Reserve that slot until their parent lease drains during a compatible rolling release.
      const legacy = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM (
        SELECT id FROM mydesk_imports WHERE processing_version=1 AND status='processing' AND lease_until>${now}
        UNION ALL SELECT id FROM student_information_imports WHERE processing_version=1 AND status='processing' AND lease_until>${now}
      ) old_workers`);
      if (active.length + (legacy.rows[0]?.count ?? 0) >= IMPORT_PROVIDER_CONCURRENCY) return { status: "wait" };
      // Waiting parents with no occupied slot go first. Within a parent, ready extraction beats detection.
      const waiting = await tx.execute<{ id: string }>(sql`
        SELECT s.id FROM import_processing_stages s
        LEFT JOIN mydesk_imports p ON p.id=s.paperwork_import_id AND p.school_id=s.school_id AND p.author_id=s.author_id
        LEFT JOIN student_information_imports c ON c.id=s.information_import_id AND c.school_id=s.school_id AND c.author_id=s.author_id
        WHERE s.provider AND s.status IN ('queued','retry','running') AND s.attempts<3
          AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=${now}) AND (s.lease_until IS NULL OR s.lease_until<=${now})
          AND ((p.status='processing' AND p.lease_id=s.parent_lease_id AND p.lease_until>${now} AND p.expires_at>${now} AND p.deleted_at IS NULL)
            OR (c.status='processing' AND c.lease_id=s.parent_lease_id AND c.lease_until>${now} AND c.expires_at>${now}))
        ORDER BY (SELECT count(*) FROM import_processing_stages busy WHERE busy.provider AND busy.lease_until>${now}
          AND busy.kind=s.kind AND busy.import_id=s.import_id AND busy.school_id=s.school_id AND busy.author_id=s.author_id),
          CASE WHEN s.stage_key LIKE 'extract:%' THEN 0 ELSE 1 END, s.created_at, s.id LIMIT 1`);
      if (waiting.rows[0]?.id !== row.id) return { status: "wait" };
    }
    const token = randomUUID();
    const [claimed] = await tx.update(stages).set({ status: "running", attempts: row.attempts+1,
      leaseId: token, parentLeaseId: options.parentLeaseId,
      requestDeadline: new Date(now.getTime() + (options.provider ? IMPORT_PROVIDER_TIMEOUT_MS : IMPORT_NATIVE_STAGE_MS)),
      leaseUntil: new Date(now.getTime() + (options.provider ? IMPORT_STAGE_FENCE_MS : IMPORT_NATIVE_STAGE_MS)), nextAttemptAt: null, lastErrorCode: null, updatedAt: now,
    }).where(eq(stages.id,row.id)).returning();
    await bumpProgress(tx, actor, options);
    return { status: "claimed", row: claimed!, token };
  });
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); },ms);
    signal?.addEventListener("abort",abort,{ once:true });
  });
}

export async function withDurableImportStage<T>(actor: Actor, options: ImportStageOptions,
  work: (signal: AbortSignal, assertCurrent: (tx: MyDeskDatabase) => Promise<void>) => Promise<T>,
): Promise<ImportStageResult<T>> {
  const admissionStarted = performance.now();
  let claim: Claim;
  for (;;) {
    if (options.signal?.aborted) throw cancelled();
    await options.assertAuthority?.();
    claim = await claimStage(actor, options);
    if (claim.status !== "wait") break;
    await pause(250, options.signal);
  }
  if (claim.status !== "claimed") return claim;
  recordRuntimePerformanceTiming("importStageAdmissionMs", performance.now() - admissionStarted);
  const operationStarted = performance.now();
  const stageTiming: Record<string, RuntimePerformanceTiming> = {
    render: "importRenderMs", detect: "importDetectionMs", extract: "importExtractionMs", build: "importEvidenceMs",
  };
  const { row, token } = claim;
  const database = options.database ?? schedulerDb;
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  options.signal?.addEventListener("abort",abort,{ once:true });
  if (options.signal?.aborted) abort();
  const fence = async (tx: MyDeskDatabase) => {
    if (controller.signal.aborted) throw controller.signal.reason ?? cancelled();
    await assertParent(tx,actor,options);
    const rows = await tx.execute(sql`SELECT id FROM import_processing_stages WHERE id=${row.id}::uuid
      AND school_id=${actor.schoolId} AND author_id=${actor.authorId} AND status='running'
      AND lease_id=${token}::uuid AND parent_lease_id=${options.parentLeaseId}::uuid AND generation=${options.generation}
      AND lease_until>clock_timestamp() AND request_deadline>clock_timestamp() FOR UPDATE`);
    if (rows.rows.length !== 1) throw cancelled();
  };
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let authorityTimer: ReturnType<typeof setTimeout> | undefined;
  const authorityPulse = async () => {
    try { await options.assertAuthority?.(); await database.transaction(tx => fence(tx)); }
    catch (error) { controller.abort(error); return; }
    if (!controller.signal.aborted) authorityTimer = setTimeout(() => { void authorityPulse(); },5_000);
  };
  authorityTimer = setTimeout(() => { void authorityPulse(); },5_000);
  const aborted = new Promise<never>((_resolve,reject) => {
    if (controller.signal.aborted) { reject(controller.signal.reason ?? cancelled()); return; }
    controller.signal.addEventListener("abort",() => reject(controller.signal.reason ?? cancelled()),{ once:true });
    timeout = setTimeout(() => controller.abort(Object.assign(new Error("Import stage timed out"), { code:"STAGE_TIMEOUT" })), Math.max(1,row.requestDeadline!.getTime()-Date.now()));
  });
  const operation = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal,fence); }).finally(() => { settled=true; });
  // A provider ignoring abort may resolve later. It cannot publish through the expired fence; retain its permit until grace expires.
  void operation.catch(() => undefined);
  try {
    const value = await Promise.race([operation,aborted]);
    await options.assertAuthority?.();
    await database.transaction(async tx => {
      await fence(tx);
      await tx.update(stages).set({ status:"completed", leaseId:null, leaseUntil:null, requestDeadline:null, parentLeaseId:null, lastErrorCode:null, updatedAt:new Date() }).where(eq(stages.id,row.id));
      await bumpProgress(tx,actor,options);
    });
    recordRuntimePerformanceCounter("importStageCompleted");
    return { status:"completed", value };
  } catch (error) {
    const code = safeCode(error);
    // Shutdown aborts are resumable. Explicit cancellation/expiry and access loss are not.
    const accessLost = /NOT_ENABLED|FORBIDDEN|NOT_AUTHORIZED|ACCESS|MEMBERSHIP|ENTITLEMENT|SCHOOL_UNAVAILABLE/.test(code);
    const nonRetryable = error && typeof error === "object" && (("retryable" in error && error.retryable === false) || ("status" in error && error.status === 422));
    const result = await database.transaction(async tx => {
      // Match claim/result transaction lock order: parent before stage, including cancellation settlement.
      const parent = await tx.execute<{ status: string; expired: boolean }>(sql`SELECT status,expires_at<=clock_timestamp() AS expired FROM ${parentTable(options.kind)} WHERE id=${options.runId} AND school_id=${actor.schoolId} AND author_id=${actor.authorId} FOR UPDATE`);
      const [current] = await tx.select().from(stages).where(eq(stages.id,row.id)).for("update");
      if (!current || current.leaseId !== token) return null;
      const closed = !parent.rows[0] || parent.rows[0].expired || ["cancelled","expired","completed"].includes(parent.rows[0].status);
      const state = current.status === "cancelled" || accessLost || closed ? "cancelled" : current.attempts>=3 || nonRetryable ? "failed" : "retry";
      const nextAttemptAt = state === "retry" ? new Date(Date.now()+current.attempts*60_000) : null;
      await tx.update(stages).set({ status:state, nextAttemptAt, lastErrorCode:code, updatedAt:new Date(),
        ...(settled ? {leaseId:null,leaseUntil:null,requestDeadline:null,parentLeaseId:null} : {}),
      }).where(eq(stages.id,row.id));
      await bumpProgress(tx,actor,options);
      return {state,nextAttemptAt};
    });
    if (!result || result.state === "cancelled" || (code === "MYDESK_IMPORT_JOB_CANCELLED" && !options.signal?.aborted)) throw error;
    recordRuntimePerformanceCounter(result.state === "failed" ? "importStageFailed" : "importStageRetry");
    return { status: result.state === "failed" ? "failed" : "retry", errorCode:code, ...(result.nextAttemptAt ? {nextAttemptAt:result.nextAttemptAt}: {}) };
  } finally {
    const timing = stageTiming[options.stageKey.split(":")[0]!];
    if (timing) recordRuntimePerformanceTiming(timing, performance.now() - operationStarted);
    clearTimeout(timeout); clearTimeout(authorityTimer);
    controller.abort();
    options.signal?.removeEventListener("abort",abort);
  }
}
