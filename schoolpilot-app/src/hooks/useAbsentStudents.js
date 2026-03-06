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
 * Shared hook returning a Set of absent student IDs for today.
 * Used by ClassPilot, PassPilot, and GoPilot dashboards to show absent badges.
 */
export function useAbsentStudents() {
  const { activeMembership } = useAuth();
  const tz = activeMembership?.schoolTimezone || "America/New_York";
  const today = todayInTimezone(tz);

  const { data } = useQuery({
    queryKey: ["/api/admin/attendance", today],
    queryFn: () => apiRequest("GET", `/admin/attendance?date=${today}`),
    staleTime: 60_000,
    retry: false,
  });

  const records = data?.records || [];
  const absentIds = new Set(records.map((r) => r.studentId));
  return { absentIds, records };
}
