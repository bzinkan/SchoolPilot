import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";
import { useAuth } from "../contexts/AuthContext";

function todayInTimezone(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return parts; // en-CA formats as YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Shared hook returning attendance status for today.
 * `unavailableIds` marks students unavailable for dismissal/movement.
 */
export function useAbsentStudents(productContext) {
  const { activeMembership } = useAuth();
  const tz = activeMembership?.schoolTimezone || "America/New_York";
  const today = todayInTimezone(tz);
  const contextParam = productContext ? `&productContext=${encodeURIComponent(productContext)}` : "";

  const { data } = useQuery({
    queryKey: ["/api/admin/attendance", today, productContext || ""],
    queryFn: () => apiRequest("GET", `/admin/attendance?date=${today}${contextParam}`),
    staleTime: 60_000,
    retry: false,
  });

  const records = data?.records || [];
  const attendanceStatusByStudent = records.reduce((acc, record) => {
    acc[record.studentId] = record.status;
    return acc;
  }, {});
  const recordedIds = new Set(records.map((r) => r.studentId));
  const absentIds = new Set(records.filter((r) => r.status === "absent").map((r) => r.studentId));
  const tardyIds = new Set(records.filter((r) => r.status === "tardy").map((r) => r.studentId));
  const earlyDismissalIds = new Set(records.filter((r) => r.status === "early_dismissal").map((r) => r.studentId));
  const unavailableIds = new Set([...absentIds, ...earlyDismissalIds]);
  return {
    absentIds,
    tardyIds,
    earlyDismissalIds,
    unavailableIds,
    recordedIds,
    attendanceStatusByStudent,
    records,
  };
}
