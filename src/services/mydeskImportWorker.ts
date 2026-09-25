import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  mydeskImports as runs,
  mydeskImportItems as items,
  mydeskImportAssets as assets,
  type MyDeskImport,
  type MyDeskImportAsset,
} from "../schema/mydeskImports.js";
import { schedulerDb } from "./schedulerDb.js";
import {
  myDeskObjectStore,
  myDeskSha256,
  type MyDeskObjectStore,
} from "./mydeskFiles.js";
import {
  renderImportSource,
  detectImportForms,
  extractImportForm,
  buildImportAttachment,
  cropImportRegion,
  importExtractionSchema,
  importRegionSchema,
  MyDeskImportProcessingError,
  createImportAiProcessor,
  MYDESK_IMPORT_PROMPT_VERSION,
} from "./mydeskImportProcessing.js";
import {
  importAssetOwn,
  importDto,
  importError,
  importHash,
  importItemOwn,
  importOwn,
  importUuid,
  lockImport,
  withImportActor,
} from "./mydeskImports.js";
import {
  IMPORT_LEASE_MS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ITEMS,
  myDeskImportsEnabledForSchool,
  myDeskImportEnabledSchoolIds,
} from "./mydeskImportsValidation.js";
import {
  loadMyDeskClassRoster,
  type MyDeskActor,
  type MyDeskDatabase,
} from "./mydesk.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import db from "../db.js";

