import { and, eq, sql } from "drizzle-orm";
import { mydeskImports as runs, mydeskImportItems as items, mydeskImportAssets as assets,
  type MyDeskImport, type MyDeskImportItem } from "../schema/mydeskImports.js";
import { paperworkProcessingWidth } from "../config/paperworkProcessing.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import db from "../db.js";
import { myDeskObjectStore } from "./mydeskFiles.js";
import { renderImportSource, cropImportRegion, buildImportAttachmentFromCrops, createImportAiProcessor,
  detectedRegionToCrop, importExtractionSchema, supportedImportPromptVersion } from "./mydeskImportProcessing.js";
import { importOwn, importAssetOwn, importItemOwn, importUuid, importError, lockImport, invalidatePeerImportReviews } from "./mydeskImports.js";
import { loadMyDeskClassRoster, currentClasses, type MyDeskActor, type MyDeskDatabase } from "./mydesk.js";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ITEMS } from "./mydeskImportsValidation.js";
import { withDurableImportStage, reconcileImportStageCheckpoint, IMPORT_NATIVE_STAGE_MS } from "./importProcessingStages.js";
import { withLease, ownedBytes, putDerived, type WorkerOptions } from "./mydeskImportWorker.js";
import { runImportPipelineQueue, type ImportPipelineTask } from "./importPipelineQueue.js";

type StageResult = { status: "retry" | "failed"; nextAttemptAt?: Date; errorCode: string };

