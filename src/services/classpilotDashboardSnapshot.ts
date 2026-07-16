import { sql } from "drizzle-orm";
import db from "../db.js";
import { getTenantStore, rlsGucEnabled } from "../db/tenantContext.js";
import { schools } from "../schema/core.js";
import { registerCacheInvalidationHandler } from "../realtime/cacheInvalidation.js";
import { isRedisBroadcastReady, isRedisPublisherReady } from "../realtime/ws-redis.js";

export const CLASSPILOT_DASHBOARD_SNAPSHOT_CHUNK_SIZE = 2_500;
export const CLASSPILOT_DASHBOARD_SCHOOL_CACHE_TTL_MS = 5_000;

export type ClasspilotDashboardSnapshotRow = {
  studentId: string;
  mappedDeviceId: string | null;
  sessionDeviceId: string | null;
  sessionLastSeenAt: Date | null;
  attendanceStatus: string | null;
  activePass: {
    id: string;
    destination: string;
    issuedAt: Date;
    expiresAt: Date;
    status: string;
  } | null;
  dismissal: {
    id: string;
    status: string;
    checkInMethod: string | null;
    checkInTime: Date | null;
  } | null;
  coverage: {
    id: string;
    contextType: string;
    name: string;
    assignedStaffId: string;
    assignedStaffDisplayName: string;
    endsAt: Date;
  } | null;
  activeClass: {
    sessionId: string;
    groupId: string;
    groupName: string;
    teacherId: string;
    startTime: Date;
  } | null;
};

export type RawClasspilotDashboardSnapshotRow = {
  student_id: string;
  mapped_device_id: string | null;
  session_device_id: string | null;
  session_last_seen_at: Date | null;
  attendance_status: string | null;
  pass_id: string | null;
  pass_destination: string | null;
  pass_issued_at: Date | null;
  pass_expires_at: Date | null;
  pass_status: string | null;
  dismissal_id: string | null;
  dismissal_status: string | null;
  dismissal_check_in_method: string | null;
  dismissal_check_in_time: Date | null;
  coverage_id: string | null;
  coverage_context_type: string | null;
  coverage_name: string | null;
  coverage_staff_id: string | null;
  coverage_staff_display_name: string | null;
  coverage_ends_at: Date | null;
  class_session_id: string | null;
  class_group_id: string | null;
  class_group_name: string | null;
  class_teacher_id: string | null;
  class_start_time: Date | null;
};

type SchoolTimezoneCacheEvent = "hit" | "miss" | "bypass" | "invalidation";

export function createClasspilotDashboardSchoolTimezoneCache(options: {
  load(schoolId: string): Promise<string | null>;
  canUse(schoolId: string): boolean;
  now?: () => number;
  onEvent?: (event: SchoolTimezoneCacheEvent) => void;
}) {
  const cache = new Map<string, { expiresAt: number; value: string | null }>();
  const loads = new Map<string, Promise<string | null>>();
  const generations = new Map<string, number>();
  const now = options.now ?? Date.now;

  const invalidate = (schoolId: string): void => {
    cache.delete(schoolId);
    loads.delete(schoolId);
    generations.set(schoolId, (generations.get(schoolId) ?? 0) + 1);
    options.onEvent?.("invalidation");
  };

  const get = async (schoolId: string): Promise<string | null> => {
    if (!options.canUse(schoolId)) {
      options.onEvent?.("bypass");
      return options.load(schoolId);
    }

    const cached = cache.get(schoolId);
    if (cached && cached.expiresAt > now()) {
      options.onEvent?.("hit");
      return cached.value;
    }
    if (cached) cache.delete(schoolId);

    const pending = loads.get(schoolId);
    if (pending) {
      options.onEvent?.("hit");
      return pending;
    }

    options.onEvent?.("miss");
    const generation = generations.get(schoolId) ?? 0;
    let next!: Promise<string | null>;
    next = options.load(schoolId)
      .then((value) => {
        if ((generations.get(schoolId) ?? 0) === generation) {
          cache.set(schoolId, {
            expiresAt: now() + CLASSPILOT_DASHBOARD_SCHOOL_CACHE_TTL_MS,
            value,
          });
        }
        return value;
      })
      .finally(() => {
        if (loads.get(schoolId) === next) loads.delete(schoolId);
      });
    loads.set(schoolId, next);
    return next;
  };

  const reset = (): void => {
    cache.clear();
    loads.clear();
    generations.clear();
  };

  return { get, invalidate, reset };
}

