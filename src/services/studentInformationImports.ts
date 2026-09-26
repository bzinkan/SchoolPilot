import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { schools } from "../schema/core.js";
import {
  studentInformationImports as runs,
  studentInformationImportAssets as assets,
  studentInformationImportItems as items,
} from "../schema/studentInformation.js";
import { mydeskImports } from "../schema/mydeskImports.js";
import {
  withSharedStudentRecords,
  assertSharedStudentActor,
  type SharedStudentActor,
  type SharedStudentIdentity,
} from "./sharedStudentRecords.js";
import type { MyDeskDatabase } from "./mydesk.js";
import {
  informationHash,
  informationAudit,
  loadContactProfile,
  applyContactChanges,
  saveContactChanges,
} from "./studentInformation.js";
import {
  informationCreate,
  informationMutation,
  informationReserve,
  informationProcess,
  informationItemUpdate,
  informationJoin,
  informationManualItem,
  informationError,
  requireInformationImport,
  INFORMATION_LIMITS,
} from "./studentInformationValidation.js";
import { myDeskImportLimits } from "./mydeskImportsValidation.js";
import {
  myDeskSha256,
  myDeskObjectStore,
  type MyDeskObjectStore,
} from "./mydeskFiles.js";
import {
  prepareImportSource,
  renderImportSource,
  myDeskImportModel,
} from "./mydeskImportProcessing.js";
import { parseInformationOffice } from "./studentInformationOffice.js";
import { createLocalDateFormatter } from "../util/schoolTime.js";

import { INFORMATION_PROMPT_VERSION } from "./studentInformationValidation.js";
export { INFORMATION_PROMPT_VERSION } from "./studentInformationValidation.js";
export const INFORMATION_LEASE_MS = 5 * 60_000;
export type InformationRun = typeof runs.$inferSelect;
export const informationRunOwn = (actor: SharedStudentActor, id: string) =>
  and(
    eq(runs.schoolId, actor.schoolId),
    eq(runs.authorId, actor.authorId),
    eq(runs.id, id),
  );
export const informationAssetOwn = (
  actor: SharedStudentActor,
  id: string,
  assetId?: string,
) =>
  and(
    eq(assets.schoolId, actor.schoolId),
    eq(assets.authorId, actor.authorId),
    eq(assets.importId, id),
    assetId ? eq(assets.id, assetId) : undefined,
  );
export const informationItemOwn = (
  actor: SharedStudentActor,
  id: string,
  itemId?: string,
) =>
  and(
    eq(items.schoolId, actor.schoolId),
    eq(items.authorId, actor.authorId),
    eq(items.importId, id),
    itemId ? eq(items.id, itemId) : undefined,
  );
export const informationTerminal = (run: InformationRun) =>
  ["completed", "cancelled", "expired"].includes(run.status);