async function prepareNative<T>(parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const native = new AbortController();
  const signal = AbortSignal.any([parent, native.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => native.abort(importError("NATIVE_PREPARATION_TIMEOUT", "Form image preparation timed out. Retry this form", 503)), IMPORT_NATIVE_STAGE_MS);
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([work(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    native.abort();
  }
}

async function matchSubject(database: MyDeskDatabase, actor: MyDeskActor, run: MyDeskImport, extraction: ReturnType<typeof importExtractionSchema.parse>) {
  const empty = { groupId: null as string | null, studentId: null as string | null, rosterRevision: null as string | null };
  if (extraction.subjectNames.length !== 1 || extraction.warnings.some(w => w === "uncertain_subject" || w === "multiple_subjects")) return empty;
  const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  const matches: Array<{ groupId: string; studentId: string; rosterRevision: string }> = [];
  for (const groupId of [...run.selectedGroupIds].sort()) {
    try {
      const roster = await loadMyDeskClassRoster(actor, groupId, database);
      for (const student of roster.students) if (normalize(student.name) === normalize(extraction.subjectNames[0]!))
        matches.push({ groupId, studentId: student.id, rosterRevision: roster.rosterRevision });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "MYDESK_CLASS_NOT_FOUND")) throw error;
    }
  }
  if (new Set(matches.map(value => value.studentId)).size !== 1) return empty;
  empty.studentId = matches[0]!.studentId;
  if (matches.length === 1) return matches[0]!;
  const classes = await currentClasses(actor, database);
  const preferred = matches.filter(candidate => classes.some(group => group.id === candidate.groupId && group.personal &&
    group.gradeLevel != null && run.preferencesSnapshot.preferredClasses[String(group.gradeLevel)] === group.id));
  return preferred.length === 1 ? preferred[0]! : empty;
}

/** Durable page/form checkpoints allow independent I/O while native work stays globally bounded. */
export async function processPipelinedMyDeskImport(claim: MyDeskImport, options: WorkerOptions = {}) {
  const actor: MyDeskActor = { schoolId: claim.schoolId, authorId: claim.authorId, manager: false };
  const leaseId = claim.leaseId!;
  const store = options.store ?? myDeskObjectStore;
  const processor = options.processor ?? { renderImportSource, cropImportRegion,
    ...createImportAiProcessor(undefined, { model: claim.modelVersion ?? undefined, promptVersion: claim.promptVersion ?? undefined }) };
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const failures: StageResult[] = [];
  let renewal: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = withLease(actor, claim.id, leaseId, async () => undefined)
      .catch(() => controller.abort()).finally(() => { renewal = undefined; });
  }, 30_000);
  heartbeat.unref();
  const own = <T>(fn: (database: MyDeskDatabase, run: MyDeskImport, current: MyDeskActor) => Promise<T>) =>
    withLease(actor, claim.id, leaseId, fn);
  const progress = (database: MyDeskDatabase) => database.update(runs).set({
    progressRevision: sql`${runs.progressRevision}+1`, updatedAt: new Date(),
  }).where(importOwn(actor, claim.id));
  let initialAttempts = claim.attempts;
  let initialAttemptStage: string | undefined;
  const stage = async <T>(stageKey: string, generation: number, provider: boolean,
    work: (signal: AbortSignal, assertCurrent: (database: MyDeskDatabase) => Promise<void>) => Promise<T>) => {
    controller.signal.throwIfAborted();
    const inheritedAttempts = initialAttemptStage === stageKey ? initialAttempts : 0;
    if (initialAttemptStage === stageKey) initialAttempts = 0;
    const result = await withDurableImportStage(actor, { runId: claim.id, kind: "paperwork", stageKey, generation,
      provider, parentLeaseId: leaseId, signal: controller.signal, database: options.database,
      initialAttempts: inheritedAttempts, assertAuthority: () => own(async () => undefined) }, work);
    if (result.status === "retry" || result.status === "failed") failures.push(result);
    return result;
  };
  try {
    if (!claim.modelVersion || !supportedImportPromptVersion(claim.promptVersion))
      throw importError("PROCESSOR_VERSION_UNAVAILABLE", "This import uses an unavailable processing version", 422);
    const sources = await own(database => database.select().from(assets).where(and(importAssetOwn(actor, claim.id),
      eq(assets.kind, "source"), eq(assets.status, "ready"))).orderBy(assets.createdAt, assets.id));
    const firstSource = sources.find(source => !source.processedAt);
    if (firstSource) initialAttemptStage = `render:${firstSource.id}`;
    await own(async database => {
      for (const source of sources.filter(source => source.processedAt)) await reconcileImportStageCheckpoint(database, actor,
        { runId: claim.id, kind: "paperwork", parentLeaseId: leaseId, stageKey: `render:${source.id}`, maxGeneration: 1 });
    });
    for (const source of sources) {
      if (source.processedAt) continue;
      await stage(`render:${source.id}`, 1, false, async (signal, fence) => {
        const bytes = await ownedBytes(actor, claim.id, leaseId, source, store);
        const pages = await processor.renderImportSource(bytes, source.contentType!, { signal });
        if (pages.length !== source.pageCount || pages.length > 20)
          throw importError("PAGE_COUNT_CHANGED", "The document page count changed during processing", 422);
        for (const page of pages) {
          signal.throwIfAborted();
          await own(database => fence(database));
          await putDerived(actor, claim.id, leaseId, { id: importUuid(`import-page:${source.id}:${page.pageNumber}`),
            kind: "page", parentAssetId: source.id, pageNumber: page.pageNumber, width: page.width,
            height: page.height, pageCount: 1 }, page.bytes, "image/jpeg", store, fence);
        }
        await own(async database => {
          await fence(database);
          await database.update(assets).set({ processedAt: new Date(), updatedAt: new Date() }).where(importAssetOwn(actor, claim.id, source.id));
          await progress(database);
        });
      });
    }
    const pages = await own(database => database.select().from(assets).where(and(importAssetOwn(actor, claim.id),
      eq(assets.kind, "page"), eq(assets.status, "ready"))).orderBy(assets.createdAt, assets.id));
    const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
    pages.sort((a, b) => (sourceOrder.get(a.parentAssetId!) ?? 0) - (sourceOrder.get(b.parentAssetId!) ?? 0) || (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
    const firstPage = pages.find(page => !page.processedAt);
    if (!initialAttemptStage && firstPage) initialAttemptStage = `detect:${firstPage.id}`;
    // Adopt ordering without changing source identities, teacher fields, or review revisions.
    await own(async database => {
      for (const page of pages.filter(page => page.processedAt)) await reconcileImportStageCheckpoint(database, actor,
        { runId: claim.id, kind: "paperwork", parentLeaseId: leaseId, stageKey: `detect:${page.id}`, maxGeneration: 1 });
      const legacy = await database.select().from(items).where(importItemOwn(actor, claim.id)).orderBy(items.ordinal);
      const pageOffsets = new Map<string, number>();
      for (const item of legacy) {
        if (!item.extractRequested) await reconcileImportStageCheckpoint(database, actor,
          { runId: claim.id, kind: "paperwork", parentLeaseId: leaseId, stageKey: `extract:${item.id}`, maxGeneration: item.revision });
        if (item.extractionStatus === "ready" && item.approvedAssetId) await reconcileImportStageCheckpoint(database, actor,
          { runId: claim.id, kind: "paperwork", parentLeaseId: leaseId, stageKey: `build:${item.id}`, maxGeneration: item.revision });
        const pageId = item.regions[0]?.assetId;
        if (!pageId) continue;
        const offset = pageOffsets.get(pageId) ?? 0;
        pageOffsets.set(pageId, offset + 1);
        if (item.documentOrder === null) await database.update(items).set({ documentOrder: Math.max(0, pages.findIndex(page => page.id === pageId)) * 50 + offset })
          .where(importItemOwn(actor, claim.id, item.id));
      }
    });
    const itemTask = (itemId: string): ImportPipelineTask => async () => {
      let item = await own(async database => (await database.select().from(items).where(importItemOwn(actor, claim.id, itemId)))[0]);
      if (!item || item.excluded || item.extractionStatus === "ready") return;
      const generation = item.revision;
      const crops: Buffer[] = [];
      // Keep only bounded normalized crops, never a whole packet of decoded/raw images.
      const prepareCrops = async (signal: AbortSignal) => {
        if (crops.length) return;
        let bytes = 0;
        for (const region of item!.regions) {
          const page = pages.find(candidate => candidate.id === region.assetId);
          if (!page) throw importError("PAGE_INVALID", "A form page is no longer available");
          const crop = await processor.cropImportRegion({ bytes: await ownedBytes(actor, claim.id, leaseId, page, store),
            region: { x: region.x, y: region.y, width: region.width, height: region.height }, rotation: region.rotation }, { signal });
          bytes += crop.length;
          if (bytes > IMPORT_MAX_BYTES) throw importError("OUTPUT_TOO_LARGE", "The combined form is larger than 10 MiB", 422);
          crops.push(crop);
        }
      };
      const currentItem = async (database: MyDeskDatabase) => {
        const [current] = await database.select().from(items).where(importItemOwn(actor, claim.id, itemId)).for("update");
        if (!current || current.revision !== generation || current.excluded || current.extractionStatus !== "pending")
          throw importError("JOB_CANCELLED", "This form changed during processing");
        return current;
      };
      const prepareBeforeProvider = async () => {
        await prepareNative(controller.signal, async signal => {
          await own(database => currentItem(database));
          // Only ephemeral bounded buffers are produced here. Native work cannot consume
          // a provider permit or its 90-second request deadline, including while queued.
          await prepareCrops(signal);
          await processor.prepareImportImages?.(crops, { signal });
          await own(database => currentItem(database));
        });
      };
      const markFailed = async () => own(async database => {
        await currentItem(database);
        await database.update(items).set({ extractionStatus: "failed", reviewed: false, reviewFingerprint: null,
          revision: generation + 1, updatedAt: new Date() }).where(importItemOwn(actor, claim.id, itemId));
        await progress(database);
      });
      if (item.extractRequested) {
        await prepareBeforeProvider();
        const result = await stage(`extract:${itemId}`, generation, true, async (signal, fence) => {
          await own(async database => { await fence(database); await currentItem(database); });
          const extraction = importExtractionSchema.parse(await processor.extractImportForm(crops, { signal }));
          await own(async (database, run, currentActor) => {
            await fence(database);
            const current = await currentItem(database);
            const match = !current.groupId && !current.studentId ? await matchSubject(database, currentActor, run, extraction) : {};
            await database.update(items).set({ ...extraction, ...match, extractRequested: false, updatedAt: new Date() })
              .where(importItemOwn(actor, claim.id, itemId));
            await progress(database);
          });
        });
        if (result.status === "retry" || result.status === "failed") {
          if (result.status === "failed") await markFailed();
          return;
        }
        item = await own(async database => (await database.select().from(items).where(importItemOwn(actor, claim.id, itemId)))[0]);
        if (!item || item.extractRequested) throw importError("STAGE_CHECKPOINT_MISSING", "A prepared form checkpoint is missing");
      }
      const builtResult = await stage(`build:${itemId}`, generation, false, async (signal, fence) => {
        await prepareCrops(signal);
        const built = await buildImportAttachmentFromCrops(crops, { signal });
        await own(async database => { await fence(database); await currentItem(database); });
        const approved = await putDerived(actor, claim.id, leaseId, {
          id: importUuid(`import-approved:${itemId}:${generation}`), kind: "approved",
          parentAssetId: item!.regions[0]!.assetId, pageCount: item!.regions.length,
        }, built.bytes, built.contentType, store, fence);
        await own(async database => {
          await fence(database);
          await currentItem(database);
          await database.update(items).set({ approvedAssetId: approved.id, extractionStatus: "ready", extractRequested: false,
            reviewed: false, reviewFingerprint: null, revision: generation + 1, updatedAt: new Date() })
            .where(importItemOwn(actor, claim.id, itemId));
          await invalidatePeerImportReviews(database, actor, claim.id, itemId);
          await progress(database);
        });
      });
      if (builtResult.status === "failed") await markFailed();
    };
    const pending = await own(database => database.select({ id: items.id, extractRequested: items.extractRequested }).from(items).where(and(importItemOwn(actor, claim.id),
      eq(items.extractionStatus, "pending"), eq(items.excluded, false))).orderBy(items.ordinal));
    if (!initialAttemptStage && pending[0]) initialAttemptStage = `${pending[0].extractRequested ? "extract" : "build"}:${pending[0].id}`;
    const tasks: ImportPipelineTask[] = pending.map(item => itemTask(item.id));
    for (const page of pages) {
      if (page.processedAt) continue;
      tasks.push(async enqueue => {
        const bytes = await prepareNative(controller.signal, async signal => {
          const image = await ownedBytes(actor, claim.id, leaseId, page, store);
          await processor.prepareImportImages?.([image], { signal });
          return image;
        });
        const result = await stage(`detect:${page.id}`, 1, true, async (signal, fence) => {
          await own(database => fence(database));
          const regions = (await processor.detectImportForms(bytes, { signal })).map(detectedRegionToCrop);
          return own(async database => {
            await fence(database);
            const list = await database.select({ id: items.id, ordinal: items.ordinal }).from(items).where(importItemOwn(actor, claim.id));
            if (list.length + regions.length > IMPORT_MAX_ITEMS)
              throw importError("FORM_LIMIT", "This packet contains more than 50 forms. Split it into smaller packets", 422);
            const ids = regions.map((_region, index) => importUuid(`import-form:${page.id}:${index}`));
            if (regions.length) await database.insert(items).values(regions.map((region, index) => ({
              id: ids[index]!, schoolId: actor.schoolId, authorId: actor.authorId, importId: claim.id,
              clientRequestId: ids[index]!, ordinal: list.length + index, documentOrder: pages.indexOf(page) * 50 + index,
              regions: [{ assetId: page.id, ...region }], extractRequested: true,
            })));
            await database.update(assets).set({ processedAt: new Date(), updatedAt: new Date() }).where(importAssetOwn(actor, claim.id, page.id));
            await progress(database);
            return ids;
          });
        });
        if (result.status === "completed") enqueue(result.value.map(id => itemTask(id)), true);
      });
    }
    await runImportPipelineQueue(tasks, paperworkProcessingWidth(), controller.signal);
    return await own(async database => {
      const failed = failures.find(failure => failure.status === "failed");
      const retry = failures.filter(failure => failure.status === "retry").sort((a, b) =>
        (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0))[0];
      const preparedPages = await database.select({ processedAt: assets.processedAt }).from(assets)
        .where(and(importAssetOwn(actor, claim.id), eq(assets.kind, "page"), eq(assets.status, "ready")));
      const unfinished = await database.select({ id: items.id }).from(items).where(and(importItemOwn(actor, claim.id),
        eq(items.excluded, false), sql`${items.extractionStatus}<>'ready'`)).limit(1);
      const complete = preparedPages.length === claim.pageCount && preparedPages.every(page => page.processedAt) && !unfinished.length;
      const status = failed ? "failed" : retry ? "queued" : complete ? "review" : "failed";
      await database.update(runs).set({ status, leaseId: null, leaseUntil: null, attempts: failed ? 3 : 0,
        nextAttemptAt: retry?.nextAttemptAt ?? null, lastErrorCode: (failed ?? retry)?.errorCode ?? (complete ? null : "STAGE_CHECKPOINT_MISSING"),
        progressRevision: sql`${runs.progressRevision}+1`, updatedAt: new Date() }).where(importOwn(actor, claim.id));
      return { id: claim.id, status };
    });
  } catch (error) {
    const interrupted = controller.signal.aborted || options.signal?.aborted === true;
    controller.abort();
    await runWithTenantContext({ schoolId: actor.schoolId }, () => db.transaction(async database => {
      const run = await lockImport(database, actor, claim.id);
      if (run.status !== "processing" || run.leaseId !== leaseId) return;
      // Shutdown/lease loss resumes checkpoints; nonretryable domain failures need attention.
      const cancelled = interrupted;
      await database.update(runs).set({ status: cancelled ? "queued" : "failed", leaseId: null, leaseUntil: null,
        nextAttemptAt: cancelled ? new Date() : null, lastErrorCode: cancelled ? null : "MYDESK_IMPORT_PROCESSING_FAILED",
        progressRevision: sql`${runs.progressRevision}+1`, updatedAt: new Date() }).where(importOwn(actor, claim.id));
    })).catch(() => undefined);
    return { id: claim.id, status: "failed" };
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", cancel);
    await renewal;
  }
}