type DashboardMetrics = {
  snapshotLoads: number;
  snapshotRows: number;
  snapshotChunks: number;
  snapshotErrors: number;
  snapshotDurationMs: number;
  schoolCacheHits: number;
  schoolCacheMisses: number;
  schoolCacheBypasses: number;
  schoolCacheInvalidations: number;
};

function emptyMetrics(): DashboardMetrics {
  return {
    snapshotLoads: 0,
    snapshotRows: 0,
    snapshotChunks: 0,
    snapshotErrors: 0,
    snapshotDurationMs: 0,
    schoolCacheHits: 0,
    schoolCacheMisses: 0,
    schoolCacheBypasses: 0,
    schoolCacheInvalidations: 0,
  };
}

let dashboardMetrics = emptyMetrics();
const dashboardMetricsTimer = setInterval(() => {
  const snapshot = dashboardMetrics;
  dashboardMetrics = emptyMetrics();
  if (Object.values(snapshot).every((value) => value === 0)) return;
  console.log(JSON.stringify({
    event: "classpilot_dashboard_hot_path",
    intervalSeconds: 60,
    ...snapshot,
  }));
}, 60_000);
dashboardMetricsTimer.unref?.();

function canUseSchoolCache(schoolId: string): boolean {
  if (!isRedisPublisherReady() || !isRedisBroadcastReady()) return false;
  if (!rlsGucEnabled()) return true;
  const tenant = getTenantStore();
  return Boolean(tenant && (tenant.isSuper || tenant.schoolId === schoolId));
}

const schoolTimezoneState = createClasspilotDashboardSchoolTimezoneCache({
  canUse: canUseSchoolCache,
  async load(schoolId) {
    const [row] = await db
      .select({ schoolTimezone: schools.schoolTimezone })
      .from(schools)
      .where(sql`${schools.id} = ${schoolId}`)
      .limit(1);
    return row?.schoolTimezone ?? null;
  },
  onEvent(event) {
    if (event === "hit") dashboardMetrics.schoolCacheHits += 1;
    if (event === "miss") dashboardMetrics.schoolCacheMisses += 1;
    if (event === "bypass") dashboardMetrics.schoolCacheBypasses += 1;
    if (event === "invalidation") dashboardMetrics.schoolCacheInvalidations += 1;
  },
});

export function invalidateClasspilotDashboardSchoolCache(schoolId: string): void {
  schoolTimezoneState.invalidate(schoolId);
}

registerCacheInvalidationHandler((target) => {
  if (target.cache === "classpilot-dashboard-school") {
    invalidateClasspilotDashboardSchoolCache(target.schoolId);
  }
});

export async function getClasspilotDashboardSchoolTimezone(schoolId: string): Promise<string | null> {
  return schoolTimezoneState.get(schoolId);
}

function mapSnapshotRow(
  row: RawClasspilotDashboardSnapshotRow
): ClasspilotDashboardSnapshotRow {
  return {
    studentId: row.student_id,
    mappedDeviceId: row.mapped_device_id,
    sessionDeviceId: row.session_device_id,
    sessionLastSeenAt: row.session_last_seen_at,
    attendanceStatus: row.attendance_status,
    activePass: row.pass_id && row.pass_destination && row.pass_issued_at && row.pass_expires_at && row.pass_status
      ? {
          id: row.pass_id,
          destination: row.pass_destination,
          issuedAt: row.pass_issued_at,
          expiresAt: row.pass_expires_at,
          status: row.pass_status,
        }
      : null,
    dismissal: row.dismissal_id && row.dismissal_status
      ? {
          id: row.dismissal_id,
          status: row.dismissal_status,
          checkInMethod: row.dismissal_check_in_method,
          checkInTime: row.dismissal_check_in_time,
        }
      : null,
    coverage: row.coverage_id && row.coverage_context_type && row.coverage_name
      && row.coverage_staff_id && row.coverage_ends_at
      ? {
          id: row.coverage_id,
          contextType: row.coverage_context_type,
          name: row.coverage_name,
          assignedStaffId: row.coverage_staff_id,
          assignedStaffDisplayName: row.coverage_staff_display_name || "Staff",
          endsAt: row.coverage_ends_at,
        }
      : null,
    activeClass: row.class_session_id && row.class_group_id && row.class_group_name
      && row.class_teacher_id && row.class_start_time
      ? {
          sessionId: row.class_session_id,
          groupId: row.class_group_id,
          groupName: row.class_group_name,
          teacherId: row.class_teacher_id,
          startTime: row.class_start_time,
        }
      : null,
  };
}

