import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../lib/queryClient";
import { useAbsentStudents } from "../hooks/useAbsentStudents";
import { useToast } from "../hooks/use-toast";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { ClipboardCheck, Loader2, Search, X } from "lucide-react";

/**
 * Compact attendance panel for teacher dashboards.
 * Embeds inline in ClassPilot, PassPilot, and GoPilot teacher views.
 *
 * @param {Object} props
 * @param {Array<{id: string, firstName: string, lastName: string}>} props.students - Class roster
 * @param {() => void} props.onClose - Close the panel
 */
export function AttendancePanel({ students, onClose }) {
  const { toast } = useToast();
  const { absentIds, records } = useAbsentStudents();

  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [markStatus, setMarkStatus] = useState("absent");
  const [markReason, setMarkReason] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const today = new Date().toISOString().slice(0, 10);

  // Split students into absent and present for this class
  const classAbsentRecords = useMemo(
    () => records.filter((r) => students.some((s) => s.id === r.studentId)),
    [records, students]
  );

  const presentStudents = useMemo(() => {
    let list = students.filter((s) => !absentIds.has(s.id));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.firstName?.toLowerCase().includes(q) ||
          s.lastName?.toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) =>
      (a.lastName || "").localeCompare(b.lastName || "")
    );
  }, [students, absentIds, searchQuery]);

  const markMutation = useMutation({
    mutationFn: (data) => apiRequest("POST", "/admin/attendance", data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/attendance"],
      });
      toast({
        title: "Students marked",
        description: `${data.count} student(s) marked as ${markStatus}.`,
      });
      setSelectedStudents(new Set());
      setMarkReason("");
      onClose();
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to mark attendance",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/admin/attendance/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/attendance"],
      });
      toast({
        title: "Absence removed",
        description: "The student is now marked as present.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to remove absence",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  function handleMarkSelected() {
    if (selectedStudents.size === 0) return;
    markMutation.mutate({
      studentIds: [...selectedStudents],
      date: today,
      status: markStatus,
      reason: markReason || undefined,
    });
  }

  function toggleStudent(id) {
    setSelectedStudents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const statusLabel = { absent: "Absent", tardy: "Tardy", early_dismissal: "Early Dismissal" };
  const statusVariant = { absent: "destructive", tardy: "default", early_dismissal: "secondary" };

  return (
    <div className="border border-border rounded-lg bg-card text-card-foreground shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">
            Attendance ({students.length} students)
          </span>
          {classAbsentRecords.length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {classAbsentRecords.length} absent
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="p-4 space-y-4">
        {/* Absent Today */}
        {classAbsentRecords.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              ABSENT TODAY
            </p>
            <div className="space-y-1.5">
              {classAbsentRecords.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {r.student?.name || r.studentId}
                    </span>
                    <Badge
                      variant={statusVariant[r.status] || "secondary"}
                      className="text-xs"
                    >
                      {statusLabel[r.status] || r.status}
                    </Badge>
                    {r.reason && (
                      <span className="text-xs text-muted-foreground capitalize">
                        {r.reason}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => removeMutation.mutate(r.id)}
                    disabled={removeMutation.isPending}
                  >
                    Mark Present
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mark Absent */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">
            MARK ABSENT
          </p>

          {/* Search + controls */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search students..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-input bg-background"
              />
            </div>
            <Select value={markStatus} onValueChange={setMarkStatus}>
              <SelectTrigger className="w-[130px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="absent">Absent</SelectItem>
                <SelectItem value="tardy">Tardy</SelectItem>
                <SelectItem value="early_dismissal">Early Dismissal</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={markReason || "_none"}
              onValueChange={(v) => setMarkReason(v === "_none" ? "" : v)}
            >
              <SelectTrigger className="w-[110px] h-8 text-xs">
                <SelectValue placeholder="Reason" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">No reason</SelectItem>
                <SelectItem value="sick">Sick</SelectItem>
                <SelectItem value="family">Family</SelectItem>
                <SelectItem value="appointment">Appointment</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Student checklist */}
          <div className="border rounded-md max-h-[240px] overflow-y-auto">
            {presentStudents.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                {searchQuery
                  ? "No matching students"
                  : "All students are marked absent"}
              </div>
            ) : (
              <div className="divide-y">
                {presentStudents.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedStudents.has(s.id)}
                      onCheckedChange={() => toggleStudent(s.id)}
                    />
                    <span className="text-sm">
                      {s.lastName}, {s.firstName}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Submit */}
          {presentStudents.length > 0 && (
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() =>
                    setSelectedStudents(
                      new Set(presentStudents.map((s) => s.id))
                    )
                  }
                >
                  Select All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => setSelectedStudents(new Set())}
                >
                  Clear
                </Button>
              </div>
              <Button
                size="sm"
                onClick={handleMarkSelected}
                disabled={
                  selectedStudents.size === 0 || markMutation.isPending
                }
              >
                {markMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                )}
                Mark {selectedStudents.size} Absent
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
