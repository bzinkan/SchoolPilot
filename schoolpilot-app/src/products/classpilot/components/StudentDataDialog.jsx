import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Download, RefreshCw, Users } from 'lucide-react';

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
  isProvisionalStudentDataState,
  normalizeStudentDataResponse,
  normalizeStudentDataScopesResponse,
  studentDataActivityLabel,
  studentDataCsv,
  studentDataQueryUrl,
  studentDataScopesQueryUrl,
  studentDataStateLabel,
} from '../lib/studentData';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year', label: 'This Year' },
];
const PROVISIONAL_REFRESH_MS = 30_000;
const FINAL_REFRESH_MS = 60_000;
const EMPTY_SCOPES = Object.freeze([]);
const STUDENT_ROW_HEIGHT = 40;
const STUDENT_VIEWPORT_HEIGHT = 320;
const STUDENT_ROW_OVERSCAN = 4;

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

function safeFileSegment(value, fallback) {
  return String(value || '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function responseStatus(error) {
  return Number(error?.response?.status) || null;
}

function responseCode(error) {
  return typeof error?.response?.data?.code === 'string' ? error.response.data.code : null;
}

function contractUnsupported(error) {
  return [405, 501].includes(responseStatus(error))
    || responseCode(error) === 'CLASSPILOT_STUDENT_DATA_UNSUPPORTED';
}

function formatAsOf(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function ActivityRows({ activities, emptyMessage }) {
  if (!activities?.length) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const hasUnspecifiedWorkspaceActivity = activities.some(
    (activity) => activity.kind === 'google_workspace_unspecified',
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {activities.map((activity, index) => {
          const label = studentDataActivityLabel(activity);
          const showDomain = label !== activity.domain;
          return (
            <div
              key={`${activity.kind}:${activity.domain}`}
              className="flex items-center justify-between gap-3 rounded bg-muted/50 px-2 py-1 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">{index + 1}.</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium" title={label}>{label}</span>
                  {showDomain ? (
                    <span className="truncate text-xs text-muted-foreground" title={activity.domain}>
                      {activity.domain}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatStudentDataSeconds(activity.seconds)}
              </span>
            </div>
          );
        })}
      </div>
      {hasUnspecifiedWorkspaceActivity ? (
        <p className="text-xs text-muted-foreground" data-testid="student-data-workspace-legacy-note">
          Older Google Workspace activity may not identify the specific app. App-level detail begins with newly recorded activity.
        </p>
      ) : null}
    </div>
  );
}

function VirtualStudentRows({ students, onSelect }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const viewportRef = useRef(null);
  const buttonRefs = useRef(new Map());
  const focusRequestRef = useRef(null);
  const viewportHeight = Math.min(
    STUDENT_VIEWPORT_HEIGHT,
    Math.max(STUDENT_ROW_HEIGHT, students.length * STUDENT_ROW_HEIGHT),
  );
  const maxScrollTop = Math.max(0, (students.length * STUDENT_ROW_HEIGHT) - viewportHeight);
  const effectiveScrollTop = Math.min(scrollTop, maxScrollTop);
  const effectiveActiveIndex = Math.min(activeIndex, Math.max(0, students.length - 1));

  useEffect(() => {
    setScrollTop((current) => {
      const clamped = Math.min(current, maxScrollTop);
      if (viewportRef.current && viewportRef.current.scrollTop !== clamped) {
        viewportRef.current.scrollTop = clamped;
      }
      return clamped;
    });
  }, [maxScrollTop]);

  const firstVisible = Math.floor(effectiveScrollTop / STUDENT_ROW_HEIGHT);
  const start = Math.max(0, firstVisible - STUDENT_ROW_OVERSCAN);
  const visibleCount = Math.ceil(STUDENT_VIEWPORT_HEIGHT / STUDENT_ROW_HEIGHT);
  const end = Math.min(students.length, firstVisible + visibleCount + STUDENT_ROW_OVERSCAN);
  const visibleStudents = students.slice(start, end);

  useEffect(() => {
    const requestedIndex = focusRequestRef.current;
    const requestedButton = requestedIndex == null ? null : buttonRefs.current.get(requestedIndex);
    if (!requestedButton) return;
    focusRequestRef.current = null;
    requestedButton.focus();
  }, [effectiveActiveIndex, start, end]);

  const focusStudentIndex = (requestedIndex) => {
    if (students.length === 0) return;
    const nextIndex = Math.max(0, Math.min(requestedIndex, students.length - 1));
    const rowTop = nextIndex * STUDENT_ROW_HEIGHT;
    const rowBottom = rowTop + STUDENT_ROW_HEIGHT;
    let nextScrollTop = effectiveScrollTop;
    if (rowTop < effectiveScrollTop) nextScrollTop = rowTop;
    if (rowBottom > effectiveScrollTop + viewportHeight) {
      nextScrollTop = rowBottom - viewportHeight;
    }
    nextScrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    focusRequestRef.current = nextIndex;
    setActiveIndex(nextIndex);
    setScrollTop(nextScrollTop);
    if (viewportRef.current) viewportRef.current.scrollTop = nextScrollTop;
  };

  const handleStudentKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowDown') nextIndex = index + 1;
    if (event.key === 'ArrowUp') nextIndex = index - 1;
    if (event.key === 'PageDown') nextIndex = index + visibleCount;
    if (event.key === 'PageUp') nextIndex = index - visibleCount;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = students.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    focusStudentIndex(nextIndex);
  };

  const handleScroll = (event) => {
    const nextScrollTop = Math.min(event.currentTarget.scrollTop, maxScrollTop);
    const nextFirstVisible = Math.floor(nextScrollTop / STUDENT_ROW_HEIGHT);
    const nextStart = Math.max(0, nextFirstVisible - STUDENT_ROW_OVERSCAN);
    const nextEnd = Math.min(
      students.length,
      nextFirstVisible + visibleCount + STUDENT_ROW_OVERSCAN,
    );
    setScrollTop(nextScrollTop);
    setActiveIndex((current) => (
      current < nextStart || current >= nextEnd
        ? Math.min(nextFirstVisible, Math.max(0, students.length - 1))
        : current
    ));
  };

  return (
    <div
      ref={viewportRef}
      className="overflow-y-auto"
      style={{ height: viewportHeight }}
      onScroll={handleScroll}
      role="list"
      aria-label="Students in this Student Data scope"
      data-testid="student-data-student-list"
    >
      <div className="relative" style={{ height: students.length * STUDENT_ROW_HEIGHT }}>
        {visibleStudents.map((student, index) => {
          const absoluteIndex = start + index;
          return (
            <div
              key={student.studentId}
              className="absolute inset-x-0 pr-1"
              style={{
                height: STUDENT_ROW_HEIGHT,
                transform: `translateY(${absoluteIndex * STUDENT_ROW_HEIGHT}px)`,
              }}
              role="listitem"
              aria-posinset={absoluteIndex + 1}
              aria-setsize={students.length}
            >
              <button
                ref={(node) => {
                  if (node) buttonRefs.current.set(absoluteIndex, node);
                  else buttonRefs.current.delete(absoluteIndex);
                }}
                type="button"
                className="flex h-9 w-full items-center justify-between gap-3 rounded bg-muted/50 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => onSelect(student)}
                onFocus={() => setActiveIndex(absoluteIndex)}
                onKeyDown={(event) => handleStudentKeyDown(event, absoluteIndex)}
                tabIndex={effectiveActiveIndex === absoluteIndex ? 0 : -1}
                data-testid={`button-student-data-student-${student.studentId}`}
              >
                <span className="truncate font-medium">{student.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {student.monitoredSeconds > 0
                    ? formatStudentDataSeconds(student.monitoredSeconds)
                    : 'No activity'}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DataState({ report }) {
  if (!report) return null;
  const provisional = isProvisionalStudentDataState(report.dataState);
  const stateLabel = studentDataStateLabel(report.dataState);
  const asOf = report.provisionalAsOf || report.asOf;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      data-testid="student-data-freshness"
    >
      <span
        className={provisional
          ? 'rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 font-semibold text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200'
          : 'rounded-full border border-border bg-muted px-2 py-0.5 font-semibold text-foreground'}
        data-testid="student-data-state"
      >
        {stateLabel}
      </span>
      <span>As of {formatAsOf(asOf)}</span>
      {report.dataState === 'live' ? <span>Updates about every 30 seconds</span> : null}
      {report.dataState === 'finalizing' ? <span>Waiting for the completed class report</span> : null}
    </div>
  );
}

function emptyScopeMessage(scope) {
  if (scope?.kind === 'class') return 'This class roster is empty.';
  if (scope?.kind === 'mine') return 'No students are assigned to your classes.';
  return 'No active students are available for this school.';
}

export default function StudentDataDialog({
  open,
  schoolId,
  viewerId,
  viewerRole,
  onOpenChange,
}) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState('today');
  const [scopeChoice, setScopeChoice] = useState(null);
  const [studentChoice, setStudentChoice] = useState(null);
  const [accessChanged, setAccessChanged] = useState(false);
  const previousAuthorizationContextRef = useRef(null);
  const previousReportContextRef = useRef(null);
  const schoolKey = schoolId || 'no-school';
  const viewerKey = viewerId || 'no-viewer';
  const roleKey = viewerRole || 'no-role';
  const authorizationContextKey = `${schoolKey}\u0000${viewerKey}\u0000${roleKey}`;

  useEffect(() => () => {
    queryClient.removeQueries({
      queryKey: ['classpilot', 'student-data', schoolKey, viewerKey, roleKey],
    });
  }, [queryClient, roleKey, schoolKey, viewerKey]);

  useEffect(() => {
    const previous = previousAuthorizationContextRef.current;
    if (previous && previous.contextKey !== authorizationContextKey) {
      queryClient.removeQueries({
        queryKey: [
          'classpilot',
          'student-data',
          previous.schoolKey,
          previous.viewerKey,
          previous.roleKey,
        ],
      });
    }
    previousAuthorizationContextRef.current = {
      contextKey: authorizationContextKey,
      schoolKey,
      viewerKey,
      roleKey,
    };
  }, [authorizationContextKey, queryClient, roleKey, schoolKey, viewerKey]);

  const scopesQuery = useQuery({
    queryKey: ['classpilot', 'student-data', schoolKey, viewerKey, roleKey, 'scopes'],
    queryFn: () => apiRequest('GET', studentDataScopesQueryUrl()),
    select: normalizeStudentDataScopesResponse,
    enabled: open && Boolean(schoolId && viewerId),
    retry: false,
    staleTime: 0,
    refetchInterval: open ? PROVISIONAL_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const scopesStatus = responseStatus(scopesQuery.error);
  const scopesAccessDenied = scopesStatus === 401 || scopesStatus === 403;
  const scopes = scopesAccessDenied ? EMPTY_SCOPES : scopesQuery.data?.scopes || EMPTY_SCOPES;

  useEffect(() => {
    if (!scopesAccessDenied) return;
    queryClient.removeQueries({
      queryKey: [
        'classpilot',
        'student-data',
        schoolKey,
        viewerKey,
        roleKey,
        'report',
      ],
    });
  }, [queryClient, roleKey, schoolKey, scopesAccessDenied, viewerKey]);

  const teacherHasNoAssignedClasses = viewerRole === 'teacher'
    && scopesQuery.isSuccess
    && !scopes.some((scope) => scope.kind === 'class');

  const chosenScopeKey = scopeChoice?.authorizationContextKey === authorizationContextKey
    ? scopeChoice.scopeKey
    : null;
  const selectedScope = useMemo(
    () => scopes.find((scope) => scope.key === chosenScopeKey)
      || scopes.find((scope) => scope.key === scopesQuery.data?.defaultScopeKey)
      || scopes[0]
      || null,
    [chosenScopeKey, scopes, scopesQuery.data?.defaultScopeKey],
  );

  const reportContextKey = selectedScope
    ? `${schoolKey}\u0000${viewerKey}\u0000${roleKey}\u0000${selectedScope.key}`
    : null;

  useEffect(() => {
    const previous = previousReportContextRef.current;
    if (previous && previous.contextKey !== reportContextKey) {
      queryClient.removeQueries({
        queryKey: [
          'classpilot',
          'student-data',
          previous.schoolKey,
          previous.viewerKey,
          previous.roleKey,
          'report',
          previous.scopeKey,
        ],
      });
    }
    previousReportContextRef.current = reportContextKey
      ? { contextKey: reportContextKey, schoolKey, viewerKey, roleKey, scopeKey: selectedScope.key }
      : null;
  }, [queryClient, reportContextKey, roleKey, schoolKey, selectedScope?.key, viewerKey]);

  const selectedStudent = studentChoice?.reportContextKey === reportContextKey
    ? studentChoice.student
    : null;
  const studentId = selectedStudent?.studentId || null;
  const reportUrl = selectedScope
    ? studentDataQueryUrl({ period, scope: selectedScope, studentId })
    : null;
  const reportQuery = useQuery({
    queryKey: [
      'classpilot',
      'student-data',
      schoolKey,
      viewerKey,
      roleKey,
      'report',
      selectedScope?.key || 'no-scope',
      period,
      studentId || 'all-students',
    ],
    queryFn: () => apiRequest('GET', reportUrl),
    select: (payload) => normalizeStudentDataResponse(payload, {
      studentId,
      expectedScope: selectedScope,
      expectedPeriod: period,
    }),
    enabled: open
      && !scopesAccessDenied
      && !teacherHasNoAssignedClasses
      && Boolean(selectedScope && reportUrl),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (
      isProvisionalStudentDataState(query.state.data?.dataState)
        ? PROVISIONAL_REFRESH_MS
        : FINAL_REFRESH_MS
    ),
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const report = reportQuery.data;
  const selectedName = report?.student?.name ?? selectedStudent?.name ?? 'Student';
  const reportStatus = responseStatus(reportQuery.error);
  const reportErrorCode = responseCode(reportQuery.error);
  const hasStudents = (report?.students?.length || 0) > 0;
  const hasActivity = Number(report?.monitoredSeconds || 0) > 0;

  useEffect(() => {
    if (reportErrorCode !== 'CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND') return undefined;
    let cancelled = false;
    const deniedScopeKey = selectedScope?.key || null;
    const studentOnlyChange = Boolean(selectedStudent);
    void scopesQuery.refetch().then((result) => {
      if (cancelled) return;
      setAccessChanged(true);
      setStudentChoice(null);
      if (deniedScopeKey) {
        queryClient.removeQueries({
          queryKey: [
            'classpilot',
            'student-data',
            schoolKey,
            viewerKey,
            roleKey,
            'report',
            deniedScopeKey,
          ],
        });
      }
      if (studentOnlyChange) return;
      const refreshed = result.data;
      const nextScopeKey = refreshed?.scopes?.some((scope) => scope.key === refreshed.defaultScopeKey)
        && refreshed.defaultScopeKey !== deniedScopeKey
        ? refreshed.defaultScopeKey
        : refreshed?.scopes?.find((scope) => scope.key !== deniedScopeKey)?.key ?? null;
      setScopeChoice(nextScopeKey ? { authorizationContextKey, scopeKey: nextScopeKey } : null);
    });
    return () => { cancelled = true; };
  }, [reportErrorCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) setStudentChoice(null);
    onOpenChange(nextOpen);
  };

  const handleScopeChange = (event) => {
    setAccessChanged(false);
    setStudentChoice(null);
    setScopeChoice({ authorizationContextKey, scopeKey: event.target.value });
  };

  const handleExport = () => {
    if (!report || !selectedScope) return;
    const suffix = selectedStudent
      ? safeFileSegment(selectedName, 'Student')
      : safeFileSegment(selectedScope.label, 'Scope');
    downloadCsv(
      `ClassPilot_${suffix}_${period}.csv`,
      studentDataCsv(report, { period, studentId }),
    );
  };

  const retryScopes = () => {
    setStudentChoice(null);
    void scopesQuery.refetch();
  };

  const retryReport = () => {
    if (reportErrorCode === 'CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND') void scopesQuery.refetch();
    void reportQuery.refetch();
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
          {!schoolId || !viewerId ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="alert">
              <p className="font-medium">Choose a school before opening Student Data.</p>
            </div>
          ) : scopesQuery.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground" role="status">
              Loading authorized classes…
            </div>
          ) : scopesQuery.isError || scopesAccessDenied ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
              <p className="font-medium">Student Data couldn’t be opened.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {scopesStatus === 403
                  ? 'Your account is not authorized to view Student Data.'
                  : contractUnsupported(scopesQuery.error)
                    ? 'This server does not support teacher-scoped Student Data yet.'
                    : 'The authorized class list could not be loaded. Try again.'}
              </p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retryScopes}>
                Retry
              </Button>
            </div>
          ) : scopes.length === 0 || teacherHasNoAssignedClasses ? (
            <div className="rounded-md border border-border bg-muted/30 p-4" role="status" data-testid="student-data-no-scopes">
              <p className="font-medium">
                {viewerRole === 'teacher' ? 'No classes are assigned to you yet' : 'No Student Data scopes available'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {viewerRole === 'teacher'
                  ? 'Student Data will appear after a class is assigned to you.'
                  : 'There are no authorized school or class scopes to display.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <label className="min-w-56 space-y-1 text-sm font-medium" htmlFor="student-data-scope">
                  <span>Scope</span>
                  <select
                    id="student-data-scope"
                    value={selectedScope?.key || ''}
                    onChange={handleScopeChange}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="select-student-data-scope"
                  >
                    {scopes.map((scope) => (
                      <option key={scope.key} value={scope.key}>
                        {scope.label}{scope.isActive ? ' — Active now' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-wrap gap-2" aria-label="Student Data period" role="group">
                  {PERIODS.map(({ key, label }) => (
                    <Button
                      key={key}
                      type="button"
                      variant={period === key ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setPeriod(key)}
                      aria-pressed={period === key}
                      data-testid={`button-student-data-period-${key}`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-b pb-2" aria-label="Student Data breadcrumb">
                <Button
                  type="button"
                  variant={!selectedStudent ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setStudentChoice(null)}
                  data-testid="button-student-data-scope-root"
                >
                  {selectedScope?.label || 'Scope'}
                </Button>
                {selectedStudent ? (
                  <>
                    <span className="text-sm text-muted-foreground" aria-hidden="true">/</span>
                    <span
                      className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                      aria-current="page"
                    >
                      {selectedName}
                    </span>
                  </>
                ) : null}
              </div>

              {accessChanged ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="student-data-access-changed">
                  Your access changed. The authorized class list was refreshed.
                </div>
              ) : null}

              {reportQuery.isLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground" role="status">
                  Loading Student Data…
                </div>
              ) : reportQuery.isError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
                  <p className="font-medium">
                    {reportErrorCode === 'CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND'
                      ? 'Student Data access changed.'
                      : contractUnsupported(reportQuery.error)
                        ? 'Student Data is not supported by this server.'
                      : 'Student Data couldn’t be loaded.'}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {reportErrorCode === 'CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND'
                      ? 'This class or student is no longer authorized. Refresh the available scopes and try again.'
                      : reportStatus === 403
                        ? 'Your account is not authorized to view this Student Data.'
                      : 'Try again. No individual fallback requests were sent.'}
                  </p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retryReport}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              ) : (
                <>
                  <DataState report={report} />

                  {selectedStudent ? (
                    report?.student ? (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-6 text-sm">
                          <span className="font-medium">
                            Monitored Time:{' '}
                            <span className="text-blue-600">
                              {formatStudentDataSeconds(report.student.monitoredSeconds)}
                            </span>
                          </span>
                          <span className="font-medium">
                            Sites Visited:{' '}
                            <span className="text-blue-600">{report.student.siteCount}</span>
                          </span>
                        </div>
                        <section className="space-y-2">
                          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                            <Clock className="h-4 w-4 text-blue-600" />
                            Top Sites &amp; Apps
                          </h4>
                          <ActivityRows
                            activities={report.student.activities}
                            emptyMessage="No monitored activity for this student in this period"
                          />
                        </section>
                      </div>
                    ) : (
                      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm" role="status">
                        This student is no longer available in the selected scope.
                      </div>
                    )
                  ) : !hasStudents ? (
                    <div className="rounded-md border border-border bg-muted/30 p-4" role="status" data-testid="student-data-empty-roster">
                      <p className="font-medium">{emptyScopeMessage(selectedScope)}</p>
                    </div>
                  ) : (
                    <>
                      {!hasActivity ? (
                        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" role="status" data-testid="student-data-no-activity">
                          No monitored activity was recorded for this scope and period.
                        </div>
                      ) : null}
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <section className="space-y-2">
                          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                            <Users className="h-4 w-4 text-blue-600" />
                            Students
                          </h4>
                          <VirtualStudentRows
                            key={`${reportContextKey}\u0000${period}`}
                            students={report.students}
                            onSelect={(student) => setStudentChoice({ reportContextKey, student })}
                          />
                        </section>

                        <section className="space-y-2">
                          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                            <Clock className="h-4 w-4 text-blue-600" />
                            Top Sites &amp; Apps ({selectedScope?.label || 'Scope'})
                          </h4>
                          <ActivityRows
                            activities={report.topActivities}
                            emptyMessage="No monitored activity for this period"
                          />
                        </section>
                      </div>
                    </>
                  )}

                  {report?.revision != null ? (
                    <p className="text-xs text-muted-foreground" data-testid="student-data-revision">
                      Aggregate revision: <code>{String(report.revision)}</code>
                    </p>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={!report || reportQuery.isError || scopesAccessDenied}
            className="flex items-center gap-1.5"
            data-testid="button-export-student-data"
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
