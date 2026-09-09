import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Card, CardContent } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import { Label } from "../../../components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { useAuth } from "../../../contexts/AuthContext";
import { apiRequest, queryClient } from "../../../lib/queryClient";

const API = "/classpilot/monitoring-interruptions";
const errorText = (error) => error?.response?.data?.error || "Monitoring status is temporarily unavailable.";
const endReason = (value) => ({ telemetry_resumed: "Telemetry resumed", monitoring_off: "Monitoring no longer expected", privacy_off: "Monitoring turned off", binding_or_scope_changed: "Class or sign-in changed", scope_or_binding_ended: "Class or sign-in ended", binding_ended: "Student signed out" }[value] || "Monitoring no longer expected");

const validSummary = (data) => data && ["healthy", "not_expected", "uncertain", "unknown"].includes(data.scanStatus)
  && typeof data.asOf === "string" && Number.isFinite(Date.parse(data.asOf))
  && (data.lastScannedAt === null || (typeof data.lastScannedAt === "string" && Number.isFinite(Date.parse(data.lastScannedAt))))
  && Number.isSafeInteger(data.counts?.open) && data.counts.open >= 0
  && Number.isSafeInteger(data.counts?.last24Hours) && data.counts.last24Hours >= 0;
async function readMonitoring(url, schoolId, signal, history = false) {
  const data = await apiRequest("GET", url, undefined, { signal, headers: { "X-School-Id": schoolId } });
  if (!validSummary(data) || (history && (!Array.isArray(data.incidents) || data.incidents.length > 50
    || !(data.nextCursor === null || typeof data.nextCursor === "string")))) throw new Error("Invalid monitoring response");
  return !data.lastScannedAt || Date.parse(data.asOf) - Date.parse(data.lastScannedAt) > 180_000 ? { ...data, scanStatus: "uncertain" } : data;
}
const uncertainReading = (query) => query.isError || !query.data || ["uncertain", "unknown"].includes(query.data.scanStatus);

