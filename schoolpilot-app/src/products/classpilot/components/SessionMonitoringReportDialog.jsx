import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';

import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { useToast } from '../../../hooks/use-toast';
import { apiRequest } from '../../../lib/queryClient';
import api from '../../../shared/utils/api';
import {
  formatReportDateTime,
  formatReportDuration,
  normalizeSessionMonitoringReport,
} from '../lib/sessionMonitoringReport';

const STUDENT_CARD_STYLE = { contentVisibility: 'auto', containIntrinsicSize: '0 260px' };

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function statusLabel(value) {
  return String(value || 'unavailable').replace(/_/g, ' ');
}

function durationPair(monitoredSeconds, eligibleSeconds) {
  if (monitoredSeconds == null && eligibleSeconds == null) return 'Not included';
  return `${formatReportDuration(monitoredSeconds)} / ${formatReportDuration(eligibleSeconds)}`;
}

function unavailableDetailLabel(reportVersion) {
  return reportVersion < 2 ? 'Not included in v1' : 'Unavailable';
}

function offTaskLabel(seconds, eventCount, reportVersion) {
  if (seconds == null && eventCount == null) return unavailableDetailLabel(reportVersion);
  return `${formatReportDuration(seconds ?? 0)} · ${pluralize(eventCount ?? 0, 'event')}`;
}

function reviewBadgeVariant(status) {
  if (status === 'Escalated') return 'destructive';
  if (status === 'Confirmed') return 'secondary';
  return 'outline';
}

function MetricCard({ label, value, testId }) {
  return (
    <div className="rounded-lg border p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold leading-tight">{value}</p>
    </div>
  );
}