export type MyDeskImportProcessor = {
  renderImportSource: typeof renderImportSource;
  detectImportForms: typeof detectImportForms;
  extractImportForm: typeof extractImportForm;
  buildImportAttachment: typeof buildImportAttachment;
  cropImportRegion: typeof cropImportRegion;
};
const defaultProcessor: MyDeskImportProcessor = {
  renderImportSource,
  detectImportForms,
  extractImportForm,
  buildImportAttachment,
  cropImportRegion,
};
type WorkerOptions = {
  store?: MyDeskObjectStore;
  processor?: MyDeskImportProcessor;
  database?: typeof schedulerDb;
  now?: Date;
};
async function withLease<T>(
  actor: MyDeskActor,
  id: string,
  leaseId: string,
  fn: (
    database: MyDeskDatabase,
    run: MyDeskImport,
    current: MyDeskActor,
  ) => Promise<T>,
) {
  return withImportActor(actor, async (database, current) => {
    const run = await lockImport(database, actor, id);
    if (
      run.status !== "processing" ||
      run.leaseId !== leaseId ||
      !run.leaseUntil ||
      run.leaseUntil.getTime() <= Date.now() ||
      run.expiresAt.getTime() <= Date.now()
    )
      throw importError(
        "JOB_CANCELLED",
        "This processing operation is no longer active",
      );
    await database
      .update(runs)
      .set({ leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS) })
      .where(importOwn(actor, id));
    return fn(database, run, current);
  });
}
async function ownedBytes(
  actor: MyDeskActor,
  runId: string,
  leaseId: string,
  asset: MyDeskImportAsset,
  store: MyDeskObjectStore,
) {
  await withLease(actor, runId, leaseId, async () => undefined);
  const bytes = await store.get(asset.storageKey);
  await withLease(actor, runId, leaseId, async () => undefined);
  return bytes;
}
async function beginStage(actor: MyDeskActor, id: string, leaseId: string) {
  return withLease(actor, id, leaseId, async (database, run) => {
    if (run.attempts === 0)
      await database
        .update(runs)
        .set({ attempts: 1 })
        .where(importOwn(actor, id));
  });
}
async function finishStage(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  id: string,
) {
  await database
    .update(runs)
    .set({ attempts: 0, lastErrorCode: null })
    .where(importOwn(actor, id));
}
async function putDerived(
  actor: MyDeskActor,
  runId: string,
  leaseId: string,
  descriptor: {
    id: string;
    kind: "page" | "approved";
    parentAssetId: string;
    pageNumber?: number;
    width?: number;
    height?: number;
    pageCount?: number;
  },
  bytes: Buffer,
  contentType: string,
  store: MyDeskObjectStore,
) {
  if (bytes.length < 1 || bytes.length > IMPORT_MAX_BYTES)
    throw importError(
      "OUTPUT_TOO_LARGE",
      "A form image is too large. Use a smaller region",
      422,
    );
  const sha256 = myDeskSha256(bytes);
  const asset = await withLease(actor, runId, leaseId, async (database) => {
    const [existing] = await database
      .select()
      .from(assets)
      .where(importAssetOwn(actor, runId, descriptor.id))
      .for("update");
    if (existing) {
      if (existing.status === "ready" && existing.sha256 === sha256)
        return existing;
      if (!["pending", "uploading"].includes(existing.status))
        throw importError("JOB_CANCELLED", "This derived image was removed");
      const [updated] = await database
        .update(assets)
        .set({
          status: "uploading",
          leaseId,
          leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(importAssetOwn(actor, runId, descriptor.id))
        .returning();
      return updated!;
    }
    const [reserved] = await database
      .insert(assets)
      .values({
        ...descriptor,
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        importId: runId,
        clientRequestId: descriptor.id,
        requestFingerprint: importHash([descriptor, sha256]),
        storageKey: `mydesk/${actor.schoolId}/${actor.authorId}/imports/${runId}/${descriptor.id}`,
        contentType,
        byteSize: bytes.length,
        inputSha256: sha256,
        status: "uploading",
        leaseId,
        leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS),
      })
      .returning();
    return reserved!;
  });
  if (asset.status === "ready") return asset;
  await withLease(actor, runId, leaseId, async () => undefined);
  await store.put(asset.storageKey, bytes, contentType);
  return withLease(actor, runId, leaseId, async (database) => {
    const [current] = await database
      .select()
      .from(assets)
      .where(importAssetOwn(actor, runId, descriptor.id))
      .for("update");
    if (
      !current ||
      current.status !== "uploading" ||
      current.leaseId !== leaseId
    )
      throw importError("JOB_CANCELLED", "This image was cancelled");
    const [ready] = await database
      .update(assets)
      .set({
        status: "ready",
        contentType,
        byteSize: bytes.length,
        sha256,
        leaseId: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(importAssetOwn(actor, runId, descriptor.id))
      .returning();
    return ready!;
  });
}
export async function processClaimedMyDeskImport(
  claim: MyDeskImport,
  options: WorkerOptions = {},
) {
  const actor: MyDeskActor = {
      schoolId: claim.schoolId,
      authorId: claim.authorId,
      manager: false,
    },
    leaseId = claim.leaseId!;
  const processor = options.processor ?? {
      ...defaultProcessor,
      ...createImportAiProcessor(undefined, {
        model: claim.modelVersion ?? undefined,
      }),
    },
    store = options.store ?? myDeskObjectStore;
  let renewal: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = withLease(actor, claim.id, leaseId, async () => undefined)
      .catch(() => undefined)
      .finally(() => {
        renewal = undefined;
      });
  }, 30_000);
  heartbeat.unref();
  try {
    if (
      !claim.modelVersion ||
      claim.promptVersion !== MYDESK_IMPORT_PROMPT_VERSION
    )
      throw importError(
        "PROCESSOR_VERSION_UNAVAILABLE",
        "This import uses a processing version that is no longer available. Start a new import",
        422,
      );
    const sources = await withLease(actor, claim.id, leaseId, (database) =>
      database
        .select()
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, claim.id),
            eq(assets.kind, "source"),
            eq(assets.status, "ready"),
          ),
        )
        .orderBy(assets.createdAt, assets.id),
    );
    for (const source of sources) {
      if (source.processedAt) continue;
      await beginStage(actor, claim.id, leaseId);
      const bytes = await ownedBytes(actor, claim.id, leaseId, source, store);
      const rendered = await processor.renderImportSource(
        bytes,
        source.contentType!,
      );
      await withLease(actor, claim.id, leaseId, async () => undefined);
      if (rendered.length !== source.pageCount || rendered.length > 20)
        throw importError(
          "PAGE_COUNT_CHANGED",
          "The document page count changed during processing",
          422,
        );
      for (const page of rendered)
        await putDerived(
          actor,
          claim.id,
          leaseId,
          {
            id: importUuid(`import-page:${source.id}:${page.pageNumber}`),
            kind: "page",
            parentAssetId: source.id,
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            pageCount: 1,
          },
          page.bytes,
          "image/jpeg",
          store,
        );
      await withLease(actor, claim.id, leaseId, async (database) => {
        await database
          .update(assets)
          .set({ processedAt: new Date(), updatedAt: new Date() })
          .where(importAssetOwn(actor, claim.id, source.id));
        await finishStage(database, actor, claim.id);
      });
    }
    const pages = await withLease(actor, claim.id, leaseId, (database) =>
      database
        .select()
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, claim.id),
            eq(assets.kind, "page"),
            eq(assets.status, "ready"),
          ),
        )
        .orderBy(assets.createdAt, assets.id),
    );
    for (const page of pages) {
      if (page.processedAt) continue;
      await beginStage(actor, claim.id, leaseId);
      const bytes = await ownedBytes(actor, claim.id, leaseId, page, store);
      await withLease(actor, claim.id, leaseId, async () => undefined);
      const found = await processor.detectImportForms(bytes); // Every provider boundary has a fresh authority + lease check.
      await withLease(actor, claim.id, leaseId, async (database) => {
        const regions = found.map((r) => importRegionSchema.parse(r));
        const list = await database
          .select({ id: items.id })
          .from(items)
          .where(importItemOwn(actor, claim.id));
        if (list.length + regions.length > IMPORT_MAX_ITEMS)
          throw importError(
            "FORM_LIMIT",
            "This packet contains more than 50 forms. Split it into smaller packets",
            422,
          );
        if (regions.length)
          await database.insert(items).values(
            regions.map((region, index) => ({
              id: importUuid(`import-form:${page.id}:${index}`),
              schoolId: actor.schoolId,
              authorId: actor.authorId,
              importId: claim.id,
              clientRequestId: importUuid(`import-form:${page.id}:${index}`),
              ordinal: list.length + index,
              regions: [{ assetId: page.id, ...region, rotation: 0 as const }],
              extractRequested: true,
            })),
          );
        await database
          .update(assets)
          .set({ processedAt: new Date(), updatedAt: new Date() })
          .where(importAssetOwn(actor, claim.id, page.id));
        await finishStage(database, actor, claim.id);
      });
    }
    const pending = await withLease(actor, claim.id, leaseId, (database) =>
      database
        .select()
        .from(items)
        .where(
          and(
            importItemOwn(actor, claim.id),
            eq(items.extractionStatus, "pending"),
            eq(items.excluded, false),
          ),
        )
        .orderBy(items.ordinal),
    );
    for (const item of pending) {
      const inputs = [];
      for (const region of item.regions) {
        const page = pages.find((p) => p.id === region.assetId);
        if (!page)
          throw importError(
            "PAGE_INVALID",
            "A form page is no longer available",
          );
        inputs.push({
          bytes: await ownedBytes(actor, claim.id, leaseId, page, store),
          region: {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
          },
          rotation: region.rotation,
        });
      }
      const crops = [];
      for (const input of inputs)
        crops.push(await processor.cropImportRegion(input));
      let extraction:
        | ReturnType<typeof importExtractionSchema.parse>
        | undefined;
      if (item.extractRequested) {
        await beginStage(actor, claim.id, leaseId);
        extraction = importExtractionSchema.parse(
          await processor.extractImportForm(crops),
        );
        await withLease(
          actor,
          claim.id,
          leaseId,
          async (database, run, current) => {
            const match = {
              groupId: null as string | null,
              studentId: null as string | null,
              rosterRevision: null as string | null,
            };
            if (
              extraction!.subjectNames.length === 1 &&
              !extraction!.warnings.some(
                (w) => w === "uncertain_subject" || w === "multiple_subjects",
              )
            ) {
              const normalize = (name: string) =>
                name
                  .normalize("NFKC")
                  .trim()
                  .replace(/\s+/g, " ")
                  .toLocaleLowerCase("en-US");
              const matches: Array<{
                groupId: string;
                studentId: string;
                rosterRevision: string;
              }> = [];
              for (const groupId of [...run.selectedGroupIds].sort()) {
                try {
                  const roster = await loadMyDeskClassRoster(
                    current,
                    groupId,
                    database,
                  );
                  for (const student of roster.students)
                    if (
                      normalize(student.name) ===
                      normalize(extraction!.subjectNames[0]!)
                    )
                      matches.push({
                        groupId,
                        studentId: student.id,
                        rosterRevision: roster.rosterRevision,
                      });
                } catch (error) {
                  if (
                    !(
                      error instanceof Error &&
                      "code" in error &&
                      error.code === "MYDESK_CLASS_NOT_FOUND"
                    )
                  )
                    throw error;
                }
              }
              if (matches.length === 1) Object.assign(match, matches[0]);
            }
            // A reread replaces extracted text, not the teacher's already selected student.
            await database
              .update(items)
              .set({
                ...extraction,
                ...(!item.groupId && !item.studentId ? match : {}),
                extractRequested: false,
                updatedAt: new Date(),
              })
              .where(importItemOwn(actor, claim.id, item.id));
            await finishStage(database, actor, claim.id);
          },
        );
      }
      await beginStage(actor, claim.id, leaseId);
      const built = await processor.buildImportAttachment(inputs);
      const approved = await putDerived(
        actor,
        claim.id,
        leaseId,
        {
          id: importUuid(`import-approved:${item.id}:${item.revision}`),
          kind: "approved",
          parentAssetId: item.regions[0]!.assetId,
          pageCount: item.regions.length,
        },
        built.bytes,
        built.contentType,
        store,
      );
      await withLease(actor, claim.id, leaseId, async (database) => {
        const [current] = await database
          .select()
          .from(items)
          .where(importItemOwn(actor, claim.id, item.id))
          .for("update");
        if (!current || current.revision !== item.revision)
          throw importError(
            "JOB_CANCELLED",
            "This form changed during processing",
          );
        await database
          .update(items)
          .set({
            ...extraction,
            approvedAssetId: approved.id,
            extractionStatus: "ready",
            extractRequested: false,
            reviewed: false,
            reviewFingerprint: null,
            revision: item.revision + 1,
            updatedAt: new Date(),
          })
          .where(importItemOwn(actor, claim.id, item.id));
        await finishStage(database, actor, claim.id);
      });
    }
    await withLease(actor, claim.id, leaseId, async (database, run) => {
      await database
        .update(runs)
        .set({
          status: "review",
          leaseId: null,
          leaseUntil: null,
          lastErrorCode: null,
          revision: run.revision + 1,
          updatedAt: new Date(),
        })
        .where(importOwn(actor, claim.id));
    });
    return { id: claim.id, status: "review" };
  } catch (error) {
    const code =
      error instanceof MyDeskImportProcessingError &&
      /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "MYDESK_IMPORT_PROCESSING_FAILED";
    const retryable =
      error instanceof MyDeskImportProcessingError
        ? error.retryable
        : !(
            error instanceof Error &&
            "status" in error &&
            typeof error.status === "number" &&
            error.status < 500
          );
    // Repair only the exact already-claimed run. Never publish content after authority revocation.
    await runWithTenantContext({ schoolId: actor.schoolId }, () =>
      db.transaction(async (database) => {
        const run = await lockImport(database, actor, claim.id);
        if (run.status !== "processing" || run.leaseId !== leaseId) return;
        await database
          .update(runs)
          .set({
            status: retryable && run.attempts < 3 ? "queued" : "failed",
            leaseId: null,
            leaseUntil: null,
            nextAttemptAt: new Date(
              Date.now() + 60_000 * 2 ** Math.max(0, run.attempts - 1),
            ),
            lastErrorCode: code,
            revision: run.revision + 1,
            updatedAt: new Date(),
          })
          .where(importOwn(actor, claim.id));
      }),
    ).catch(() => undefined);
    return { id: claim.id, status: "failed" };
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}
/** A global database claim bounds concurrency across worker processes; no provider I/O holds its connection. */
export async function runMyDeskImportJobs(options: WorkerOptions = {}) {
  const database = options.database ?? schedulerDb,
    now = options.now ?? new Date();
  const allowed = myDeskImportEnabledSchoolIds();
  if (allowed !== null && !allowed.length) return [];
  const claims = await database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('mydesk-import-global-slots',0))`,
    );
    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.status, "processing"), sql`${runs.leaseUntil}>${now}`),
      );
    let slots = Math.max(0, 2 - active.length);
    if (!slots) return [];
    const due = await tx
      .select()
      .from(runs)
      .where(
        and(
          or(
            and(
              eq(runs.status, "queued"),
              or(isNull(runs.nextAttemptAt), lte(runs.nextAttemptAt, now)),
            ),
            and(eq(runs.status, "processing"), lte(runs.leaseUntil, now)),
          ),
          sql`${runs.expiresAt}>${now}`,
          allowed === null ? undefined : inArray(runs.schoolId, allowed),
        ),
      )
      .orderBy(runs.createdAt)
      .limit(50)
      .for("update", { skipLocked: true });
    const result: MyDeskImport[] = [];
    for (const run of due) {
      if (!slots) break;
      if (!myDeskImportsEnabledForSchool(run.schoolId)) continue;
      if (run.attempts >= 3) {
        await tx
          .update(runs)
          .set({
            status: "failed",
            leaseId: null,
            leaseUntil: null,
            lastErrorCode: "MYDESK_IMPORT_ATTEMPTS_EXHAUSTED",
            updatedAt: now,
          })
          .where(eq(runs.id, run.id));
        continue;
      }
      const [claimed] = await tx
        .update(runs)
        .set({
          status: "processing",
          leaseId: randomUUID(),
          leaseUntil: new Date(now.getTime() + IMPORT_LEASE_MS),
          attempts: run.attempts + 1,
          revision: run.revision + 1,
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();
      result.push(claimed!);
      slots--;
    }
    return result;
  });
  return Promise.all(
    claims.map((claim) => processClaimedMyDeskImport(claim, options)),
  );
}
