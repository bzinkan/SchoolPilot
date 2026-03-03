import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useNavigate } from "react-router-dom";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { useToast } from "../../../hooks/use-toast";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Badge } from "../../../components/ui/badge";
import {
  ArrowLeft,
  Plus,
  Users,
  Trash2,
  Search,
  Loader2,
  UserCheck,
  Calendar,
} from "lucide-react";

export default function AdminSubstitutes() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useClassPilotAuth();

  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("active");

  // Form state
  const [isExternal, setIsExternal] = useState(false);
  const [substituteUserId, setSubstituteUserId] = useState("");
  const [substituteEmail, setSubstituteEmail] = useState("");
  const [substituteName, setSubstituteName] = useState("");
  const [absentTeacherId, setAbsentTeacherId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");

  // Fetch substitute assignments
  const { data: activeData, isLoading: loadingActive } = useQuery({
    queryKey: ["/api/admin/substitutes", "active"],
    queryFn: () => apiRequest("GET", "/admin/substitutes?active=true"),
  });

  const { data: allData, isLoading: loadingAll } = useQuery({
    queryKey: ["/api/admin/substitutes", "all"],
    queryFn: () => apiRequest("GET", "/admin/substitutes"),
  });

  // Fetch staff list for dropdowns
  const { data: staffData } = useQuery({
    queryKey: ["/api/staff"],
    queryFn: () => apiRequest("GET", "/staff"),
  });

  const staff = staffData?.staff || [];
  const teachers = staff.filter(
    (s) => s.role === "teacher" || s.role === "admin"
  );

  // Create assignment
  const createMutation = useMutation({
    mutationFn: (data) => apiRequest("POST", "/admin/substitutes", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/substitutes"] });
      toast({
        title: "Substitute assigned",
        description: "The substitute assignment has been created.",
      });
      resetForm();
      setAssignDialogOpen(false);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to create assignment",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  // Cancel assignment
  const cancelMutation = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/admin/substitutes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/substitutes"] });
      toast({
        title: "Assignment canceled",
        description: "The substitute assignment has been canceled.",
      });
      setCancelTarget(null);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to cancel assignment",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  function resetForm() {
    setIsExternal(false);
    setSubstituteUserId("");
    setSubstituteEmail("");
    setSubstituteName("");
    setAbsentTeacherId("");
    setStartDate("");
    setEndDate("");
    setNotes("");
  }

  function handleCreate() {
    const payload = {
      absentTeacherId,
      startDate,
      endDate,
      notes: notes || undefined,
    };

    if (isExternal) {
      payload.substituteEmail = substituteEmail;
      payload.substituteName = substituteName || undefined;
    } else {
      payload.substituteUserId = substituteUserId;
    }

    createMutation.mutate(payload);
  }

  const canSubmit = isExternal
    ? substituteEmail && absentTeacherId && startDate && endDate
    : substituteUserId && absentTeacherId && startDate && endDate;

  // Defaults for date inputs
  function openAssignDialog() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    setStartDate(`${today}T07:00`);
    setEndDate(`${today}T16:00`);
    setAssignDialogOpen(true);
  }

  // Filter assignments by search
  function filterAssignments(assignments) {
    if (!searchQuery) return assignments;
    const q = searchQuery.toLowerCase();
    return assignments.filter(
      (a) =>
        a.substitute?.name?.toLowerCase().includes(q) ||
        a.substitute?.email?.toLowerCase().includes(q) ||
        a.absentTeacher?.name?.toLowerCase().includes(q) ||
        a.absentTeacher?.email?.toLowerCase().includes(q)
    );
  }

  const activeAssignments = filterAssignments(activeData?.assignments || []);
  const allAssignments = filterAssignments(allData?.assignments || []);
  const historyAssignments = allAssignments.filter(
    (a) => a.status !== "active"
  );

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function statusBadge(status) {
    const variants = {
      active: "default",
      expired: "secondary",
      canceled: "destructive",
    };
    return <Badge variant={variants[status] || "secondary"}>{status}</Badge>;
  }

  function renderTable(assignments, showCancel = false) {
    if (!assignments || assignments.length === 0) {
      return (
        <div className="text-center py-12 text-muted-foreground">
          <UserCheck className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>No substitute assignments found</p>
        </div>
      );
    }

    return (
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-sm">
                Substitute
              </th>
              <th className="px-4 py-3 text-left font-medium text-sm">
                Covering For
              </th>
              <th className="px-4 py-3 text-left font-medium text-sm">
                Start
              </th>
              <th className="px-4 py-3 text-left font-medium text-sm">End</th>
              <th className="px-4 py-3 text-left font-medium text-sm">
                Status
              </th>
              {showCancel && (
                <th className="px-4 py-3 text-right font-medium text-sm">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id} className="border-t hover:bg-muted/50">
                <td className="px-4 py-3">
                  <div>
                    <p className="font-medium">
                      {a.substitute?.name || "Unknown"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {a.substitute?.email}
                    </p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div>
                    <p className="font-medium">
                      {a.absentTeacher?.name || "Unknown"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {a.absentTeacher?.email}
                    </p>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm">{formatDate(a.startDate)}</td>
                <td className="px-4 py-3 text-sm">{formatDate(a.endDate)}</td>
                <td className="px-4 py-3">{statusBadge(a.status)}</td>
                {showCancel && (
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCancelTarget(a)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <Users className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Substitute Teachers</h1>
            <p className="text-muted-foreground">
              Manage temporary teacher coverage across all products
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => navigate("/classpilot/admin")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Admin
          </Button>
        </div>
      </div>

      {/* Main content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="active">
              Active ({activeAssignments.length})
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search substitutes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
            <Button onClick={openAssignDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Assign Substitute
            </Button>
          </div>
        </div>

        <TabsContent value="active">
          <Card>
            <CardHeader>
              <CardTitle>Active Assignments</CardTitle>
              <CardDescription>
                Currently active substitute teacher assignments. Substitutes can
                access the absent teacher's classes, grades, and homerooms.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingActive ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                renderTable(activeAssignments, true)
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Assignment History</CardTitle>
              <CardDescription>
                Past and canceled substitute assignments.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingAll ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                renderTable(historyAssignments, false)
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Assign Substitute Dialog */}
      <Dialog
        open={assignDialogOpen}
        onOpenChange={(open) => {
          setAssignDialogOpen(open);
          if (!open) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign Substitute Teacher</DialogTitle>
            <DialogDescription>
              Create a temporary assignment so the substitute can access the
              absent teacher's resources across ClassPilot, PassPilot, and
              GoPilot.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Absent teacher */}
            <div className="space-y-2">
              <Label>Absent Teacher</Label>
              <Select
                value={absentTeacherId}
                onValueChange={setAbsentTeacherId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select teacher being covered" />
                </SelectTrigger>
                <SelectContent>
                  {teachers.map((t) => (
                    <SelectItem key={t.userId} value={t.userId}>
                      {t.displayName ||
                        `${t.firstName} ${t.lastName}`}{" "}
                      ({t.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* In-house vs External toggle */}
            <div className="space-y-2">
              <Label>Substitute Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={!isExternal ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsExternal(false)}
                >
                  In-House Staff
                </Button>
                <Button
                  type="button"
                  variant={isExternal ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsExternal(true)}
                >
                  External Substitute
                </Button>
              </div>
            </div>

            {/* Substitute selection */}
            {!isExternal ? (
              <div className="space-y-2">
                <Label>Substitute (Staff Member)</Label>
                <Select
                  value={substituteUserId}
                  onValueChange={setSubstituteUserId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select substitute" />
                  </SelectTrigger>
                  <SelectContent>
                    {teachers
                      .filter((t) => t.userId !== absentTeacherId)
                      .map((t) => (
                        <SelectItem key={t.userId} value={t.userId}>
                          {t.displayName ||
                            `${t.firstName} ${t.lastName}`}{" "}
                          ({t.email})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="sub-email">Substitute Email</Label>
                  <Input
                    id="sub-email"
                    type="email"
                    placeholder="substitute@example.com"
                    value={substituteEmail}
                    onChange={(e) => setSubstituteEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sub-name">
                    Substitute Name{" "}
                    <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="sub-name"
                    placeholder="Jane Smith"
                    value={substituteName}
                    onChange={(e) => setSubstituteName(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Date range */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="start-date">
                  <Calendar className="h-3 w-3 inline mr-1" />
                  Start
                </Label>
                <Input
                  id="start-date"
                  type="datetime-local"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">
                  <Calendar className="h-3 w-3 inline mr-1" />
                  End
                </Label>
                <Input
                  id="end-date"
                  type="datetime-local"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="notes">
                Notes{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="notes"
                placeholder="e.g. Covering periods 1-3 only"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAssignDialogOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!canSubmit || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Assigning...
                </>
              ) : (
                "Assign Substitute"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Confirmation */}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Substitute Assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately revoke{" "}
              <strong>{cancelTarget?.substitute?.name}</strong>'s access to{" "}
              <strong>{cancelTarget?.absentTeacher?.name}</strong>'s resources.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Active</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelMutation.mutate(cancelTarget?.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelMutation.isPending ? "Canceling..." : "Cancel Assignment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
