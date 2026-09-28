import { and, eq, inArray, sql } from "drizzle-orm";
import { mydeskImports as runs, mydeskImportAssets as assets, mydeskImportItems as items, type MyDeskImport } from "../schema/mydeskImports.js";
import type { MyDeskActor, MyDeskDatabase } from "./mydesk.js";

export type ImportProgressCounts = { pagesPrepared: number; pagesChecked: number; formsFound: number; formsReady: number; formsReviewed: number };
export type ProgressRun = Pick<MyDeskImport, "status" | "pageCount" | "attempts" | "lastErrorCode" | "nextAttemptAt" | "expiresAt" | "processingVersion">;

/** Counts describe durable work, never elapsed-time guesses or provider output. */
export function importProgress(run: ProgressRun, counts: ImportProgressCounts, now = new Date()) {
  const status = !["completed", "cancelled", "expired"].includes(run.status) && run.expiresAt <= now ? "expired" : run.status;
  const terminal = ["completed", "cancelled", "expired"].includes(status);
  const detectionComplete = run.pageCount > 0 && counts.pagesChecked === run.pageCount;
  const retryAt = status === "queued" && run.nextAttemptAt && run.nextAttemptAt > now ? run.nextAttemptAt : null;
  const phase = terminal ? status : status === "uploading" ? "uploading" : status === "failed" ? "needs_attention"
    : status === "review" ? "ready" : retryAt ? "retrying" : status === "queued" ? "waiting"
      : counts.pagesPrepared < run.pageCount ? "preparing_pages" : !detectionComplete ? "checking_forms" : "preparing_previews";
  return {
    phase, pagesTotal: run.pageCount, ...counts, detectionComplete, retryAt,
    canRetry: status === "failed" && run.attempts < 3 && !["ATTEMPTS_EXHAUSTED", "MYDESK_IMPORT_ATTEMPTS_EXHAUSTED"].includes(run.lastErrorCode || ""),
    actions: {
      reviewFields: !terminal && counts.formsReady > 0 && (["review", "failed"].includes(status) || run.processingVersion === 2 && ["queued", "processing"].includes(status)),
      editGeometry: ["review", "failed"].includes(status),
      publish: status === "review" && detectionComplete,
    },
  };
}

export async function importProgressCounts(database: MyDeskDatabase, actor: MyDeskActor, ids: string[]) {
  if (!ids.length) return new Map<string, ImportProgressCounts>();
  // Correlated aggregates stay inside a single owner-scoped statement, regardless of list length.
  const rows = await database.select({
    id: runs.id,
    pagesPrepared: sql<number>`(select count(*)::int from ${assets} where ${assets.schoolId}=${runs.schoolId} and ${assets.authorId}=${runs.authorId} and ${assets.importId}=${runs.id} and ${assets.kind}='page' and ${assets.status}='ready')`,
    pagesChecked: sql<number>`(select count(*)::int from ${assets} where ${assets.schoolId}=${runs.schoolId} and ${assets.authorId}=${runs.authorId} and ${assets.importId}=${runs.id} and ${assets.kind}='page' and ${assets.status}='ready' and ${assets.processedAt} is not null)`,
    formsFound: sql<number>`(select count(*)::int from ${items} where ${items.schoolId}=${runs.schoolId} and ${items.authorId}=${runs.authorId} and ${items.importId}=${runs.id})`,
    formsReady: sql<number>`(select count(*)::int from ${items} where ${items.schoolId}=${runs.schoolId} and ${items.authorId}=${runs.authorId} and ${items.importId}=${runs.id} and not ${items.excluded} and ${items.extractionStatus}='ready' and ${items.approvedAssetId} is not null)`,
    formsReviewed: sql<number>`(select count(*)::int from ${items} where ${items.schoolId}=${runs.schoolId} and ${items.authorId}=${runs.authorId} and ${items.importId}=${runs.id} and not ${items.excluded} and ${items.reviewed})`,
  }).from(runs).where(and(eq(runs.schoolId, actor.schoolId), eq(runs.authorId, actor.authorId), inArray(runs.id, ids)));
  return new Map(rows.map(({ id, ...counts }) => [id, counts]));
}

export const emptyImportProgressCounts: ImportProgressCounts = { pagesPrepared: 0, pagesChecked: 0, formsFound: 0, formsReady: 0, formsReviewed: 0 };
