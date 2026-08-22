import { useState, useMemo } from "react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { useToast } from "../../../../hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "../../../../lib/queryClient";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { formatTimeFull, startOfTodayInTimezone } from "../../../../lib/date-utils";
import { Users, Clock, UserCheck, Timer, Heart, AlertTriangle, ChevronDown, Edit3, X, Search, Bath, Triangle, Monitor, ClipboardCheck, BarChart3, Download } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../../../components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { useAbsentStudents } from "../../../../hooks/useAbsentStudents";
import { AttendancePanel } from "../../../../components/AttendancePanel";
import { useStudentImportHome } from "../../../../shared/hooks/useStudentImportHome";
import {
  fetchAllPassPilotHistory,
  isCanonicalPassPilotSource,
  passPilotClassRosterQueryKey,
  passPilotClassRequest,
  useCanonicalPassPilotClasses,
  usePassPilotClassRoster,
} from "../../classData";
import {
  readPassPilotSelectedClassId,
  resolvePassPilotSelectedClassId,
  writePassPilotSelectedClassId,
} from "../../selectedClassSession";
import {
  formatPassDuration,
  getCurrentSchoolWeekRange,
  getPassActualDurationMs,
  getPassDestinationLabel,
  getPassIssuerLabel,
  getPassStatusLabel,
} from "../../passData";
import { encodePassPilotCsv } from "../../passCsv";
import { useKioskSessions } from "../../useKioskSessions";
import ClaimKioskDialog from "../ClaimKioskDialog";

const DESTINATION_LABELS = {
  bathroom: 'Bathroom',
  nurse: 'Nurse',
  office: 'Office',
  counselor: 'Counselor',
  other_classroom: 'Other Classroom',
};

const PASS_DETAIL_PERIODS = new Set(['today', 'week']);

function schoolLocalDateKey(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatSchoolLocalDate(value, timezone, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  });
}

function getPassDurationLabel(pass) {
  const durationMs = getPassActualDurationMs(pass);
  if (durationMs !== null) return formatPassDuration(durationMs);
  return getPassStatusLabel(pass) === 'Still out' ? 'Pending' : 'Unavailable';
}

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

function MyClassTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [customReason, setCustomReason] = useState('');
  const [selectedStudentForCustom, setSelectedStudentForCustom] = useState(null);
  const [isCustomReasonDialogOpen, setIsCustomReasonDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isClaimKioskDialogOpen, setIsClaimKioskDialogOpen] = useState(false);
  const [claimTargetClassId, setClaimTargetClassId] = useState(null);
  const [showAttendance, setShowAttendance] = useState(false);
  const [showPassData, setShowPassData] = useState(false);
  const [timePeriod, setTimePeriod] = useState('today');
  const [selectedPassDataStudent, setSelectedPassDataStudent] = useState(null); // { id, name, classId, schoolId }
  const [currentTime, setCurrentTime] = useState(() => new Date());

  const { isAdmin, isSchoolwideManager, school, user } = usePassPilotAuth();
  const { canLinkToClassPilot } = useStudentImportHome();
  const userId = user?.id || '';
  const schoolId = school?.id || '';
  const tz = school?.schoolTimezone ?? "America/New_York";
  const { toast } = useToast();
  const { absentIds } = useAbsentStudents();

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const classInventoryQuery = useCanonicalPassPilotClasses(!!schoolId, schoolId);
  const sourceResolved = !!schoolId && classInventoryQuery.isSuccess;
  const canonical = sourceResolved && isCanonicalPassPilotSource(classInventoryQuery.data?.source);

  const { kioskSessions, legacyKioskServer, retargetKiosks, releaseKiosk } =
    useKioskSessions({ enabled: sourceResolved });

  const legacyKioskConfigQuery = useQuery({
    queryKey: ['passpilot', 'kiosk-config', canonical ? 'classpilot_groups' : 'legacy_grades'],
    queryFn: () => passPilotClassRequest('GET', '/kiosk-config'),
    enabled: sourceResolved && legacyKioskServer,
  });
  const legacyKioskClassId =
    legacyKioskConfigQuery.data?.classId || legacyKioskConfigQuery.data?.gradeId || null;

  const myClasses = classInventoryQuery.data?.classes || [];
  const requestedClassId = searchParams.get('classId') || '';
  const storedClassId = readPassPilotSelectedClassId(userId, schoolId);
  const activeGradeId = resolvePassPilotSelectedClassId(
    myClasses,
    requestedClassId,
    storedClassId,
  );
  const activePassDataStudent = selectedPassDataStudent?.classId === activeGradeId
    && selectedPassDataStudent?.schoolId === schoolId
    ? selectedPassDataStudent
    : null;

  const setActiveGradeId = (classId) => {
    if (!sourceResolved || !myClasses.some((item) => item.id === classId)) return;
    setSelectedPassDataStudent(null);
    writePassPilotSelectedClassId(userId, schoolId, classId);
    const next = new URLSearchParams(searchParams);
    next.set('classId', classId);
    setSearchParams(next);
  };

  // Keep direct links authoritative, then repair missing/stale URL and session
  // state from the remembered class or the first currently accessible class.
  React.useEffect(() => {
    if (!sourceResolved || !userId || !schoolId) return;

    writePassPilotSelectedClassId(userId, schoolId, activeGradeId);
    if (requestedClassId === activeGradeId && (activeGradeId || !searchParams.has('classId'))) return;

    const next = new URLSearchParams(searchParams);
    if (activeGradeId) next.set('classId', activeGradeId);
    else next.delete('classId');
    setSearchParams(next, { replace: true });
  }, [activeGradeId, requestedClassId, schoolId, searchParams, setSearchParams, sourceResolved, userId]);

  React.useEffect(() => {
    setSelectedPassDataStudent((current) => (
      current && (current.classId !== activeGradeId || current.schoolId !== schoolId)
        ? null
        : current
    ));
  }, [activeGradeId, schoolId]);

  const {
    data: students = [],
    isLoading: studentsLoading,
    isError: studentsError,
    refetch: refetchStudents,
  } = usePassPilotClassRoster(activeGradeId, sourceResolved && !!activeGradeId, schoolId);

  const {
    data: passes = [],
    isLoading: passesLoading,
    isError: passesError,
    refetch: refetchPasses,
  } = useQuery({
    queryKey: ['/api/passes/active', schoolId, canonical ? 'classpilot_groups' : 'legacy_grades'],
    queryFn: () => passPilotClassRequest('GET', '/passes/active'),
    select: (data) => Array.isArray(data) ? data : (data?.passes ?? []),
    refetchInterval: 3000,
    gcTime: 0,
    enabled: sourceResolved,
  });

  // Pass Data: fetch history for analytics. The school-local day anchor keeps
  // Today/This Week stable between 30-second refreshes while still rolling the
  // window over at the school's midnight rather than the device's midnight.
  const currentSchoolDateAnchor = schoolLocalDateKey(currentTime, tz);
  const passDataRange = useMemo(() => {
    const now = new Date();
    switch (timePeriod) {
      case 'today':
        return {
          start: startOfTodayInTimezone(tz, now),
          end: now,
          anchor: currentSchoolDateAnchor,
          label: formatSchoolLocalDate(now, tz, { weekday: 'long' }),
        };
      case 'week':
        return getCurrentSchoolWeekRange(tz, now);
      case 'month': {
        const d = new Date(now);
        d.setMonth(d.getMonth() - 1);
        return { start: d, end: now, anchor: d.toISOString(), label: '' };
      }
      case 'year': {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() - 1);
        return { start: d, end: now, anchor: d.toISOString(), label: '' };
      }
      default:
        return {
          start: startOfTodayInTimezone(tz, now),
          end: now,
          anchor: currentSchoolDateAnchor,
          label: formatSchoolLocalDate(now, tz, { weekday: 'long' }),
        };
    }
  }, [currentSchoolDateAnchor, timePeriod, tz]);
  const passDataDateStart = passDataRange.start.toISOString();
  const passDataDateEnd = passDataRange.end.toISOString();
  const showIndividualPassDetails = PASS_DETAIL_PERIODS.has(timePeriod);

  const {
    data: passHistory = [],
    isLoading: historyLoading,
    isError: historyError,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: [
      '/api/passes/history',
      schoolId,
      activeGradeId,
      timePeriod,
      passDataRange.anchor,
      passDataDateStart,
      passDataDateEnd,
    ],
    queryFn: async () => {
      const requestNow = new Date();
      const requestRange = timePeriod === 'week'
        ? getCurrentSchoolWeekRange(tz, requestNow)
        : timePeriod === 'today'
          ? { start: startOfTodayInTimezone(tz, requestNow), end: requestNow }
          : passDataRange;
      const params = new URLSearchParams();
      params.append('dateStart', requestRange.start.toISOString());
      params.append('dateEnd', requestRange.end.toISOString());
      if (activeGradeId) params.append(canonical ? 'classId' : 'gradeId', activeGradeId);
      return fetchAllPassPilotHistory(`/passes/history?${params.toString()}`);
    },
    enabled: showPassData && sourceResolved && !!activeGradeId,
    refetchInterval: showPassData && showIndividualPassDetails ? 30_000 : false,
    refetchIntervalInBackground: false,
    gcTime: 0,
  });

  const passDataStats = useMemo(() => {
    // Build student counts from pass history
    const studentCounts = new Map();
    passHistory.forEach(pass => {
      const key = pass.studentId;
      const name = pass.student
        ? `${pass.student.firstName} ${pass.student.lastName}`
        : 'Unknown';
      const existing = studentCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        studentCounts.set(key, { id: key, name, count: 1 });
      }
    });

    // Include ALL grade students (even those with 0 passes)
    const currentGradeStudents = students;
    currentGradeStudents.forEach(s => {
      if (!studentCounts.has(s.id)) {
        studentCounts.set(s.id, { id: s.id, name: `${s.firstName} ${s.lastName}`, count: 0 });
      }
    });

    const allStudents = [...studentCounts.values()].sort((a, b) => b.count - a.count);

    // Top destinations (class-wide)
    const destCounts = new Map();
    passHistory.forEach(pass => {
      const dest = pass.customDestination || DESTINATION_LABELS[pass.destination] || pass.destination || 'General';
      destCounts.set(dest, (destCounts.get(dest) || 0) + 1);
    });
    const topDestinations = [...destCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Average duration (completed passes only)
    let totalDuration = 0;
    let completedCount = 0;
    passHistory.forEach(pass => {
      const durationMs = getPassActualDurationMs(pass);
      if (durationMs === null) return;
      totalDuration += durationMs / 60000;
      completedCount++;
    });
    const avgDuration = completedCount > 0 ? Math.round(totalDuration / completedCount) : 0;

    return { allStudents, topDestinations, total: passHistory.length, avgDuration };
  }, [passHistory, students]);

  // Per-student aggregates and the school-local daily groups used by the
  // Today/This Week detail view.
  const selectedStudentStats = useMemo(() => {
    if (!activePassDataStudent) return null;
    const studentPasses = passHistory
      .filter((pass) => pass.studentId === activePassDataStudent.id)
      .sort((left, right) => {
        const issuedDifference = new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
        return issuedDifference || String(right.id || '').localeCompare(String(left.id || ''));
      });
    const destCounts = new Map();
    studentPasses.forEach(pass => {
      const dest = pass.customDestination || DESTINATION_LABELS[pass.destination] || pass.destination || 'General';
      destCounts.set(dest, (destCounts.get(dest) || 0) + 1);
    });
    const destinations = [...destCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    let totalReturnedDurationMs = 0;
    let returnedCount = 0;
    studentPasses.forEach(pass => {
      const durationMs = getPassActualDurationMs(pass);
      if (durationMs === null) return;
      totalReturnedDurationMs += durationMs;
      returnedCount += 1;
    });
    const averageReturnedDurationMs = returnedCount > 0
      ? totalReturnedDurationMs / returnedCount
      : null;

    const passGroups = [];
    const groupsByDay = new Map();
    studentPasses.forEach((pass) => {
      const dayKey = schoolLocalDateKey(pass.issuedAt, tz);
      let group = groupsByDay.get(dayKey);
      if (!group) {
        group = {
          key: dayKey,
          label: formatSchoolLocalDate(pass.issuedAt, tz, { weekday: 'long' }),
          passes: [],
        };
        groupsByDay.set(dayKey, group);
        passGroups.push(group);
      }
      group.passes.push(pass);
    });

    return {
      total: studentPasses.length,
      destinations,
      totalReturnedDurationMs,
      averageReturnedDurationMs,
      returnedCount,
      passGroups,
    };
  }, [activePassDataStudent, passHistory, tz]);

  const handlePassDataExportCSV = () => {
    const periodLabel = timePeriod === 'today'
      ? 'Today'
      : timePeriod === 'week'
        ? 'This Week'
        : timePeriod === 'month'
          ? 'This Month'
          : 'This Year';
    const periodFileLabel = periodLabel.replace(/\s+/g, '_');
    const gradeName = currentActiveGrade?.name || 'Class';
    let csvRows;

    if (!activePassDataStudent) {
      csvRows = [
        ['Student', 'Total Passes', 'Avg Duration (min)'],
        ...(passDataStats?.allStudents || []).map((student) => [student.name, student.count, '']),
      ];
    } else if (showIndividualPassDetails) {
      const detailRows = (selectedStudentStats?.passGroups || []).flatMap((group) => (
        group.passes.map((pass) => {
          const actualDurationMs = getPassActualDurationMs(pass);
          return [
            formatSchoolLocalDate(pass.issuedAt, tz),
            pass.issuedAt ? formatTimeFull(pass.issuedAt, tz) : '',
            actualDurationMs !== null ? formatTimeFull(pass.returnedAt, tz) : '',
            getPassDestinationLabel(pass),
            getPassIssuerLabel(pass),
            getPassStatusLabel(pass),
            getPassDurationLabel(pass),
          ];
        })
      ));
      csvRows = [
        [`Student: ${activePassDataStudent.name}`],
        [`Period: ${periodLabel}`],
        [`Date range: ${passDataRange.label}`],
        [`Total Returned Time: ${formatPassDuration(selectedStudentStats?.totalReturnedDurationMs ?? 0)}`],
        [],
        ['Date', 'Checked Out', 'Returned', 'Destination', 'Issued By', 'Status', 'Duration'],
        ...detailRows,
      ];
    } else {
      csvRows = [
        [`Student: ${activePassDataStudent.name}`],
        [`Period: ${periodFileLabel}`],
        [],
        ['Destination', 'Passes'],
        ...(selectedStudentStats?.destinations || []).map((destination) => [destination.name, destination.count]),
      ];
    }

    const fileName = activePassDataStudent
      ? `PassPilot_${activePassDataStudent.name.replace(/\s+/g, '_')}_${periodFileLabel}.csv`
      : `PassPilot_${gradeName.replace(/\s+/g, '_')}_${periodFileLabel}.csv`;
    downloadCsv(fileName, encodePassPilotCsv(csvRows));
  };

  const isLoading = studentsLoading
    || passesLoading
    || classInventoryQuery.isLoading;

  const handleMarkOut = async (studentId, studentName, passType = 'general', customReasonText = '') => {
    try {
      const requestBody = {
        studentId,
        passType,
        customReason: customReasonText || undefined,
        ...(activeGradeId ? { classId: activeGradeId } : {}),
      };

      await passPilotClassRequest('POST', '/passes', requestBody);

      queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes/history', schoolId] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      if (activeGradeId) queryClient.invalidateQueries({
        queryKey: passPilotClassRosterQueryKey(activeGradeId, schoolId),
      });

      const reasonText = customReasonText ? customReasonText : (
        passType === 'nurse' ? 'Nurse' :
        passType === 'office' ? 'Main Office' :
        passType === 'restroom' ? 'Restroom' :
        'General'
      );
      toast({
        title: "Pass created",
        description: `${studentName} has been marked out for ${reasonText}.`,
      });

      // Auto-scroll to top of page
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 100);
    } catch (error) {
      console.error('handleMarkOut error:', error);
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const openClaimDialog = (gradeId) => {
    setClaimTargetClassId(gradeId);
    setIsClaimKioskDialogOpen(true);
  };

  // Legacy school-global toggle for servers that predate kiosk sessions.
  const handleLegacySendToKiosk = async (gradeId) => {
    try {
      const nextId = legacyKioskClassId === gradeId ? null : gradeId;
      await passPilotClassRequest('PUT', '/kiosk-config', canonical ? { classId: nextId } : { gradeId: nextId });
      queryClient.invalidateQueries({ queryKey: ['passpilot', 'kiosk-config'] });
      toast({
        title: nextId ? "Kiosk Updated" : "Kiosk Cleared",
        description: nextId ? "Kiosk is now showing this class." : "The kiosk class selection was cleared.",
      });
    } catch {
      toast({ title: "Error", description: "Failed to update kiosk.", variant: "destructive" });
    }
  };

  // Retarget ALL of this teacher's kiosks to the chosen class. Falls back to
  // the claim dialog when the session list was stale (every kiosk died since
  // the last poll).
  const handleRetargetKiosks = async (gradeId, gradeName) => {
    try {
      const data = await retargetKiosks(gradeId);
      if ((data?.updated ?? 0) === 0) {
        openClaimDialog(gradeId);
        return;
      }
      toast({
        title: "Kiosk Updated",
        description: `Sent ${gradeName ?? "this class"} to ${data.updated} kiosk${data.updated > 1 ? "s" : ""}.`,
      });
    } catch {
      toast({ title: "Error", description: "Failed to update kiosk.", variant: "destructive" });
    }
  };

  // Zero-kiosk entry point: legacy servers keep the school-global toggle,
  // otherwise open the claim dialog. (With kiosks claimed, the button becomes
  // an explicit menu — see the tab row below.)
  const handleSendToKiosk = async (gradeId) => {
    if (legacyKioskServer) {
      await handleLegacySendToKiosk(gradeId);
      return;
    }
    openClaimDialog(gradeId);
  };

  const handleReleaseKiosk = async (sessionId) => {
    try {
      await releaseKiosk(sessionId);
      toast({ title: "Kiosk Released", description: "The kiosk is showing its claim code again." });
    } catch (error) {
      if (error?.response?.status === 404) {
        // Already dead (TTL, released elsewhere) — the desired state holds.
        toast({ title: "Kiosk Released", description: "That kiosk session had already ended." });
      } else {
        toast({ title: "Error", description: "Failed to release kiosk.", variant: "destructive" });
      }
    }
  };

  const handleCustomReasonSubmit = () => {
    if (selectedStudentForCustom && customReason.trim()) {
      handleMarkOut(selectedStudentForCustom.id, `${selectedStudentForCustom.firstName} ${selectedStudentForCustom.lastName}`, 'custom', customReason.trim());
      setCustomReason('');
      setSelectedStudentForCustom(null);
      setIsCustomReasonDialogOpen(false);
    }
  };

  const openCustomReasonDialog = (student) => {
    setSelectedStudentForCustom(student);
    setCustomReason('');
    setIsCustomReasonDialogOpen(true);
  };

  const handleMarkReturned = async (passId, studentName) => {
    try {
      await passPilotClassRequest('PUT', `/passes/${passId}/return`, {});
      queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes/history', schoolId] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      if (activeGradeId) queryClient.invalidateQueries({
        queryKey: passPilotClassRosterQueryKey(activeGradeId, schoolId),
      });

      toast({
        title: "Student returned",
        description: `${studentName} has been marked as returned.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const getInitials = (name) => {
    if (!name || typeof name !== 'string') return 'S';
    return name
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getAvatarColor = (name) => {
    const colors = [
      'bg-blue-100 text-blue-600',
      'bg-pink-100 text-pink-600',
      'bg-green-100 text-green-600',
      'bg-purple-100 text-purple-600',
      'bg-yellow-100 text-yellow-600',
      'bg-red-100 text-red-600'
    ];
    if (!name || typeof name !== 'string') return colors[0];
    const index = name.length % colors.length;
    return colors[index];
  };

  const getPassTypeIcon = (passType, destination) => {
    if (destination) {
      const destLower = destination.toLowerCase();
      if (destLower.includes('nurse') || destLower.includes('health')) {
        return <Heart className="w-4 h-4 text-red-500" />;
      }
      if (destLower.includes('office') || destLower.includes('main office') || destLower.includes('principal')) {
        return <Triangle className="w-4 h-4 text-yellow-600" />;
      }
      if (destLower.includes('restroom') || destLower.includes('bathroom') || destLower.includes('general hall pass') || destLower.includes('general')) {
        return <Bath className="w-4 h-4 text-blue-500" />;
      }
      return <Edit3 className="w-4 h-4 text-purple-600" />;
    }

    switch (passType) {
      case 'nurse':
        return <Heart className="w-4 h-4 text-red-500" />;
      case 'office':
        return <Triangle className="w-4 h-4 text-yellow-600" />;
      case 'discipline':
        return <AlertTriangle className="w-4 h-4 text-orange-500" />;
      case 'custom':
        return <Edit3 className="w-4 h-4 text-purple-600" />;
      case 'restroom':
      case 'bathroom':
        return <Bath className="w-4 h-4 text-blue-500" />;
      default:
        return <Bath className="w-4 h-4 text-blue-500" />;
    }
  };

  const getPassTypeBadgeColor = (passType, destination) => {
    if (destination) {
      const destLower = destination.toLowerCase();
      if (destLower.includes('nurse') || destLower.includes('health')) {
        return 'bg-red-100 text-red-700 border-red-200';
      }
      if (destLower.includes('office') || destLower.includes('main office') || destLower.includes('principal')) {
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      }
      if (destLower.includes('restroom') || destLower.includes('bathroom') || destLower.includes('general hall pass') || destLower.includes('general')) {
        return 'bg-blue-100 text-blue-700 border-blue-200';
      }
      return 'bg-purple-100 text-purple-700 border-purple-200';
    }

    switch (passType) {
      case 'nurse':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'office':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'discipline':
        return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'custom':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'restroom':
      case 'bathroom':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      default:
        return 'bg-blue-100 text-blue-700 border-blue-200';
    }
  };

  const formatDuration = (issuedAt) => {
    if (!issuedAt) return '0 min';
    const issued = new Date(issuedAt);
    if (isNaN(issued.getTime())) return '0 min';
    const diffMs = currentTime.getTime() - issued.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return `${Math.max(1, diffMinutes)} min`;
  };

  if (isLoading) {
    return (
      <div className="p-4" aria-live="polite">
        <div className="animate-pulse space-y-4 motion-reduce:animate-none">
          <div className="h-4 bg-muted rounded w-1/4"></div>
          <div className="h-20 bg-muted rounded"></div>
          <div className="h-20 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  if (classInventoryQuery.isError) {
    return (
      <div className="p-4">
        <Card className="border-destructive/40">
          <CardContent className="p-8 text-center">
            <h2 className="text-lg font-semibold">Classes couldn’t be loaded</h2>
            <p className="mt-2 text-sm text-muted-foreground">Try again. No class changes were made.</p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => classInventoryQuery.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (studentsError || passesError) {
    return (
      <div className="p-4">
        <Card className="border-destructive/40">
          <CardContent className="p-8 text-center" aria-live="polite">
            <h2 className="text-lg font-semibold">Class roster couldn’t be loaded</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Try again. PassPilot will not treat a loading failure as an empty class.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => {
                if (studentsError) void refetchStudents();
                if (passesError) void refetchPasses();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (myClasses.length === 0) {
    return (
      <div className="p-4">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-foreground mb-2">My Class</h2>
          <p className="text-sm text-muted-foreground">Manage student passes and track who's out of class</p>
        </div>
        <Card>
          <CardContent className="p-6 text-center">
            <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              {canonical && isSchoolwideManager ? "No official classes yet" : "No Classes Assigned"}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {canonical
                ? (isSchoolwideManager
                  ? "Create a class in ClassPilot to use it in PassPilot."
                  : "Ask IT to assign you as a teacher or co-teacher in ClassPilot.")
                : "Ask your admin to assign classes to your account, or add classes from the Classes tab."}
            </p>
            {canonical && isAdmin && canLinkToClassPilot ? (
              <Button asChild>
                <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses">Manage Classes in ClassPilot</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get current active grade data
  const currentActiveGrade = myClasses.find(g => g.id === activeGradeId);
  const gradeStudents = currentActiveGrade ? students : [];
  const gradeOutPasses = currentActiveGrade ? passes.filter((pass) => {
    const passClassId = pass.classId || pass.classpilotGroupId || pass.gradeId;
    return passClassId === currentActiveGrade.id;
  }) : [];

  // Filter students based on search query
  const filterStudentsBySearch = (studentList, query) => {
    if (!query.trim()) return studentList;

    const q = query.toLowerCase().trim();
    return studentList.filter(student => {
      const fullName = `${student.firstName} ${student.lastName}`.toLowerCase();
      const lastFirst = `${student.lastName}, ${student.firstName}`.toLowerCase();
      return fullName.includes(q) ||
             lastFirst.includes(q) ||
             student.firstName.toLowerCase().includes(q) ||
             student.lastName.toLowerCase().includes(q);
    });
  };

  const sortStudentsByLastName = (studentList) => {
    return [...studentList].sort((a, b) => {
      const lastNameA = (a.lastName || '').toLowerCase();
      const lastNameB = (b.lastName || '').toLowerCase();
      return lastNameA.localeCompare(lastNameB);
    });
  };

  const allAvailableStudents = gradeStudents.filter(student =>
    !passes.some(pass => pass.studentId === student.id)
  );
  const filteredAvailableStudents = filterStudentsBySearch(allAvailableStudents, searchQuery);
  const availableStudents = sortStudentsByLastName(filteredAvailableStudents);

  const allCheckedOutStudents = gradeOutPasses.map(pass => {
    const student = students.find(s => s.id === pass.studentId);
    return { ...pass, student };
  }).filter(item => item.student);
  const filteredCheckedOutStudents = filterStudentsBySearch(
    allCheckedOutStudents.map(item => item.student),
    searchQuery
  );
  const checkedOutStudentIds = new Set(filteredCheckedOutStudents.map(s => s.id));

  const sortedGradeOutPasses = [...gradeOutPasses]
    .filter(pass => {
      const student = students.find(s => s.id === pass.studentId);
      return student && checkedOutStudentIds.has(student.id);
    })
    .sort((a, b) => {
      const studentA = students.find((s) => s.id === a.studentId);
      const studentB = students.find((s) => s.id === b.studentId);
      const lastNameA = (studentA?.lastName || '').toLowerCase();
      const lastNameB = (studentB?.lastName || '').toLowerCase();
      return lastNameA.localeCompare(lastNameB);
    });

  return (
    <div className="p-4">
      <div className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold text-foreground">My Class</h2>
          {canonical ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              Managed in ClassPilot
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">Manage student passes and track who's out of class</p>
        {canonical ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Classes and rosters follow your ClassPilot assignments.
          </p>
        ) : null}
      </div>

      {/* Grade Tabs (left) + Action Buttons (right) */}
      <div className="mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {myClasses.map((grade) => {
              const gradeOutCount = passes.filter((pass) => (
                pass.classId || pass.classpilotGroupId || pass.gradeId
              ) === grade.id).length;

              const isActive = activeGradeId === grade.id;

              return (
                <Button
                  key={grade.id}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setActiveGradeId(grade.id);
                  }}
                  data-testid={`tab-grade-${grade.name}`}
                  className={`flex items-center gap-2 ${isActive ? 'ring-2 ring-primary' : ''}`}
                >
                  <Users className="w-4 h-4" aria-hidden="true" />
                  {grade.name}
                  {gradeOutCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">
                      {gradeOutCount}
                    </span>
                  )}
                </Button>
              );
            })}
            {currentActiveGrade && (legacyKioskServer || kioskSessions.length === 0) && (
                <Button
                  variant={
                    legacyKioskServer && legacyKioskClassId === currentActiveGrade.id
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  onClick={() => handleSendToKiosk(currentActiveGrade.id)}
                  className="flex items-center gap-1.5"
                  title={
                    legacyKioskServer
                      ? "Send this class to the school kiosk"
                      : "Claim a kiosk with the code shown on its screen"
                  }
                >
                  <Monitor className="w-4 h-4" />
                  {legacyKioskServer && legacyKioskClassId === currentActiveGrade.id
                    ? "On Kiosk"
                    : "Send to Kiosk"}
                </Button>
            )}
            {currentActiveGrade && !legacyKioskServer && kioskSessions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={
                      kioskSessions.every((s) => s.classId === currentActiveGrade.id)
                        ? "default"
                        : "outline"
                    }
                    size="sm"
                    className="flex items-center gap-1.5"
                    title="Send this class to your kiosks or claim another"
                  >
                    <Monitor className="w-4 h-4" />
                    {kioskSessions.every((s) => s.classId === currentActiveGrade.id)
                      ? kioskSessions.length === 1
                        ? "On Kiosk"
                        : `On ${kioskSessions.length} Kiosks`
                      : "Send to Kiosk"}
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onClick={() => handleRetargetKiosks(currentActiveGrade.id, currentActiveGrade.name)}
                    data-testid="menu-send-to-kiosks"
                  >
                    <Monitor className="mr-2 h-4 w-4" />
                    Send {currentActiveGrade.name} to my {kioskSessions.length} kiosk{kioskSessions.length > 1 ? "s" : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => openClaimDialog(currentActiveGrade.id)}
                    data-testid="menu-enter-kiosk-code"
                  >
                    <Edit3 className="mr-2 h-4 w-4" />
                    Enter a kiosk code&hellip;
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {currentActiveGrade && (
            <div className="flex gap-2 shrink-0">
              <Button
                variant={showPassData ? "default" : "outline"}
                size="sm"
                onClick={() => setShowPassData(!showPassData)}
                className="flex items-center gap-1.5"
              >
                <BarChart3 className="w-4 h-4" />
                Pass Data
                <ChevronDown className={`w-3 h-3 transition-transform ${showPassData ? 'rotate-180' : ''}`} />
              </Button>
              <Button
                variant={showAttendance ? "default" : "outline"}
                size="sm"
                onClick={() => setShowAttendance(!showAttendance)}
                className="flex items-center gap-1.5"
              >
                <ClipboardCheck className="w-4 h-4" />
                Attendance
              </Button>
            </div>
          )}
        </div>
        {kioskSessions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {kioskSessions.map((kioskSession) => (
              <span
                key={kioskSession.id}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground"
              >
                <Monitor className="w-3.5 h-3.5" />
                {kioskSession.className || "No class"} · kiosk
                <button
                  type="button"
                  onClick={() => handleReleaseKiosk(kioskSession.id)}
                  className="ml-1 hover:text-foreground"
                  title="Release this kiosk (it will show a new claim code)"
                  aria-label="Release kiosk"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Attendance Panel */}
      {showAttendance && currentActiveGrade && (
        <div className="mb-6">
          <AttendancePanel
            students={gradeStudents}
            onClose={() => setShowAttendance(false)}
          />
        </div>
      )}

      {/* Show active grade content */}
      {currentActiveGrade && (
        <div className="space-y-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <Users className="h-5 w-5 text-blue-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Students</p>
                    <p className="text-lg font-bold">{gradeStudents.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <Timer className="h-5 w-5 text-red-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Currently Out</p>
                    <p className="text-lg font-bold text-red-600">{sortedGradeOutPasses.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <UserCheck className="h-5 w-5 text-green-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Available</p>
                    <p className="text-lg font-bold text-green-600">{availableStudents.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {showPassData && (
            <Card>
              <CardContent className="p-4 space-y-4">
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
                      variant={timePeriod === key ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTimePeriod(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {showIndividualPassDetails ? (
                  <p className="text-xs text-muted-foreground">
                    {timePeriod === 'week' ? 'Current school week' : 'Today'}:{' '}
                    <span className="font-medium text-foreground">{passDataRange.label}</span>
                  </p>
                ) : null}

                {/* Class / Student Tab Switcher */}
                <div className="flex items-center gap-2 border-b pb-2">
                  <Button
                    variant={!activePassDataStudent ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setSelectedPassDataStudent(null)}
                  >
                    Class
                  </Button>
                  {activePassDataStudent && (
                    <Button variant="default" size="sm" className="pointer-events-none">
                      {activePassDataStudent.name}
                    </Button>
                  )}
                </div>

                {historyLoading ? (
                  <div className="text-center py-4 text-muted-foreground text-sm">Loading pass data...</div>
                ) : historyError ? (
                  <div className="py-4 text-center" role="alert">
                    <p className="text-sm font-medium text-destructive">Pass history couldn’t be loaded.</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => refetchHistory()}>
                      Retry
                    </Button>
                  </div>
                ) : !activePassDataStudent ? (
                  /* ========== CLASS VIEW ========== */
                  <>
                    {/* Summary Stats */}
                    <div className="flex items-center gap-6 text-sm">
                      <span className="font-medium text-foreground">
                        Total: <span className="text-blue-600">{passDataStats.total} passes</span>
                      </span>
                      {passDataStats.avgDuration > 0 && (
                        <span className="font-medium text-foreground">
                          Avg Duration: <span className="text-blue-600">{passDataStats.avgDuration} min</span>
                        </span>
                      )}
                    </div>

                    {/* Two-column grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* All Students */}
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                          <Users className="w-4 h-4 text-blue-600" />
                          Students
                        </h4>
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                          {passDataStats.allStudents.map((s, i) => (
                            <button
                              type="button"
                              key={s.id || i}
                              className="flex w-full items-center justify-between rounded bg-muted/50 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              onClick={() => setSelectedPassDataStudent({
                                id: s.id,
                                name: s.name,
                                classId: activeGradeId,
                                schoolId,
                              })}
                            >
                              <span className="flex items-center gap-2">
                                <span className="text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
                                <span className="font-medium">{s.name}</span>
                              </span>
                              <span className={`${s.count === 0 ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
                                {s.count} {s.count === 1 ? 'pass' : 'passes'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Top Destinations */}
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                          <Clock className="w-4 h-4 text-blue-600" />
                          Top Destinations
                        </h4>
                        <div className="space-y-1.5">
                          {passDataStats.topDestinations.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-2">No passes this period</p>
                          ) : passDataStats.topDestinations.map((d, i) => (
                            <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded bg-muted/50">
                              <span className="flex items-center gap-2">
                                <span className="text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
                                <span className="font-medium">{d.name}</span>
                              </span>
                              <span className="text-muted-foreground">{d.count} {d.count === 1 ? 'pass' : 'passes'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                  </>
                ) : (
                  /* ========== STUDENT VIEW ========== */
                  <>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                      <span className="font-medium text-foreground">
                        Total: <span className="text-blue-600">{selectedStudentStats?.total || 0} passes</span>
                      </span>
                      <span className="font-medium text-foreground">
                        <span>Total Returned Time</span>:{' '}
                        <span className="text-blue-600">
                          {formatPassDuration(selectedStudentStats?.totalReturnedDurationMs ?? 0)}
                        </span>
                      </span>
                      <span className="font-medium text-foreground">
                        <span>Average Returned Time</span>:{' '}
                        <span className="text-blue-600">
                          {formatPassDuration(selectedStudentStats?.averageReturnedDurationMs ?? null)}
                        </span>
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Returned passes only</span>{' '}
                      are included in time totals and averages.
                    </p>

                    <div className="space-y-2">
                      <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-blue-600" />
                        Destinations
                      </h4>
                      <div className="space-y-1.5">
                        {(!selectedStudentStats || selectedStudentStats.destinations.length === 0) ? (
                          <p className="text-sm text-muted-foreground py-2">No passes this period</p>
                        ) : selectedStudentStats.destinations.map((d, i) => (
                          <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded bg-muted/50">
                            <span className="flex items-center gap-2">
                              <span className="text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
                              <span className="font-medium">{d.name}</span>
                            </span>
                            <span className="text-muted-foreground">{d.count} {d.count === 1 ? 'pass' : 'passes'}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {showIndividualPassDetails ? (
                      <div className="space-y-3" data-testid="pass-detail-list">
                        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                          <Timer className="h-4 w-4 text-blue-600" />
                          Pass Details
                        </h4>
                        {(!selectedStudentStats || selectedStudentStats.passGroups.length === 0) ? (
                          <p className="py-2 text-sm text-muted-foreground">No pass details this period</p>
                        ) : selectedStudentStats.passGroups.map((group) => (
                          <section key={group.key} className="space-y-1.5" data-testid={`pass-detail-day-${group.key}`}>
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {group.label}
                            </h5>
                            <div className="divide-y rounded-md border bg-card">
                              {group.passes.map((pass) => {
                                const statusLabel = getPassStatusLabel(pass);
                                const actualDurationMs = getPassActualDurationMs(pass);
                                const statusClass = statusLabel === 'Returned'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                                  : statusLabel === 'Still out'
                                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                    : 'bg-muted text-muted-foreground';
                                return (
                                  <article
                                    key={pass.id}
                                    className="grid gap-3 p-3 text-sm sm:grid-cols-2 xl:grid-cols-6"
                                    data-testid={`pass-detail-${pass.id}`}
                                  >
                                    <div>
                                      <p className="text-xs text-muted-foreground">Checked Out</p>
                                      <p className="font-medium text-foreground">
                                        {pass.issuedAt ? formatTimeFull(pass.issuedAt, tz) : '—'}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-muted-foreground">Returned</p>
                                      <p className="font-medium text-foreground">
                                        {actualDurationMs !== null ? formatTimeFull(pass.returnedAt, tz) : '—'}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-muted-foreground">Destination</p>
                                      <p className="font-medium text-foreground">{getPassDestinationLabel(pass)}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-muted-foreground">Issued By</p>
                                      <p className="font-medium text-foreground">{getPassIssuerLabel(pass)}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-muted-foreground">Duration</p>
                                      <p className="font-medium text-foreground">
                                        {getPassDurationLabel(pass)}
                                      </p>
                                    </div>
                                    <div className="xl:text-right">
                                      <p className="mb-1 text-xs text-muted-foreground">Status</p>
                                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusClass}`}>
                                        {statusLabel}
                                      </span>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}

                {!historyLoading && !historyError ? (
                  <div className="pt-2 border-t">
                    <Button variant="outline" size="sm" onClick={handlePassDataExportCSV} className="flex items-center gap-1.5">
                      <Download className="h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search students by name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-students"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSearchQuery('')}
                className="absolute right-1 top-1/2 transform -translate-y-1/2 h-8 w-8 p-0"
                data-testid="button-clear-search"
                aria-label="Clear student search"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {searchQuery && (
            <div className="text-sm text-muted-foreground">
              Found {availableStudents.length} available and {sortedGradeOutPasses.length} checked-out students matching "{searchQuery}"
            </div>
          )}

          {/* Currently Out Students */}
          <Card id="currently-out-section">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-red-600" />
                Currently Out - {currentActiveGrade.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sortedGradeOutPasses.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  No students are currently out of class
                </p>
              ) : (
                <div className="space-y-3">
                  {sortedGradeOutPasses.map((pass) => {
                    const student = students.find((s) => s.id === pass.studentId);
                    if (!student) return null;

                    return (
                      <div key={pass.id} className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${getAvatarColor(`${student.firstName} ${student.lastName}`)}`}>
                            {getInitials(`${student.firstName} ${student.lastName}`)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{student.firstName} {student.lastName}</p>
                              <span className={`px-2 py-1 text-xs rounded-full border flex items-center gap-1 ${getPassTypeBadgeColor(pass.destination || 'general', pass.destination)}`}>
                                {getPassTypeIcon(pass.destination || 'general', pass.destination)}
                                {pass.destination || 'general'}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {pass.customDestination || `Out for ${formatDuration(pass.issuedAt)}`} • Since {pass.issuedAt ? formatTimeFull(pass.issuedAt, tz) : 'Unknown time'}
                            </p>
                          </div>
                        </div>
                        <Button
                          onClick={() => handleMarkReturned(pass.id, `${student.firstName} ${student.lastName}`)}
                          size="sm"
                          data-testid={`button-return-${pass.id}`}
                        >
                          Mark Returned
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Available Students */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-green-600" />
                Available Students - {currentActiveGrade.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {availableStudents.length === 0 ? (
                <div className="py-4 text-center text-muted-foreground">
                  <p>
                    {gradeStudents.length === 0
                      ? (canonical
                        ? (isAdmin
                          ? "This class has no students. Add students to its roster in ClassPilot."
                          : isSchoolwideManager
                            ? "This class has no students. Ask an administrator to update its ClassPilot roster."
                            : "This class has no students yet. Ask IT to update the ClassPilot roster.")
                        : `No students in ${currentActiveGrade.name}. Add students in the Classes tab.`)
                      : "All students are currently out of class"
                    }
                  </p>
                  {gradeStudents.length === 0 && canonical && isAdmin && canLinkToClassPilot ? (
                    <Button asChild variant="outline" size="sm" className="mt-3">
                      <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses">Manage Roster in ClassPilot</Link>
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-3">
                  {availableStudents.map((student) => {
                    const isAbsent = absentIds.has(student.id);
                    if (isAbsent) {
                      return (
                        <div
                          key={student.id}
                          className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700 rounded-lg opacity-60"
                        >
                          <div className="flex items-center space-x-3 flex-grow">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${getAvatarColor(`${student.firstName} ${student.lastName}`)}`}>
                              {getInitials(`${student.firstName} ${student.lastName}`)}
                            </div>
                            <div className="flex-grow">
                              <div className="flex items-center gap-3">
                                <span className="font-medium">{student.firstName} {student.lastName}</span>
                                <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium">Absent</span>
                              </div>
                              {student.studentIdNumber && (
                                <p className="text-sm text-muted-foreground">ID: {student.studentIdNumber}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <DropdownMenu key={student.id}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3 text-left transition-colors hover:bg-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:border-green-800 dark:bg-green-900/20 dark:hover:bg-green-900/30"
                            data-testid={`button-checkout-${student.id}`}
                          >
                            <div className="flex items-center space-x-3 flex-grow">
                              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${getAvatarColor(`${student.firstName} ${student.lastName}`)}`}>
                                {getInitials(`${student.firstName} ${student.lastName}`)}
                              </div>
                              <div className="flex-grow">
                                <div className="flex items-center gap-3">
                                  <span className="font-medium">{student.firstName} {student.lastName}</span>
                                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                </div>
                                {student.studentIdNumber && (
                                  <p className="text-sm text-muted-foreground">ID: {student.studentIdNumber}</p>
                                )}
                              </div>
                            </div>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            onClick={() => handleMarkOut(student.id, `${student.firstName} ${student.lastName}`, 'general', '')}
                            className="flex items-center gap-2"
                          >
                            <Bath className="w-4 h-4 text-blue-500" />
                            General/Restroom
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleMarkOut(student.id, `${student.firstName} ${student.lastName}`, 'nurse')}
                            className="flex items-center gap-2"
                          >
                            <Heart className="w-4 h-4 text-red-500" />
                            Nurse
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleMarkOut(student.id, `${student.firstName} ${student.lastName}`, 'office')}
                            className="flex items-center gap-2"
                          >
                            <Triangle className="w-4 h-4 text-yellow-500" />
                            Office
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => openCustomReasonDialog(student)}
                            className="flex items-center gap-2"
                          >
                            <Edit3 className="w-4 h-4 text-purple-500" />
                            Custom Reason
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* No active grade selected */}
      {!currentActiveGrade && myClasses.length > 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium text-muted-foreground mb-2">Select a Grade</h3>
            <p className="text-sm text-muted-foreground">
              Click on one of the grade tabs above to view and manage students.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Custom Reason Dialog */}
      <Dialog open={isCustomReasonDialogOpen} onOpenChange={setIsCustomReasonDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom Reason for {selectedStudentForCustom?.firstName} {selectedStudentForCustom?.lastName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label htmlFor="customReason">Reason for leaving class</Label>
              <Input
                id="customReason"
                placeholder="e.g., Library research, Guidance counselor, Office errand..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCustomReasonSubmit();
                  }
                }}
                data-testid="input-custom-reason"
              />
            </div>
            <div className="flex justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => setIsCustomReasonDialogOpen(false)}
                data-testid="button-cancel-custom-reason"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCustomReasonSubmit}
                disabled={!customReason.trim()}
                data-testid="button-submit-custom-reason"
              >
                Mark Out
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Claim Kiosk dialog: enter the 6-digit code shown on the kiosk screen */}
      <ClaimKioskDialog
        open={isClaimKioskDialogOpen}
        onOpenChange={setIsClaimKioskDialogOpen}
        defaultClassId={claimTargetClassId ?? currentActiveGrade?.id ?? null}
      />
    </div>
  );
}

export default MyClassTab;
