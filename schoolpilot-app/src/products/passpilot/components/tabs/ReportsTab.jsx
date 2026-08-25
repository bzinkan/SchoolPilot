import { useState } from "react";
import { Card, CardContent } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { Label } from "../../../../components/ui/label";
import { Input } from "../../../../components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "../../../../hooks/use-toast";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { formatTime, formatHour, formatDateTime, startOfTodayInTimezone } from "../../../../lib/date-utils";
import { usePassNow } from "../LivePassDuration";
import {
  fetchAllPassPilotHistory,
  isCanonicalPassPilotSource,
  passPilotClassRequest,
  usePassPilotHistoryClasses,
} from "../../classData";
import {
  formatPassOverdueDuration,
  getCurrentSchoolWeekRange,
  getPassActualDurationMs,
  getPassIssuerLabel,
  getPassOverdueMs,
  getPassStatusLabel,
} from "../../passData";
import { encodePassPilotCsv } from "../../passCsv";

const DEFAULT_REPORT_FILTERS = Object.freeze({
  dateRange: 'today',
  grade: 'all',
  teacher: 'all',
  passType: 'all',
});

function reportClassFilterValue(item) {
  const type = item?.filterKey?.type
    || (item?.legacyGradeId || item?.historyOnly ? "gradeId" : "classId");
  const value = item?.filterKey?.value || item?.legacyGradeId || item?.classId || item?.id;
  return `${type}:${value}`;
}

function reportClassLabel(item) {
  if (item.historyOnly || item.migrationState === "history_only") return `${item.name} (History only)`;
  if (item.status && item.status !== "active") return `${item.name} (Archived)`;
  return item.name;
}

function reportIssuerLabel(issuer) {
  const displayName = issuer?.displayName || issuer?.name || "Former staff member";
  if (
    issuer?.status !== "former"
    || /^Former staff member$/i.test(displayName)
    || /\(Former staff\)$/i.test(displayName)
  ) {
    return displayName;
  }
  return `${displayName} (Former staff)`;
}

