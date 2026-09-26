import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  mydeskImports as runs,
  mydeskImportItems as items,
  mydeskImportAssets as assets,
  type MyDeskImport,
  type MyDeskImportItem,
  type MyDeskImportAsset,
  type ImportRegion,
} from "../schema/mydeskImports.js";
import { mydeskNotes, mydeskAttachments } from "../schema/mydesk.js";
import { schools } from "../schema/core.js";
import { auditLogs } from "../schema/shared.js";
import { createLocalDateFormatter } from "../util/schoolTime.js";
import {
  withActor,
  currentClasses,
  loadMyDeskClassRoster,
  myDeskError,
  type MyDeskActor,
  type MyDeskDatabase,
} from "./mydesk.js";
import {
  myDeskObjectStore,
  type MyDeskObjectStore,
  myDeskSha256,
} from "./mydeskFiles.js";
import {
  prepareImportSource,
  myDeskImportModel,
  MYDESK_IMPORT_PROMPT_VERSION,
} from "./mydeskImportProcessing.js";
import {
  importCreate,
  importUpdate,
  importMutation,
  importItemCreate,
  importItemUpdate,
  importItemJoin,
  importCommit,
  importReservation,
  myDeskImportsEnabledForSchool,
  myDeskImportLimits,
  IMPORT_MAX_SOURCES,
  IMPORT_MAX_PAGES,
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_BYTES,
  IMPORT_UPLOAD_MS,
  IMPORT_REVIEW_MS,
  IMPORT_LEASE_MS,
} from "./mydeskImportsValidation.js";

export const importHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const importUuid = (value: string) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const importError = (code: string, message: string, status = 409) =>
  myDeskError(status, `MYDESK_IMPORT_${code}`, message);
export const importOwn = (actor: MyDeskActor, id?: string) =>
  and(
    eq(runs.schoolId, actor.schoolId),
    eq(runs.authorId, actor.authorId),
    id ? eq(runs.id, id) : undefined,
  )!;
export const importItemOwn = (actor: MyDeskActor, runId: string, id?: string) =>
  and(
    eq(items.schoolId, actor.schoolId),
    eq(items.authorId, actor.authorId),
    eq(items.importId, runId),
    id ? eq(items.id, id) : undefined,
  )!;
export const importAssetOwn = (
  actor: MyDeskActor,
  runId: string,
  id?: string,
) =>
  and(
    eq(assets.schoolId, actor.schoolId),
    eq(assets.authorId, actor.authorId),
    eq(assets.importId, runId),
    id ? eq(assets.id, id) : undefined,
  )!;
export const importTerminal = (status: string) =>
  ["completed", "cancelled", "expired"].includes(status);
