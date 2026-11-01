import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useAdminShell, useAdminNavigation } from '../hooks/useAdminNavigation';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { adminIdentityKey } from '../lib/adminNavigation';
import { ADOPTION_HEALTH_API, displayCount, formatAdoptionDate, requireAdoptionSection } from '../lib/adoptionHealth';
import { ClassroomTools, NeedsAttention, ObservedClients, ReportingAvailability, SectionFeedback } from '../components/AdoptionHealthPanels';
import SessionMonitoringReportDialog from '../components/SessionMonitoringReportDialog';

function useSection(section, { identity, schoolId, period, page = 1, enabled = true }) {
  return useQuery({
    queryKey: [ADOPTION_HEALTH_API, identity, period, section, page],
    queryFn: async ({ signal }) => requireAdoptionSection(await apiRequest('GET', `${ADOPTION_HEALTH_API}/${section}?period=${period}${section === 'failures' ? `&page=${page}` : ''}`, undefined, { signal, headers: { 'X-School-Id': schoolId } }), section),
    enabled, retry: false, gcTime: 0,
  });
}

function Stat({ label, value, context, denominator }) {
  return <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{displayCount(value)}{denominator !== undefined && <span className="ml-1 text-sm font-normal text-muted-foreground">/ {displayCount(denominator)}</span>}</p><p className="mt-2 text-xs text-muted-foreground">{context}</p></CardContent></Card>;
}

