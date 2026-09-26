import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  studentInformationImports as runs,
  studentInformationImportAssets as assets,
  studentInformationImportItems as items,
  studentContactProfiles as profiles,
} from "../schema/studentInformation.js";
import { mydeskImports } from "../schema/mydeskImports.js";
import { students } from "../schema/students.js";
import { schoolMemberships } from "../schema/core.js";
import { schedulerDb } from "./schedulerDb.js";
import { classpilotEntitledSchoolPredicate } from "./classpilotEntitlement.js";
import {
  withSharedStudentRecords,
  sharedStudentWhere,
  type SharedStudentActor,
} from "./sharedStudentRecords.js";
import {
  informationRunOwn,
  informationAssetOwn,
  informationItemOwn,
  lockInformationRun,
  INFORMATION_LEASE_MS,
  INFORMATION_PROMPT_VERSION,
  scrubInformationImport,
  type InformationRun,
} from "./studentInformationImports.js";
import {
  emptyContactFields,
  extractionSchema,
  informationError,
  studentInformationImportEnabled,
} from "./studentInformationValidation.js";
import {
  createInformationExtractor,
  type InformationExtractor,
} from "./studentInformationProcessing.js";
import {
  myDeskObjectStore,
  myDeskSha256,
  type MyDeskObjectStore,
} from "./mydeskFiles.js";
import { informationHash } from "./studentInformation.js";
type Options = {
  database?: typeof schedulerDb;
  store?: MyDeskObjectStore;
  extractor?: InformationExtractor;
  now?: Date;
};
const normalized = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
export async function processStudentInformationClaim(
  claim: InformationRun,
  options: Options = {},
) {
  const actor = { schoolId: claim.schoolId, authorId: claim.authorId },
    leaseId = claim.leaseId,
    store = options.store ?? myDeskObjectStore;
  const fenced = <T>(
    fn: (
      tx: Parameters<Parameters<typeof withSharedStudentRecords<T>>[1]>[0],
      run: InformationRun,
      identity: Parameters<
        Parameters<typeof withSharedStudentRecords<T>>[1]
      >[1],
    ) => Promise<T>,
  ) =>
    withSharedStudentRecords(actor, async (tx, identity) => {
      if (!studentInformationImportEnabled())
        throw informationError(
          409,
          "JOB_CANCELLED",
          "Import processing is disabled",
        );
      const run = await lockInformationRun(tx, actor, claim.id);
      if (
        run.status !== "processing" ||
        run.leaseId !== leaseId ||
        !run.leaseUntil ||
        run.leaseUntil.getTime() <= Date.now()
      )
        throw informationError(
          409,
          "JOB_CANCELLED",
          "This import is no longer processing",
        );
      await tx
        .update(runs)
        .set({ leaseUntil: new Date(Date.now() + INFORMATION_LEASE_MS) })
        .where(informationRunOwn(actor, run.id));
      return fn(tx, run, identity);
    });
  try {
    if (
      claim.promptVersion !== INFORMATION_PROMPT_VERSION ||
      !claim.modelVersion
    )
      throw informationError(
        503,
        "PROMPT_UNAVAILABLE",
        "This import version is unavailable",
      );
    const extract =
      options.extractor ??
      createInformationExtractor({
        model: claim.modelVersion,
        promptVersion: claim.promptVersion,
      });
    const selected = await fenced((tx) =>
      tx
        .select()
        .from(assets)
        .where(
          and(
            informationAssetOwn(actor, claim.id),
            eq(assets.status, "ready"),
            inArray(assets.id, claim.selectedSectionIds),
          ),
        )
        .orderBy(assets.id),
    );
    if (selected.length !== claim.selectedSectionIds.length)
      throw informationError(
        409,
        "SOURCE_CHANGED",
        "A selected source is no longer available",
      );
    const stages: Array<typeof selected> = [];
    for (const section of selected) {
      const group =
        section.contentType === "text/plain"
          ? stages.find(
              (parts) =>
                parts[0]?.contentType === "text/plain" &&
                parts[0]?.parentId === section.parentId,
            )
          : undefined;
      if (group) group.push(section);
      else stages.push([section]);
    }
    for (const stage of stages) {
      const section = stage[0]!;
      if (stage.every((part) => part.processedAt)) continue;
      if (stage.some((part) => part.processedAt))
        throw informationError(
          409,
          "SOURCE_CHANGED",
          "A source stage was only partially completed",
        );
      await fenced(async (tx, run) => {
        if (run.attempts >= 3)
          throw informationError(
            409,
            "ATTEMPTS_EXHAUSTED",
            "This source reached its retry limit",
          );
        await tx
          .update(runs)
          .set({ attempts: run.attempts + 1 })
          .where(informationRunOwn(actor, claim.id));
      });
      const buffers: Buffer[] = [];
      for (const part of stage) {
        const data = await store.get(part.storageKey);
        if (myDeskSha256(data) !== part.sha256)
          throw informationError(
            409,
            "SOURCE_CHANGED",
            "A selected source changed",
          );
        buffers.push(data);
      }
      const bytes =
        stage.length === 1
          ? buffers[0]!
          : Buffer.from(
              buffers
                .map(
                  (part, index) =>
                    `Selected section ${index + 1}:\n${part.toString("utf8")}`,
                )
                .join("\n\n"),
            );
      if (section.contentType === "text/plain" && bytes.length > 1048576)
        throw informationError(
          422,
          "SOURCE_LIMIT",
          "Selected source text exceeds the import limit",
        );
      await fenced(async () => {}); // No provider stage starts after cancellation or membership loss.
      const extracted = extractionSchema.parse(
        await extract({ bytes, contentType: section.contentType }),
      );
      await fenced(async (tx, run, identity) => {
        const existing = await tx
          .select({ id: items.id })
          .from(items)
          .where(informationItemOwn(actor, claim.id));
        if (existing.length + extracted.profiles.length > 500)
          throw informationError(
            422,
            "PROFILE_LIMIT",
            "This source has more than 500 profiles. Split it into smaller packets",
          );
        const authorized = await tx
          .select({
            id: students.id,
            firstName: students.firstName,
            lastName: students.lastName,
            externalId: students.externalId,
            number: students.studentIdNumber,
          })
          .from(students)
          .where(sharedStudentWhere(identity));
        const current = await tx
          .select({
            studentId: profiles.filingStudentId,
            revision: profiles.revision,
          })
          .from(profiles)
          .where(eq(profiles.schoolId, actor.schoolId));
        for (let n = 0; n < extracted.profiles.length; n++) {
          const draft = extracted.profiles[n]!;
          const matches = authorized.filter(
            (s) =>
              normalized(`${s.firstName} ${s.lastName}`) ===
                normalized(draft.studentName) &&
              (!draft.studentIdentifier ||
                draft.studentIdentifier === s.externalId ||
                draft.studentIdentifier === s.number),
          );
          const studentId = matches.length === 1 ? matches[0]!.id : null;
          const proposed = {
            contacts: draft.contacts.map((c) => ({
              ...emptyContactFields,
              ...c,
              id: randomUUID(),
            })),
          };
          await tx.insert(items).values({
            schoolId: actor.schoolId,
            authorId: actor.authorId,
            importId: claim.id,
            ordinal: existing.length + n,
            sourceSectionId: section.id,
            studentName: draft.studentName,
            studentIdentifier: draft.studentIdentifier,
            studentId,
            baseRevision:
              current.find((p) => p.studentId === studentId)?.revision ?? 0,
            proposed,
            changes: [],
            warnings: [
              ...new Set([
                ...stage.flatMap((part) => part.warnings),
                ...draft.warnings,
                ...(studentId ? [] : ["student_match_required"]),
              ]),
            ],
          });
        }
        await tx
          .update(assets)
          .set({ processedAt: new Date() })
          .where(
            and(
              informationAssetOwn(actor, claim.id),
              inArray(
                assets.id,
                stage.map((part) => part.id),
              ),
            ),
          );
        await tx
          .update(runs)
          .set({ attempts: 0, updatedAt: new Date() })
          .where(informationRunOwn(actor, run.id));
      });
    }
    await fenced(async (tx, run) => {
      await tx
        .update(runs)
        .set({
          status: "review",
          leaseId: null,
          leaseUntil: null,
          revision: run.revision + 1,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(informationRunOwn(actor, run.id));
    });
    return { id: claim.id, status: "review" };
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^STUDENT_INFORMATION_[A-Z_]+$/.test(error.code)
        ? error.code
        : "STUDENT_INFORMATION_PROCESSING_FAILED";
    await runWithTenantContext({ schoolId: actor.schoolId }, () =>
      db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(informationRunOwn(actor, claim.id))
          .for("update");
        if (!run || run.status !== "processing" || run.leaseId !== leaseId)
          return;
        const retry =
          run.attempts < 3 &&
          ![
            "STUDENT_INFORMATION_JOB_CANCELLED",
            "STUDENT_INFORMATION_PROFILE_LIMIT",
            "STUDENT_INFORMATION_PROMPT_UNAVAILABLE",
          ].includes(code);
        await tx
          .update(runs)
          .set({
            status: retry ? "queued" : "failed",
            leaseId: null,
            leaseUntil: null,
            lastErrorCode: code,
            nextAttemptAt: retry ? new Date(Date.now() + 30_000) : null,
            revision: run.revision + 1,
            updatedAt: new Date(),
          })
          .where(informationRunOwn(actor, claim.id));
      }),
    );
    return { id: claim.id, status: "failed", code };
  }
}
export async function runStudentInformationJobs(options: Options = {}) {
  if (!studentInformationImportEnabled()) return [];
  const database = options.database ?? schedulerDb,
    now = options.now ?? new Date();
  const claims = await database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('mydesk-import-global-slots',0))`,
    );
    const ownActive = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.status, "processing"), gt(runs.leaseUntil, now)));
    const paperActive = await tx
      .select({ id: mydeskImports.id })
      .from(mydeskImports)
      .where(
        and(
          eq(mydeskImports.status, "processing"),
          gt(mydeskImports.leaseUntil, now),
        ),
      );
    const slots = Math.max(0, 2 - ownActive.length - paperActive.length);
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
          gt(runs.expiresAt, now),
          classpilotEntitledSchoolPredicate(runs.schoolId),
          sql`EXISTS(SELECT 1 FROM ${schoolMemberships} WHERE ${schoolMemberships.schoolId}=${runs.schoolId} AND ${schoolMemberships.userId}=${runs.authorId} AND ${schoolMemberships.status}='active' AND ${schoolMemberships.role} IN ('teacher','admin','school_admin'))`,
        ),
      )
      .orderBy(runs.createdAt, runs.id)
      .limit(slots)
      .for("update", { skipLocked: true });
    const claimed = [];
    for (const run of due) {
      const [updated] = await tx
        .update(runs)
        .set({
          status: "processing",
          leaseId: randomUUID(),
          leaseUntil: new Date(Date.now() + INFORMATION_LEASE_MS),
          revision: run.revision + 1,
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();
      claimed.push(updated!);
    }
    return claimed;
  });
  return Promise.all(
    claims.map((claim) => processStudentInformationClaim(claim, options)),
  );
}
/** Cleanup is independent of the operational mode and author membership. */
export async function cleanupStudentInformationImports(options: Options = {}) {
  const database = options.database ?? schedulerDb,
    store = options.store ?? myDeskObjectStore,
    now = options.now ?? new Date();
  const expired = await database
    .select()
    .from(runs)
    .where(
      and(
        lte(runs.expiresAt, now),
        inArray(runs.status, [
          "uploading",
          "queued",
          "processing",
          "review",
          "failed",
        ]),
      ),
    )
    .orderBy(runs.expiresAt)
    .limit(50);
  for (const run of expired)
    await runWithTenantContext({ schoolId: run.schoolId }, () =>
      db.transaction(async (tx) => {
        const locked = await lockInformationRun(tx, run, run.id, true);
        if (locked.expiresAt.getTime() <= now.getTime())
          await scrubInformationImport(tx, run, locked, "expired");
      }),
    );
  const due = await database
    .select()
    .from(assets)
    .where(
      and(
        inArray(assets.status, ["delete_pending", "deleted"]),
        or(isNull(assets.nextCleanupAt), lte(assets.nextCleanupAt, now)),
        or(
          isNull(assets.leaseUntil),
          sql`${assets.leaseUntil}<${new Date(now.getTime() - 60_000)}`,
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${assets.status}='delete_pending' THEN 0 ELSE 1 END`,
      assets.nextCleanupAt,
      assets.id,
    )
    .limit(50);
  let deleted = 0;
  for (const asset of due) {
    try {
      await store.delete(asset.storageKey);
      await database
        .update(assets)
        .set({
          status: "deleted",
          filename: "",
          label: "",
          warnings: [],
          sha256: null,
          leaseId: null,
          leaseUntil: null,
          nextCleanupAt: new Date(now.getTime() + 24 * 3600_000),
          cleanupAttempts: asset.cleanupAttempts + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(assets.id, asset.id),
            inArray(assets.status, ["delete_pending", "deleted"]),
          ),
        );
      deleted++;
    } catch {
      await database
        .update(assets)
        .set({
          cleanupAttempts: asset.cleanupAttempts + 1,
          nextCleanupAt: new Date(
            now.getTime() +
              Math.min(
                3600_000,
                30_000 * 2 ** Math.min(7, asset.cleanupAttempts),
              ),
          ),
        })
        .where(eq(assets.id, asset.id));
    }
  }
  return { expired: expired.length, deleted };
}
