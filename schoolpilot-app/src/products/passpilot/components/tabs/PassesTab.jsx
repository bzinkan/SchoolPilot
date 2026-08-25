import { Card, CardContent } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { Badge } from "../../../../components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../../components/ui/alert-dialog";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { useToast } from "../../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../../lib/queryClient";
import { formatTime } from "../../../../lib/date-utils";
import {
  isCanonicalPassPilotSource,
  passPilotClassesQueryKey,
  passPilotClassRequest,
  useCanonicalPassPilotClasses,
} from "../../classData";
import { formatPassOverdueDuration, isPassOverdue } from "../../passData";
import { usePassNow } from "../LivePassDuration";

function formatLiveDuration(issuedAt, nowMs) {
  if (!issuedAt) return "Unknown";
  const issuedAtMs = new Date(issuedAt).getTime();
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(nowMs)) return "Unknown";
  return `${Math.max(0, Math.floor((nowMs - issuedAtMs) / 60_000))} min`;
}

function getOverdueLabel(pass, nowMs) {
  const duration = formatPassOverdueDuration(pass, nowMs);
  if (!duration) return null;
  return duration === '<1 min' ? `Overdue ${duration}` : `Overdue by ${duration}`;
}

function PassesTab() {
  const { school, isSchoolwideManager } = usePassPilotAuth();
  const { toast } = useToast();
  const tz = school?.schoolTimezone ?? "America/New_York";
  const schoolId = school?.id || '';
  const classInventoryQuery = useCanonicalPassPilotClasses();
  const canonical = classInventoryQuery.isSuccess
    && isCanonicalPassPilotSource(classInventoryQuery.data?.source);
  const { data: passes, isLoading, error } = useQuery({
    queryKey: ['/api/passes/active'],
    queryFn: () => passPilotClassRequest('GET', '/passes/active'),
    select: (data) => Array.isArray(data) ? data : (data?.passes ?? []),
    refetchInterval: 5000,
    gcTime: 0,
    enabled: classInventoryQuery.isSuccess,
  });

  const { data: legacyGrades = [] } = useQuery({
    queryKey: ['/api/grades'],
    queryFn: () => apiRequest('GET', '/grades'),
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? []),
    enabled: classInventoryQuery.isSuccess && !canonical,
  });
  const classes = canonical ? (classInventoryQuery.data?.classes || []) : legacyGrades;

  const [filterType, setFilterType] = useState("all");
  const [filterClassId, setFilterClassId] = useState("all");
  const [updatingPassId, setUpdatingPassId] = useState(null);
  const passActionInFlightRef = useRef(false);
  const nowMs = usePassNow();

  if (isLoading || classInventoryQuery.isLoading) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted rounded w-1/4"></div>
          <div className="h-20 bg-muted rounded"></div>
          <div className="h-20 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  if (error || classInventoryQuery.isError) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-destructive mb-2">Could not load passes</p>
            <p className="text-xs text-muted-foreground">{error?.message || classInventoryQuery.error?.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!passes) return null;

  const getInitials = (name) => {
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
    const index = name.length % colors.length;
    return colors[index];
  };

  const getDestinationBadge = (pass) => {
    if (pass.customDestination) {
      return <Badge variant="outline" className="bg-purple-50 text-purple-600 border-purple-200">{pass.customDestination}</Badge>;
    }

    const destination = (pass.destination || '').toLowerCase();
    if (destination.includes('nurse')) {
      return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200">Nurse</Badge>;
    } else if (destination.includes('main office') || destination.includes('office')) {
      return <Badge variant="outline" className="bg-yellow-50 text-yellow-600 border-yellow-200">Main Office</Badge>;
    } else if (destination.includes('discipline')) {
      return <Badge variant="outline" className="bg-orange-50 text-orange-600 border-orange-200">Main Office</Badge>;
    }

    return <Badge variant="outline" className="bg-blue-50 text-blue-600 border-blue-200">General</Badge>;
  };

  const invalidatePassState = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] }),
    queryClient.invalidateQueries({ queryKey: ['/api/passes'] }),
    queryClient.invalidateQueries({ queryKey: ['/api/passes/history'] }),
    queryClient.invalidateQueries({ queryKey: passPilotClassesQueryKey(schoolId) }),
    queryClient.invalidateQueries({ queryKey: ['passpilot', 'class-students'] }),
    queryClient.invalidateQueries({ queryKey: ['/api/students'] }),
  ]);

  const transitionPass = async (pass, action) => {
    if (passActionInFlightRef.current) return;
    passActionInFlightRef.current = true;
    setUpdatingPassId(pass.id);
    const studentName = [pass.student?.firstName, pass.student?.lastName].filter(Boolean).join(' ') || 'Student';
    try {
      await passPilotClassRequest('PATCH', `/passes/${pass.id}/${action}`, {});
      await invalidatePassState();
      toast(action === 'return'
        ? {
            title: 'Student returned',
            description: `${studentName} has been marked as returned.`,
          }
        : {
            title: 'Pass canceled',
            description: `${studentName}'s pass was canceled. They were not marked returned.`,
          });
    } catch (transitionError) {
      toast({
        title: 'Error',
        description: transitionError?.response?.data?.error || transitionError?.message || 'The pass could not be updated.',
        variant: 'destructive',
      });
    } finally {
      passActionInFlightRef.current = false;
      setUpdatingPassId(null);
    }
  };

  const filteredPasses = (passes || []).filter((pass) => {
    let passType = 'general';
    if (pass.destination?.toLowerCase().includes('nurse')) {
      passType = 'nurse';
    } else if (pass.destination?.toLowerCase().includes('discipline') || pass.destination?.toLowerCase().includes('office')) {
      passType = 'discipline';
    }

    const typeMatch = filterType === "all" || passType === filterType;
    const passClassId = pass.classId || pass.classpilotGroupId || pass.gradeId || pass.student?.gradeId;
    const classMatch = filterClassId === "all" || passClassId === filterClassId;

    return typeMatch && classMatch;
  });

  return (
    <div className="p-4">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-foreground mb-2">Current Passes</h2>
        <p className="text-sm text-muted-foreground">Students currently checked out</p>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-sm">
            <div className="w-2 h-2 bg-secondary rounded-full animate-pulse"></div>
            <span className="text-muted-foreground">Live updates enabled</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-sm text-muted-foreground">
              Showing {filteredPasses.length} of {passes.length} passes
            </div>
            <div className="text-xs text-blue-600 font-medium">
              {isSchoolwideManager ? "Showing all school passes" : "Showing passes you can access"}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground">Filter by type:</span>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="general">General</SelectItem>
                <SelectItem value="nurse">Nurse</SelectItem>
                <SelectItem value="discipline">Main Office</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground">Filter by class:</span>
            <Select value={filterClassId} onValueChange={setFilterClassId}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Classes</SelectItem>
                {classes.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="space-y-3" data-testid="active-passes-list">
        {filteredPasses.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {passes.length === 0
                  ? "All students are in class"
                  : `No ${filterType === 'all' ? '' : filterType + ' '}${filterClassId === 'all' ? '' : 'class '}passes currently active`
                }
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredPasses.map((pass) => {
            const overdue = isPassOverdue(pass, nowMs);
            const overdueLabel = getOverdueLabel(pass, nowMs);
            const passActionPending = updatingPassId === pass.id;
            const studentName = `${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim();

            return (
              <Card
                key={pass.id}
                className={`shadow-sm ${overdue ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/20' : ''}`}
                data-testid={`pass-card-${pass.id}`}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center space-x-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${getAvatarColor(studentName)}`}>
                        <span className="text-sm font-medium" data-testid={`student-initials-${pass.id}`}>
                          {getInitials(studentName)}
                        </span>
                      </div>
                      <div>
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-foreground" data-testid={`student-name-${pass.id}`}>
                            {pass.student?.firstName} {pass.student?.lastName}
                          </h3>
                          {getDestinationBadge(pass)}
                          {overdueLabel ? (
                            <Badge
                              variant="outline"
                              className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-200"
                              data-testid={`pass-overdue-${pass.id}`}
                            >
                              {overdueLabel}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Class <span data-testid={`student-grade-${pass.id}`}>{pass.className || pass.classNameSnapshot || pass.student?.grade || "Unknown"}</span> •
                          Out for <span data-testid={`pass-duration-${pass.id}`}>{formatLiveDuration(pass.issuedAt, nowMs)}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Issued by: <span className="font-medium">{pass.teacher ? `${pass.teacher.firstName} ${pass.teacher.lastName}`.trim() + (pass.issuedVia === "kiosk" && pass.notes ? ` (${pass.notes} Kiosk)` : '') : (pass.issuedVia === "kiosk" ? (pass.notes ? `${pass.notes} Kiosk` : "Kiosk") : "Unknown")}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Checked out</p>
                        <p className="text-sm font-medium text-foreground" data-testid={`checkout-time-${pass.id}`}>
                          {formatTime(pass.issuedAt, tz)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => transitionPass(pass, 'return')}
                          disabled={updatingPassId !== null}
                          data-testid={`button-return-${pass.id}`}
                        >
                          {passActionPending ? 'Updating...' : 'Mark Returned'}
                        </Button>
                        {overdue ? (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={updatingPassId !== null}
                                data-testid={`button-cancel-pass-${pass.id}`}
                              >
                                Cancel Pass
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Cancel {studentName || 'this student'}&apos;s overdue pass?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Canceling closes this pass but does not mark the student returned. Use Mark Returned if the student is back in class.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Keep Pass Active</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => transitionPass(pass, 'cancel')}
                                  data-testid={`button-confirm-cancel-pass-${pass.id}`}
                                >
                                  Cancel Pass
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

export default PassesTab;