export function mapClasspilotDashboardSnapshotRows(
  rows: readonly RawClasspilotDashboardSnapshotRow[],
  requestedStudentIds: readonly string[]
): ClasspilotDashboardSnapshotRow[] {
  const requested = new Set(requestedStudentIds);
  return rows
    .filter((row) => requested.has(row.student_id))
    .map(mapSnapshotRow);
}

async function loadSnapshotChunk(
  schoolId: string,
  studentIds: string[],
  today: string
): Promise<ClasspilotDashboardSnapshotRow[]> {
  const requestedValues = sql.join(studentIds.map((studentId) => sql`(${studentId})`), sql`, `);
  const result = await db.execute(sql`
    WITH requested(student_id) AS (VALUES ${requestedValues}),
    scoped_students AS MATERIALIZED (
      SELECT student.id AS student_id
      FROM students AS student
      INNER JOIN requested ON requested.student_id = student.id
      WHERE student.school_id = ${schoolId}
    ),
    latest_devices AS MATERIALIZED (
      SELECT DISTINCT ON (mapping.student_id)
             mapping.student_id, mapping.device_id
      FROM student_devices AS mapping
      INNER JOIN scoped_students AS scoped ON scoped.student_id = mapping.student_id
      ORDER BY mapping.student_id, mapping.last_seen_at DESC, mapping.device_id
    ),
    active_student_sessions AS MATERIALIZED (
      SELECT DISTINCT ON (session.student_id)
             session.student_id, session.device_id, session.last_seen_at
      FROM student_sessions AS session
      INNER JOIN scoped_students AS scoped ON scoped.student_id = session.student_id
      WHERE session.is_active = true
      ORDER BY session.student_id, session.last_seen_at DESC, session.id
    ),
    today_attendance AS MATERIALIZED (
      SELECT attendance.student_id, attendance.status
      FROM student_attendance AS attendance
      INNER JOIN scoped_students AS scoped ON scoped.student_id = attendance.student_id
      WHERE attendance.school_id = ${schoolId} AND attendance.date = ${today}
    ),
    active_passes AS MATERIALIZED (
      SELECT DISTINCT ON (pass.student_id)
             pass.student_id, pass.id, pass.destination, pass.issued_at,
             pass.expires_at, pass.status
      FROM passes AS pass
      INNER JOIN scoped_students AS scoped ON scoped.student_id = pass.student_id
      WHERE pass.school_id = ${schoolId} AND pass.status = 'active'
      ORDER BY pass.student_id, pass.issued_at DESC, pass.id
    ),
    current_dismissals AS MATERIALIZED (
      SELECT DISTINCT ON (queue.student_id)
             queue.student_id, queue.id, queue.status,
             queue.check_in_method, queue.check_in_time
      FROM dismissal_queue AS queue
      INNER JOIN scoped_students AS scoped ON scoped.student_id = queue.student_id
      INNER JOIN dismissal_sessions AS dismissal_session
        ON dismissal_session.id = queue.session_id
       AND dismissal_session.school_id = ${schoolId}
       AND dismissal_session.date = ${today}
       AND dismissal_session.status IN ('active', 'paused', 'completed')
      ORDER BY queue.student_id, queue.created_at DESC, queue.id
    ),
    current_coverages AS MATERIALIZED (
      SELECT DISTINCT ON (assignment.student_id)
             assignment.student_id, context.id, context.context_type,
             context.name, context.assigned_staff_id, context.ends_at
      FROM classpilot_supervision_students AS assignment
      INNER JOIN scoped_students AS scoped ON scoped.student_id = assignment.student_id
      INNER JOIN classpilot_supervision_contexts AS context
        ON context.id = assignment.context_id
       AND context.school_id = ${schoolId}
      WHERE assignment.school_id = ${schoolId}
        AND assignment.released_at IS NULL
        AND context.status = 'active'
        AND context.ends_at > now()
      ORDER BY assignment.student_id, context.updated_at DESC, context.id
    ),
    current_classes AS MATERIALIZED (
      SELECT DISTINCT ON (roster.student_id)
             roster.student_id,
             teaching_session.id AS session_id,
             classroom.id AS group_id,
             classroom.name AS group_name,
             teaching_session.teacher_id,
             teaching_session.start_time
      FROM group_students AS roster
      INNER JOIN scoped_students AS scoped ON scoped.student_id = roster.student_id
      INNER JOIN groups AS classroom
        ON classroom.id = roster.group_id
       AND classroom.school_id = ${schoolId}
      INNER JOIN teaching_sessions AS teaching_session
        ON teaching_session.group_id = classroom.id
       AND teaching_session.session_mode = 'live'
       AND teaching_session.end_time IS NULL
      ORDER BY roster.student_id,
               COALESCE(teaching_session.control_updated_at, teaching_session.start_time) DESC,
               teaching_session.start_time DESC,
               teaching_session.created_at DESC,
               teaching_session.id DESC
    )
    SELECT
      scoped.student_id,
      mapped_device.device_id AS mapped_device_id,
      active_student_session.device_id AS session_device_id,
      active_student_session.last_seen_at AS session_last_seen_at,
      attendance.status AS attendance_status,
      active_pass.id AS pass_id,
      active_pass.destination AS pass_destination,
      active_pass.issued_at AS pass_issued_at,
      active_pass.expires_at AS pass_expires_at,
      active_pass.status AS pass_status,
      current_dismissal.id AS dismissal_id,
      current_dismissal.status AS dismissal_status,
      current_dismissal.check_in_method AS dismissal_check_in_method,
      current_dismissal.check_in_time AS dismissal_check_in_time,
      current_coverage.id AS coverage_id,
      current_coverage.context_type AS coverage_context_type,
      current_coverage.name AS coverage_name,
      current_coverage.assigned_staff_id AS coverage_staff_id,
      COALESCE(
        coverage_staff.display_name,
        NULLIF(trim(concat_ws(' ', coverage_staff.first_name, coverage_staff.last_name)), ''),
        coverage_staff.email,
        'Staff'
      ) AS coverage_staff_display_name,
      current_coverage.ends_at AS coverage_ends_at,
      current_class.session_id AS class_session_id,
      current_class.group_id AS class_group_id,
      current_class.group_name AS class_group_name,
      current_class.teacher_id AS class_teacher_id,
      current_class.start_time AS class_start_time
    FROM scoped_students AS scoped
    LEFT JOIN latest_devices AS mapped_device ON mapped_device.student_id = scoped.student_id
    LEFT JOIN active_student_sessions AS active_student_session
      ON active_student_session.student_id = scoped.student_id
    LEFT JOIN today_attendance AS attendance ON attendance.student_id = scoped.student_id
    LEFT JOIN active_passes AS active_pass ON active_pass.student_id = scoped.student_id
    LEFT JOIN current_dismissals AS current_dismissal
      ON current_dismissal.student_id = scoped.student_id
    LEFT JOIN current_coverages AS current_coverage
      ON current_coverage.student_id = scoped.student_id
    LEFT JOIN users AS coverage_staff ON coverage_staff.id = current_coverage.assigned_staff_id
    LEFT JOIN current_classes AS current_class ON current_class.student_id = scoped.student_id
    ORDER BY scoped.student_id
  `);
  return mapClasspilotDashboardSnapshotRows(
    result.rows as unknown as RawClasspilotDashboardSnapshotRow[],
    studentIds
  );
}

