import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";

/**
 * Shared hook returning a Set of absent student IDs for today.
 * Used by ClassPilot, PassPilot, and GoPilot dashboards to show absent badges.
 */
export function useAbsentStudents() {
  const today = new Date().toISOString().slice(0, 10);

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
