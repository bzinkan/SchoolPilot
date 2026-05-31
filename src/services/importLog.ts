// Durable record of roster-import outcomes. Lets an admin/developer pinpoint
// "the import didn't work right" — counts, the exact per-row failures, and the
// silent zero-result case (wrong OU / missing Workspace permission).
//
// Writes through the dedicated scheduler pool (max 3), NOT the API pool, so a
// burst of imports can never starve request handling. Fire-and-forget: a
// logging failure must never affect the import response.

const MAX_FAILURES_STORED = 100;

export interface ImportRunInput {
  schoolId: string;
  userId?: string | null;
  requestId?: string | null;
  source: "workspace_directory" | "workspace_direct" | "workspace_staff" | "classroom";
  scope?: string | null;
  totalFound: number;
  imported: number;
  updated: number;
  skipped: number;
  // "email: reason" strings (or {email, reason}) — capped before storage.
  failures?: Array<string | { email?: string; reason?: string }>;
  warnings?: string[];
}

export async function recordImportRun(run: ImportRunInput): Promise<void> {
  try {
    const { schedulerDb } = await import("./schedulerDb.js");
    const { importRuns } = await import("../schema/shared.js");

    const failures = (run.failures ?? []).slice(0, MAX_FAILURES_STORED);
    const warnings = run.warnings ?? [];
    // Auto-flag the silent "Google returned nothing" case.
    if (run.totalFound === 0 && !warnings.includes("google_returned_zero_users")) {
      warnings.push("google_returned_zero_users");
    }

    await schedulerDb.insert(importRuns).values({
      schoolId: run.schoolId,
      userId: run.userId ?? null,
      requestId: run.requestId ?? null,
      source: run.source,
      scope: run.scope ?? null,
      totalFound: run.totalFound,
      imported: run.imported,
      updated: run.updated,
      skipped: run.skipped,
      failures: failures.length > 0 ? failures : null,
      warnings: warnings.length > 0 ? warnings : null,
    });
  } catch (err) {
    // Never throw — logging the outcome must not break the import itself.
    console.error("[ImportLog] Failed to record import run:", (err as Error).message);
    // Surface persistent import-logging failures to the operator (own table,
    // no PII passed). Safe: errorMonitor writes to a different table.
    try {
      const { default: errorMonitor } = await import("./errorMonitor.js");
      errorMonitor.trackError("scheduler_failure", err, { job: "recordImportRun", schoolId: run.schoolId });
    } catch {
      /* swallow — never let logging-of-logging break anything */
    }
  }
}
