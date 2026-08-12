import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

const REPORT_VERSION = "gopilot-school-driven-inventory-v1";

type InventoryRow = {
  school_id: string;
  parent_memberships: string | number;
  approved_parent_links: string | number;
  unusual_parent_link_accounts: string | number;
  approved_pickups_without_staff_evidence: string | number;
  invalid_pickup_statuses: string | number;
  unused_family_invite_tokens: string | number;
  duplicate_family_students: string | number;
  duplicate_queue_students: string | number;
  duplicate_queue_positions: string | number;
  weekend_sessions: string | number;
  unlicensed_sessions: string | number;
  invalid_session_statuses: string | number;
  completed_sessions_with_open_queue: string | number;
};

function numberValue(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10) || 0;
}

export async function runGopilotContainmentInventory(
  args: string[]
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write([
      "Usage: npm run audit:gopilot -- [--school-id <uuid>]",
      "",
      "Read-only. Reports school IDs and counts only; never names, emails,",
      "student records, car numbers, invitation tokens, or pickup details.",
    ].join("\n") + "\n");
    return 0;
  }

  let schoolId: string | undefined;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--school-id") {
      process.stderr.write(`${JSON.stringify({ version: REPORT_VERSION, status: "failed", code: "invalid_arguments" })}\n`);
      return 2;
    }
    schoolId = args[1]!;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
      process.stderr.write(`${JSON.stringify({ version: REPORT_VERSION, status: "failed", code: "invalid_school_id" })}\n`);
      return 2;
    }
  }

  let databaseModule: typeof import("../db.js") | undefined;
  let schedulerModule: typeof import("../services/schedulerDb.js") | undefined;
  try {
    [databaseModule, schedulerModule] = await Promise.all([
      import("../db.js"),
      import("../services/schedulerDb.js"),
    ]);
    const result = await schedulerModule.schedulerDb.execute<InventoryRow>(sql`
      SELECT
        s.id AS school_id,
        (SELECT COUNT(*) FROM school_memberships sm
          WHERE sm.school_id = s.id
            AND (sm.role = 'parent' OR sm.gopilot_role = 'parent')) AS parent_memberships,
        (SELECT COUNT(*) FROM parent_student ps
          INNER JOIN students st ON st.id = ps.student_id AND st.school_id = s.id
          WHERE ps.status = 'approved') AS approved_parent_links,
        (SELECT COUNT(*) FROM (
          SELECT ps.parent_id
          FROM parent_student ps
          INNER JOIN students st ON st.id = ps.student_id AND st.school_id = s.id
          WHERE ps.status = 'approved'
          GROUP BY ps.parent_id
          HAVING COUNT(*) > 10
        ) unusual) AS unusual_parent_link_accounts,
        (SELECT COUNT(*) FROM authorized_pickups ap
          INNER JOIN students st ON st.id = ap.student_id AND st.school_id = s.id
          WHERE ap.status = 'approved'
            AND NOT EXISTS (
              SELECT 1 FROM school_memberships sm
              WHERE sm.school_id = s.id AND sm.user_id = ap.added_by
                AND sm.status = 'active'
                AND COALESCE(sm.gopilot_role, sm.role) IN ('admin', 'school_admin', 'office_staff')
            )) AS approved_pickups_without_staff_evidence,
        (SELECT COUNT(*) FROM authorized_pickups ap
          INNER JOIN students st ON st.id = ap.student_id AND st.school_id = s.id
          WHERE ap.status NOT IN ('pending', 'approved', 'revoked')) AS invalid_pickup_statuses,
        (SELECT COUNT(*) FROM family_groups fg
          WHERE fg.school_id = s.id AND fg.invite_token IS NOT NULL) AS unused_family_invite_tokens,
        (SELECT COUNT(*) FROM (
          SELECT fgs.student_id
          FROM family_group_students fgs
          INNER JOIN family_groups fg ON fg.id = fgs.family_group_id
          WHERE fg.school_id = s.id
          GROUP BY fgs.student_id
          HAVING COUNT(*) > 1
        ) duplicates) AS duplicate_family_students,
        (SELECT COUNT(*) FROM (
          SELECT dq.session_id, dq.student_id
          FROM dismissal_queue dq
          INNER JOIN dismissal_sessions ds ON ds.id = dq.session_id
          WHERE ds.school_id = s.id
          GROUP BY dq.session_id, dq.student_id
          HAVING COUNT(*) > 1
        ) duplicates) AS duplicate_queue_students,
        (SELECT COUNT(*) FROM (
          SELECT dq.session_id, dq.position
          FROM dismissal_queue dq
          INNER JOIN dismissal_sessions ds ON ds.id = dq.session_id
          WHERE ds.school_id = s.id
          GROUP BY dq.session_id, dq.position
          HAVING COUNT(*) > 1
        ) duplicates) AS duplicate_queue_positions,
        (SELECT COUNT(*) FROM dismissal_sessions ds
          WHERE ds.school_id = s.id AND EXTRACT(ISODOW FROM ds.date) IN (6, 7)) AS weekend_sessions,
        (SELECT COUNT(*) FROM dismissal_sessions ds
          WHERE ds.school_id = s.id
            AND NOT EXISTS (
              SELECT 1 FROM product_licenses pl
              WHERE pl.school_id = s.id AND pl.product = 'GOPILOT' AND pl.status = 'active'
                AND (pl.expires_at IS NULL OR pl.expires_at > NOW())
            )) AS unlicensed_sessions,
        (SELECT COUNT(*) FROM dismissal_sessions ds
          WHERE ds.school_id = s.id AND ds.status NOT IN ('pending', 'active', 'paused', 'completed')) AS invalid_session_statuses,
        (SELECT COUNT(DISTINCT ds.id) FROM dismissal_sessions ds
          INNER JOIN dismissal_queue dq ON dq.session_id = ds.id
          INNER JOIN students st ON st.id = dq.student_id AND st.school_id = s.id
          WHERE ds.school_id = s.id AND ds.status = 'completed'
            AND dq.status NOT IN ('dismissed')) AS completed_sessions_with_open_queue
      FROM schools s
      WHERE s.deleted_at IS NULL
        AND (${schoolId ?? null}::text IS NULL OR s.id = ${schoolId ?? null})
        AND (
          EXISTS (SELECT 1 FROM product_licenses pl WHERE pl.school_id = s.id AND pl.product = 'GOPILOT')
          OR EXISTS (SELECT 1 FROM dismissal_sessions ds WHERE ds.school_id = s.id)
          OR EXISTS (SELECT 1 FROM school_memberships sm WHERE sm.school_id = s.id AND (sm.role = 'parent' OR sm.gopilot_role = 'parent'))
        )
      ORDER BY s.id
    `);

    const orphanResult = await schedulerModule.schedulerDb.execute<{ count: string | number }>(sql`
      SELECT COUNT(*) AS count FROM (
        SELECT ap.id FROM authorized_pickups ap
          LEFT JOIN students st ON st.id = ap.student_id
          WHERE st.id IS NULL
        UNION ALL
        SELECT ca.id FROM custody_alerts ca
          LEFT JOIN students st ON st.id = ca.student_id
          WHERE st.id IS NULL
        UNION ALL
        SELECT dq.id FROM dismissal_queue dq
          LEFT JOIN dismissal_sessions ds ON ds.id = dq.session_id
          LEFT JOIN students st ON st.id = dq.student_id
          WHERE ds.id IS NULL OR st.id IS NULL OR ds.school_id <> st.school_id
        UNION ALL
        SELECT dc.id FROM dismissal_changes dc
          LEFT JOIN dismissal_sessions ds ON ds.id = dc.session_id
          LEFT JOIN students st ON st.id = dc.student_id
          WHERE ds.id IS NULL OR st.id IS NULL OR ds.school_id <> st.school_id
        UNION ALL
        SELECT fgs.id FROM family_group_students fgs
          LEFT JOIN family_groups fg ON fg.id = fgs.family_group_id
          LEFT JOIN students st ON st.id = fgs.student_id
          WHERE fg.id IS NULL OR st.id IS NULL OR fg.school_id <> st.school_id
        UNION ALL
        SELECT ht.id FROM homeroom_teachers ht
          LEFT JOIN homerooms h ON h.id = ht.homeroom_id
          LEFT JOIN users u ON u.id = ht.teacher_id
          WHERE h.id IS NULL OR u.id IS NULL
        UNION ALL
        SELECT dover.id FROM dismissal_overrides dover
          LEFT JOIN students st ON st.id = dover.student_id
          WHERE st.id IS NULL
        UNION ALL
        SELECT ps.id FROM parent_student ps
          LEFT JOIN students st ON st.id = ps.student_id
          LEFT JOIN users u ON u.id = ps.parent_id
          WHERE st.id IS NULL OR u.id IS NULL
      ) orphaned
    `);

    const schools = result.rows.map((row) => ({
      schoolId: row.school_id,
      counts: {
        parentMemberships: numberValue(row.parent_memberships),
        approvedParentLinks: numberValue(row.approved_parent_links),
        unusualParentLinkAccounts: numberValue(row.unusual_parent_link_accounts),
        approvedPickupsWithoutStaffEvidence: numberValue(row.approved_pickups_without_staff_evidence),
        invalidPickupStatuses: numberValue(row.invalid_pickup_statuses),
        unusedFamilyInviteTokens: numberValue(row.unused_family_invite_tokens),
        duplicateFamilyStudents: numberValue(row.duplicate_family_students),
        duplicateQueueStudents: numberValue(row.duplicate_queue_students),
        duplicateQueuePositions: numberValue(row.duplicate_queue_positions),
        weekendSessions: numberValue(row.weekend_sessions),
        unlicensedSessions: numberValue(row.unlicensed_sessions),
        invalidSessionStatuses: numberValue(row.invalid_session_statuses),
        completedSessionsWithOpenQueue: numberValue(row.completed_sessions_with_open_queue),
      },
    }));
    process.stdout.write(`${JSON.stringify({
      version: REPORT_VERSION,
      status: "passed",
      mode: "read_only",
      schoolCount: schools.length,
      globalOrphanedChildRecords: numberValue(orphanResult.rows[0]?.count ?? 0),
      schools,
    })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      version: REPORT_VERSION,
      status: "failed",
      code: "inventory_failed",
    })}\n`);
    return 1;
  } finally {
    await Promise.allSettled([
      databaseModule?.pool.end(),
      databaseModule?.sessionPool.end(),
      schedulerModule?.schedulerPool.end(),
      schedulerModule?.schedulerLockPool.end(),
    ]);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  void runGopilotContainmentInventory(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
