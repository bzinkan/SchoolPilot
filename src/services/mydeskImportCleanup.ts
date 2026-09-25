import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  mydeskImports as runs,
  mydeskImportAssets as assets,
} from "../schema/mydeskImports.js";
import { schedulerDb } from "./schedulerDb.js";
import { myDeskObjectStore, type MyDeskObjectStore } from "./mydeskFiles.js";
import {
  importOwn,
  importAssetOwn,
  importTerminal,
  lockImport,
  scrubMyDeskImport,
} from "./mydeskImports.js";
/** Cleanup is deliberately independent of AI rollout, license, and staff membership. */
export async function cleanupMyDeskImports(
  options: {
    database?: typeof schedulerDb;
    store?: MyDeskObjectStore;
    now?: Date;
    limit?: number;
  } = {},
) {
  const database = options.database ?? schedulerDb,
    store = options.store ?? myDeskObjectStore,
    now = options.now ?? new Date(),
    limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const expired = await database
    .select({ id: runs.id, schoolId: runs.schoolId, authorId: runs.authorId })
    .from(runs)
    .where(
      and(
        inArray(runs.status, [
          "uploading",
          "queued",
          "processing",
          "review",
          "failed",
        ]),
        lte(runs.expiresAt, now),
      ),
    )
    .limit(limit);
  for (const owner of expired)
    await database.transaction(async (tx) => {
      const actor = { ...owner, manager: false },
        run = await lockImport(tx, actor, owner.id);
      if (importTerminal(run.status) || run.expiresAt > now) return;
      await scrubMyDeskImport(tx, actor, owner.id);
      await tx
        .update(runs)
        .set({
          status: "expired",
          selectedGroupIds: [],
          pageDecisions: [],
          leaseId: null,
          leaseUntil: null,
          revision: run.revision + 1,
          deletedAt: now,
          updatedAt: now,
          lastErrorCode: null,
        })
        .where(importOwn(actor, owner.id));
    });
  const due = await database
    .select({
      id: assets.id,
      importId: assets.importId,
      schoolId: assets.schoolId,
      authorId: assets.authorId,
    })
    .from(assets)
    .where(
      and(
        inArray(assets.status, ["delete_pending", "deleted"]),
        or(isNull(assets.nextCleanupAt), lte(assets.nextCleanupAt, now)),
        or(
          isNull(assets.leaseUntil),
          lte(assets.leaseUntil, new Date(now.getTime() - 60_000)),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${assets.status}='delete_pending' THEN 0 ELSE 1 END`,
      sql`${assets.nextCleanupAt} ASC NULLS FIRST`,
      assets.id,
    )
    .limit(limit);
  let deleted = 0;
  for (const owner of due) {
    const actor = { ...owner, manager: false };
    // Recheck and claim before network I/O. Promotion never accepts delete_pending, eliminating the delete/promote race.
    const asset = await database.transaction(async (tx) => {
      await lockImport(tx, actor, owner.importId);
      const [row] = await tx
        .select()
        .from(assets)
        .where(importAssetOwn(actor, owner.importId, owner.id))
        .for("update");
      if (
        !row ||
        !["delete_pending", "deleted"].includes(row.status) ||
        (row.leaseUntil && row.leaseUntil.getTime() > now.getTime() - 60_000)
      )
        return null;
      await tx
        .update(assets)
        .set({
          status: "delete_pending",
          nextCleanupAt: new Date(now.getTime() + 5 * 60_000),
        })
        .where(importAssetOwn(actor, owner.importId, owner.id));
      return row;
    });
    if (!asset) continue;
    try {
      await store.delete(asset.storageKey);
      await database
        .update(assets)
        .set({
          status: "deleted",
          originalFilename: "",
          contentType: null,
          inputSha256: null,
          sha256: null,
          byteSize: null,
          width: null,
          height: null,
          pageCount: null,
          leaseId: null,
          leaseUntil: null,
          nextCleanupAt: new Date(now.getTime() + 24 * 3600_000),
          cleanupAttempts: 0,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            importAssetOwn(actor, owner.importId, owner.id),
            eq(assets.status, "delete_pending"),
          ),
        );
      deleted++;
    } catch {
      await database
        .update(assets)
        .set({
          cleanupAttempts: sql`${assets.cleanupAttempts}+1`,
          lastErrorCode: "OBJECT_DELETE_FAILED",
          nextCleanupAt: new Date(
            now.getTime() +
              Math.min(
                24 * 3600_000,
                60_000 * 2 ** Math.min(asset.cleanupAttempts, 10),
              ),
          ),
          updatedAt: now,
        })
        .where(
          and(
            importAssetOwn(actor, owner.importId, owner.id),
            eq(assets.status, "delete_pending"),
          ),
        );
    }
  }
  return { expired: expired.length, deleted };
}
