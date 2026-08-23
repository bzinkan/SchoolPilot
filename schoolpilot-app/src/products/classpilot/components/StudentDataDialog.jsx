import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Download, Users } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { apiRequest } from '../../../lib/queryClient';
import {
  formatStudentDataSeconds,
  normalizeStudentDataResponse,
  studentDataCsv,
  studentDataQueryUrl,
} from '../lib/studentData';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year', label: 'This Year' },
];

function downloadCsv(fileName, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function DomainRows({ domains, emptyMessage }) {
  if (!domains?.length) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-1.5">
      {domains.map((domain, index) => (
        <div
          key={domain.domain}
          className="flex items-center justify-between gap-3 rounded bg-muted/50 px-2 py-1 text-sm"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">{index + 1}.</span>
            <span className="truncate font-medium" title={domain.domain}>{domain.domain}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatStudentDataSeconds(domain.seconds)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function StudentDataDialog({ open, students, onOpenChange }) {
  const [period, setPeriod] = useState('today');
  const [studentId, setStudentId] = useState(null);
  const rosterStudents = useMemo(() => [...(students || [])], [students]);
  const queryUrl = studentDataQueryUrl({ period, studentId });
  const reportQuery = useQuery({
    queryKey: ['classpilot', 'student-data', period, studentId ?? 'class'],
    queryFn: () => apiRequest('GET', queryUrl),
    select: (payload) => normalizeStudentDataResponse(payload, { rosterStudents, studentId }),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const report = reportQuery.data;
  const selectedName = report?.student?.name
    ?? rosterStudents.find((student) => String(student.studentId ?? student.id) === String(studentId))?.studentName
    ?? 'Student';
  const aggregateUnavailable = [404, 405, 501].includes(reportQuery.error?.response?.status);

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) setStudentId(null);
    onOpenChange(nextOpen);
  };

  const handleExport = () => {
    if (!report) return;
    const suffix = studentId
      ? selectedName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Student'
      : 'Class';
    downloadCsv(
      `ClassPilot_${suffix}_${period}.csv`,
      studentDataCsv(report, { period, studentId }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-4xl overflow-y-auto" data-testid="dialog-student-data">
        <DialogHeader>
          <DialogTitle>Student Data</DialogTitle>
          <DialogDescription>
            Activity time is derived from monitoring heartbeats. Screenshots are not used for time calculations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex flex-wrap gap-2" aria-label="Student Data period">
            {PERIODS.map(({ key, label }) => (
              <Button
                key={key}
                type="button"
                variant={period === key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPeriod(key)}
                data-testid={`button-student-data-period-${key}`}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-2 border-b pb-2">
            <Button
              type="button"
              variant={!studentId ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setStudentId(null)}
            >
              Class
            </Button>
            {studentId && (
              <Button type="button" variant="default" size="sm" className="pointer-events-none">
                {selectedName}
              </Button>
            )}
          </div>

          {reportQuery.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground" role="status">
              Loading Student Data…
            </div>
          ) : reportQuery.isError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
              <p className="font-medium">Student Data couldn’t be loaded.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {aggregateUnavailable
                  ? 'This server does not support the aggregate Student Data contract yet. No per-student fallback requests were sent.'
                  : 'Try again. No individual fallback requests were sent.'}
              </p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => reportQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : studentId ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-6 text-sm">
                <span className="font-medium">
                  Monitored Time:{' '}
                  <span className="text-blue-600">
                    {formatStudentDataSeconds(report?.student?.monitoredSeconds)}
                  </span>
                </span>
                <span className="font-medium">
                  Sites Visited:{' '}
                  <span className="text-blue-600">{report?.student?.siteCount ?? 0}</span>
                </span>
              </div>
              <section className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Clock className="h-4 w-4 text-blue-600" />
                  Top Domains
                </h4>
                <DomainRows
                  domains={report?.student?.domains}
                  emptyMessage="No browsing data for this period"
                />
              </section>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Users className="h-4 w-4 text-blue-600" />
                  Students
                </h4>
                <div className="max-h-80 space-y-1.5 overflow-y-auto">
                  {(report?.students || []).map((student) => (
                    <button
                      key={student.studentId}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded bg-muted/50 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => setStudentId(student.studentId)}
                    >
                      <span className="truncate font-medium">{student.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {student.monitoredSeconds > 0
                          ? formatStudentDataSeconds(student.monitoredSeconds)
                          : 'No activity'}
                      </span>
                    </button>
                  ))}
                  {(report?.students || []).length === 0 && (
                    <p className="py-4 text-center text-sm text-muted-foreground">No students</p>
                  )}
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Clock className="h-4 w-4 text-blue-600" />
                  Top Domains (Class)
                </h4>
                <DomainRows
                  domains={report?.topDomains}
                  emptyMessage="No browsing data for this period"
                />
              </section>
            </div>
          )}

          {report?.revision != null && (
            <p className="text-xs text-muted-foreground" data-testid="student-data-revision">
              Aggregate revision: <code>{String(report.revision)}</code>
            </p>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={!report}
            className="flex items-center gap-1.5"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} data-testid="button-close-student-data">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