async function importAudit(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  id: string,
  action: string,
  counts: Record<string, number> = {},
) {
  await database.insert(auditLogs).values({
    schoolId: actor.schoolId,
    userId: actor.authorId,
    action: `mydesk.import.${action}`,
    entityType: "mydesk_import",
    entityId: id,
    metadata: counts,
  });
}
export async function withImportActor<T>(
  actor: MyDeskActor,
  fn: (database: MyDeskDatabase, current: MyDeskActor) => Promise<T>,
) {
  return withActor(actor, async (database, current) => {
    if (!myDeskImportsEnabledForSchool(actor.schoolId))
      throw importError(
        "NOT_ENABLED",
        "Paperwork import is temporarily unavailable",
        404,
      );
    return fn(database, current);
  });
}
export async function lockImport(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  id: string,
) {
  const [run] = await database
    .select()
    .from(runs)
    .where(importOwn(actor, id))
    .for("update");
  if (!run) throw importError("NOT_FOUND", "Import not found", 404);
  return run;
}
export function assertImportOpen(run: MyDeskImport, statuses?: string[]) {
  if (importTerminal(run.status) || run.expiresAt.getTime() <= Date.now())
    throw importError("CLOSED", "This import has finished or expired");
  if (statuses && !statuses.includes(run.status))
    throw importError(
      "BUSY",
      "Wait for processing to finish before changing this import",
    );
}
const safeAsset = (a: MyDeskImportAsset) => ({
  id: a.id,
  kind: a.kind,
  parentAssetId: a.parentAssetId,
  pageNumber: a.pageNumber,
  status: a.status,
  contentType: a.contentType,
  byteSize: a.byteSize,
  width: a.width,
  height: a.height,
  pageCount: a.pageCount,
  originalFilename: a.originalFilename,
});
const safeItem = (i: MyDeskImportItem) => ({
  id: i.id,
  ordinal: i.ordinal,
  revision: i.revision,
  regions: i.regions,
  subjectNames: i.subjectNames,
  groupId: i.groupId,
  studentId: i.studentId,
  rosterRevision: i.rosterRevision,
  category: i.category,
  title: i.title,
  body: i.body,
  entryDate: i.entryDate,
  warnings: i.warnings,
  reviewed: i.reviewed,
  excluded: i.excluded,
  extractionStatus: i.extractionStatus,
  approvedAssetId: i.approvedAssetId,
  noteId: i.noteId,
});
export async function importDto(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  run: MyDeskImport,
) {
  const expired =
    !importTerminal(run.status) && run.expiresAt.getTime() <= Date.now();
  const terminal = importTerminal(run.status) || expired;
  const a = terminal
    ? []
    : await database
        .select()
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, run.id),
            inArray(assets.status, ["pending", "uploading", "ready"]),
          ),
        )
        .orderBy(assets.createdAt, assets.id);
  const i = terminal
    ? []
    : await database
        .select()
        .from(items)
        .where(importItemOwn(actor, run.id))
        .orderBy(items.ordinal, items.id);
  return {
    id: run.id,
    status: expired ? "expired" : run.status,
    revision: run.revision,
    selectedGroupIds: terminal ? [] : run.selectedGroupIds,
    pageDecisions: terminal ? [] : run.pageDecisions,
    expiresAt: run.expiresAt,
    uploadExpiresAt: run.uploadExpiresAt,
    pageCount: run.pageCount,
    expectedSourceCount: run.expectedSourceCount,
    attempts: run.attempts,
    lastErrorCode: run.lastErrorCode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    commitReceipt: run.commitReceipt
      ? { notes: run.commitReceipt.notes }
      : null,
    assets: a.map(safeAsset),
    items: i.map(safeItem),
  };
}
async function assertGroups(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  ids: string[],
) {
  const allowed = await currentClasses(actor, database);
  if (ids.some((id) => !allowed.some((g) => g.id === id)))
    throw importError(
      "CLASS_UNAVAILABLE",
      "Choose current classes you can access",
    );
}
export async function createMyDeskImport(
  actor: MyDeskActor,
  input: z.infer<typeof importCreate>,
) {
  return withImportActor(actor, async (database, current) => {
    const hash = importHash(input);
    await database.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mydesk-import:${actor.schoolId}:${actor.authorId}:${input.clientRequestId}`},0))`,
    );
    const [existing] = await database
      .select()
      .from(runs)
      .where(
        and(importOwn(actor), eq(runs.clientRequestId, input.clientRequestId)),
      )
      .for("update");
    if (existing) {
      if (existing.requestFingerprint !== hash)
        throw importError(
          "REQUEST_CONFLICT",
          "This request identifier was already used for different content",
        );
      return {
        import: await importDto(database, actor, existing),
        created: false,
      };
    }
    await assertGroups(database, current, input.selectedGroupIds);
    const [run] = await database
      .insert(runs)
      .values({
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        clientRequestId: input.clientRequestId,
        requestFingerprint: hash,
        selectedGroupIds: input.selectedGroupIds,
        expectedSourceCount: input.expectedSourceCount,
        expiresAt: new Date(Date.now() + IMPORT_UPLOAD_MS),
        uploadExpiresAt: new Date(Date.now() + IMPORT_UPLOAD_MS),
      })
      .returning();
    await importAudit(database, actor, run!.id, "create");
    return { import: await importDto(database, actor, run!), created: true };
  });
}
export async function getMyDeskImport(actor: MyDeskActor, id: string) {
  return withImportActor(actor, async (database) =>
    importDto(database, actor, await lockImport(database, actor, id)),
  );
}
export async function listMyDeskImports(actor: MyDeskActor, raw: unknown = {}) {
  return withImportActor(actor, async (database) => {
    const query = z
      .object({
        cursor: z.string().max(2048).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(raw);
    let cursor: { time: string; id: string; owner: string } | undefined;
    if (query.cursor) {
      try {
        cursor = z
          .object({
            time: z.string().datetime(),
            id: z.string().uuid(),
            owner: z.string(),
          })
          .parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
      } catch {
        throw importError("CURSOR_INVALID", "Reload the import list", 400);
      }
      if (cursor.owner !== importHash([actor.schoolId, actor.authorId]))
        throw importError("CURSOR_INVALID", "Reload the import list", 400);
    }
    const rows = await database
      .select({
        id: runs.id,
        status: runs.status,
        revision: runs.revision,
        pageCount: runs.pageCount,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        expiresAt: runs.expiresAt,
        lastErrorCode: runs.lastErrorCode,
        exactTime: sql<string>`to_char(${runs.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(runs)
      .where(
        and(
          importOwn(actor),
          inArray(runs.status, [
            "uploading",
            "queued",
            "processing",
            "review",
            "failed",
          ]),
          sql`${runs.expiresAt}>now()`,
          cursor
            ? sql`(${runs.createdAt},${runs.id})<(${cursor.time}::timestamptz,${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit),
      last = page.at(-1);
    return {
      imports: page.map(({ exactTime: _exactTime, ...row }) => row),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                time: last.exactTime,
                id: last.id,
                owner: importHash([actor.schoolId, actor.authorId]),
              }),
            ).toString("base64url")
          : null,
    };
  });
}
type Mutation = z.infer<typeof importMutation>;
export async function mutateImport(
  actor: MyDeskActor,
  id: string,
  input: Mutation,
  kind: string,
  fn: (
    database: MyDeskDatabase,
    current: MyDeskActor,
    run: MyDeskImport,
  ) => Promise<Partial<typeof runs.$inferInsert> | void>,
) {
  return withImportActor(actor, async (database, current) => {
    const run = await lockImport(database, actor, id),
      hash = importHash([kind, input]);
    const receipt = run.mutationReceipts.find((r) => r.id === input.requestId);
    if (receipt) {
      if (receipt.fingerprint !== hash || receipt.kind !== kind)
        throw importError(
          "REQUEST_CONFLICT",
          "This request identifier was already used for a different change",
        );
      return importDto(database, actor, run);
    }
    if (run.revision !== input.revision)
      throw importError(
        "REVISION_CONFLICT",
        "This import changed. Reload it before saving",
      );
    const changes = await fn(database, current, run);
    const [updated] = await database
      .update(runs)
      .set({
        ...changes,
        revision: run.revision + 1,
        updatedAt: new Date(),
        mutationReceipts: [
          ...run.mutationReceipts,
          {
            id: input.requestId,
            fingerprint: hash,
            kind,
            revision: run.revision + 1,
          },
        ].slice(-100),
      })
      .where(importOwn(actor, id))
      .returning();
    await importAudit(database, actor, id, kind.split(":")[0]!);
    return importDto(database, actor, updated!);
  });
}
export async function updateMyDeskImport(
  actor: MyDeskActor,
  id: string,
  input: z.infer<typeof importUpdate>,
) {
  return mutateImport(
    actor,
    id,
    input,
    "update",
    async (database, current, run) => {
      assertImportOpen(run, ["uploading", "review", "failed"]);
      const selected = input.selectedGroupIds ?? run.selectedGroupIds;
      await assertGroups(database, current, selected);
      if (input.pageDecisions) {
        const pages = await database
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              importAssetOwn(actor, id),
              eq(assets.kind, "page"),
              eq(assets.status, "ready"),
            ),
          );
        if (
          new Set(input.pageDecisions.map((p) => p.assetId)).size !==
            input.pageDecisions.length ||
          input.pageDecisions.some(
            (p) => !pages.some((a) => a.id === p.assetId),
          )
        )
          throw importError("PAGE_INVALID", "Choose pages from this import");
        const excludedPages = input.pageDecisions
          .filter((p) => p.excluded)
          .map((p) => p.assetId);
        if (excludedPages.length)
          await database
            .update(assets)
            .set({ processedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                importAssetOwn(actor, id),
                eq(assets.kind, "page"),
                inArray(assets.id, excludedPages),
              ),
            );
      }
      if (
        input.selectedGroupIds &&
        importHash(selected) !== importHash(run.selectedGroupIds)
      )
        await database
          .update(items)
          .set({
            reviewed: false,
            reviewFingerprint: null,
            revision: sql`${items.revision}+1`,
            updatedAt: new Date(),
          })
          .where(importItemOwn(actor, id));
      return {
        selectedGroupIds: selected,
        pageDecisions: input.pageDecisions ?? run.pageDecisions,
        ...(run.status === "failed" &&
        (await importDraftsReady(database, actor, run))
          ? { status: "review" as const, lastErrorCode: null }
          : {}),
      };
    },
  );
}
export async function reserveMyDeskImportAsset(
  actor: MyDeskActor,
  id: string,
  input: z.infer<typeof importReservation>,
) {
  return withImportActor(actor, async (database) => {
    const run = await lockImport(database, actor, id);
    assertImportOpen(run, ["uploading"]);
    const hash = importHash(input);
    const [existing] = await database
      .select()
      .from(assets)
      .where(
        and(
          importAssetOwn(actor, id),
          eq(assets.clientRequestId, input.clientRequestId),
        ),
      );
    if (existing) {
      if (existing.requestFingerprint !== hash)
        throw importError(
          "REQUEST_CONFLICT",
          "This upload identifier was already used for another file",
        );
      if (!["pending", "uploading", "ready"].includes(existing.status))
        throw importError("CLOSED", "This upload was removed");
      return safeAsset(existing);
    }
    const sources = await database
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          importAssetOwn(actor, id),
          eq(assets.kind, "source"),
          inArray(assets.status, ["pending", "uploading", "ready"]),
        ),
      );
    if (sources.length >= run.expectedSourceCount)
      throw importError(
        "SOURCE_LIMIT",
        "Every file in this import has already been reserved",
      );
    const assetId = randomUUID();
    const [asset] = await database
      .insert(assets)
      .values({
        id: assetId,
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        importId: id,
        kind: "source",
        clientRequestId: input.clientRequestId,
        requestFingerprint: hash,
        storageKey: `mydesk/${actor.schoolId}/${actor.authorId}/imports/${id}/${assetId}`,
        originalFilename: input.filename,
        contentType: input.contentType,
        inputSha256: input.sha256,
        byteSize: input.size,
      })
      .returning();
    await database
      .update(runs)
      .set({
        revision: run.revision + 1,
        updatedAt: new Date(),
      })
      .where(importOwn(actor, id));
    return safeAsset(asset!);
  });
}
export async function uploadMyDeskImportAsset(
  actor: MyDeskActor,
  id: string,
  assetId: string,
  bytes: Buffer,
  contentType: string,
  options: {
    store?: MyDeskObjectStore;
    prepare?: typeof prepareImportSource;
  } = {},
) {
  const store = options.store ?? myDeskObjectStore,
    leaseId = randomUUID();
  if (bytes.length < 1 || bytes.length > IMPORT_MAX_BYTES)
    throw importError("FILE_SIZE", "Choose a file no larger than 10 MiB", 413);
  const asset = await withImportActor(actor, async (database) => {
    const run = await lockImport(database, actor, id);
    assertImportOpen(run, ["uploading"]);
    const [found] = await database
      .select()
      .from(assets)
      .where(and(importAssetOwn(actor, id, assetId), eq(assets.kind, "source")))
      .for("update");
    if (!found || !["pending", "uploading", "ready"].includes(found.status))
      throw importError("NOT_FOUND", "Upload not found", 404);
    if (
      found.inputSha256 !== myDeskSha256(bytes) ||
      found.requestFingerprint !==
        importHash({
          clientRequestId: found.clientRequestId,
          filename: found.originalFilename,
          contentType,
          size: bytes.length,
          sha256: myDeskSha256(bytes),
        })
    )
      throw importError(
        "UPLOAD_MISMATCH",
        "This file differs from the reserved upload",
      );
    if (found.status === "ready") return found;
    if (found.contentType !== contentType || found.byteSize !== bytes.length)
      throw importError(
        "UPLOAD_MISMATCH",
        "The file type or size differs from the reserved upload",
      );
    if (found.leaseUntil && found.leaseUntil.getTime() > Date.now())
      throw importError(
        "UPLOAD_BUSY",
        "This file is still uploading. Retry shortly",
      );
    const [updated] = await database
      .update(assets)
      .set({
        status: "uploading",
        leaseId,
        leaseUntil: new Date(Date.now() + IMPORT_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(importAssetOwn(actor, id, assetId))
      .returning();
    return updated!;
  });
  if (asset.status === "ready") return safeAsset(asset);
  try {
    const prepared = await (options.prepare ?? prepareImportSource)(
      bytes,
      contentType,
    );
    if (
      !Number.isInteger(prepared.pageCount) ||
      prepared.pageCount < 1 ||
      prepared.pageCount > IMPORT_MAX_PAGES ||
      prepared.bytes.length > IMPORT_MAX_BYTES
    )
      throw importError("PAGE_LIMIT", "A packet can contain at most 20 pages");
    if (!asset.leaseUntil || Date.now() + 60_000 >= asset.leaseUntil.getTime())
      throw importError(
        "UPLOAD_EXPIRED",
        "Processing this file took too long. Retry the upload",
      );
    await store.put(asset.storageKey, prepared.bytes, prepared.contentType);
    return await withImportActor(actor, async (database) => {
      const run = await lockImport(database, actor, id);
      assertImportOpen(run, ["uploading"]);
      const [live] = await database
        .select()
        .from(assets)
        .where(importAssetOwn(actor, id, assetId))
        .for("update");
      if (!live || live.status !== "uploading" || live.leaseId !== leaseId)
        throw importError("UPLOAD_CANCELLED", "This upload was cancelled");
      const other = await database
        .select({ pages: assets.pageCount })
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, id),
            eq(assets.kind, "source"),
            eq(assets.status, "ready"),
            ne(assets.id, assetId),
          ),
        );
      const total = other.reduce(
        (n, a) => n + (a.pages ?? 0),
        prepared.pageCount,
      );
      if (total > IMPORT_MAX_PAGES)
        throw importError(
          "PAGE_LIMIT",
          "A packet can contain at most 20 pages",
        );
      const [ready] = await database
        .update(assets)
        .set({
          status: "ready",
          contentType: prepared.contentType,
          byteSize: prepared.bytes.length,
          sha256: myDeskSha256(prepared.bytes),
          pageCount: prepared.pageCount,
          leaseId: null,
          leaseUntil: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(importAssetOwn(actor, id, assetId))
        .returning();
      const unfinished = await database
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, id),
            eq(assets.kind, "source"),
            inArray(assets.status, ["pending", "uploading"]),
          ),
        );
      await database
        .update(runs)
        .set({
          pageCount: total,
          revision: run.revision + 1,
          updatedAt: new Date(),
          ...(!unfinished.length && other.length + 1 === run.expectedSourceCount
            ? {
                expiresAt: new Date(Date.now() + IMPORT_REVIEW_MS),
              }
            : {}),
        })
        .where(importOwn(actor, id));
      return safeAsset(ready!);
    });
  } catch (error) {
    await repairImportUpload(actor, id, assetId, leaseId).catch(
      () => undefined,
    );
    throw error;
  }
}
async function repairImportUpload(
  actor: MyDeskActor,
  id: string,
  assetId: string,
  leaseId: string,
) {
  const { runWithTenantContext } = await import(
      "../middleware/tenantContext.js"
    ),
    { default: db } = await import("../db.js");
  await runWithTenantContext({ schoolId: actor.schoolId }, () =>
    db.transaction(async (database) => {
      const run = await lockImport(database, actor, id);
      const [asset] = await database
        .select()
        .from(assets)
        .where(importAssetOwn(actor, id, assetId))
        .for("update");
      if (!asset || asset.status === "promoted" || asset.status === "ready")
        return;
      if (
        importTerminal(run.status) ||
        ["deleted", "delete_pending"].includes(asset.status)
      )
        await database
          .update(assets)
          .set({
            status: "delete_pending",
            nextCleanupAt: new Date(),
            updatedAt: new Date(),
            lastErrorCode: "LATE_UPLOAD",
          })
          .where(importAssetOwn(actor, id, assetId));
      else if (asset.leaseId === leaseId)
        await database
          .update(assets)
          .set({
            status: "pending",
            lastErrorCode: "UPLOAD_FAILED",
            updatedAt: new Date(),
          })
          .where(importAssetOwn(actor, id, assetId));
    }),
  );
}
export async function readMyDeskImportAsset(
  actor: MyDeskActor,
  id: string,
  assetId: string,
  store: MyDeskObjectStore = myDeskObjectStore,
) {
  const read = () =>
    withImportActor(actor, async (database) => {
      const run = await lockImport(database, actor, id);
      assertImportOpen(run);
      const [asset] = await database
        .select()
        .from(assets)
        .where(
          and(importAssetOwn(actor, id, assetId), eq(assets.status, "ready")),
        );
      if (!asset) throw importError("NOT_FOUND", "Preview not found", 404);
      return asset;
    });
  const asset = await read(),
    bytes = await store.get(asset.storageKey);
  await read();
  return {
    bytes,
    contentType: asset.contentType!,
    filename: asset.kind === "source" ? asset.originalFilename : "form-preview",
  };
}
async function chargeQuota(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  run: MyDeskImport,
  pages: number,
) {
  const limits = myDeskImportLimits();
  await database.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mydesk-import-quota:${actor.schoolId}`},0))`,
  );
  const [school] = await database
    .select({ timezone: schools.schoolTimezone })
    .from(schools)
    .where(eq(schools.id, actor.schoolId));
  const date = createLocalDateFormatter(school?.timezone)(new Date());
  const usage = sql<number>`(SELECT coalesce(sum((entry->>'pages')::int),0) FROM jsonb_array_elements(${runs.quotaUsage}) entry WHERE entry->>'date'=${date})`;
  const [totals] = await database
    .select({
      school: sql<number>`coalesce(sum(${usage}),0)::int`,
      author: sql<number>`coalesce(sum(CASE WHEN ${runs.authorId}=${actor.authorId} THEN ${usage} ELSE 0 END),0)::int`,
    })
    .from(runs)
    .where(eq(runs.schoolId, actor.schoolId));
  if (
    (totals?.author ?? 0) + pages > limits.teacherDailyPages ||
    (totals?.school ?? 0) + pages > limits.schoolDailyPages
  )
    throw importError(
      "DAILY_LIMIT",
      "The daily paperwork page allowance has been reached. Try again tomorrow",
      429,
    );
  const ledger = run.quotaUsage.map((row) => ({ ...row }));
  const today = ledger.find((row) => row.date === date);
  if (today) today.pages += pages;
  else ledger.push({ date, pages });
  if (ledger.length > 8)
    throw importError("CLOSED", "This import review window has ended");
  return { quotaUsage: ledger, quotaDate: run.quotaDate ?? date };
}
export async function processMyDeskImport(
  actor: MyDeskActor,
  id: string,
  input: Mutation,
) {
  return mutateImport(
    actor,
    id,
    input,
    "process",
    async (database, current, run) => {
      assertImportOpen(run, ["uploading", "failed"]);
      await assertGroups(database, current, run.selectedGroupIds);
      const sources = await database
        .select()
        .from(assets)
        .where(
          and(
            importAssetOwn(actor, id),
            eq(assets.kind, "source"),
            inArray(assets.status, ["pending", "uploading", "ready"]),
          ),
        );
      if (
        sources.length !== run.expectedSourceCount ||
        sources.some((a) => a.status !== "ready") ||
        run.pageCount < 1 ||
        run.pageCount > 20
      )
        throw importError(
          "UPLOADS_INCOMPLETE",
          "Finish uploading every source file first",
        );
      if (run.attempts >= 3)
        throw importError(
          "ATTEMPTS_EXHAUSTED",
          "Processing could not finish after three attempts. Start a new import",
        );
      const quota = run.quotaDate
        ? {}
        : await chargeQuota(database, actor, run, run.pageCount);
      const modelVersion = run.modelVersion ?? myDeskImportModel();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelVersion))
        throw importError(
          "CONFIGURATION",
          "Paperwork import is temporarily unavailable",
          503,
        );
      return {
        status: "queued",
        ...quota,
        modelVersion,
        promptVersion: run.promptVersion ?? MYDESK_IMPORT_PROMPT_VERSION,
        nextAttemptAt: new Date(),
        lastErrorCode: null,
      };
    },
  );
}
async function validateRegions(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  id: string,
  regions: ImportRegion[],
) {
  const pages = await database
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        importAssetOwn(actor, id),
        eq(assets.kind, "page"),
        eq(assets.status, "ready"),
      ),
    );
  if (regions.some((r) => !pages.some((p) => p.id === r.assetId)))
    throw importError("PAGE_INVALID", "Choose pages from this import");
}
async function importDraftsReady(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  run: MyDeskImport,
) {
  const pages = await database
    .select({ processedAt: assets.processedAt })
    .from(assets)
    .where(
      and(
        importAssetOwn(actor, run.id),
        eq(assets.kind, "page"),
        eq(assets.status, "ready"),
      ),
    );
  const waiting = await database
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        importItemOwn(actor, run.id),
        eq(items.excluded, false),
        ne(items.extractionStatus, "ready"),
      ),
    )
    .limit(1);
  return (
    pages.length === run.pageCount &&
    pages.every((p) => p.processedAt) &&
    !waiting.length
  );
}
const reviewHash = (item: MyDeskImportItem, asset: MyDeskImportAsset) =>
  importHash([
    item.regions,
    item.groupId,
    item.studentId,
    item.rosterRevision,
    item.category,
    item.title,
    item.body,
    item.entryDate,
    asset.id,
    asset.sha256,
  ]);
