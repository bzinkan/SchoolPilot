import { useState } from "react";
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { useToast } from "../../../../hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../../lib/queryClient";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { formatTimeFull } from "../../../../lib/date-utils";
import { Users, Clock, UserCheck, Timer, Heart, AlertTriangle, ChevronDown, Edit3, X, Search, Bath, MapPin, Building2, HelpCircle, Triangle, Monitor } from "lucide-react";
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
  DialogTrigger,
} from "../../../../components/ui/dialog";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";

function MyClassTab() {
  const [activeGradeId, setActiveGradeId] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [selectedStudentForCustom, setSelectedStudentForCustom] = useState(null);
  const [isCustomReasonDialogOpen, setIsCustomReasonDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [kioskGradeId, setKioskGradeId] = useState(null);

  const { isAdmin, school } = usePassPilotAuth();
  const tz = school?.schoolTimezone ?? "America/New_York";
  const { toast } = useToast();

  const { data: myClasses = [] } = useQuery({
    queryKey: ['my-classes'],
    queryFn: async () => {
      const url = isAdmin ? '/api/grades' : '/api/my-classes';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch classes');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? data?.classes ?? []),
  });

  // Auto-select first class if none selected
  React.useEffect(() => {
    if (!activeGradeId && myClasses.length > 0) {
      setActiveGradeId(myClasses[0].id);
    }
  }, [myClasses, activeGradeId]);

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['/api/students'],
    queryFn: async () => {
      const res = await fetch('/api/students', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch students');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });

  const { data: passes = [], isLoading: passesLoading } = useQuery({
    queryKey: ['/api/passes/active'],
    queryFn: async () => {
      const res = await fetch('/api/passes/active', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch passes');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.passes ?? []),
    refetchInterval: 3000,
    gcTime: 0,
  });

  const isLoading = studentsLoading || passesLoading;

  const handleMarkOut = async (studentId, studentName, passType = 'general', customReasonText = '') => {
    try {
      const requestBody = {
        studentId,
        passType,
        customReason: customReasonText || undefined,
      };

      await apiRequest('POST', '/passes', requestBody);

      queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

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

  const handleSendToKiosk = async (gradeId) => {
    try {
      await apiRequest('PUT', '/kiosk-config', { gradeId });
      setKioskGradeId(gradeId);
      toast({ title: "Kiosk Updated", description: "Kiosk is now showing this grade." });
    } catch {
      toast({ title: "Error", description: "Failed to update kiosk.", variant: "destructive" });
    }
  };

  const handleClearKiosk = async () => {
    try {
      await apiRequest('PUT', '/kiosk-config', { gradeId: null });
      setKioskGradeId(null);
      toast({ title: "Kiosk Cleared", description: "Kiosk returned to grade picker." });
    } catch {
      toast({ title: "Error", description: "Failed to clear kiosk.", variant: "destructive" });
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
      await apiRequest('PUT', `/passes/${passId}/return`, {});
      queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/passes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

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

  const getPassTypeLabel = (passType) => {
    switch (passType) {
      case 'nurse':
        return 'Nurse';
      case 'discipline':
        return 'Discipline';
      default:
        return 'General';
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

  // Use state to force re-render every few seconds for real-time updates
  const [currentTime, setCurrentTime] = useState(new Date());

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const formatDuration = (issuedAt) => {
    if (!issuedAt) return '0 min';
    const issued = new Date(issuedAt);
    if (isNaN(issued.getTime())) return '0 min';
    const diffMs = currentTime.getTime() - issued.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return `${Math.max(1, diffMinutes)} min`;
  };

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
            <h3 className="text-lg font-medium text-muted-foreground mb-2">No Classes Assigned</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Ask your admin to assign classes to your account, or add classes from the Classes tab.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
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

  // Get current active grade data
  const currentActiveGrade = myClasses.find(g => g.id === activeGradeId);
  const gradeStudents = currentActiveGrade ? students.filter((student) => student.gradeId === currentActiveGrade.id) : [];
  const gradeOutPasses = currentActiveGrade ? passes.filter((pass) => {
    const student = students.find((s) => s.id === pass.studentId);
    return student && student.gradeId === currentActiveGrade.id;
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
        <h2 className="text-xl font-semibold text-foreground mb-2">My Class</h2>
        <p className="text-sm text-muted-foreground">Manage student passes and track who's out of class</p>
      </div>

      {/* Small Grade Tabs for Quick Switching */}
      <div className="mb-6">
        <div className="flex flex-wrap gap-2">
          {myClasses.map((grade) => {
            const gradeOutCount = passes.filter(p => {
              const student = students.find(s => s.id === p.studentId);
              return student && student.gradeId === grade.id;
            }).length;

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
                <Users className="w-4 h-4" />
                {grade.name}
                {gradeOutCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">
                    {gradeOutCount}
                  </span>
                )}
              </Button>
            );
          })}
          {currentActiveGrade && (
            <Button
              variant={kioskGradeId === currentActiveGrade.id ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (kioskGradeId === currentActiveGrade.id) {
                  handleClearKiosk();
                } else {
                  handleSendToKiosk(currentActiveGrade.id);
                }
              }}
              className="flex items-center gap-1.5"
              title={kioskGradeId === currentActiveGrade.id ? "Click to clear kiosk" : "Send this grade to kiosk"}
            >
              <Monitor className="w-4 h-4" />
              {kioskGradeId === currentActiveGrade.id ? "On Kiosk" : "Send to Kiosk"}
            </Button>
          )}
        </div>
      </div>

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
                              <span className={`px-2 py-1 text-xs rounded-full border flex items-center gap-1 ${getPassTypeBadgeColor(pass.passType || 'general', pass.destination)}`}>
                                {getPassTypeIcon(pass.passType || 'general', pass.destination)}
                                {pass.destination || getPassTypeLabel(pass.passType || 'general')}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {pass.customReason || `Out for ${formatDuration(pass.issuedAt)}`} • Since {pass.issuedAt ? formatTimeFull(pass.issuedAt, tz) : 'Unknown time'}
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
                <p className="text-center text-muted-foreground py-4">
                  {gradeStudents.length === 0
                    ? `No students in ${currentActiveGrade.name}. Add students in the Classes tab.`
                    : "All students are currently out of class"
                  }
                </p>
              ) : (
                <div className="grid gap-3">
                  {availableStudents.map((student) => (
                    <DropdownMenu key={student.id}>
                      <DropdownMenuTrigger asChild>
                        <div
                          className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg cursor-pointer hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
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
                        </div>
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
                  ))}
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
    </div>
  );
}

export default MyClassTab;