function ReportsTab() {
  const nowMs = usePassNow();
  const { school, isSchoolwideManager } = usePassPilotAuth();
  const tz = school?.schoolTimezone ?? "America/New_York";
  const { toast } = useToast();
  const classInventoryQuery = usePassPilotHistoryClasses(Boolean(school?.id), school?.id);
  const canonical = classInventoryQuery.isSuccess
    && isCanonicalPassPilotSource(classInventoryQuery.data?.source);
  const schoolId = school?.id || '';
  const [scopedFilters, setScopedFilters] = useState(() => ({
    schoolId,
    values: DEFAULT_REPORT_FILTERS,
  }));
  const filters = scopedFilters.schoolId === schoolId
    ? scopedFilters.values
    : DEFAULT_REPORT_FILTERS;
  const updateFilters = (updates) => {
    setScopedFilters({
      schoolId,
      values: { ...filters, ...updates },
    });
  };

  const [customDateRange, setCustomDateRange] = useState({
    startDate: '',
    endDate: ''
  });

  const {
    data: issuers = [],
    isLoading: issuersLoading,
    isError: issuersError,
    refetch: refetchIssuers,
  } = useQuery({
    queryKey: ['/api/passpilot/passes/issuers', school?.id],
    queryFn: () => passPilotClassRequest('GET', '/passpilot/passes/issuers'),
    select: (data) => Array.isArray(data?.issuers) ? data.issuers : [],
    enabled: Boolean(isSchoolwideManager && school?.id),
  });
  const requestedIssuerId = filters.teacher;
  const requestedIssuerIsValid = requestedIssuerId === 'all'
    || issuers.some((issuer) => issuer.id === requestedIssuerId);
  const effectiveIssuerId = isSchoolwideManager && requestedIssuerIsValid
    ? requestedIssuerId
    : isSchoolwideManager
      ? null
      : 'all';
  const issuerSelectionInvalid = Boolean(
    isSchoolwideManager
    && requestedIssuerId !== 'all'
    && !issuersLoading
    && !issuersError
    && !requestedIssuerIsValid
  );

  const currentWeekRange = filters.dateRange === 'week'
    ? getCurrentSchoolWeekRange(tz)
    : null;

  const calculateDuration = (pass) => {
    const durationMs = getPassActualDurationMs(pass);
    return durationMs === null ? null : Math.round(durationMs / (1000 * 60));
  };

  const {
    data: passes = [],
    isLoading: passesLoading,
    isError: passesError,
    refetch: refetchPasses,
  } = useQuery({
    queryKey: [
      '/api/passes/history',
      school?.id,
      isSchoolwideManager ? 'schoolwide' : 'assigned',
      canonical ? 'classpilot_groups' : 'legacy_grades',
      tz,
      filters.dateRange,
      currentWeekRange?.anchor || null,
      currentWeekRange?.start.toISOString() || null,
      filters.grade,
      effectiveIssuerId,
      filters.passType,
      JSON.stringify(customDateRange),
    ],
    refetchInterval: 30000,
    queryFn: async () => {
      const params = new URLSearchParams();

      if (filters.dateRange && filters.dateRange !== 'all') {
        const now = new Date();
        let dateStart = new Date();

        switch (filters.dateRange) {
          case 'today':
            dateStart = startOfTodayInTimezone(tz);
            params.append('dateStart', dateStart.toISOString());
            break;
          case 'week': {
            const weekRange = getCurrentSchoolWeekRange(tz, now);
            params.append('dateStart', weekRange.start.toISOString());
            params.append('dateEnd', weekRange.end.toISOString());
            break;
          }
          case 'month':
            dateStart.setMonth(now.getMonth() - 1);
            params.append('dateStart', dateStart.toISOString());
            break;
          case 'custom':
            if (customDateRange.startDate) {
              params.append('dateStart', new Date(customDateRange.startDate + 'T00:00:00').toISOString());
            }
            if (customDateRange.endDate) {
              params.append('dateEnd', new Date(customDateRange.endDate + 'T23:59:59').toISOString());
            }
            break;
        }
      }

      if (filters.grade && filters.grade !== 'all') {
        const selectedClass = (classInventoryQuery.data?.classes || [])
          .find((item) => reportClassFilterValue(item) === filters.grade);
        if (selectedClass) {
          const filterType = selectedClass.filterKey?.type
            || (selectedClass.legacyGradeId || selectedClass.historyOnly ? 'gradeId' : 'classId');
          const filterValue = selectedClass.filterKey?.value
            || selectedClass.legacyGradeId
            || selectedClass.classId
            || selectedClass.id;
          params.append(filterType, filterValue);
        }
      }
      if (isSchoolwideManager && effectiveIssuerId && effectiveIssuerId !== 'all') {
        params.append('teacherId', effectiveIssuerId);
      }
      if (filters.passType && filters.passType !== 'all') params.append('passType', filters.passType);

      const url = `/passes/history${params.toString() ? '?' + params.toString() : ''}`;
      return fetchAllPassPilotHistory(url);
    },
    enabled: classInventoryQuery.isSuccess
      && Boolean(school?.id)
      && effectiveIssuerId !== null,
    gcTime: 0,
  });

  const reportClasses = classInventoryQuery.data?.classes || [];
  const legacyHistoryClasses = reportClasses.filter((item) => (
    item.filterKey?.type === 'gradeId' || item.legacyGradeId || item.historyOnly
  ));
  const canonicalHistoryClasses = reportClasses.filter((item) => !legacyHistoryClasses.includes(item));

  const handleExportCSV = () => {
    if (!passes || passes.length === 0) {
      toast({ title: "No Data", description: "No pass data available to export.", variant: "destructive" });
      return;
    }

    const csvHeaders = ["Student Name", "Class", "Issued By", "Pass Type", "Destination", "Checkout Time", "Return Time", "Status", "Duration (min)"];
    const csvRows = passes.map((pass) => {
      const statusLabel = getPassStatusLabel(pass, nowMs);
      const isReturned = statusLabel === 'Returned' && Boolean(pass.returnedAt);
      const calculatedDuration = calculateDuration(pass);

      return [
        `${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || "Unknown",
        pass.className || pass.classNameSnapshot || pass.student?.grade || "Unknown",
        getPassIssuerLabel(pass),
        pass.destination || 'General',
        pass.customDestination || pass.destination || 'General',
        formatDateTime(pass.issuedAt, tz),
        isReturned ? formatDateTime(pass.returnedAt, tz) : "—",
        statusLabel,
        calculatedDuration !== null ? calculatedDuration : "—"
      ];
    });

    const csvContent = encodePassPilotCsv([csvHeaders, ...csvRows]);

    const blob = new Blob([csvContent], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pass-report-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);

    toast({ title: "Export Complete", description: "Pass report has been downloaded." });
  };

  // Calculate statistics
  const completedPasses = passes.filter(p => p.status === 'returned' && p.returnedAt);
  const passesWithDuration = completedPasses.map(p => ({
    ...p,
    calculatedDuration: calculateDuration(p)
  })).filter(p => p.calculatedDuration !== null);

  const stats = {
    totalPasses: passes.length,
    avgDuration: passesWithDuration.length > 0
      ? Math.round(passesWithDuration.reduce((sum, p) => sum + (p.calculatedDuration || 0), 0) / passesWithDuration.length * 10) / 10
      : 0,
    peakHour: passes.length > 0
      ? (() => {
          const hourCounts = {};
          passes.forEach(p => {
            const h = new Date(p.issuedAt).getHours();
            hourCounts[h] = (hourCounts[h] || 0) + 1;
          });
          const peakH = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
          return peakH !== undefined ? formatHour(new Date(2000, 0, 1, Number(peakH)).toISOString(), tz) : 'N/A';
        })()
      : 'N/A',
    uniqueStudents: new Set(passes.map(p => p.studentId)).size,
  };

  const getPassTypeFromDestination = (destination) => {
    const dest = destination?.toLowerCase() || '';
    if (dest.includes('nurse') || dest.includes('health')) return 'nurse';
    if (dest.includes('discipline') || dest.includes('office') || dest.includes('principal')) return 'discipline';
    return 'general';
  };

  const passTypeStats = {
    general: passes.filter(p => getPassTypeFromDestination(p.destination || '') === 'general').length,
    nurse: passes.filter(p => getPassTypeFromDestination(p.destination || '') === 'nurse').length,
    discipline: passes.filter(p => getPassTypeFromDestination(p.destination || '') === 'discipline').length,
  };

  // Today's activity (using school timezone)
  const todayStart = startOfTodayInTimezone(tz);
  const todaysPasses = passes.filter(pass => new Date(pass.issuedAt) >= todayStart);

  const recentActivity = todaysPasses.length > 0 ? todaysPasses
    .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime())
    .slice(0, 10)
    .map(pass => {
      const calculatedDuration = calculateDuration(pass);
      const statusLabel = getPassStatusLabel(pass, nowMs);
      const overdueDuration = getPassOverdueMs(pass, nowMs) !== null
        ? formatPassOverdueDuration(pass, nowMs)
        : null;
      const overdueLabel = overdueDuration === '<1 min'
        ? 'Overdue <1 min'
        : overdueDuration
          ? `Overdue by ${overdueDuration}`
          : null;
      const checkoutDestination = pass.customDestination
        ? ` - ${pass.customDestination}`
        : pass.destination
          ? ` to ${pass.destination}`
          : '';
      return {
        id: pass.id,
        studentName: `${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || 'Unknown',
        action: statusLabel === 'Returned'
          ? (calculatedDuration === null
              ? 'Returned (duration unavailable)'
              : `Returned after ${calculatedDuration} minutes`)
          : overdueLabel
            || (statusLabel === 'Still out' ? `Checked out${checkoutDestination}` : statusLabel),
        status: statusLabel,
        destination: pass.destination,
        time: formatTime(pass.issuedAt, tz),
        date: 'Today',
        customDestination: pass.customDestination,
      };
    }) : [];

  if (classInventoryQuery.isLoading) {
    return <div className="p-8 text-center text-sm text-muted-foreground" aria-live="polite">Loading reports…</div>;
  }

  if (classInventoryQuery.isError) {
    return (
      <div className="p-4">
        <Card className="border-destructive/40">
          <CardContent className="p-8 text-center">
            <h2 className="text-lg font-semibold">Report classes couldn’t be loaded</h2>
            <p className="mt-2 text-sm text-muted-foreground">Try again. No report data was changed.</p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => classInventoryQuery.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (passesLoading) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground" aria-live="polite">
        Loading complete report data…
      </div>
    );
  }


  if (passesError) {
    return (
      <div className="p-4">
        <Card className="border-destructive/40">
          <CardContent className="p-8 text-center" aria-live="polite">
            <h2 className="text-lg font-semibold">Report data couldn’t be loaded</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Try again. No empty report or partial export was generated.
            </p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => refetchPasses()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-foreground mb-2">Reports</h2>
        <p className="text-sm text-muted-foreground">View and export student pass usage data</p>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <h3 className="font-medium text-foreground mb-4">Filters</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            <div>
              <Label htmlFor="dateRange">Date Range</Label>
              <Select value={filters.dateRange} onValueChange={(value) => updateFilters({ dateRange: value })}>
                <SelectTrigger id="dateRange"><SelectValue placeholder="Select date range" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">This Week</SelectItem>
                  <SelectItem value="month">This Month</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {filters.dateRange === 'custom' && (
              <>
                <div>
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input id="startDate" type="date" value={customDateRange.startDate} onChange={(e) => setCustomDateRange({ ...customDateRange, startDate: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="endDate">End Date</Label>
                  <Input id="endDate" type="date" value={customDateRange.endDate} onChange={(e) => setCustomDateRange({ ...customDateRange, endDate: e.target.value })} />
                </div>
              </>
            )}

            <div>
              <Label htmlFor="reportClass">Class</Label>
              <Select value={filters.grade} onValueChange={(value) => updateFilters({ grade: value })}>
                <SelectTrigger id="reportClass"><SelectValue placeholder="All Classes" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classes</SelectItem>
                  {canonicalHistoryClasses.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>ClassPilot classes</SelectLabel>
                      {canonicalHistoryClasses.map((item) => (
                        <SelectItem key={reportClassFilterValue(item)} value={reportClassFilterValue(item)}>
                          {reportClassLabel(item)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  {legacyHistoryClasses.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{canonical ? "Legacy class history" : "PassPilot classes"}</SelectLabel>
                      {legacyHistoryClasses.map((item) => (
                        <SelectItem key={reportClassFilterValue(item)} value={reportClassFilterValue(item)}>
                          {reportClassLabel(item)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            </div>

            {isSchoolwideManager ? (
              <div>
                <Label htmlFor="reportIssuer">Issued By</Label>
                <Select
                  value={effectiveIssuerId || requestedIssuerId}
                  onValueChange={(value) => updateFilters({ teacher: value })}
                  disabled={issuersLoading || issuersError}
                >
                  <SelectTrigger
                    id="reportIssuer"
                    aria-describedby={issuersLoading || issuersError || issuerSelectionInvalid ? "reportIssuerStatus" : undefined}
                  >
                    <SelectValue placeholder="All Issuers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Issuers</SelectItem>
                    {issuers.map((issuer) => (
                      <SelectItem key={issuer.id} value={issuer.id}>{reportIssuerLabel(issuer)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {issuersLoading ? (
                  <p id="reportIssuerStatus" className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                    Loading issuers…
                  </p>
                ) : issuersError ? (
                  <div id="reportIssuerStatus" className="mt-1 flex items-center gap-2 text-xs text-destructive" role="alert">
                    <span>Issuer options couldn’t be loaded.</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => refetchIssuers()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : issuerSelectionInvalid ? (
                  <div id="reportIssuerStatus" className="mt-1 flex items-center gap-2 text-xs text-destructive" role="alert">
                    <span>The selected issuer is no longer available.</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => updateFilters({ teacher: 'all' })}
                    >
                      Show all issuers
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div>
              <Label>Pass Type</Label>
              <Select value={filters.passType} onValueChange={(value) => updateFilters({ passType: value })}>
                <SelectTrigger><SelectValue placeholder="All Types" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="general">General</SelectItem>
                  <SelectItem value="nurse">Nurse</SelectItem>
                  <SelectItem value="discipline">Main Office</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {currentWeekRange ? (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="report-week-range">
              Current school week:{' '}
              <span className="font-medium text-foreground">{currentWeekRange.label}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Pass Type Breakdown */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <h3 className="font-medium text-foreground mb-4">Pass Type Breakdown</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="flex items-center justify-center space-x-2 mb-2">
                <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                <span className="text-sm font-medium">General</span>
              </div>
              <div className="text-2xl font-bold text-blue-600">{passTypeStats.general}</div>
              <div className="text-xs text-muted-foreground">Bathroom/General</div>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center space-x-2 mb-2">
                <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                <span className="text-sm font-medium">Nurse</span>
              </div>
              <div className="text-2xl font-bold text-red-600">{passTypeStats.nurse}</div>
              <div className="text-xs text-muted-foreground">Health Office</div>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center space-x-2 mb-2">
                <div className="w-3 h-3 bg-orange-500 rounded-full"></div>
                <span className="text-sm font-medium">Main Office</span>
              </div>
              <div className="text-2xl font-bold text-orange-600">{passTypeStats.discipline}</div>
              <div className="text-xs text-muted-foreground">Office/Admin</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Statistics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card><CardContent className="p-4 text-center"><div className="text-2xl font-bold text-primary">{stats.totalPasses}</div><div className="text-sm text-muted-foreground">Total Passes</div></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><div className="text-2xl font-bold text-secondary">{stats.avgDuration}</div><div className="text-sm text-muted-foreground">Avg Minutes</div></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><div className="text-2xl font-bold">{stats.peakHour}</div><div className="text-sm text-muted-foreground">Peak Hour</div></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><div className="text-2xl font-bold">{stats.uniqueStudents}</div><div className="text-sm text-muted-foreground">Students</div></CardContent></Card>
      </div>

      {/* Export */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">Export Data</h3>
            <Button onClick={handleExportCSV} className="bg-secondary hover:bg-secondary/90">
              Export CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardContent className="p-0">
          <div className="p-4 border-b border-border">
            <h3 className="font-medium text-foreground">Today's Activity</h3>
          </div>
          <div className="divide-y divide-border">
            {recentActivity.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-sm text-muted-foreground">No activity today</p>
              </div>
            ) : (
              recentActivity.map((activity) => (
                <div key={activity.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                        <span className="text-xs font-medium text-primary">
                          {activity.studentName.split(' ').map((n) => n[0]).join('')}
                        </span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center space-x-2">
                          <p className="text-sm font-medium">{activity.studentName}</p>
                          {(() => {
                            const destination = activity.customDestination || activity.destination || '';
                            const lowerDest = destination.toLowerCase();
                            let badgeClass = 'bg-blue-100 text-blue-700';
                            let displayText = 'General';

                            if (activity.customDestination) {
                              badgeClass = 'bg-purple-100 text-purple-700';
                              displayText = activity.customDestination;
                            } else if (lowerDest.includes('nurse')) {
                              badgeClass = 'bg-red-100 text-red-700';
                              displayText = 'Nurse';
                            } else if (lowerDest.includes('office')) {
                              badgeClass = 'bg-yellow-100 text-yellow-700';
                              displayText = 'Main Office';
                            }

                            return <span className={`px-2 py-1 text-xs rounded-full ${badgeClass}`}>{displayText}</span>;
                          })()}
                        </div>
                        <p className={`text-xs ${activity.status === 'Overdue'
                          ? 'font-semibold text-amber-700 dark:text-amber-400'
                          : 'text-muted-foreground'
                        }`}>
                          {activity.action}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{activity.time}</p>
                      <p className="text-xs text-muted-foreground">{activity.date}</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default ReportsTab;