export async function lockInformationRun(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  id: string,
  allowTerminal = false,
) {
  const [run] = await tx
    .select()
    .from(runs)
    .where(informationRunOwn(actor, id))
    .for("update");
  if (!run) throw informationError(404, "NOT_FOUND", "Import not found");
  if (
    !allowTerminal &&
    (informationTerminal(run) || run.expiresAt.getTime() <= Date.now())
  )
    throw informationError(409, "CLOSED", "This import is closed or expired");
  return run;
}
export function informationRetry(
  run: InformationRun,
  input: { requestId: string; revision: number },
  kind: string,
  payload: unknown,
) {
  const fingerprint = informationHash(payload),
    receipt = run.mutationReceipts.find((r) => r.id === input.requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || receipt.kind !== kind)
      throw informationError(
        409,
        "REQUEST_CONFLICT",
        "This request identifier was used for a different action",
      );
    return true;
  }
  if (run.revision !== input.revision)
    throw informationError(
      409,
      "REVISION_CONFLICT",
      "This import changed. Refresh before continuing",
    );
  return false;
}
export async function informationReceipt(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  run: InformationRun,
  input: { requestId: string },
  kind: string,
  payload: unknown,
  patch: Partial<typeof runs.$inferInsert> = {},
) {
  const revision = run.revision + 1;
  await tx
    .update(runs)
    .set({
      ...patch,
      revision,
      updatedAt: new Date(),
      mutationReceipts: [
        ...run.mutationReceipts,
        {
          id: input.requestId,
          fingerprint: informationHash(payload),
          kind,
          revision,
        },
      ].slice(-100),
    })
    .where(informationRunOwn(actor, run.id));
}
export async function informationDto(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  run: InformationRun,
) {
  const visible =
    !informationTerminal(run) && run.expiresAt.getTime() > Date.now();
  const sourceRows = visible
    ? await tx
        .select({
          id: assets.id,
          parentId: assets.parentId,
          inputSha256: assets.inputSha256,
          kind: assets.kind,
          status: assets.status,
          filename: assets.filename,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          label: assets.label,
          ordinal: assets.ordinal,
          units: assets.units,
          hidden: assets.hidden,
          warnings: assets.warnings,
          stats: assets.stats,
        })
        .from(assets)
        .where(
          and(
            informationAssetOwn(actor, run.id),
            inArray(assets.status, ["pending", "uploading", "ready"]),
          ),
        )
        .orderBy(assets.createdAt, assets.ordinal)
    : [];
  const itemRows = visible
    ? await tx
        .select({
          id: items.id,
          ordinal: items.ordinal,
          revision: items.revision,
          sourceSectionId: items.sourceSectionId,
          studentName: items.studentName,
          studentIdentifier: items.studentIdentifier,
          studentId: items.studentId,
          baseRevision: items.baseRevision,
          proposed: items.proposed,
          changes: items.changes,
          warnings: items.warnings,
          reviewed: items.reviewed,
          excluded: items.excluded,
        })
        .from(items)
        .where(informationItemOwn(actor, run.id))
        .orderBy(items.ordinal)
    : [];
  return {
    id: run.id,
    status: visible
      ? run.status
      : informationTerminal(run)
        ? run.status
        : "expired",
    revision: run.revision,
    expectedSourceCount: run.expectedSourceCount,
    selectedSectionIds: visible ? run.selectedSectionIds : [],
    units: run.units,
    expiresAt: run.expiresAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastErrorCode: run.lastErrorCode,
    assets: sourceRows,
    items: itemRows,
    receipt: await authorizedInformationReceipt(tx, actor, run),
  };
}
async function authorizedInformationReceipt(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  run: InformationRun,
) {
  if (!run.commitReceipt) return null;
  const identity = await assertSharedStudentActor(actor, tx);
  for (const saved of run.commitReceipt.profiles) {
    await loadContactProfile(tx, identity, saved.studentId, false, true);
  }
  return run.commitReceipt;
}
export const getInformationImport = (actor: SharedStudentActor, id: string) =>
  withSharedStudentRecords(actor, async (tx) =>
    informationDto(tx, actor, await lockInformationRun(tx, actor, id, true)),
  );
