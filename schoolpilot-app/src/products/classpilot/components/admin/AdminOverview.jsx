import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarDays, CheckCircle2, CircleAlert, FileText, GraduationCap, Users } from "lucide-react";
import { apiRequest } from "../../../../lib/queryClient";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { formatSchoolDate, schoolYearSummary } from "../../lib/adminSchoolYear";

const schoolYearPath = "/classpilot/admin/scheduling?section=school-year";
const shortcuts = [
  { title: "Staff accounts", detail: "Manage staff roles and accounts", path: "/classpilot/admin?tab=staff", Icon: Users },
  { title: "Classes", detail: "Teachers, rosters, and class assignments", path: "/classpilot/admin/classes", Icon: GraduationCap },
  { title: "Discipline logs", detail: "School records organized by student", path: "/classpilot/discipline-records?entry=admin", Icon: FileText },
  { title: "Calendar", detail: "Holidays and school closures", path: "/classpilot/admin/scheduling?section=calendar", Icon: CalendarDays },
];

export default function AdminOverview({ schoolId, viewerId, schoolTimezone }) {
  const scheduling = useQuery({
    queryKey: ["classpilot-school-scheduling", schoolId, viewerId],
    queryFn: ({ signal }) => apiRequest("GET", "/classpilot/admin/scheduling", undefined, { signal }),
    enabled: Boolean(schoolId && viewerId),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const year = schoolYearSummary(scheduling.data?.config, scheduling.data?.schoolLocalToday);
  const needsAttention = ["missing", "invalid", "ended"].includes(year.status);
  return <div className="space-y-8" data-testid="admin-overview">
    <p className="max-w-2xl text-muted-foreground">Manage your school from one workspace. Start with the school year, or open a common task below.</p>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><CalendarDays className="size-5" aria-hidden="true" />School year</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {scheduling.isPending ? <p role="status">Loading school-year dates…</p> : scheduling.isError ? <div role="alert" className="space-y-3">
          <p>School-year dates could not be loaded. This does not mean they are missing.</p>
          <Button variant="outline" onClick={() => scheduling.refetch()}>Retry school-year dates</Button>
        </div> : <>
          <div className="flex items-start gap-3">
            {needsAttention ? <CircleAlert className="mt-1 size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" /> : <CheckCircle2 className="mt-1 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
            <div className="space-y-1"><p className="font-semibold">{year.label}</p>
              {year.start && <p className="text-xl font-semibold tracking-tight"><time dateTime={year.start}>{formatSchoolDate(year.start)}</time> – <time dateTime={year.end}>{formatSchoolDate(year.end)}</time></p>}
              <p className="text-sm text-muted-foreground">{year.detail}</p>
              <p className="text-sm text-muted-foreground">School timezone: {scheduling.data?.schoolTimezone || schoolTimezone}</p>
            </div>
          </div>
          <Button asChild variant={needsAttention ? "default" : "outline"}><Link to={schoolYearPath}>{needsAttention ? "Review school-year dates" : "Open School year"}<ArrowRight className="ml-2 size-4" aria-hidden="true" /></Link></Button>
        </>}
      </CardContent>
    </Card>
    <section aria-labelledby="admin-common-tasks"><h2 id="admin-common-tasks" className="mb-4 text-lg font-semibold">Common tasks</h2>
      <div className="grid gap-3 sm:grid-cols-2">{shortcuts.map(({ title, detail, path, Icon }) => <Link key={path} to={path} className="flex min-w-0 items-center gap-4 rounded-lg border bg-card p-5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block font-semibold">{title}</span><span className="mt-1 block text-sm text-muted-foreground">{detail}</span></span><ArrowRight className="size-4 shrink-0" aria-hidden="true" />
      </Link>)}</div>
    </section>
  </div>;
}
