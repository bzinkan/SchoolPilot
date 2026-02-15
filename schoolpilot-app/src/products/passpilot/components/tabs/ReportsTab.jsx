import { useState, useEffect } from "react";
import { Card, CardContent } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { Label } from "../../../../components/ui/label";
import { Input } from "../../../../components/ui/input";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../../../hooks/use-toast";
import { apiRequest } from "../../../../lib/queryClient";
import { Trash2, AlertTriangle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../../../../components/ui/alert-dialog";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { formatTime, formatHour, formatDateTime, startOfTodayInTimezone } from "../../../../lib/date-utils";

function ReportsTab() {
  const { school } = usePassPilotAuth();
  const tz = school?.schoolTimezone ?? "America/New_York";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    dateRange: 'today',
    grade: 'all',
    teacher: 'all',
    passType: 'all',
  });

  const [customDateRange, setCustomDateRange] = useState({
    startDate: '',
    endDate: ''
  });

  const calculateDuration = (issuedAt, returnedAt) => {
    if (!returnedAt) return null;
    const issued = new Date(issuedAt);
    const returned = new Date(returnedAt);
    const diffMs = returned.getTime() - issued.getTime();
    return Math.max(0, Math.round(diffMs / (1000 * 60)));
  };

  const { data: passes = [], refetch } = useQuery({
    queryKey: ['/api/passes/history', JSON.stringify(filters), JSON.stringify(customDateRange)],
    refetchInterval: 3000,
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
          case 'week':
            dateStart.setDate(now.getDate() - 7);
            params.append('dateStart', dateStart.toISOString());
            break;
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

      if (filters.grade && filters.grade !== 'all') params.append('gradeId', filters.grade);
      if (filters.teacher && filters.teacher !== 'all') params.append('teacherId', filters.teacher);
      if (filters.passType && filters.passType !== 'all') params.append('passType', filters.passType);

      const url = `/passes/history${params.toString() ? '?' + params.toString() : ''}`;
      const data = await apiRequest('GET', url);
      return Array.isArray(data) ? data : [];
    },
    gcTime: 0,
  });

  useEffect(() => {
    refetch();
  }, [filters, customDateRange, refetch]);

  const deletePassMutation = useMutation({
    mutationFn: async (passId) => {
      return await apiRequest('DELETE', `/passes/${passId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/passes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes/history'] });
      toast({ title: "Pass Deleted", description: "The pass record has been removed." });
    },
    onError: () => {
      toast({ title: "Delete Failed", description: "Failed to delete the pass record.", variant: "destructive" });
    },
  });

  const { data: grades = [] } = useQuery({
    queryKey: ['/api/grades'],
    queryFn: async () => {
      const res = await fetch('/api/grades', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch grades');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? []),
  });

  const { data: teachers = [] } = useQuery({
    queryKey: ['/api/teachers'],
    queryFn: async () => {
      const res = await fetch('/api/teachers', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch teachers');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.teachers ?? data?.staff ?? []),
  });

  const handleExportCSV = () => {
    if (!passes || passes.length === 0) {
      toast({ title: "No Data", description: "No pass data available to export.", variant: "destructive" });
      return;
    }

    const csvHeaders = ["Student Name", "Grade/Class", "Teacher", "Pass Type", "Destination", "Checkout Time", "Return Time", "Duration (min)"];
    const csvRows = passes.map((pass) => {
      const isReturned = pass.returnedAt || pass.status === 'returned';
      const calculatedDuration = isReturned ? calculateDuration(pass.issuedAt, pass.returnedAt) : null;

      return [
        `${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || "Unknown",
        pass.student?.grade || "Unknown",
        `${pass.teacher?.firstName ?? ''} ${pass.teacher?.lastName ?? ''}`.trim() || "Unknown",
        pass.destination || 'General',
        pass.customDestination || pass.destination || 'General',
        formatDateTime(pass.issuedAt, tz),
        isReturned ? formatDateTime(pass.returnedAt, tz) : "Still Out",
        calculatedDuration !== null ? calculatedDuration : "Still Out"
      ];
    });

    const BOM = '\uFEFF';
    const csvContent = BOM + [csvHeaders, ...csvRows]
      .map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

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
    calculatedDuration: calculateDuration(p.issuedAt, p.returnedAt)
  })).filter(p => p.calculatedDuration !== null);

  const stats = {
    totalPasses: passes.length,
    avgDuration: passesWithDuration.length > 0
      ? Math.round(passesWithDuration.reduce((sum, p) => sum + (p.calculatedDuration || 0), 0) / passesWithDuration.length * 10) / 10
      : 0,
    peakHour: passes.length > 0
      ? formatHour(passes.reduce((latest, pass) =>
          new Date(pass.issuedAt) > new Date(latest.issuedAt) ? pass : latest
        ).issuedAt, tz)
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
      const calculatedDuration = calculateDuration(pass.issuedAt, pass.returnedAt);
      return {
        id: pass.id,
        studentName: `${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || 'Unknown',
        action: pass.status === 'returned'
          ? `Returned after ${calculatedDuration !== null ? calculatedDuration : 0} minutes`
          : `Checked out${pass.customDestination ? ` - ${pass.customDestination}` : (pass.destination ? ` to ${pass.destination}` : '')}`,
        destination: pass.destination,
        time: formatTime(pass.issuedAt, tz),
        date: 'Today',
        customDestination: pass.customDestination,
      };
    }) : [];

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
              <Select value={filters.dateRange} onValueChange={(value) => setFilters({ ...filters, dateRange: value })}>
                <SelectTrigger><SelectValue placeholder="Select date range" /></SelectTrigger>
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
                  <Input type="date" value={customDateRange.startDate} onChange={(e) => setCustomDateRange({ ...customDateRange, startDate: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="endDate">End Date</Label>
                  <Input type="date" value={customDateRange.endDate} onChange={(e) => setCustomDateRange({ ...customDateRange, endDate: e.target.value })} />
                </div>
              </>
            )}

            <div>
              <Label>Grade/Class</Label>
              <Select value={filters.grade} onValueChange={(value) => setFilters({ ...filters, grade: value })}>
                <SelectTrigger><SelectValue placeholder="All Grades" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Grades</SelectItem>
                  {grades.map((grade) => (
                    <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Teacher</Label>
              <Select value={filters.teacher} onValueChange={(value) => setFilters({ ...filters, teacher: value })}>
                <SelectTrigger><SelectValue placeholder="All Teachers" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Teachers</SelectItem>
                  {teachers.map((teacher) => (
                    <SelectItem key={teacher.id} value={teacher.id}>{teacher.name || teacher.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Pass Type</Label>
              <Select value={filters.passType} onValueChange={(value) => setFilters({ ...filters, passType: value })}>
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
                        <p className="text-xs text-muted-foreground">{activity.action}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">{activity.time}</p>
                        <p className="text-xs text-muted-foreground">{activity.date}</p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="flex items-center space-x-2">
                              <AlertTriangle className="h-5 w-5 text-destructive" />
                              <span>Delete Pass Record</span>
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete this pass record for <strong>{activity.studentName}</strong>?
                              This will permanently remove it from all reports.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deletePassMutation.mutate(activity.id)}
                              className="bg-destructive hover:bg-destructive/90"
                              disabled={deletePassMutation.isPending}
                            >
                              {deletePassMutation.isPending ? 'Deleting...' : 'Delete Pass'}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
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
