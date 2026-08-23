import type {
  ClasspilotSessionReport,
  ClasspilotSessionStudentReport,
} from "../schema/classpilot.js";
import { formulaSafeCsvCell } from "../util/classpilotEventCursor.js";

/**
 * The single public projection for immutable session report v1/v2 data. Both
 * JSON and CSV presentations consume this object so exports cannot silently
 * fall back to mutable heartbeat/event rows.
 */
export function classpilotSessionReportDto(
  report: ClasspilotSessionReport,
  studentReports: readonly ClasspilotSessionStudentReport[]
) {
  if (report.reportVersion < 2) {
    // Frozen v1 public contract. In particular, it did not advertise a
    // reportVersion field or any v2-only activity/safety dimensions.
    return {
      reportVersion: undefined,
      teachingSessionId: report.teachingSessionId,
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      timezone: report.timezone,
      coverageAlgorithmVersion: report.coverageAlgorithmVersion,
      totals: {
        roster: report.rosterCount,
        eligible: report.eligibleStudentCount,
        complete: report.completeCount,
        partial: report.partialCount,
        none: report.noneCount,
        notExpected: report.notExpectedCount,
        unavailable: report.unavailableCount,
        eligibleSeconds: report.totalEligibleSeconds,
        observedSeconds: report.totalObservedSeconds,
        gapSeconds: report.totalGapSeconds,
        unclassifiedSeconds: undefined,
        offTaskSeconds: undefined,
        offTaskEventCount: undefined,
        safetyAlertCount: undefined,
      },
      students: studentReports.map((student) => ({
        studentId: student.studentId,
        studentName: student.studentNameSnapshot,
        status: student.status,
        eligibleSeconds: student.eligibleSeconds,
        observedSeconds: student.observedSeconds,
        gapSeconds: student.gapSeconds,
        coveragePercent: student.coveragePercent,
        heartbeatCount: student.heartbeatCount,
        firstObservedAt: student.firstObservedAt,
        lastObservedAt: student.lastObservedAt,
        gapIntervals: Array.isArray(student.gapIntervals)
          ? student.gapIntervals.map((value) => {
              const gap = value && typeof value === "object"
                ? value as Record<string, unknown>
                : {};
              return {
                start: gap.start,
                end: gap.end,
                durationSeconds: gap.durationSeconds,
                cause: "unknown",
              };
            })
          : [],
        eventCounts: student.eventCounts,
        topDomains: student.topDomains,
        unclassifiedSeconds: undefined,
        offTaskSeconds: undefined,
        offTaskEventCount: undefined,
        offTaskEvents: undefined,
        safetyAlerts: undefined,
      })),
    };
  }
  return {
    teachingSessionId: report.teachingSessionId,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    timezone: report.timezone,
    reportVersion: report.reportVersion,
    coverageAlgorithmVersion: report.coverageAlgorithmVersion,
    totals: {
      roster: report.rosterCount,
      eligible: report.eligibleStudentCount,
      complete: report.completeCount,
      partial: report.partialCount,
      none: report.noneCount,
      notExpected: report.notExpectedCount,
      unavailable: report.unavailableCount,
      eligibleSeconds: report.totalEligibleSeconds,
      observedSeconds: report.totalObservedSeconds,
      gapSeconds: report.totalGapSeconds,
      unclassifiedSeconds: report.totalUnclassifiedSeconds,
      offTaskSeconds: report.totalOffTaskSeconds,
      offTaskEventCount: report.totalOffTaskEventCount,
      safetyAlertCount: report.totalSafetyAlertCount,
    },
    students: studentReports.map((student) => ({
      studentId: student.studentId,
      studentName: student.studentNameSnapshot,
      status: student.status,
      eligibleSeconds: student.eligibleSeconds,
      observedSeconds: student.observedSeconds,
      gapSeconds: student.gapSeconds,
      coveragePercent: student.coveragePercent,
      heartbeatCount: student.heartbeatCount,
      firstObservedAt: student.firstObservedAt,
      lastObservedAt: student.lastObservedAt,
      gapIntervals: Array.isArray(student.gapIntervals)
        ? student.gapIntervals.map((value) => {
            const gap = value && typeof value === "object"
              ? value as Record<string, unknown>
              : {};
            return {
              start: gap.start,
              end: gap.end,
              durationSeconds: gap.durationSeconds,
              cause: "unknown",
            };
          })
        : [],
      eventCounts: student.eventCounts,
      topDomains: student.topDomains,
      unclassifiedSeconds: student.unclassifiedSeconds,
      offTaskSeconds: student.offTaskSeconds,
      offTaskEventCount: student.offTaskEventCount,
      offTaskEvents: student.offTaskEvents,
      safetyAlerts: student.safetyAlerts,
    })),
  };
}

