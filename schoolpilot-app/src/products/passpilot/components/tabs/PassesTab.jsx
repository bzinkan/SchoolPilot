import { Card, CardContent } from "../../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { Badge } from "../../../../components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { formatTime } from "../../../../lib/date-utils";

function PassesTab() {
  const { school } = usePassPilotAuth();
  const tz = school?.schoolTimezone ?? "America/New_York";
  const { data: passes, isLoading, error } = useQuery({
    queryKey: ['/api/passes/active'],
    queryFn: async () => {
      const res = await fetch('/api/passes/active', {
        credentials: 'include',
        cache: 'no-cache',
      });
      if (!res.ok) throw new Error(`Failed to fetch passes: ${res.status}`);
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.passes ?? []),
    refetchInterval: 5000,
    gcTime: 0,
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

  const [filterType, setFilterType] = useState("all");
  const [filterGrade, setFilterGrade] = useState("all");

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

  if (error) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-destructive mb-2">Could not load passes</p>
            <p className="text-xs text-muted-foreground">{error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!passes) return null;

  const formatDuration = (issuedAt) => {
    if (!issuedAt) return "Unknown";
    try {
      const now = new Date();
      const issued = new Date(issuedAt);
      if (isNaN(issued.getTime())) return "Unknown";
      const diffMs = now.getTime() - issued.getTime();
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes} min`;
    } catch {
      return "Unknown";
    }
  };

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

  const filteredPasses = (passes || []).filter((pass) => {
    let passType = 'general';
    if (pass.destination?.toLowerCase().includes('nurse')) {
      passType = 'nurse';
    } else if (pass.destination?.toLowerCase().includes('discipline') || pass.destination?.toLowerCase().includes('office')) {
      passType = 'discipline';
    }

    const typeMatch = filterType === "all" || passType === filterType;
    const gradeMatch = filterGrade === "all" || pass.student?.grade === filterGrade;

    return typeMatch && gradeMatch;
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
              Showing all school passes
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
            <Select value={filterGrade} onValueChange={setFilterGrade}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Classes</SelectItem>
                {grades.map((grade) => (
                  <SelectItem key={grade.id} value={grade.name}>
                    {grade.name}
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
                  : `No ${filterType === 'all' ? '' : filterType + ' '}${filterGrade === 'all' ? '' : 'grade ' + filterGrade + ' '}passes currently active`
                }
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredPasses.map((pass) => (
            <Card key={pass.id} className="shadow-sm" data-testid={`pass-card-${pass.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${getAvatarColor(`${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || '')}`}>
                      <span className="text-sm font-medium" data-testid={`student-initials-${pass.id}`}>
                        {getInitials(`${pass.student?.firstName ?? ''} ${pass.student?.lastName ?? ''}`.trim() || '')}
                      </span>
                    </div>
                    <div>
                      <div className="flex items-center space-x-2 mb-1">
                        <h3 className="font-medium text-foreground" data-testid={`student-name-${pass.id}`}>
                          {pass.student?.firstName} {pass.student?.lastName}
                        </h3>
                        {getDestinationBadge(pass)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Grade <span data-testid={`student-grade-${pass.id}`}>{pass.student?.grade}</span> •
                        Out for <span data-testid={`pass-duration-${pass.id}`}>{formatDuration(pass.issuedAt)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Issued by: <span className="font-medium">{pass.teacher ? `${pass.teacher.firstName} ${pass.teacher.lastName}`.trim() + (pass.issuedVia === "kiosk" && pass.notes ? ` (Kiosk: ${pass.notes})` : '') : (pass.issuedVia === "kiosk" ? (pass.notes ? `Kiosk: ${pass.notes}` : "Kiosk") : "Unknown")}</span>
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Checked out</p>
                    <p className="text-sm font-medium text-foreground" data-testid={`checkout-time-${pass.id}`}>
                      {formatTime(pass.issuedAt, tz)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

export default PassesTab;