function PeriodView({ identity, school, period, onPeriodChange }) {
  const shell = useAdminShell();
  const { navigate } = useAdminNavigation();
  const [page, setPage] = useState(1);
  const [expandedClasses, setExpandedClasses] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [clientsOpen, setClientsOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const options = { identity, schoolId: school.id, period };
  const overview = useSection('overview', options);
  const failures = useSection('failures', { ...options, page });
  const availability = useSection('availability', { ...options, enabled: availabilityOpen });
  const tools = useSection('tools', { ...options, enabled: toolsOpen });
  const clients = useSection('clients', { ...options, enabled: clientsOpen });
  const data = !overview.isError ? overview.data : null;
  const timezone = data?.period.timeZone || school.timezone;
  const rows = data ? (expandedClasses ? data.classes : data.classes.slice(0, 6)) : [];
  return <div className="container mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    {!shell && <div className="flex items-center justify-between gap-3"><Button variant="outline" onClick={() => navigate('/classpilot/admin')}><ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Back to Admin</Button><ThemeToggle /></div>}
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">Adoption &amp; reporting health</h1><p className="mt-2 text-sm text-muted-foreground">Review confirmed failures and see where ClassPilot is being used.</p></div>
      <div className="grid max-w-full gap-2"><label className="grid gap-1 text-xs text-muted-foreground">Reporting period<select aria-label="Reporting period" className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={period} onChange={event => onPeriodChange(event.target.value)}><option value="7d">Last 7 days</option><option value="today">Today</option><option value="30d">Last 30 days</option></select></label>
        {data && <p className="text-xs text-muted-foreground">{formatAdoptionDate(data.period.startLocalDate)} – {formatAdoptionDate(data.period.todayLocalDate)}</p>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Completed class sessions · {timezone}. Current lessons appear after they end and their summaries are prepared.</p>
    {data?.range.partiallyRetained && <p role="note" className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">Part of this range is outside the school’s retention window. Totals include retained completed sessions only; older data is unavailable.</p>}
    <NeedsAttention query={failures} page={page} onPageChange={setPage} onSelect={setSelectedReport} timezone={timezone} />
    <ReportingAvailability query={availability} readyCount={data?.reportCounts.ready} open={availabilityOpen} onToggle={setAvailabilityOpen} onSelect={setSelectedReport} timezone={timezone} />

    <section aria-labelledby="adoption-overview-heading" className="min-w-0 space-y-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="adoption-overview-heading" className="text-lg font-semibold">Adoption across the school</h2><p className="text-xs text-muted-foreground">Current active official classes · completed sessions</p></div>
      <SectionFeedback query={overview} label="adoption overview">{data && <>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3"><Stat label="Classes with observations" value={data.summary.classesWithObservations} denominator={data.summary.totalClasses} context="Active official classes" /><Stat label="Students observed" value={data.summary.studentsObserved} context={`${displayCount(data.summary.totalStudents)} students currently enrolled`} /><Stat label="Teachers with live sessions" value={data.summary.teachersWithLiveSessions} context="Automatic scheduled reporting excluded" /></div>
        <p className="text-xs text-muted-foreground">Observation totals use {displayCount(data.summary.readySummaries)} ready summaries from {displayCount(data.summary.completedSessions)} completed official-class sessions.{data.dataState === 'partial' || data.dataState === 'unavailable' ? ' Some summaries are preparing or unavailable; observation totals are incomplete.' : ''}</p>
        <Card className="min-w-0 overflow-hidden"><div className="px-5 pb-3 pt-5"><h3 className="text-base font-medium">Activity by official class</h3><p className="mt-1 text-xs text-muted-foreground">All active official classes, in alphabetical order. Session counts include automatic scheduled reporting.</p></div>
          <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[29rem] text-sm"><thead className="border-y bg-muted/40 text-xs text-muted-foreground"><tr><th scope="col" className="px-5 py-3 text-left font-medium">Class / teacher</th><th scope="col" className="px-4 py-3 text-right font-medium">Sessions</th><th scope="col" className="px-4 py-3 text-right font-medium">Days with observations</th><th scope="col" className="px-5 py-3 text-left font-medium">Last observed</th></tr></thead><tbody>{rows.map(row => <tr key={row.groupId} className="border-b last:border-0"><td className="px-5 py-4"><span className="font-medium">{row.groupName}</span><p className="mt-1 text-xs text-muted-foreground">{row.teacherName}</p></td><td className="px-4 py-4 text-right tabular-nums">{displayCount(row.sessionCount)}</td><td className="px-4 py-4 text-right tabular-nums">{displayCount(row.daysWithObservations)}</td><td className="px-5 py-4 text-xs text-muted-foreground">{formatAdoptionDate(row.lastObservedAt, timezone)}</td></tr>)}</tbody></table></div>
          {data.classes.length === 0 && <p className="px-5 py-5 text-sm text-muted-foreground">No active official classes are configured.</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground"><span>Showing {rows.length} of {data.classes.length} active official classes</span>{data.classes.length > 6 && <Button variant="link" size="sm" className="h-auto p-0" aria-expanded={expandedClasses} onClick={() => setExpandedClasses(value => !value)}>{expandedClasses ? 'Show fewer classes' : `Show all ${data.classes.length} classes`}</Button>}</div>
        </Card>
      </>}</SectionFeedback>
    </section>
    <div className="min-w-0 border-t"><ClassroomTools query={tools} open={toolsOpen} onToggle={setToolsOpen} /><ObservedClients query={clients} open={clientsOpen} onToggle={setClientsOpen} /></div>
    {selectedReport && <SessionMonitoringReportDialog target={selectedReport} onClose={() => setSelectedReport(null)} schoolId={school.id} queryIdentity={identity} />}
  </div>;
}

function AdoptionPage({ identity, school }) {
  const [period, setPeriod] = useState('7d');
  // A changed period remounts local expansion, pagination, and report selection.
  return <PeriodView key={period} identity={identity} school={school} period={period} onPeriodChange={setPeriod} />;
}

export default function AdminAnalytics() {
  const { user, activeMembership, activeSchoolId } = useAuth();
  const { school, currentUser, isAdmin, isLoading } = useClassPilotAuth();
  if (isLoading) return <p role="status">Checking administrator access…</p>;
  if (!(isAdmin || currentUser?.isSuperAdmin) || !school?.id) return <p role="alert" className="p-6 text-sm">Administrator access is required for adoption and reporting health.</p>;
  const identity = JSON.stringify([adminIdentityKey(user, activeMembership, activeSchoolId), user?.authVersion ?? null]);
  return <AdoptionPage key={identity} identity={identity} school={school} />;
}