export async function getClasspilotDashboardSnapshot(
  schoolId: string,
  studentIds: string[],
  today: string
): Promise<ClasspilotDashboardSnapshotRow[]> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))];
  if (uniqueStudentIds.length === 0) return [];

  const startedAt = performance.now();
  dashboardMetrics.snapshotLoads += 1;
  const rows: ClasspilotDashboardSnapshotRow[] = [];
  try {
    for (let offset = 0; offset < uniqueStudentIds.length; offset += CLASSPILOT_DASHBOARD_SNAPSHOT_CHUNK_SIZE) {
      const chunk = uniqueStudentIds.slice(offset, offset + CLASSPILOT_DASHBOARD_SNAPSHOT_CHUNK_SIZE);
      dashboardMetrics.snapshotChunks += 1;
      rows.push(...await loadSnapshotChunk(schoolId, chunk, today));
    }
    dashboardMetrics.snapshotRows += rows.length;
    return rows;
  } catch (error) {
    dashboardMetrics.snapshotErrors += 1;
    throw error;
  } finally {
    dashboardMetrics.snapshotDurationMs += Math.round(performance.now() - startedAt);
  }
}

export function resetClasspilotDashboardSnapshotStateForTests(): void {
  schoolTimezoneState.reset();
  dashboardMetrics = emptyMetrics();
}