async function verifyReview(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  run: MyDeskImport,
  item: MyDeskImportItem,
) {
  if (
    item.excluded ||
    item.extractionStatus !== "ready" ||
    !item.approvedAssetId ||
    !item.groupId ||
    !item.studentId ||
    !item.entryDate ||
    !item.rosterRevision ||
    !run.selectedGroupIds.includes(item.groupId)
  )
    throw importError(
      "REVIEW_REQUIRED",
      "Choose the student, class and date, and wait for the form preview before confirming review",
    );
  const roster = await loadMyDeskClassRoster(actor, item.groupId, database, {
    lock: true,
  });
  if (
    roster.rosterRevision !== item.rosterRevision ||
    !roster.students.some((s) => s.id === item.studentId)
  )
    throw importError(
      "ROSTER_CHANGED",
      "The class roster changed. Confirm the student again",
    );
  const [asset] = await database
    .select()
    .from(assets)
    .where(
      and(
        importAssetOwn(actor, run.id, item.approvedAssetId),
        eq(assets.kind, "approved"),
        eq(assets.status, "ready"),
      ),
    )
    .for("update");
  if (!asset || asset.leaseId || !asset.sha256)
    throw importError(
      "PREVIEW_NOT_READY",
      "Wait for the approved form preview to finish",
    );
  return { asset, roster, hash: reviewHash(item, asset) };
}
export async function createMyDeskImportItem(
  actor: MyDeskActor,
  id: string,
  input: z.infer<typeof importItemCreate>,
) {
  return mutateImport(
    actor,
    id,
    input,
    "item.create",
    async (database, _current, run) => {
      assertImportOpen(run, ["review", "failed"]);
      await validateRegions(database, actor, id, input.regions);
      const list = await database
        .select({ ordinal: items.ordinal })
        .from(items)
        .where(importItemOwn(actor, id));
      if (list.length >= IMPORT_MAX_ITEMS)
        throw importError(
          "FORM_LIMIT",
          "A packet can contain at most 50 forms",
        );
      const quota = await chargeQuota(
        database,
        actor,
        run,
        new Set(input.regions.map((r) => r.assetId)).size,
      );
      await database.insert(items).values({
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        importId: id,
        clientRequestId: input.requestId,
        ordinal: list.length,
        regions: input.regions,
        extractRequested: true,
      });
      // Explicit manual regions replace failed automatic detection on these pages.
      await database
        .update(assets)
        .set({ processedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            importAssetOwn(actor, id),
            eq(assets.kind, "page"),
            inArray(assets.id, [
              ...new Set(input.regions.map((r) => r.assetId)),
            ]),
          ),
        );
      return {
        status: "queued",
        ...quota,
        attempts: 0,
        nextAttemptAt: new Date(),
        pageDecisions: run.pageDecisions.filter(
          (p) => !input.regions.some((r) => r.assetId === p.assetId),
        ),
      };
    },
  );
}
export async function updateMyDeskImportItem(
  actor: MyDeskActor,
  id: string,
  itemId: string,
  input: z.infer<typeof importItemUpdate>,
) {
  return mutateImport(
    actor,
    id,
    input,
    `item.update:${itemId}`,
    async (database, current, run) => {
      assertImportOpen(run, ["review", "failed"]);
      const [item] = await database
        .select()
        .from(items)
        .where(importItemOwn(actor, id, itemId))
        .for("update");
      if (!item) throw importError("NOT_FOUND", "Form not found", 404);
      if (item.revision !== input.itemRevision)
        throw importError(
          "REVISION_CONFLICT",
          "This form changed. Reload it before saving",
        );
      const {
        requestId: _requestId,
        revision: _revision,
        itemRevision: _itemRevision,
        reviewed,
        ...patch
      } = input;
      if (patch.regions)
        await validateRegions(database, actor, id, patch.regions);
      if (patch.groupId && !run.selectedGroupIds.includes(patch.groupId))
        throw importError(
          "CLASS_UNAVAILABLE",
          "Choose one of the selected classes",
        );
      const changedRegions =
        patch.regions !== undefined &&
        importHash(patch.regions) !== importHash(item.regions);
      const manualText = ["title", "body", "category", "entryDate"].some(
        (key) => key in patch,
      );
      const rebuild =
        changedRegions ||
        (!item.approvedAssetId && (manualText || patch.excluded === false));
      if (rebuild && reviewed)
        throw importError(
          "PREVIEW_NOT_READY",
          "Review the rebuilt form image before confirming it",
        );
      let updated: MyDeskImportItem = {
        ...item,
        ...patch,
        reviewed: false,
        reviewFingerprint: null,
        revision: item.revision + 1,
        updatedAt: new Date(),
      };
      if (!updated.regions.length && !updated.excluded)
        throw importError(
          "REGION_REQUIRED",
          "Keep at least one region or exclude this form",
        );
      if (rebuild) {
        updated.approvedAssetId = null;
        updated.extractionStatus = updated.excluded ? "ready" : "pending";
        updated.extractRequested = false;
      }
      if (updated.excluded) {
        updated.reviewed = false;
        updated.reviewFingerprint = null;
      } else if (reviewed) {
        updated.reviewFingerprint = (
          await verifyReview(database, current, run, updated)
        ).hash;
        updated.reviewed = true;
      }
      if (item.approvedAssetId && rebuild)
        await database
          .update(assets)
          .set({
            status: "delete_pending",
            nextCleanupAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              importAssetOwn(actor, id, item.approvedAssetId),
              ne(assets.status, "promoted"),
            ),
          );
      await database
        .update(items)
        .set({
          regions: updated.regions,
          groupId: updated.groupId,
          studentId: updated.studentId,
          rosterRevision: updated.rosterRevision,
          category: updated.category,
          title: updated.title,
          body: updated.body,
          entryDate: updated.entryDate,
          excluded: updated.excluded,
          reviewed: updated.reviewed,
          reviewFingerprint: updated.reviewFingerprint,
          approvedAssetId: updated.approvedAssetId,
          extractionStatus: updated.extractionStatus,
          extractRequested: updated.extractRequested,
          revision: updated.revision,
          updatedAt: updated.updatedAt,
        })
        .where(importItemOwn(actor, id, itemId));
      const affected =
        changedRegions || patch.excluded !== undefined
          ? [...item.regions, ...updated.regions].map((r) => r.assetId)
          : [];
      return {
        pageDecisions: run.pageDecisions.filter(
          (p) => !affected.includes(p.assetId),
        ),
        ...(rebuild && !updated.excluded
          ? {
              status: "queued" as const,
              attempts: 0,
              nextAttemptAt: new Date(),
            }
          : run.status === "failed" &&
              (await importDraftsReady(database, actor, run))
            ? { status: "review" as const, lastErrorCode: null }
            : {}),
      };
    },
  );
}
export async function joinMyDeskImportItems(
  actor: MyDeskActor,
  id: string,
  itemId: string,
  input: z.infer<typeof importItemJoin>,
) {
  return mutateImport(
    actor,
    id,
    input,
    `item.join:${itemId}`,
    async (database, _current, run) => {
      assertImportOpen(run, ["review", "failed"]);
      if (itemId === input.sourceItemId)
        throw importError("JOIN_INVALID", "Choose two different forms", 400);
      const forms = await database
        .select()
        .from(items)
        .where(
          and(
            importItemOwn(actor, id),
            inArray(items.id, [itemId, input.sourceItemId]),
          ),
        )
        .orderBy(items.id)
        .for("update");
      const target = forms.find((i) => i.id === itemId),
        source = forms.find((i) => i.id === input.sourceItemId);
      if (!target || !source)
        throw importError("NOT_FOUND", "Form not found", 404);
      if (
        target.revision !== input.itemRevision ||
        source.revision !== input.sourceItemRevision
      )
        throw importError(
          "REVISION_CONFLICT",
          "A form changed. Reload before joining",
        );
      const regions = [...target.regions, ...source.regions];
      if (
        target.excluded ||
        source.excluded ||
        !regions.length ||
        regions.length > 20
      )
        throw importError(
          "JOIN_INVALID",
          "Join included forms with at most 20 total regions",
          400,
        );
      await validateRegions(database, actor, id, regions);
      const oldAssets = [target.approvedAssetId, source.approvedAssetId].filter(
        (v): v is string => !!v,
      );
      if (oldAssets.length)
        await database
          .update(assets)
          .set({
            status: "delete_pending",
            nextCleanupAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              importAssetOwn(actor, id),
              inArray(assets.id, oldAssets),
              ne(assets.status, "promoted"),
            ),
          );
      await database
        .update(items)
        .set({
          regions,
          reviewed: false,
          reviewFingerprint: null,
          approvedAssetId: null,
          extractionStatus: "pending",
          extractRequested: false,
          revision: target.revision + 1,
          updatedAt: new Date(),
        })
        .where(importItemOwn(actor, id, target.id));
      await database
        .update(items)
        .set({
          excluded: true,
          reviewed: false,
          reviewFingerprint: null,
          approvedAssetId: null,
          extractionStatus: "pending",
          extractRequested: false,
          revision: source.revision + 1,
          updatedAt: new Date(),
        })
        .where(importItemOwn(actor, id, source.id));
      return {
        status: "queued",
        attempts: 0,
        nextAttemptAt: new Date(),
        pageDecisions: run.pageDecisions.filter(
          (p) => !regions.some((r) => r.assetId === p.assetId),
        ),
      };
    },
  );
}
export async function rereadMyDeskImportItem(
  actor: MyDeskActor,
  id: string,
  itemId: string,
  input: Mutation & { itemRevision: number },
) {
  return mutateImport(
    actor,
    id,
    input,
    `item.reread:${itemId}`,
    async (database, _current, run) => {
      assertImportOpen(run, ["review", "failed"]);
      const [item] = await database
        .select()
        .from(items)
        .where(importItemOwn(actor, id, itemId))
        .for("update");
      if (!item) throw importError("NOT_FOUND", "Form not found", 404);
      if (item.revision !== input.itemRevision)
        throw importError(
          "REVISION_CONFLICT",
          "This form changed. Reload it before reading it again",
        );
      if (item.excluded || !item.regions.length)
        throw importError("REGION_REQUIRED", "Choose a form region first");
      const quota = await chargeQuota(
        database,
        actor,
        run,
        new Set(item.regions.map((r) => r.assetId)).size,
      );
      if (item.approvedAssetId)
        await database
          .update(assets)
          .set({
            status: "delete_pending",
            nextCleanupAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              importAssetOwn(actor, id, item.approvedAssetId),
              ne(assets.status, "promoted"),
            ),
          );
      await database
        .update(items)
        .set({
          extractRequested: true,
          extractionStatus: "pending",
          approvedAssetId: null,
          reviewed: false,
          reviewFingerprint: null,
          revision: item.revision + 1,
          updatedAt: new Date(),
        })
        .where(importItemOwn(actor, id, itemId));
      return {
        status: "queued",
        ...quota,
        attempts: 0,
        nextAttemptAt: new Date(),
      };
    },
  );
}
/** Scrub drafts immediately; object deletion remains durable and independent of rollout/membership. */
export async function scrubMyDeskImport(
  database: MyDeskDatabase,
  actor: MyDeskActor,
  id: string,
) {
  await database
    .update(items)
    .set({
      regions: [],
      subjectNames: [],
      groupId: null,
      studentId: null,
      rosterRevision: null,
      category: "note",
      title: "",
      body: "",
      entryDate: null,
      warnings: [],
      reviewed: false,
      reviewFingerprint: null,
      approvedAssetId: null,
      extractRequested: false,
      updatedAt: new Date(),
    })
    .where(importItemOwn(actor, id));
  await database
    .update(assets)
    .set({
      status: "delete_pending",
      originalFilename: "",
      nextCleanupAt: new Date(),
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        importAssetOwn(actor, id),
        inArray(assets.status, ["pending", "uploading", "ready"]),
      ),
    );
  await database
    .update(assets)
    .set({
      originalFilename: "",
      inputSha256: null,
      width: null,
      height: null,
      updatedAt: new Date(),
    })
    .where(and(importAssetOwn(actor, id), eq(assets.status, "promoted")));
}
export async function cancelMyDeskImport(
  actor: MyDeskActor,
  id: string,
  input: Mutation,
) {
  return mutateImport(
    actor,
    id,
    input,
    "cancel",
    async (database, _current, run) => {
      if (run.status === "completed")
        throw importError("CLOSED", "This import has already been saved");
      if (importTerminal(run.status))
        throw importError("CLOSED", "This import has already finished");
      await scrubMyDeskImport(database, actor, id);
      return {
        status: "cancelled",
        selectedGroupIds: [],
        pageDecisions: [],
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: null,
        deletedAt: new Date(),
      };
    },
  );
}
export async function commitMyDeskImport(
  actor: MyDeskActor,
  id: string,
  input: z.infer<typeof importCommit>,
) {
  return withImportActor(actor, async (database, current) => {
    const run = await lockImport(database, actor, id),
      hash = importHash(input);
    if (run.commitReceipt) {
      if (
        run.commitReceipt.requestId !== input.requestId ||
        run.commitReceipt.fingerprint !== hash
      )
        throw importError(
          "REQUEST_CONFLICT",
          "This import was already saved with a different request",
        );
      return {
        import: await importDto(database, actor, run),
        receipt: { notes: run.commitReceipt.notes },
      };
    }
    if (run.revision !== input.revision)
      throw importError(
        "REVISION_CONFLICT",
        "This import changed. Reload it before saving",
      );
    assertImportOpen(run, ["review"]);
    const forms = await database
      .select()
      .from(items)
      .where(importItemOwn(actor, id))
      .orderBy(items.ordinal)
      .for("update");
    const included = forms.filter((i) => !i.excluded);
    if (
      !included.length ||
      included.length !== input.itemIds.length ||
      included.some((i) => !input.itemIds.includes(i.id) || !i.reviewed)
    )
      throw importError(
        "REVIEW_REQUIRED",
        "Review every included form and explicitly exclude all others before saving",
      );
    const pages = await database
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          importAssetOwn(actor, id),
          eq(assets.kind, "page"),
          eq(assets.status, "ready"),
        ),
      );
    if (
      !pages.length ||
      pages.length !== run.pageDecisions.length ||
      pages.some((p) => {
        const d = run.pageDecisions.find((d) => d.assetId === p.id);
        const used = included.some((i) =>
          i.regions.some((r) => r.assetId === p.id),
        );
        return !d || d.excluded === used;
      })
    )
      throw importError(
        "PAGES_UNACCOUNTED",
        "Confirm that every page is accounted for, including blank or excluded pages",
      );
    const rosters = new Map<
      string,
      Awaited<ReturnType<typeof loadMyDeskClassRoster>>
    >();
    for (const groupId of [
      ...new Set(
        included.map((i) => i.groupId).filter((s): s is string => !!s),
      ),
    ].sort())
      rosters.set(
        groupId,
        await loadMyDeskClassRoster(current, groupId, database, { lock: true }),
      );
    const notes: Array<{ itemId: string; noteId: string }> = [],
      now = new Date();
    for (const item of included) {
      const { asset, hash: expected } = await verifyReview(
        database,
        current,
        run,
        item,
      );
      if (item.reviewFingerprint !== expected)
        throw importError(
          "REVIEW_REQUIRED",
          "A form changed after review. Confirm it again",
        );
      const roster = rosters.get(item.groupId!)!,
        student = roster.students.find((s) => s.id === item.studentId)!;
      const noteId = randomUUID(),
        attachmentId = randomUUID();
      await database.insert(mydeskNotes).values({
        id: noteId,
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        clientRequestId: importUuid(`import-note:${id}:${item.id}`),
        requestFingerprint: importHash([id, item.id, expected]),
        targetKind: "student",
        groupId: item.groupId,
        filingGroupId: item.groupId,
        groupName: roster.class.name,
        studentId: item.studentId,
        filingStudentId: item.studentId,
        studentName: student.name,
        category: item.category,
        title: item.title,
        body: item.body,
        entryDate: item.entryDate!,
        status: "active",
        expiresAt: null,
      });
      await database.insert(mydeskAttachments).values({
        id: attachmentId,
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        noteId,
        clientRequestId: importUuid(`import-attachment:${id}:${item.id}`),
        requestFingerprint: importHash([id, item.id, asset.sha256]),
        storageKey: asset.storageKey,
        originalFilename:
          asset.contentType === "application/pdf"
            ? "approved-form.pdf"
            : "approved-form.jpg",
        contentType: asset.contentType,
        inputSha256: asset.sha256,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
        status: "ready",
        committedAt: now,
      });
      await database
        .update(assets)
        .set({
          status: "promoted",
          attachmentId,
          leaseId: null,
          leaseUntil: null,
          nextCleanupAt: null,
          updatedAt: now,
        })
        .where(
          and(importAssetOwn(actor, id, asset.id), eq(assets.status, "ready")),
        );
      await database
        .update(items)
        .set({ noteId, updatedAt: now })
        .where(importItemOwn(actor, id, item.id));
      notes.push({ itemId: item.id, noteId });
    }
    await scrubMyDeskImport(database, actor, id);
    const [finished] = await database
      .update(runs)
      .set({
        status: "completed",
        revision: run.revision + 1,
        commitReceipt: { requestId: input.requestId, fingerprint: hash, notes },
        selectedGroupIds: [],
        pageDecisions: [],
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(importOwn(actor, id))
      .returning();
    await importAudit(database, actor, id, "commit", {
      noteCount: notes.length,
    });
    return {
      import: await importDto(database, actor, finished!),
      receipt: { notes },
    };
  });
}