function MonitoringHistory({ schoolId, identity, initialFilter, refreshSummary }) {
  const historyId = useId();
  const [filter, setFilter] = useState(initialFilter);
  const [cursors, setCursors] = useState([null]);
  const cursor = cursors.at(-1);
  const query = useQuery({ queryKey: [API, schoolId, identity, "history", filter, cursor],
    queryFn: ({ signal }) => readMonitoring(`${API}?view=history&filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, schoolId, signal, true),
    refetchInterval: 60_000, refetchIntervalInBackground: false });
  const uncertain = uncertainReading(query);
  const refresh = () => { setCursors([null]); if (!cursor) void query.refetch(); void refreshSummary(); };
  return <>
    <DialogHeader className="pr-6">
      <DialogTitle>Monitoring interruption history</DialogTitle>
      <DialogDescription>Events in your authorized classes and supervision sessions. Expected updates stopped for more than 60 seconds; the cause is unknown.</DialogDescription>
    </DialogHeader>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs value={filter} onValueChange={(value) => { setFilter(value); setCursors([null]); }}>
        <TabsList aria-label="Interruption history filter"><TabsTrigger id={`${historyId}-open-tab`} aria-controls={`${historyId}-open-panel`} value="open">Open</TabsTrigger><TabsTrigger id={`${historyId}-recent-tab`} aria-controls={`${historyId}-recent-panel`} value="recent">Last 24 hours</TabsTrigger></TabsList>
      </Tabs>
      <Button size="sm" variant="outline" onClick={refresh} disabled={query.isFetching}>Refresh history</Button>
    </div>
    <p className="text-xs text-muted-foreground">{filter === "open" ? "All retained open events, including those that began more than 24 hours ago." : "Events detected in the last 24 hours, including recovered and ended events."} Counts are events, not unique students.</p>
    <div id={`${historyId}-${filter}-panel`} role="tabpanel" aria-labelledby={`${historyId}-${filter}-tab`} className="min-h-0 overflow-y-auto space-y-3" tabIndex={0}>
      {query.isFetching ? <p role="status">{query.isPending ? "Loading interruption history…" : "Refreshing history… Previously loaded events remain visible."}</p> : null}
      {!query.isPending && uncertain ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{query.isError ? errorText(query.error) : "Monitoring status is uncertain. These are the last recorded events."}</p> : null}
      {query.isError ? <Button variant="outline" onClick={refresh}>Retry history</Button> : null}
      {query.data?.scanStatus === "not_expected" ? <p className="text-sm text-muted-foreground">Full classroom monitoring is not currently expected.</p> : null}
      {!query.isFetching && !query.isPending && !query.isError && query.data?.incidents.length === 0 ? <p className="text-sm">{uncertain ? "No confirmed events to display." : filter === "open" ? "No open interruption events." : "No interruption events in the last 24 hours."}</p> : null}
      {query.data?.incidents.map((incident) => <article key={incident.id} className="rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{incident.studentName || "Student"}</p><p className="break-words text-muted-foreground">{incident.scopeName}</p></div><Badge variant={!uncertain && incident.status === "open" ? "destructive" : "outline"}>{!incident.endedAt && uncertain ? "uncertain" : incident.status}</Badge></div>
        <p className="mt-2 text-xs text-muted-foreground">Last observed {new Date(incident.lastObservedAt).toLocaleString()} · Detected {new Date(incident.detectedAt).toLocaleString()}</p>
        <p className="mt-1 text-xs">{incident.endedAt ? `${endReason(incident.endReason)} · ${new Date(incident.endedAt).toLocaleString()}` : "Cause unknown"}</p>
      </article>)}
    </div>
    <div id={`${historyId}-${filter === 'open' ? 'recent' : 'open'}-panel`} role="tabpanel" aria-labelledby={`${historyId}-${filter === 'open' ? 'recent' : 'open'}-tab`} hidden />
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <p role="status" className="text-xs text-muted-foreground">Page {cursors.length} · Up to 50 events per page</p>
      <div className="flex gap-2"><Button variant="outline" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((values) => values.slice(0, -1))}>Previous page</Button><Button variant="outline" disabled={!query.data?.nextCursor || query.isFetching || query.isError} onClick={() => setCursors((values) => [...values, query.data.nextCursor])}>Next page</Button></div>
    </div>
  </>;
}

function ScopedMonitoringPanel({ schoolId, identity }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const query = useQuery({ queryKey: [API, schoolId, identity, "summary"],
    queryFn: ({ signal }) => readMonitoring(`${API}?view=summary`, schoolId, signal),
    enabled: Boolean(schoolId), refetchInterval: 60_000, refetchIntervalInBackground: false });
  const uncertain = uncertainReading(query);
  const counts = query.data?.counts;
  const historyLabel = !query.isFetching && !uncertain && query.data.scanStatus === "healthy"
    ? counts.open > 0 ? "Review open interruptions" : "View recent history"
    : "View interruption history";
  return <Card className="mb-6" data-testid="monitoring-interruptions-panel">
    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1"><p className="flex items-center gap-2 text-sm font-medium"><CircleAlert className="h-4 w-4 shrink-0" />Monitoring interruptions</p>
        <p role="status" className={`text-sm ${uncertain && !query.isPending ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
          {query.isPending || query.isFetching ? "Checking monitoring status…" : uncertain ? query.isError ? errorText(query.error) : "Monitoring status is uncertain." : query.data.scanStatus === "not_expected" ? "Full classroom monitoring is not currently expected." : counts.open === 0 ? "No open monitoring interruptions" : `${counts.open} open interruption${counts.open === 1 ? "" : "s"}`}
          {counts ? ` · ${counts.last24Hours} event${counts.last24Hours === 1 ? "" : "s"} in the last 24 hours` : ""}
        </p>
        {counts && (query.isFetching || uncertain || query.data.scanStatus === "not_expected") ? <p className="text-xs text-muted-foreground">Last recorded: {counts.open} open. Counts may not describe current monitoring.</p> : null}
        <p className="text-xs text-muted-foreground">{query.data?.lastScannedAt ? <>Last check: <time dateTime={query.data.lastScannedAt}>{new Date(query.data.lastScannedAt).toLocaleString()}</time></> : "Last check unavailable"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
          <DialogTrigger asChild><Button variant="outline" size="sm" disabled={!schoolId}>{historyLabel}</Button></DialogTrigger>
          {historyOpen ? <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] p-4 sm:p-6"><MonitoringHistory schoolId={schoolId} identity={identity} initialFilter={counts?.open ? "open" : "recent"} refreshSummary={query.refetch} /></DialogContent> : null}
        </Dialog>
        <Button variant="ghost" size="icon" aria-label="Refresh monitoring interruptions" onClick={() => query.refetch()} disabled={!schoolId || query.isFetching}><RefreshCw className="h-4 w-4" /></Button>
      </div>
    </CardContent>
  </Card>;
}

export default function MonitoringInterruptionsPanel() {
  const { user, activeSchoolId, activeMembership } = useAuth();
  const identity = JSON.stringify([user?.id, activeMembership?.role, Boolean(user?.isSuperAdmin)]);
  return <ScopedMonitoringPanel key={`${activeSchoolId}:${identity}`} schoolId={user?.id ? activeSchoolId : null} identity={identity} />;
}

function ScopedMonitoringDigestSettings({ schoolId, identity }) {
  const settingsKey = [API, schoolId, identity, "settings"];
  const query = useQuery({ queryKey: settingsKey, enabled: Boolean(schoolId), queryFn: ({ signal }) => apiRequest("GET", `${API}/settings`, undefined, { signal, headers: { "X-School-Id": schoolId } }) });
  const save = useMutation({ mutationFn: (digestEnabled) => apiRequest("PUT", `${API}/settings`, { digestEnabled, expectedRevision: query.data.revision }, { headers: { "X-School-Id": schoolId } }),
    onSuccess: (data) => queryClient.setQueryData(settingsKey, data), onError: () => queryClient.invalidateQueries({ queryKey: settingsKey }) });
  return <div className="space-y-2 rounded-lg border p-4" data-testid="monitoring-digest-settings">
    <div className="flex items-center justify-between gap-4"><Label htmlFor="monitoring-digest-enabled">Daily monitoring interruption digest</Label><Switch id="monitoring-digest-enabled" checked={query.data?.digestEnabled === true} onCheckedChange={(enabled) => save.mutate(enabled)} disabled={!query.data || query.isFetching || save.isPending} /></div>
    <p className="text-sm text-muted-foreground">Off by default. Send active school administrators one operational summary 30 minutes after the configured tracking end time on tracking days, when interruptions occurred. Student safety notifications are separate.</p>
    {query.error || save.error ? <p role="alert" className="text-sm text-destructive">{errorText(save.error || query.error)}</p> : null}
  </div>;
}

export function MonitoringDigestSettings() {
  const { user, activeSchoolId, activeMembership } = useAuth();
  const identity = JSON.stringify([user?.id, activeMembership?.role, Boolean(user?.isSuperAdmin)]);
  return <ScopedMonitoringDigestSettings key={`${activeSchoolId}:${identity}`} schoolId={user?.id ? activeSchoolId : null} identity={identity} />;
}
