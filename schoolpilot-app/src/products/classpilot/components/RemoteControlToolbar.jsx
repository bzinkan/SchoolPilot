import { useState, useMemo } from "react";
import { TabletSmartphone, ListChecks, CheckSquare, XSquare, Users, BarChart3, Route, KeyRound, ChevronDown, Clock, Download, ClipboardCheck } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { startOfTodayInTimezone } from "../../../lib/date-utils";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Badge } from "../../../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { apiRequest } from "../../../lib/queryClient";
import { useQuery } from "@tanstack/react-query";

function RemoteControlToolbar({
  selectedStudentIds,
  students,
  selectedGrade,
  onGradeChange,
  userRole,
  coverageCount = 0,
  availableCount = 0,
  claimedCount = 0,
  pickupView = "class",
  onPickupViewChange,
  onOpenCoverage,
  canReroute = false,
  onReroute,
  canViewHistoricalTelemetry = false,
}) {
  const [showStudentDataDialog, setShowStudentDataDialog] = useState(false);
  const [selectedStudentForData, setSelectedStudentForData] = useState(null); // null = class view, studentId = student view
  const [studentDataTimePeriod, setStudentDataTimePeriod] = useState('today');
  const coverageRailButtonClass = (active = false) => [
    "h-9 rounded-md border px-4 text-sm font-semibold text-slate-950 shadow-sm transition-colors",
    "focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-1",
    active
      ? "border-yellow-500 bg-yellow-400 hover:bg-yellow-300"
      : "border-yellow-300 bg-yellow-50 hover:bg-yellow-100",
  ].join(" ");
  const coverageActionButtonClass = [
    "h-9 rounded-md border border-yellow-500 bg-yellow-400 px-4 text-sm font-semibold text-slate-950 shadow-sm",
    "hover:bg-yellow-300 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-1",
    "disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:disabled:border-slate-700 dark:disabled:bg-slate-800 dark:disabled:text-slate-500",
  ].join(" ");
  const coverageCountClass = "ml-1 min-w-5 rounded-full bg-white/85 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-slate-950 ring-1 ring-yellow-700/20";

  // Fetch settings for grade levels
  const { data: settings } = useQuery({
    queryKey: ['/api/settings'],
    queryFn: () => apiRequest('GET', '/settings'),
    select: (data) => data?.settings ?? data ?? null,
  });

  // Sort students alphabetically by name
  const sortedStudents = [...students].sort((a, b) => {
    const nameA = a.studentName || '';
    const nameB = b.studentName || '';
    return nameA.localeCompare(nameB);
  });

  // Date range for student data
  const schoolTz = settings?.schoolTimezone || 'America/New_York';
  const studentDataDateStart = useMemo(() => {
    const now = new Date();
    switch (studentDataTimePeriod) {
      case 'today': return startOfTodayInTimezone(schoolTz).toISOString();
      case 'week': { const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString(); }
      case 'month': { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d.toISOString(); }
      case 'year': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d.toISOString(); }
      default: return startOfTodayInTimezone(schoolTz).toISOString();
    }
  }, [studentDataTimePeriod, schoolTz]);

  // Fetch heartbeats for selected student with date filtering
  const { data: studentHeartbeats = [], isLoading: studentDataLoading } = useQuery({
    queryKey: ['/api/student-analytics', selectedStudentForData, studentDataDateStart],
    queryFn: () => {
      const params = new URLSearchParams();
      params.append('startDate', studentDataDateStart);
      params.append('limit', '2000');
      return apiRequest('GET', `/student-analytics/${selectedStudentForData}?${params.toString()}`);
    },
    select: (data) => data?.heartbeats ?? (Array.isArray(data) ? data : []),
    enabled: canViewHistoricalTelemetry && showStudentDataDialog && !!selectedStudentForData,
  });

  // Fetch heartbeats for ALL students in class view
  const { data: allStudentHeartbeats = {}, isLoading: classDataLoading } = useQuery({
    queryKey: ['/api/student-analytics-class', studentDataDateStart, showStudentDataDialog],
    queryFn: async () => {
      // Fetch heartbeats for each student in parallel
      const results = {};
      const fetches = sortedStudents.map(async (s) => {
        const params = new URLSearchParams();
        params.append('startDate', studentDataDateStart);
        params.append('limit', '500');
        try {
          const data = await apiRequest('GET', `/student-analytics/${s.studentId}?${params.toString()}`);
          results[s.studentId] = data?.heartbeats ?? (Array.isArray(data) ? data : []);
        } catch { /* ignore */ }
      });
      await Promise.all(fetches);
      return results;
    },
    enabled: canViewHistoricalTelemetry && showStudentDataDialog && !selectedStudentForData && sortedStudents.length > 0,
    gcTime: 0,
  });

  // Class-wide computed stats
  const classDataStats = useMemo(() => {
    if (selectedStudentForData) return null;

    const getLastName = (name) => {
      const parts = (name || '').trim().split(/\s+/);
      return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
    };

    // Per-student domain aggregation
    const studentList = sortedStudents.map(s => {
      const hbs = allStudentHeartbeats[s.studentId] || [];
      const domainMap = {};
      for (const hb of hbs) {
        if (!hb.activeTabUrl) continue;
        try {
          const domain = new URL(hb.activeTabUrl).hostname;
          domainMap[domain] = (domainMap[domain] || 0) + 10;
        } catch { /* skip */ }
      }
      const topDomain = Object.entries(domainMap).sort((a, b) => b[1] - a[1])[0];
      const totalTime = Object.values(domainMap).reduce((a, b) => a + b, 0);
      return {
        id: s.studentId,
        name: s.studentName || 'Unknown',
        totalTime,
        topDomain: topDomain ? topDomain[0] : null,
        siteCount: Object.keys(domainMap).length,
      };
    }).sort((a, b) => getLastName(a.name).localeCompare(getLastName(b.name)));

    // Class-wide top domains
    const classDomainMap = {};
    Object.values(allStudentHeartbeats).forEach(hbs => {
      for (const hb of hbs) {
        if (!hb.activeTabUrl) continue;
        try {
          const domain = new URL(hb.activeTabUrl).hostname;
          classDomainMap[domain] = (classDomainMap[domain] || 0) + 10;
        } catch { /* skip */ }
      }
    });
    const topDomains = Object.entries(classDomainMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    return { studentList, topDomains };
  }, [selectedStudentForData, allStudentHeartbeats, sortedStudents]);

  // Per-student computed stats
  const selectedStudentData = useMemo(() => {
    if (!selectedStudentForData) return null;
    const domainMap = {};
    for (const hb of studentHeartbeats) {
      if (!hb.activeTabUrl) continue;
      try {
        const domain = new URL(hb.activeTabUrl).hostname;
        domainMap[domain] = (domainMap[domain] || 0) + 10;
      } catch { /* skip */ }
    }
    const domains = Object.entries(domainMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const totalTime = domains.reduce((a, d) => a + d.value, 0);
    return { domains, totalTime, totalSites: domains.length };
  }, [selectedStudentForData, studentHeartbeats]);

  // CSV export
  const handleExportCSV = () => {
    const BOM = '\uFEFF';
    let csv = BOM;
    const period = studentDataTimePeriod === 'today' ? 'Today' : studentDataTimePeriod === 'week' ? 'This_Week' : studentDataTimePeriod === 'month' ? 'This_Month' : 'This_Year';

    if (!selectedStudentForData && classDataStats) {
      // Class view export
      csv += '"Student","Total Time","Top Domain","Sites Visited"\n';
      classDataStats.studentList.forEach(s => {
        const mins = Math.floor(s.totalTime / 60);
        const secs = s.totalTime % 60;
        const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        csv += `"${s.name}","${time}","${s.topDomain || 'None'}","${s.siteCount}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ClassPilot_Class_Data_${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (selectedStudentForData && selectedStudentData) {
      // Student view export
      const studentName = sortedStudents.find(s => s.studentId === selectedStudentForData)?.studentName || 'Student';
      csv += `"Student: ${studentName}"\n"Period: ${period}"\n\n`;
      csv += '"Domain","Time Spent"\n';
      selectedStudentData.domains.forEach(d => {
        const mins = Math.floor(d.value / 60);
        const secs = d.value % 60;
        const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        csv += `"${d.name}","${time}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ClassPilot_${studentName.replace(/\s+/g, '_')}_${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const CHART_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  ];

  return (
    <>
      <div className="border-b border-border bg-muted/30 px-6 py-4 mb-8">
        <div className="max-w-screen-2xl mx-auto">
          {/* Top Row: utility tools + centered coverage controls */}
          <div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 lg:justify-start">
              {userRole === 'admin' && settings?.gradeLevels && settings.gradeLevels.length > 0 && (
                <Tabs value={selectedGrade} onValueChange={onGradeChange}>
                  <TabsList className="flex-wrap h-auto gap-2 p-1.5 bg-muted/50 rounded-xl">
                    {settings.gradeLevels.map((grade) => (
                      <TabsTrigger
                        key={grade}
                        value={grade}
                        data-testid={`tab-grade-${grade}`}
                        className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg px-5 py-2.5 font-medium transition-all duration-200 data-[state=active]:shadow-md"
                      >
                        {grade}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              {canViewHistoricalTelemetry && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowStudentDataDialog(true)}
                  data-testid="button-student-data-tab"
                >
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Student Data
                </Button>
              )}
            </div>

            <div className="flex justify-center">
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-yellow-300 bg-yellow-50/80 p-1.5 shadow-sm" data-testid="coverage-action-rail">
              {onPickupViewChange && (
                <div className="flex flex-wrap items-center justify-center gap-1.5" data-testid="student-pickup-view-tabs">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onPickupViewChange("class")}
                    data-testid="button-view-class-students"
                    className={coverageRailButtonClass(pickupView === "class")}
                  >
                    Class
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onPickupViewChange("available")}
                    data-testid="button-view-available-students"
                    className={coverageRailButtonClass(pickupView === "available")}
                  >
                    Available
                    {availableCount > 0 && (
                      <span className={coverageCountClass}>
                        {availableCount}
                      </span>
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onPickupViewChange("claimed")}
                    data-testid="button-view-claimed-students"
                    className={coverageRailButtonClass(pickupView === "claimed")}
                  >
                    Claimed
                    {claimedCount > 0 && (
                      <span className={coverageCountClass}>
                        {claimedCount}
                      </span>
                    )}
                  </Button>
                </div>
              )}
              {onOpenCoverage && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onOpenCoverage}
                  data-testid="button-coverage-tab"
                  title={coverageCount > 0 ? `${coverageCount} claimed group${coverageCount === 1 ? "" : "s"} assigned to you` : "Open coverage setup"}
                  className={coverageActionButtonClass}
                >
                  <ClipboardCheck className="h-4 w-4 mr-2" />
                  Coverage
                  {coverageCount > 0 && (
                    <span className={coverageCountClass}>
                      {coverageCount}
                    </span>
                  )}
                </Button>
              )}
              {onReroute && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onReroute}
                  disabled={selectedStudentIds.size === 0 || !canReroute}
                  data-testid="button-reroute-selected"
                  title={!canReroute ? "Create a Supervision Group with assigned staff before sending students" : "Send selected students to assigned staff"}
                  className={coverageActionButtonClass}
                >
                  <Route className="h-4 w-4 mr-2" />
                  Send to...
                </Button>
              )}
              </div>
            </div>

            <div className="hidden lg:block" />
          </div>
        </div>
      </div>

      {/* Student Data Dialog */}
      <Dialog open={showStudentDataDialog} onOpenChange={(open) => {
        setShowStudentDataDialog(open);
        if (!open) setSelectedStudentForData(null);
      }}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto" data-testid="dialog-student-data">
          <DialogHeader>
            <DialogTitle>Student Data</DialogTitle>
            <DialogDescription>
              View browsing activity for your class or individual students
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {/* Time Period Selector */}
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'today', label: 'Today' },
                { key: 'week', label: 'This Week' },
                { key: 'month', label: 'This Month' },
                { key: 'year', label: 'This Year' },
              ].map(({ key, label }) => (
                <Button
                  key={key}
                  variant={studentDataTimePeriod === key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStudentDataTimePeriod(key)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {/* Class / Student Tab Switcher */}
            <div className="flex items-center gap-2 border-b pb-2">
              <Button
                variant={!selectedStudentForData ? "default" : "ghost"}
                size="sm"
                onClick={() => setSelectedStudentForData(null)}
              >
                Class
              </Button>
              {selectedStudentForData && (
                <Button variant="default" size="sm" className="pointer-events-none">
                  {sortedStudents.find(s => s.studentId === selectedStudentForData)?.studentName || 'Student'}
                </Button>
              )}
            </div>

            {!selectedStudentForData ? (
              /* ========== CLASS VIEW ========== */
              classDataLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading class data...</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Students List */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-blue-600" />
                      Students
                    </h4>
                    <div className="space-y-1.5 max-h-80 overflow-y-auto">
                      {(classDataStats?.studentList || []).map((s) => {
                        const mins = Math.floor(s.totalTime / 60);
                        const secs = s.totalTime % 60;
                        const time = s.totalTime > 0 ? (mins > 0 ? `${mins}m ${secs}s` : `${secs}s`) : 'No activity';
                        return (
                          <div
                            key={s.id}
                            className="flex items-center justify-between text-sm py-1.5 px-2 rounded bg-muted/50 cursor-pointer hover:bg-muted transition-colors"
                            onClick={() => setSelectedStudentForData(s.id)}
                          >
                            <span className="font-medium">{s.name}</span>
                            <span className={`text-xs ${s.totalTime === 0 ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
                              {time}
                            </span>
                          </div>
                        );
                      })}
                      {(classDataStats?.studentList || []).length === 0 && (
                        <p className="text-sm text-muted-foreground py-4 text-center">No students</p>
                      )}
                    </div>
                  </div>

                  {/* Top Domains */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-blue-600" />
                      Top Domains (Class)
                    </h4>
                    <div className="space-y-1.5">
                      {(classDataStats?.topDomains || []).length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">No browsing data this period</p>
                      ) : (classDataStats?.topDomains || []).map((d, i) => {
                        const mins = Math.floor(d.value / 60);
                        const secs = d.value % 60;
                        const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded bg-muted/50">
                            <span className="flex items-center gap-2">
                              <span className="text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
                              <span className="font-medium truncate" title={d.name}>{d.name}</span>
                            </span>
                            <span className="text-muted-foreground text-xs shrink-0">{time}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )
            ) : (
              /* ========== STUDENT VIEW ========== */
              studentDataLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading student data...</div>
              ) : (
                <div className="space-y-4">
                  {/* Summary */}
                  <div className="flex items-center gap-6 text-sm">
                    <span className="font-medium">
                      Total Time: <span className="text-blue-600">
                        {selectedStudentData ? (() => {
                          const m = Math.floor(selectedStudentData.totalTime / 60);
                          const s = selectedStudentData.totalTime % 60;
                          return m > 0 ? `${m}m ${s}s` : `${s}s`;
                        })() : '0s'}
                      </span>
                    </span>
                    <span className="font-medium">
                      Sites Visited: <span className="text-blue-600">{selectedStudentData?.totalSites || 0}</span>
                    </span>
                  </div>

                  {/* Domain list */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-blue-600" />
                      Websites Visited
                    </h4>
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {(!selectedStudentData || selectedStudentData.domains.length === 0) ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">No browsing data this period</p>
                      ) : selectedStudentData.domains.map((d, i) => {
                        const mins = Math.floor(d.value / 60);
                        const secs = d.value % 60;
                        const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded bg-muted/50">
                            <span className="flex items-center gap-2">
                              <span className="text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
                              <span className="font-medium truncate" title={d.name}>{d.name}</span>
                            </span>
                            <span className="text-muted-foreground text-xs shrink-0">{time}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
          <DialogFooter className="flex justify-between sm:justify-between">
            <Button variant="outline" size="sm" onClick={handleExportCSV} className="flex items-center gap-1.5">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => setShowStudentDataDialog(false)} data-testid="button-close-student-data">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default RemoteControlToolbar;
