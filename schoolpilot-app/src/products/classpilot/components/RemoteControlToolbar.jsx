import { useState, useMemo } from "react";
import { MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, ListChecks, CheckSquare, XSquare, Users, BarChart3, Route, KeyRound, ChevronDown, Clock, Download, ClipboardCheck } from "lucide-react";
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
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useQuery } from "@tanstack/react-query";

function RemoteControlToolbar({
  selectedStudentIds,
  students,
  selectedGrade,
  onGradeChange,
  userRole,
  coverageCount = 0,
  onOpenCoverage,
  canReroute = false,
  onReroute,
}) {
  const [showOpenTab, setShowOpenTab] = useState(false);
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [showFlightPathDialog, setShowFlightPathDialog] = useState(false);
  const [showStudentDataDialog, setShowStudentDataDialog] = useState(false);
  const [showTabLimit, setShowTabLimit] = useState(false);
  const [showApplyScene, setShowApplyScene] = useState(false);
  const [showTempUnblock, setShowTempUnblock] = useState(false);
  const [targetUrl, setTargetUrl] = useState("");
  const [lockUrl, setLockUrl] = useState("");
  const [tabLimit, setTabLimit] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedStudentForData, setSelectedStudentForData] = useState(null); // null = class view, studentId = student view
  const [studentDataTimePeriod, setStudentDataTimePeriod] = useState('today');
  const [tempUnblockDomain, setTempUnblockDomain] = useState("");
  const [tempUnblockDuration, setTempUnblockDuration] = useState("5");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Fetch flight paths
  const { data: scenes = [] } = useQuery({
    queryKey: ['/api/flight-paths'],
    queryFn: () => apiRequest('GET', '/flight-paths'),
    select: (data) => Array.isArray(data) ? data : data?.flightPaths ?? [],
  });

  // Fetch settings for grade levels
  const { data: settings } = useQuery({
    queryKey: ['/api/settings'],
    queryFn: () => apiRequest('GET', '/settings'),
    select: (data) => data?.settings ?? data ?? null,
  });

  const handleOpenTab = async () => {
    if (!targetUrl) {
      toast({
        title: "Error",
        description: "Please enter a URL",
        variant: "destructive",
      });
      return;
    }

    // Validate selection before executing command
    if (!validateSelection()) {
      return;
    }

    // Normalize URL - add https:// if no protocol specified
    let normalizedUrl = targetUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/remote/open-tab", {
        url: normalizedUrl,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedStudentIds.size > 0
        ? `${selectedStudentIds.size} student(s)`
        : "all students";
      toast({
        title: "Success",
        description: `Opened ${normalizedUrl} on ${target}`,
      });
      setTargetUrl("");
      setShowOpenTab(false);
    } catch {
      toast({
        title: "Error",
        description: "Failed to open tab",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLockScreen = async () => {
    if (!lockUrl) {
      toast({
        title: "Error",
        description: "Please enter a URL to lock to",
        variant: "destructive",
      });
      return;
    }

    // Validate selection before executing command
    if (!validateSelection()) {
      return;
    }

    // Normalize URL - add https:// if no protocol specified
    let normalizedLockUrl = lockUrl.trim();
    if (!normalizedLockUrl.match(/^https?:\/\//i)) {
      normalizedLockUrl = 'https://' + normalizedLockUrl;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/remote/lock-screen", {
        url: normalizedLockUrl,
        targetDeviceIds: targetDeviceIdsArray
      });

      // Invalidate cache to update lock icon immediately
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

      const target = selectedStudentIds.size > 0
        ? `${selectedStudentIds.size} student(s)`
        : "all students";

      // Extract domain for display
      const domain = normalizedLockUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

      toast({
        title: "Screen Locked",
        description: `${target} locked to ${domain} - they can browse within this site`,
      });
      setLockUrl("");
      setShowLockScreen(false);
    } catch {
      toast({
        title: "Error",
        description: "Failed to lock screens",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTempUnblock = async () => {
    if (!tempUnblockDomain) {
      toast({
        title: "Error",
        description: "Please enter a domain to unblock",
        variant: "destructive",
      });
      return;
    }

    if (!validateSelection()) {
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/remote/temp-unblock", {
        domain: tempUnblockDomain.trim().replace(/^https?:\/\//, '').replace(/^www\./, ''),
        durationMinutes: parseInt(tempUnblockDuration) || 5,
        targetDeviceIds: targetDeviceIdsArray
      });

      const target = selectedStudentIds.size > 0
        ? `${selectedStudentIds.size} student(s)`
        : "all students";
      toast({
        title: "Success",
        description: `Temporarily unblocked ${tempUnblockDomain} for ${target} (${tempUnblockDuration} minutes)`,
      });
      setShowTempUnblock(false);
      setTempUnblockDomain("");
    } catch {
      toast({
        title: "Error",
        description: "Failed to temporarily unblock domain",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyTabLimit = async () => {
    const maxTabs = tabLimit ? parseInt(tabLimit, 10) : null;

    if (maxTabs !== null && (isNaN(maxTabs) || maxTabs < 1)) {
      toast({
        title: "Error",
        description: "Please enter a valid number of tabs (minimum 1)",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/remote/limit-tabs", { maxTabs });
      toast({
        title: "Success",
        description: maxTabs
          ? `Set tab limit to ${maxTabs} for all students`
          : "Removed tab limit for all students",
      });
      setTabLimit("");
      setShowTabLimit(false);
    } catch {
      toast({
        title: "Error",
        description: "Failed to apply tab limit",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyScene = async () => {
    if (!selectedSceneId) {
      toast({
        title: "Error",
        description: "Please select a flight path",
        variant: "destructive",
      });
      return;
    }

    // Validate selection before executing command
    if (!validateSelection()) {
      return;
    }

    const scene = scenes.find(s => s.id === selectedSceneId);
    if (!scene) {
      toast({
        title: "Error",
        description: "Flight path not found",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/remote/apply-flight-path", {
        flightPathId: selectedSceneId,
        allowedDomains: scene.allowedDomains,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedStudentIds.size > 0
        ? `${selectedStudentIds.size} student(s)`
        : "all students";
      toast({
        title: "Success",
        description: `Applied "${scene.flightPathName}" to ${target}`,
      });
      setSelectedSceneId("");
      setShowApplyScene(false);
    } catch {
      toast({
        title: "Error",
        description: "Failed to apply flight path",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Convert selected student IDs to device IDs for API calls
  const targetDeviceIdsArray = useMemo(() => {
    if (selectedStudentIds.size === 0) return undefined; // All students

    const deviceIds = [];
    students.forEach(student => {
      if (selectedStudentIds.has(student.studentId)) {
        // Add all devices for this student
        student.devices.forEach(device => {
          if (device.deviceId) {
            deviceIds.push(device.deviceId);
          }
        });
        // Also add primary device if it exists and isn't in the devices array
        if (student.primaryDeviceId && !deviceIds.includes(student.primaryDeviceId)) {
          deviceIds.push(student.primaryDeviceId);
        }
      }
    });

    // IMPORTANT: Return empty array (not undefined) when students selected but no devices
    // This prevents silently targeting "all students" when selected students are offline
    return deviceIds;
  }, [selectedStudentIds, students]);

  // Validate that selected students have active devices before executing commands
  const validateSelection = () => {
    // If students selected but none have devices, show warning
    if (selectedStudentIds.size > 0 && targetDeviceIdsArray && targetDeviceIdsArray.length === 0) {
      toast({
        title: "No Active Devices",
        description: "Selected students have no active devices. Make sure students are online before sending commands.",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

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
    enabled: showStudentDataDialog && !!selectedStudentForData,
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
    enabled: showStudentDataDialog && !selectedStudentForData && sortedStudents.length > 0,
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
          {/* Top Row: Grade Tabs + Student Data Button */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            {/* Left Side: Grade Tabs (Admin Only) */}
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

            {/* Right Side: Class Tools */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowStudentDataDialog(true)}
                data-testid="button-student-data-tab"
              >
                <BarChart3 className="h-4 w-4 mr-2" />
                Student Data
              </Button>
              {onOpenCoverage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onOpenCoverage}
                  data-testid="button-coverage-tab"
                  title={coverageCount > 0 ? `${coverageCount} active coverage context${coverageCount === 1 ? "" : "s"} assigned to you` : "Open Coverage"}
                >
                  <ClipboardCheck className="h-4 w-4 mr-2" />
                  Coverage
                  {coverageCount > 0 && (
                    <span className="ml-1 min-w-5 rounded-full bg-amber-400 px-1.5 py-0.5 text-center text-[11px] font-semibold leading-none text-slate-900">
                      {coverageCount}
                    </span>
                  )}
                </Button>
              )}
              {onReroute && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onReroute}
                  disabled={selectedStudentIds.size === 0 || !canReroute}
                  data-testid="button-reroute-selected"
                  title={!canReroute ? "Create an active coverage context before rerouting students" : "Move selected students into temporary coverage"}
                >
                  <Route className="h-4 w-4 mr-2" />
                  Reroute
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Open Tab Dialog */}
      <Dialog open={showOpenTab} onOpenChange={setShowOpenTab}>
        <DialogContent data-testid="dialog-open-tab">
          <DialogHeader>
            <DialogTitle>Open Tab on All Devices</DialogTitle>
            <DialogDescription>
              Enter a URL to open on all student devices. This will open a new tab with the specified URL.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="target-url">URL</Label>
              <Input
                id="target-url"
                placeholder="https://example.com"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                data-testid="input-target-url"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenTab(false)} data-testid="button-cancel-open-tab">
              Cancel
            </Button>
            <Button onClick={handleOpenTab} disabled={isLoading} data-testid="button-submit-open-tab">
              Open Tab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock Screen Dialog */}
      <Dialog open={showLockScreen} onOpenChange={setShowLockScreen}>
        <DialogContent data-testid="dialog-lock-screen">
          <DialogHeader>
            <DialogTitle>Lock Screens to Website</DialogTitle>
            <DialogDescription>
              Lock student screens to a specific website domain. Students can navigate freely within that site (e.g., ixl.com/math, ixl.com/science) but cannot leave the domain until unlocked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lock-url">Website URL</Label>
              <Input
                id="lock-url"
                placeholder="https://ixl.com or khanacademy.org"
                value={lockUrl}
                onChange={(e) => setLockUrl(e.target.value)}
                data-testid="input-lock-url"
              />
              <p className="text-xs text-muted-foreground">
                Students will be locked to this domain and can browse within it freely.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLockScreen(false)} data-testid="button-cancel-lock">
              Cancel
            </Button>
            <Button onClick={handleLockScreen} disabled={isLoading} data-testid="button-submit-lock">
              Lock Screens
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Temp Unblock Dialog */}
      <Dialog open={showTempUnblock} onOpenChange={setShowTempUnblock}>
        <DialogContent data-testid="dialog-temp-unblock">
          <DialogHeader>
            <DialogTitle>Temporarily Unblock Domain</DialogTitle>
            <DialogDescription>
              Allow temporary access to a blocked domain. This bypasses both school and teacher block lists for the specified duration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="temp-unblock-domain">Domain to Unblock</Label>
              <Input
                id="temp-unblock-domain"
                placeholder="e.g., youtube.com or docs.google.com"
                value={tempUnblockDomain}
                onChange={(e) => setTempUnblockDomain(e.target.value)}
                data-testid="input-temp-unblock-domain"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="temp-unblock-duration">Duration (minutes)</Label>
              <Select value={tempUnblockDuration} onValueChange={setTempUnblockDuration}>
                <SelectTrigger id="temp-unblock-duration" data-testid="select-temp-unblock-duration">
                  <SelectValue placeholder="Select duration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 minutes</SelectItem>
                  <SelectItem value="10">10 minutes</SelectItem>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTempUnblock(false)} data-testid="button-cancel-temp-unblock">
              Cancel
            </Button>
            <Button onClick={handleTempUnblock} disabled={isLoading} data-testid="button-submit-temp-unblock">
              Unblock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Limit Tabs Dialog */}
      <Dialog open={showTabLimit} onOpenChange={setShowTabLimit}>
        <DialogContent data-testid="dialog-limit-tabs">
          <DialogHeader>
            <DialogTitle>Limit Student Tabs</DialogTitle>
            <DialogDescription>
              Set the maximum number of tabs students can have open. Leave empty to remove the limit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tab-limit">Maximum Tabs (leave empty for unlimited)</Label>
              <Input
                id="tab-limit"
                type="number"
                min="1"
                placeholder="e.g., 5"
                value={tabLimit}
                onChange={(e) => setTabLimit(e.target.value)}
                data-testid="input-tab-limit"
              />
              <p className="text-xs text-muted-foreground">
                When a limit is set, the oldest tabs will be automatically closed if students exceed this number.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTabLimit(false)} data-testid="button-cancel-limit-tabs">
              Cancel
            </Button>
            <Button onClick={handleApplyTabLimit} disabled={isLoading} data-testid="button-submit-limit-tabs">
              Apply Tab Limit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyScene} onOpenChange={setShowApplyScene}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader>
            <DialogTitle>Apply Flight Path</DialogTitle>
            <DialogDescription>
              Select a flight path to apply. Students will only be able to access the allowed domains defined in the flight path.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="scene-select">Flight Path</Label>
              <Select value={selectedSceneId} onValueChange={setSelectedSceneId}>
                <SelectTrigger id="scene-select" data-testid="select-scene">
                  <SelectValue placeholder="Select a flight path" />
                </SelectTrigger>
                <SelectContent>
                  {scenes.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No flight paths available</div>
                  ) : (
                    scenes.map((scene) => (
                      <SelectItem key={scene.id} value={scene.id} data-testid={`select-scene-${scene.id}`}>
                        {scene.flightPathName}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedSceneId && (() => {
                const selectedScene = scenes.find(s => s.id === selectedSceneId);
                return selectedScene && selectedScene.allowedDomains ? (
                  <div className="mt-2 p-3 bg-muted rounded-md">
                    <p className="text-sm font-medium mb-1">Allowed Domains:</p>
                    <ul className="text-sm text-muted-foreground list-disc list-inside">
                      {selectedScene.allowedDomains.map((domain, index) => (
                        <li key={index}>{domain}</li>
                      ))}
                    </ul>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyScene(false)} data-testid="button-cancel-apply-flight-path">
              Cancel
            </Button>
            <Button onClick={handleApplyScene} disabled={isLoading || !selectedSceneId} data-testid="button-submit-apply-flight-path">
              Apply Flight Path
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Flight Path View Dialog */}
      <Dialog open={showFlightPathDialog} onOpenChange={setShowFlightPathDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh]" data-testid="dialog-flight-path-view">
          <DialogHeader>
            <DialogTitle>Student Flight Paths</DialogTitle>
            <DialogDescription>
              View which flight path each student is currently on
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Search students..."
              className="mb-4"
              data-testid="input-search-flight-path-students"
            />
            <div className="border rounded-lg overflow-hidden">
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-muted sticky top-0 z-10">
                    <tr>
                      <th className="text-left p-3 text-sm font-semibold">Student</th>
                      <th className="text-left p-3 text-sm font-semibold">Flight Path</th>
                      <th className="text-left p-3 text-sm font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sortedStudents.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="p-8 text-center text-muted-foreground">
                          No students found
                        </td>
                      </tr>
                    ) : (
                      sortedStudents.map((student) => (
                        <tr key={student.studentId} className="hover-elevate" data-testid={`row-student-flight-path-${student.studentId}`}>
                          <td className="p-3 text-sm font-medium">{student.studentName || 'Unnamed Student'}</td>
                          <td className="p-3 text-sm">
                            {student.flightPathActive && student.activeFlightPathName ? (
                              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800">
                                <Layers className="h-3 w-3 mr-1" />
                                {student.activeFlightPathName}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground italic">None</span>
                            )}
                          </td>
                          <td className="p-3 text-sm">
                            <Badge
                              variant="outline"
                              className={
                                student.status === 'online'
                                  ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800'
                                  : student.status === 'idle'
                                  ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800'
                                  : 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-950 dark:text-gray-400 dark:border-gray-800'
                              }
                            >
                              {student.status.charAt(0).toUpperCase() + student.status.slice(1)}
                            </Badge>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFlightPathDialog(false)} data-testid="button-close-flight-path-view">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