function SafetyAlertList({ alerts, timezone, emptyMessage }) {
  if (alerts.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <ul className="space-y-2" data-testid="session-report-safety-alerts">
      {alerts.map((alert) => (
        <li key={alert.id} className="grid gap-2 rounded-md border bg-muted/30 p-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="font-medium">{alert.category}</p>
            <p className="truncate text-muted-foreground" title={alert.domain || undefined}>
              {alert.domain || 'Domain unavailable'} · {formatReportDateTime(alert.occurredAt, timezone)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            <Badge variant="outline">Evidence: {alert.evidenceAvailability}</Badge>
            <Badge variant={reviewBadgeVariant(alert.reviewStatus)}>{alert.reviewStatus}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

const StudentReportCard = memo(function StudentReportCard({ student, reportVersion, timezone }) {
  const safetyEmptyMessage = reportVersion >= 2
    ? 'No safety alerts recorded for this student.'
    : 'Safety review details were not included in report v1.';

  return (
    <article
      className="space-y-3 rounded-lg border p-3"
      style={STUDENT_CARD_STYLE}
      data-testid={`session-report-student-${student.studentId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{student.studentName}</h3>
          <p className="text-xs text-muted-foreground">
            Coverage: {student.coveragePercent == null ? 'Not included' : `${student.coveragePercent}%`}
          </p>
        </div>
        <Badge variant="outline" className="capitalize">{statusLabel(student.status)}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Monitored / eligible</dt>
          <dd className="font-medium">{durationPair(student.monitoredSeconds, student.eligibleSeconds)}</dd>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Gaps</dt>
          <dd className="font-medium">{formatReportDuration(student.gapSeconds)}</dd>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Unclassified</dt>
          <dd className="font-medium">{student.unclassifiedSeconds == null ? unavailableDetailLabel(reportVersion) : formatReportDuration(student.unclassifiedSeconds)}</dd>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Off-task</dt>
          <dd className="font-medium">{offTaskLabel(student.offTaskSeconds, student.offTaskEventCount, reportVersion)}</dd>
        </div>
      </dl>

      <div className="grid gap-3 lg:grid-cols-2">
        <section aria-label={`Top normalized domains for ${student.studentName}`}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top normalized domains</h4>
          {student.topDomains.length === 0 ? (
            <p className="text-xs text-muted-foreground">No attributed domain time.</p>
          ) : (
            <ul className="space-y-1 text-xs" data-testid="session-report-top-domains">
              {student.topDomains.map((domain) => (
                <li key={domain.domain} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate" title={domain.domain}>{domain.domain}</span>
                  <span className="shrink-0 font-medium">{formatReportDuration(domain.seconds)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label={`Safety alerts for ${student.studentName}`}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Safety alerts</h4>
          <SafetyAlertList alerts={student.safetyAlerts} timezone={timezone} emptyMessage={safetyEmptyMessage} />
        </section>
      </div>
    </article>
  );
});

export default function SessionMonitoringReportDialog({ target, onClose }) {
  const { toast } = useToast();
  const {
    data: sessionReport,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['/api/classpilot/teaching-sessions/report', target?.id],
    queryFn: () => apiRequest(
      'GET',
      `/classpilot/teaching-sessions/${encodeURIComponent(target.id)}/report`,
    ),
    enabled: !!target?.id,
    retry: false,
    refetchInterval: (query) => query.state.data?.state === 'pending' ? 5000 : false,
  });
  const report = useMemo(
    () => sessionReport?.state === 'ready' && sessionReport.report
      ? normalizeSessionMonitoringReport(sessionReport.report)
      : null,
    [sessionReport],
  );

  const downloadEvents = async () => {
    if (!target?.id) return;
    try {
      const response = await api.get(
        `/classpilot/teaching-sessions/${encodeURIComponent(target.id)}/events/export.csv`,
        { responseType: 'blob' },
      );
      const blobUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `ClassPilot_${target.name.replace(/[^a-z0-9_-]+/gi, '_')}_Monitoring.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (downloadError) {
      toast({
        variant: 'destructive',
        title: 'Could not export monitoring activity',
        description: downloadError.response?.data?.error || downloadError.message,
      });
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden" data-testid="dialog-session-monitoring-report">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{target?.name} — Session Summary</DialogTitle>
            {report ? <Badge variant="outline">Report v{report.reportVersion}</Badge> : null}
          </div>
          <DialogDescription className="space-y-1">
            <span className="block">Activity time is derived from authenticated monitoring heartbeats. Screenshots are not used to calculate monitored time, domain time, gaps, or off-task duration.</span>
            <span className="block">Gaps identify missing telemetry only; they do not establish a cause or intentional behavior.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1">
          {(isLoading || sessionReport?.state === 'pending') && (
            <div className="flex items-center gap-3 rounded-lg border p-4 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Finalizing the immutable report after the 30-second settlement window…
            </div>
          )}
          {(error || sessionReport?.state === 'failed') && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {error?.response?.data?.code === 'SUMMARY_EXPIRED'
                ? 'This Session Summary has expired under the school’s retention policy.'
                : 'The Session Summary could not be generated. No “No activity” conclusion or summary email will be sent.'}
            </div>
          )}
          {report ? (
            <div className="space-y-4">
              {report.reportVersion < 2 ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="note">
                  This stored v1 report predates unclassified, off-task-duration, and safety-review details. Available heartbeat coverage and normalized domains are shown; missing v2 values are not inferred.
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <MetricCard label="Students" value={report.totals.roster} testId="session-report-student-count" />
                <MetricCard label="Monitored / eligible" value={durationPair(report.totals.monitoredSeconds, report.totals.eligibleSeconds)} testId="session-report-monitored-time" />
                <MetricCard label="Gaps" value={formatReportDuration(report.totals.gapSeconds)} testId="session-report-gap-time" />
                <MetricCard label="Unclassified" value={report.totals.unclassifiedSeconds == null ? unavailableDetailLabel(report.reportVersion) : formatReportDuration(report.totals.unclassifiedSeconds)} testId="session-report-unclassified-time" />
                <MetricCard label="Off-task" value={offTaskLabel(report.totals.offTaskSeconds, report.totals.offTaskEventCount, report.reportVersion)} testId="session-report-off-task" />
              </div>

              <p className="text-xs text-muted-foreground" data-testid="session-report-coverage-counts">
                {pluralize(report.totals.complete, 'complete record')} · {pluralize(report.totals.partial, 'partial record')} · {pluralize(report.totals.none, 'record with no telemetry')} · {pluralize(report.totals.unavailable, 'unavailable record')}
                {report.totals.safetyAlertCount == null ? ' · Safety detail not included in v1' : ` · ${pluralize(report.totals.safetyAlertCount, 'safety alert')}`}
              </p>
              {report.reportVersion >= 2 && (report.totals.safetyAlertCount || 0) > 0 ? (
                <p className="text-xs text-muted-foreground" role="note">
                  “Automated” means the alert was system-generated; it does not mean a person confirmed it.
                </p>
              ) : null}

              {report.unassignedSafetyAlerts.length > 0 ? (
                <section className="rounded-lg border p-3" aria-label="Session safety alerts">
                  <h3 className="mb-2 font-medium">Session safety alerts</h3>
                  <SafetyAlertList
                    alerts={report.unassignedSafetyAlerts}
                    timezone={report.timezone}
                    emptyMessage="No session-level safety alerts recorded."
                  />
                </section>
              ) : null}

              <div className="space-y-3">
                {report.students.length === 0 ? (
                  <div className="rounded-lg border p-4 text-sm text-muted-foreground">No student report rows are available.</div>
                ) : report.students.map((student) => (
                  <StudentReportCard
                    key={student.studentId}
                    student={student}
                    reportVersion={report.reportVersion}
                    timezone={report.timezone}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {sessionReport?.state === 'ready' && (
            <Button variant="outline" onClick={() => void downloadEvents()}>
              <Download className="mr-2 h-4 w-4" /> Export Monitoring CSV
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