export const listInformationImports = (
  actor: SharedStudentActor,
  cursor?: string,
) =>
  withSharedStudentRecords(actor, async (tx) => {
    const rows = await tx
      .select({
        id: runs.id,
        status: runs.status,
        revision: runs.revision,
        createdAt: runs.createdAt,
        expiresAt: runs.expiresAt,
      })
      .from(runs)
      .where(
        and(
          eq(runs.schoolId, actor.schoolId),
          eq(runs.authorId, actor.authorId),
          cursor ? lt(runs.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(runs.id))
      .limit(31);
    return {
      imports: rows.slice(0, 30).map((r) => ({
        ...r,
        status:
          r.expiresAt.getTime() <= Date.now() &&
          !["completed", "cancelled"].includes(r.status)
            ? "expired"
            : r.status,
      })),
      nextCursor: rows.length > 30 ? rows[29]!.id : null,
    };
  });
export async function createInformationImport(
  actor: SharedStudentActor,
  raw: unknown,
) {
  requireInformationImport();
  const input = informationCreate.parse(raw),
    fingerprint = informationHash(input);
  return withSharedStudentRecords(actor, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`information-create:${actor.schoolId}:${actor.authorId}:${input.clientRequestId}`},0))`,
    );
    const [existing] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.schoolId, actor.schoolId),
          eq(runs.authorId, actor.authorId),
          eq(runs.clientRequestId, input.clientRequestId),
        ),
      );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw informationError(
          409,
          "REQUEST_CONFLICT",
          "This request identifier was used for a different import",
        );
      return { import: await informationDto(tx, actor, existing) };
    }
    const expiresAt = new Date(Date.now() + 24 * 3600_000);
    const [run] = await tx
      .insert(runs)
      .values({
        schoolId: actor.schoolId,
        authorId: actor.authorId,
        ...input,
        requestFingerprint: fingerprint,
        expiresAt,
        uploadExpiresAt: expiresAt,
      })
      .returning();
    informationAudit(actor, "import_created", [run!.id]);
    return { import: await informationDto(tx, actor, run!) };
  });
}
export async function reserveInformationAsset(
  actor: SharedStudentActor,
  id: string,
  raw: unknown,
) {
  requireInformationImport();
  const input = informationReserve.parse(raw),
    fingerprint = informationHash(input);
  return withSharedStudentRecords(actor, async (tx) => {
    const run = await lockInformationRun(tx, actor, id);
    const [existing] = await tx
      .select()
      .from(assets)
      .where(
        and(
          informationAssetOwn(actor, id),
          eq(assets.clientRequestId, input.clientRequestId),
        ),
      );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw informationError(
          409,
          "REQUEST_CONFLICT",
          "This file request has changed",
        );
      return { asset: { id: existing.id, status: existing.status } };
    }
    if (
      run.status !== "uploading" ||
      run.uploadExpiresAt.getTime() <= Date.now()
    )
      throw informationError(
        409,
        "UPLOAD_CLOSED",
        "The source upload window has ended",
      );
    const sources = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(informationAssetOwn(actor, id), eq(assets.kind, "source")));
    if (sources.length >= run.expectedSourceCount)
      throw informationError(
        422,
        "SOURCE_LIMIT",
        "All declared source files have been reserved",
      );
    const assetId = randomUUID();
    await tx.insert(assets).values({
      id: assetId,
      schoolId: actor.schoolId,
      authorId: actor.authorId,
      importId: id,
      clientRequestId: input.clientRequestId,
      requestFingerprint: fingerprint,
      kind: "source",
      filename: input.filename,
      contentType: input.contentType,
      inputSha256: input.sha256,
      byteSize: input.size,
      storageKey: `mydesk/${actor.schoolId}/${actor.authorId}/information/${id}/${assetId}`,
    });
    return { asset: { id: assetId, status: "pending" } };
  });
}
type PreparedSection = {
  label: string;
  bytes: Buffer;
  contentType: string;
  hidden: boolean;
  warnings: string[];
  units: number;
  stats: {
    pages: number;
    sheets: number;
    rows: number;
    columns: number;
    textBytes: number;
    sheetId?: string;
  };
};
async function prepareSource(
  bytes: Buffer,
  contentType: string,
): Promise<PreparedSection[]> {
  if (contentType === "application/pdf" || contentType.startsWith("image/")) {
    const prepared = await prepareImportSource(bytes, contentType),
      pages = await renderImportSource(prepared.bytes, prepared.contentType);
    return pages.map((p) => ({
      label: `Page ${p.pageNumber}`,
      bytes: p.bytes,
      contentType: "image/jpeg",
      hidden: false,
      warnings: [],
      units: 1,
      stats: { pages: 1, sheets: 0, rows: 0, columns: 0, textBytes: 0 },
    }));
  }
  const parsed = await parseInformationOffice(bytes, contentType);
  return parsed.sections.map((s) => {
    const sheet = s.sheet ? 1 : 0;
    return {
      label: s.label,
      bytes: Buffer.from(s.text),
      contentType: "text/plain",
      hidden: s.hidden,
      warnings: [...new Set([...parsed.warnings, ...s.warnings])],
      units: s.units,
      stats: {
        pages: 0,
        sheets: sheet,
        rows: s.rows,
        columns: s.columns,
        textBytes: Buffer.byteLength(s.text),
        ...(s.sheet ? { sheetId: s.sheet } : {}),
      },
    };
  });
}
export async function uploadInformationAsset(
  actor: SharedStudentActor,
  id: string,
  assetId: string,
  bytes: Buffer,
  contentType: string,
  store: MyDeskObjectStore = myDeskObjectStore,
) {
  requireInformationImport();
  const digest = myDeskSha256(bytes),
    leaseId = randomUUID();
  const claim = await withSharedStudentRecords(actor, async (tx) => {
    const run = await lockInformationRun(tx, actor, id);
    const [asset] = await tx
      .select()
      .from(assets)
      .where(informationAssetOwn(actor, id, assetId))
      .for("update");
    if (!asset || asset.kind !== "source")
      throw informationError(404, "NOT_FOUND", "Source not found");
    if (
      asset.contentType !== contentType ||
      asset.byteSize !== bytes.length ||
      asset.inputSha256 !== digest
    )
      throw informationError(
        409,
        "UPLOAD_CHANGED",
        "The uploaded bytes do not match the reserved file",
      );
    if (asset.status === "ready") return { asset, ready: true };
    if (
      run.status !== "uploading" ||
      run.uploadExpiresAt.getTime() <= Date.now() ||
      !["pending", "uploading"].includes(asset.status)
    )
      throw informationError(
        409,
        "UPLOAD_CLOSED",
        "The source upload window has ended",
      );
    if (asset.leaseUntil && asset.leaseUntil.getTime() > Date.now())
      throw informationError(
        409,
        "UPLOAD_BUSY",
        "This file upload is already in progress",
      );
    await tx
      .update(assets)
      .set({
        status: "uploading",
        leaseId,
        leaseUntil: new Date(Date.now() + INFORMATION_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(informationAssetOwn(actor, id, assetId));
    return { asset, ready: false };
  });
  if (claim.ready) return { asset: { id: assetId, status: "ready" } };
  const derivedIds: string[] = [];
  try {
    const sections = await prepareSource(bytes, contentType);
    const reserved = await withSharedStudentRecords(actor, async (tx) => {
      const run = await lockInformationRun(tx, actor, id);
      const [source] = await tx
        .select()
        .from(assets)
        .where(informationAssetOwn(actor, id, assetId))
        .for("update");
      if (
        run.status !== "uploading" ||
        source?.leaseId !== leaseId ||
        !source.leaseUntil ||
        source.leaseUntil.getTime() <= Date.now()
      )
        throw informationError(
          409,
          "UPLOAD_CLOSED",
          "This upload is no longer active",
        );
      const existing = await tx
        .select({ stats: assets.stats })
        .from(assets)
        .where(
          and(
            informationAssetOwn(actor, id),
            eq(assets.kind, "section"),
            eq(assets.status, "ready"),
          ),
        );
      const all = [
        ...existing.map((r) => r.stats),
        ...sections.map((s) => s.stats),
      ];
      const total = (key: "pages" | "sheets" | "rows" | "textBytes") =>
        all.reduce((n, s) => n + s[key], 0);
      if (
        total("pages") > 20 ||
        total("textBytes") > 1024 * 1024 ||
        all.some((s) => s.columns > 50) ||
        sections.length > 100
      )
        throw informationError(
          422,
          "SOURCE_LIMIT",
          "The packet exceeds the page, sheet, row, column, or text limit. Split it into smaller files",
        );
      const rows = sections.map((section, ordinal) => {
        const sectionId = randomUUID();
        derivedIds.push(sectionId);
        return {
          id: sectionId,
          schoolId: actor.schoolId,
          authorId: actor.authorId,
          importId: id,
          parentId: assetId,
          clientRequestId: randomUUID(),
          requestFingerprint: informationHash([assetId, leaseId, ordinal]),
          kind: "section" as const,
          status: "uploading" as const,
          storageKey: `mydesk/${actor.schoolId}/${actor.authorId}/information/${id}/${sectionId}`,
          filename: "",
          contentType: section.contentType,
          inputSha256: myDeskSha256(section.bytes),
          sha256: myDeskSha256(section.bytes),
          byteSize: section.bytes.length,
          label: section.label,
          ordinal,
          units: section.units,
          hidden: section.hidden,
          warnings: section.warnings,
          stats: section.stats,
          leaseId,
          leaseUntil: source.leaseUntil,
        };
      });
      await tx.insert(assets).values(rows);
      return rows;
    });
    await store.put(claim.asset.storageKey, bytes, contentType);
    for (let i = 0; i < reserved.length; i++) {
      await withSharedStudentRecords(actor, async (tx) => {
        const run = await lockInformationRun(tx, actor, id);
        const [source] = await tx
          .select({ leaseId: assets.leaseId, leaseUntil: assets.leaseUntil })
          .from(assets)
          .where(informationAssetOwn(actor, id, assetId));
        if (
          run.status !== "uploading" ||
          source?.leaseId !== leaseId ||
          !source.leaseUntil ||
          source.leaseUntil.getTime() <= Date.now()
        )
          throw informationError(
            409,
            "UPLOAD_CLOSED",
            "This upload is no longer active",
          );
      });
      await store.put(
        reserved[i]!.storageKey,
        sections[i]!.bytes,
        sections[i]!.contentType,
      );
    }
    await withSharedStudentRecords(actor, async (tx) => {
      const run = await lockInformationRun(tx, actor, id);
      const [source] = await tx
        .select()
        .from(assets)
        .where(informationAssetOwn(actor, id, assetId))
        .for("update");
      if (
        run.status !== "uploading" ||
        source?.leaseId !== leaseId ||
        !source.leaseUntil ||
        source.leaseUntil.getTime() <= Date.now()
      )
        throw informationError(
          409,
          "UPLOAD_CLOSED",
          "This upload is no longer active",
        );
      await tx
        .update(assets)
        .set({
          status: "ready",
          sha256: digest,
          leaseId: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(informationAssetOwn(actor, id, assetId));
      await tx
        .update(assets)
        .set({
          status: "ready",
          leaseId: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            informationAssetOwn(actor, id),
            inArray(assets.id, derivedIds),
            eq(assets.leaseId, leaseId),
          ),
        );
      const sources = await tx
        .select({ status: assets.status })
        .from(assets)
        .where(and(informationAssetOwn(actor, id), eq(assets.kind, "source")));
      if (
        sources.length === run.expectedSourceCount &&
        sources.every((s) => s.status === "ready") &&
        run.expiresAt.getTime() === run.uploadExpiresAt.getTime()
      )
        await tx
          .update(runs)
          .set({
            expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
            updatedAt: new Date(),
          })
          .where(informationRunOwn(actor, id));
    });
    return { asset: { id: assetId, status: "ready" } };
  } catch (error) {
    // Cleanup owns all keys before any PUT; preserve leases so late writes cannot
    // escape cancellation. A failed source may be retried with identical bytes.
    await withSharedStudentRecords(actor, async (tx) => {
      const run = await lockInformationRun(tx, actor, id, true);
      await tx
        .update(assets)
        .set({
          status: "delete_pending",
          nextCleanupAt: new Date(Date.now() + INFORMATION_LEASE_MS),
        })
        .where(
          and(informationAssetOwn(actor, id), inArray(assets.id, derivedIds)),
        );
      if (!informationTerminal(run))
        await tx
          .update(assets)
          .set({ status: "pending", leaseId: null, leaseUntil: null })
          .where(
            and(
              informationAssetOwn(actor, id, assetId),
              eq(assets.leaseId, leaseId),
            ),
          );
    }).catch(() => {
      /* Expiry worker owns the persisted upload lease. */
    });
    throw error;
  }
}
export async function readInformationAsset(
  actor: SharedStudentActor,
  id: string,
  assetId: string,
  store: MyDeskObjectStore = myDeskObjectStore,
) {
  const check = () =>
    withSharedStudentRecords(actor, async (tx) => {
      await lockInformationRun(tx, actor, id);
      const [asset] = await tx
        .select()
        .from(assets)
        .where(
          and(
            informationAssetOwn(actor, id, assetId),
            eq(assets.status, "ready"),
          ),
        );
      if (!asset) throw informationError(404, "NOT_FOUND", "Source not found");
      return asset;
    });
  const asset = await check(),
    bytes = await store.get(asset.storageKey);
  await check();
  if (myDeskSha256(bytes) !== asset.sha256)
    throw informationError(
      503,
      "SOURCE_UNAVAILABLE",
      "Source preview is temporarily unavailable",
    );
  return { bytes, contentType: asset.contentType };
}
export async function informationQuotaTotals(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  date: string,
) {
  const usage = sql<number>`(SELECT coalesce(sum((entry->>'pages')::int),0) FROM jsonb_array_elements(${runs.quotaUsage}) entry WHERE entry->>'date'=${date})`;
  const [totals] = await tx
    .select({
      school: sql<number>`coalesce(sum(${usage}),0)::int`,
      author: sql<number>`coalesce(sum(CASE WHEN ${runs.authorId}=${actor.authorId} THEN ${usage} ELSE 0 END),0)::int`,
    })
    .from(runs)
    .where(eq(runs.schoolId, actor.schoolId));
  return totals ?? { school: 0, author: 0 };
}
async function chargeInformationQuota(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  run: InformationRun,
  units: number,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mydesk-import-quota:${actor.schoolId}`},0))`,
  );
  const [school] = await tx
    .select({ timezone: schools.schoolTimezone })
    .from(schools)
    .where(eq(schools.id, actor.schoolId));
  const date = createLocalDateFormatter(school?.timezone)(new Date()),
    limits = myDeskImportLimits();
  const usage = sql<number>`(SELECT coalesce(sum((entry->>'pages')::int),0) FROM jsonb_array_elements(${mydeskImports.quotaUsage}) entry WHERE entry->>'date'=${date})`;
  const [paperwork] = await tx
    .select({
      school: sql<number>`coalesce(sum(${usage}),0)::int`,
      author: sql<number>`coalesce(sum(CASE WHEN ${mydeskImports.authorId}=${actor.authorId} THEN ${usage} ELSE 0 END),0)::int`,
    })
    .from(mydeskImports)
    .where(eq(mydeskImports.schoolId, actor.schoolId));
  const information = await informationQuotaTotals(tx, actor, date);
  if (
    (paperwork?.school ?? 0) + information.school + units >
      limits.schoolDailyPages ||
    (paperwork?.author ?? 0) + information.author + units >
      limits.teacherDailyPages
  )
    throw informationError(
      429,
      "DAILY_LIMIT",
      "The shared daily import allowance has been reached. Try again tomorrow",
    );
  const ledger = structuredClone(run.quotaUsage),
    today = ledger.find((e) => e.date === date);
  if (today) today.pages += units;
  else ledger.push({ date, pages: units });
  if (ledger.length > 8)
    throw informationError(409, "CLOSED", "This review window has ended");
  return ledger;
}
export async function processInformationImport(
  actor: SharedStudentActor,
  id: string,
  raw: unknown,
) {
  requireInformationImport();
  const input = informationProcess.parse(raw);
  return withSharedStudentRecords(actor, async (tx) => {
    const run = await lockInformationRun(tx, actor, id);
    if (informationRetry(run, input, "process", input))
      return { import: await informationDto(tx, actor, run) };
    if (
      !["uploading", "failed"].includes(run.status) ||
      run.selectedSectionIds.length
    )
      throw informationError(
        409,
        "PROCESS_STARTED",
        "This import already has a source selection",
      );
    const sources = await tx
      .select({ status: assets.status })
      .from(assets)
      .where(and(informationAssetOwn(actor, id), eq(assets.kind, "source")));
    if (
      sources.length !== run.expectedSourceCount ||
      sources.some((s) => s.status !== "ready")
    )
      throw informationError(
        409,
        "UPLOAD_INCOMPLETE",
        "Finish all declared uploads before processing",
      );
    const selected = await tx
      .select()
      .from(assets)
      .where(
        and(
          informationAssetOwn(actor, id),
          eq(assets.kind, "section"),
          eq(assets.status, "ready"),
          inArray(assets.id, input.sectionIds),
        ),
      );
    if (selected.length !== input.sectionIds.length)
      throw informationError(
        400,
        "SELECTION_INVALID",
        "Select each source section once",
      );
    if (selected.some((s) => s.warnings.length) && !input.acknowledgedWarnings)
      throw informationError(
        400,
        "WARNINGS_REQUIRED",
        "Review and acknowledge unsupported source content before processing",
      );
    const selectedSheets = new Set(
      selected
        .filter((s) => s.stats.sheets > 0)
        .map((s) => s.parentId + ":" + (s.stats.sheetId ?? s.id)),
    );
    if (
      selectedSheets.size > 5 ||
      selected.reduce((n, s) => n + s.stats.rows, 0) > 500
    )
      throw informationError(
        422,
        "SOURCE_LIMIT",
        "Select at most five sheets and 500 rows",
      );
    const units = selected.reduce((n, s) => n + s.units, 0);
    if (units > 20)
      throw informationError(
        422,
        "UNIT_LIMIT",
        "Select at most 20 import units",
      );
    const quotaUsage = await chargeInformationQuota(tx, actor, run, units);
    await informationReceipt(tx, actor, run, input, "process", input, {
      status: "queued",
      selectedSectionIds: input.sectionIds,
      units,
      quotaUsage,
      modelVersion: myDeskImportModel(),
      promptVersion: INFORMATION_PROMPT_VERSION,
      attempts: 0,
      nextAttemptAt: new Date(),
    });
    informationAudit(actor, "import_processing", [id], units);
    return {
      import: await informationDto(
        tx,
        actor,
        await lockInformationRun(tx, actor, id),
      ),
    };
  });
}
export async function updateInformationItem(
  actor: SharedStudentActor,
  id: string,
  itemId: string,
  raw: unknown,
) {
  const input = informationItemUpdate.parse(raw);
  return withSharedStudentRecords(
    actor,
    async (tx, identity) => {
      const run = await lockInformationRun(tx, actor, id);
      if (informationRetry(run, input, "review", [itemId, input]))
        return { import: await informationDto(tx, actor, run) };
      if (run.status !== "review")
        throw informationError(
          409,
          "NOT_READY",
          "Wait for processing to finish",
        );
      const [item] = await tx
        .select()
        .from(items)
        .where(informationItemOwn(actor, id, itemId))
        .for("update");
      if (!item)
        throw informationError(404, "NOT_FOUND", "Profile draft not found");
      if (item.revision !== input.itemRevision)
        throw informationError(
          409,
          "REVISION_CONFLICT",
          "This draft changed. Refresh before reviewing",
        );
      if (input.reviewed && !input.excluded) {
        if (!input.studentId || !input.resolvedWarnings)
          throw informationError(
            400,
            "REVIEW_REQUIRED",
            "Select the student and resolve every uncertain contact field",
          );
        const { profile } = await loadContactProfile(
          tx,
          identity,
          input.studentId,
          true,
        );
        if ((profile?.revision ?? 0) !== input.baseRevision)
          throw informationError(
            409,
            "PROFILE_CHANGED",
            "The current profile changed. Review its latest values",
          );
        applyContactChanges(profile?.data ?? { contacts: [] }, input.changes);
      }
      const decision = {
        studentId: input.studentId,
        baseRevision: input.baseRevision,
        changes: input.changes,
        reviewed: input.reviewed && !input.excluded,
        excluded: input.excluded,
      };
      await tx
        .update(items)
        .set({
          ...decision,
          reviewFingerprint: decision.reviewed
            ? informationHash([decision, item.proposed, item.sourceSectionId])
            : null,
          revision: item.revision + 1,
          updatedAt: new Date(),
        })
        .where(informationItemOwn(actor, id, itemId));
      await informationReceipt(tx, actor, run, input, "review", [
        itemId,
        input,
      ]);
      informationAudit(actor, "import_reviewed", [id, itemId]);
      return {
        import: await informationDto(
          tx,
          actor,
          await lockInformationRun(tx, actor, id),
        ),
      };
    },
    { lifecycle: true },
  );
}
export async function joinInformationItems(
  actor: SharedStudentActor,
  id: string,
  itemId: string,
  raw: unknown,
) {
  const input = informationJoin.parse(raw);
  return withSharedStudentRecords(actor, async (tx) => {
    const run = await lockInformationRun(tx, actor, id);
    if (informationRetry(run, input, "join", [itemId, input]))
      return { import: await informationDto(tx, actor, run) };
    if (run.status !== "review" || input.sourceItemId === itemId)
      throw informationError(
        409,
        "NOT_READY",
        "Choose another profile draft to combine",
      );
    const selected = await tx
      .select()
      .from(items)
      .where(
        and(
          informationItemOwn(actor, id),
          inArray(items.id, [itemId, input.sourceItemId]),
        ),
      )
      .orderBy(items.id)
      .for("update");
    const target = selected.find((i) => i.id === itemId),
      source = selected.find((i) => i.id === input.sourceItemId);
    if (!target || !source)
      throw informationError(404, "NOT_FOUND", "Profile draft not found");
    if (
      target.revision !== input.itemRevision ||
      source.revision !== input.sourceItemRevision ||
      target.excluded ||
      source.excluded
    )
      throw informationError(
        409,
        "REVISION_CONFLICT",
        "These drafts changed. Refresh before combining",
      );
    const contacts = [...target.proposed.contacts, ...source.proposed.contacts];
    if (contacts.length > 20)
      throw informationError(
        422,
        "CONTACT_LIMIT",
        "A profile can include at most 20 contacts",
      );
    await tx
      .update(items)
      .set({
        proposed: { contacts },
        changes: [],
        reviewed: false,
        reviewFingerprint: null,
        warnings: [
          ...new Set([
            ...target.warnings,
            ...source.warnings,
            "combined_sources_require_review",
          ]),
        ],
        revision: target.revision + 1,
        updatedAt: new Date(),
      })
      .where(informationItemOwn(actor, id, itemId));
    await tx
      .update(items)
      .set({
        excluded: true,
        reviewed: false,
        reviewFingerprint: null,
        changes: [],
        revision: source.revision + 1,
        updatedAt: new Date(),
      })
      .where(informationItemOwn(actor, id, source.id));
    await informationReceipt(tx, actor, run, input, "join", [itemId, input]);
    return {
      import: await informationDto(
        tx,
        actor,
        await lockInformationRun(tx, actor, id),
      ),
    };
  });
}
export async function addInformationItem(
  actor: SharedStudentActor,
  id: string,
  raw: unknown,
) {
  const input = informationManualItem.parse(raw);
  return withSharedStudentRecords(
    actor,
    async (tx, identity) => {
      const run = await lockInformationRun(tx, actor, id);
      if (informationRetry(run, input, "manual-item", input))
        return { import: await informationDto(tx, actor, run) };
      if (
        run.status !== "review" ||
        !run.selectedSectionIds.includes(input.sourceSectionId)
      )
        throw informationError(
          409,
          "NOT_READY",
          "Choose a selected source from this completed review",
        );
      const existing = await tx
        .select({ id: items.id })
        .from(items)
        .where(informationItemOwn(actor, id));
      if (existing.length >= 500)
        throw informationError(
          422,
          "PROFILE_LIMIT",
          "An import can contain at most 500 profiles",
        );
      const { student, profile } = await loadContactProfile(
        tx,
        identity,
        input.studentId,
        true,
      );
      await tx
        .insert(items)
        .values({
          schoolId: actor.schoolId,
          authorId: actor.authorId,
          importId: id,
          ordinal: existing.length,
          sourceSectionId: input.sourceSectionId,
          studentName: student.name.slice(0, 200),
          studentId: student.id,
          baseRevision: profile?.revision ?? 0,
          proposed: { contacts: [] },
          warnings: ["manually_added_requires_review"],
        });
      await informationReceipt(tx, actor, run, input, "manual-item", input);
      return {
        import: await informationDto(
          tx,
          actor,
          await lockInformationRun(tx, actor, id),
        ),
      };
    },
    { lifecycle: true },
  );
}
export async function scrubInformationImport(
  tx: MyDeskDatabase,
  actor: SharedStudentActor,
  run: InformationRun,
  status: "completed" | "cancelled" | "expired",
) {
  await tx
    .update(items)
    .set({
      studentName: "",
      studentIdentifier: null,
      studentId: null,
      proposed: { contacts: [] },
      changes: [],
      warnings: [],
      reviewed: false,
      excluded: true,
      reviewFingerprint: null,
      updatedAt: new Date(),
    })
    .where(informationItemOwn(actor, run.id));
  await tx
    .update(assets)
    .set({
      status: "delete_pending",
      filename: "",
      label: "",
      warnings: [],
      nextCleanupAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(informationAssetOwn(actor, run.id), sql`${assets.status}<>'deleted'`),
    );
  await tx
    .update(runs)
    .set({
      status,
      selectedSectionIds: [],
      leaseId: null,
      leaseUntil: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    })
    .where(informationRunOwn(actor, run.id));
}
export async function commitInformationImport(
  actor: SharedStudentActor,
  id: string,
  raw: unknown,
) {
  const input = informationMutation.parse(raw);
  return withSharedStudentRecords(
    actor,
    async (tx, identity) => {
      const run = await lockInformationRun(tx, actor, id, true);
      if (run.commitReceipt) {
        if (
          run.commitReceipt.requestId !== input.requestId ||
          run.commitReceipt.fingerprint !== informationHash(input)
        )
          throw informationError(
            409,
            "CLOSED",
            "This import was already saved",
          );
        return {
          receipt: (await authorizedInformationReceipt(tx, identity, run))!,
        };
      }
      if (run.status !== "review" || run.expiresAt.getTime() <= Date.now())
        throw informationError(409, "NOT_READY", "This import cannot be saved");
      informationRetry(run, input, "commit", input);
      const drafts = await tx
        .select()
        .from(items)
        .where(informationItemOwn(actor, id))
        .orderBy(items.studentId, items.id)
        .for("update");
      if (!drafts.length || drafts.some((d) => !d.excluded && !d.reviewed))
        throw informationError(
          400,
          "REVIEW_REQUIRED",
          "Review or explicitly exclude every profile before saving together",
        );
      const included = drafts.filter((d) => !d.excluded);
      if (!included.length)
        throw informationError(
          400,
          "REVIEW_REQUIRED",
          "Include at least one reviewed profile",
        );
      if (new Set(included.map((d) => d.studentId)).size !== included.length)
        throw informationError(
          400,
          "DUPLICATE_STUDENT",
          "Combine changes for each student into one draft before saving",
        );
      const saved = [];
      for (const item of included) {
        const decision = {
          studentId: item.studentId,
          baseRevision: item.baseRevision,
          changes: item.changes,
          reviewed: item.reviewed,
          excluded: item.excluded,
        };
        if (
          !item.studentId ||
          item.reviewFingerprint !==
            informationHash([decision, item.proposed, item.sourceSectionId])
        )
          throw informationError(
            409,
            "REVIEW_CHANGED",
            "Review this profile again before saving",
          );
        const result = await saveContactChanges(
          tx,
          identity,
          item.studentId,
          {
            requestId: item.id,
            revision: item.baseRevision,
            changes: item.changes,
            reason: "Reviewed student information import",
          },
          id,
        );
        saved.push({
          itemId: item.id,
          studentId: item.studentId,
          revision: result.profile!.revision,
        });
      }
      const receipt = {
        requestId: input.requestId,
        fingerprint: informationHash(input),
        profiles: saved,
      };
      await informationReceipt(tx, actor, run, input, "commit", input, {
        commitReceipt: receipt,
      });
      await scrubInformationImport(tx, actor, run, "completed");
      informationAudit(actor, "import_committed", [id], saved.length);
      return { receipt };
    },
    { lifecycle: true },
  );
}
export async function cancelInformationImport(
  actor: SharedStudentActor,
  id: string,
  raw: unknown,
) {
  const input = informationMutation.parse(raw);
  return withSharedStudentRecords(actor, async (tx) => {
    const run = await lockInformationRun(tx, actor, id, true);
    if (informationRetry(run, input, "cancel", input)) return { ok: true };
    if (informationTerminal(run))
      throw informationError(409, "CLOSED", "This import is closed");
    await informationReceipt(tx, actor, run, input, "cancel", input);
    await scrubInformationImport(tx, actor, run, "cancelled");
    informationAudit(actor, "import_cancelled", [id]);
    return { ok: true };
  });
}