export type ClasspilotSessionReportDto = ReturnType<typeof classpilotSessionReportDto>;

function iso(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * One row per frozen student report. Aggregate fields are repeated so a CSV
 * remains self-contained when filtered, and every detail is sourced from the
 * same immutable DTO returned by the report API.
 */
export function classpilotSessionReportCsv(
  report: ClasspilotSessionReportDto
): string {
  const reportVersion = report.reportVersion ?? 1;
  const header = [
    "Report Version",
    "Coverage Algorithm Version",
    "Teaching Session ID",
    "Window Start",
    "Window End",
    "Timezone",
    "Student ID",
    "Student",
    "Status",
    "Eligible Seconds",
    "Monitored Seconds",
    "Gap Seconds",
    "Unclassified Seconds",
    "Coverage Percent",
    "Heartbeat Count",
    "First Observed At",
    "Last Observed At",
    "Top Domains",
    "Off-task Seconds",
    "Off-task Event Count",
    "Off-task Events",
    "Safety Alerts",
    "Monitoring Event Counts",
    "Gap Intervals",
    "Roster Total",
    "Eligible Students",
    "Complete Students",
    "Partial Students",
    "No Coverage Students",
    "Not Expected Students",
    "Unavailable Students",
    "Total Eligible Seconds",
    "Total Monitored Seconds",
    "Total Gap Seconds",
    "Total Unclassified Seconds",
    "Total Off-task Seconds",
    "Total Off-task Event Count",
    "Total Safety Alert Count",
  ];

  const sourceStudents: Array<ClasspilotSessionReportDto["students"][number] | undefined> =
    report.students.length > 0 ? report.students : [undefined];
  const rows = sourceStudents.map((student) => [
    reportVersion,
    report.coverageAlgorithmVersion,
    report.teachingSessionId,
    iso(report.windowStart),
    iso(report.windowEnd),
    report.timezone,
    student?.studentId ?? "",
    student?.studentName ?? "",
    student?.status ?? "",
    student?.eligibleSeconds ?? "",
    student?.observedSeconds ?? "",
    student?.gapSeconds ?? "",
    student && "unclassifiedSeconds" in student ? student.unclassifiedSeconds ?? "" : "",
    student?.coveragePercent ?? "",
    student?.heartbeatCount ?? "",
    iso(student?.firstObservedAt),
    iso(student?.lastObservedAt),
    json(student?.topDomains ?? []),
    student && "offTaskSeconds" in student ? student.offTaskSeconds ?? "" : "",
    student && "offTaskEventCount" in student ? student.offTaskEventCount ?? "" : "",
    json(student && "offTaskEvents" in student ? student.offTaskEvents ?? [] : []),
    json(student && "safetyAlerts" in student ? student.safetyAlerts ?? [] : []),
    json(student?.eventCounts ?? {}),
    json(student?.gapIntervals ?? []),
    report.totals.roster,
    report.totals.eligible,
    report.totals.complete,
    report.totals.partial,
    report.totals.none,
    report.totals.notExpected,
    report.totals.unavailable,
    report.totals.eligibleSeconds,
    report.totals.observedSeconds,
    report.totals.gapSeconds,
    report.totals.unclassifiedSeconds ?? "",
    report.totals.offTaskSeconds ?? "",
    report.totals.offTaskEventCount ?? "",
    report.totals.safetyAlertCount ?? "",
  ]);

  return `\uFEFF${[header, ...rows]
    .map((row) => row.map(formulaSafeCsvCell).join(","))
    .join("\r\n")}`;
}
