import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/queryClient";
import { UserCheck } from "lucide-react";

/**
 * Banner shown to teachers who have active substitute assignments.
 * Displays which absent teachers they are covering for.
 */
export default function SubstituteBanner() {
  const { data } = useQuery({
    queryKey: ["/api/admin/substitutes/mine"],
    queryFn: () => apiRequest("GET", "/admin/substitutes/mine"),
    staleTime: 60_000,
    retry: false,
  });

  const subs = data?.substitutions;
  if (!subs || subs.length === 0) return null;

  const names = subs
    .map((s) => s.absentTeacher?.name || "Unknown Teacher")
    .join(", ");

  return (
    <div className="bg-blue-500/15 border border-blue-500/30 text-blue-700 dark:text-blue-300 px-4 py-2.5 flex items-center gap-2 text-sm">
      <UserCheck className="h-4 w-4 shrink-0" />
      <span>
        <strong>Substituting for:</strong> {names}
      </span>
    </div>
  );
}
