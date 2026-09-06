import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import { Label } from "../../../components/ui/label";
import { apiRequest, queryClient } from "../../../lib/queryClient";

const API = "/classpilot/monitoring-interruptions";
const settingsKey = [API, "settings"];
const errorText = (error) => error?.response?.data?.error || "Monitoring status is temporarily unavailable.";
const endReason = (value) => ({ telemetry_resumed: "Telemetry resumed", monitoring_off: "Monitoring no longer expected", privacy_off: "Monitoring turned off", binding_or_scope_changed: "Class or sign-in changed", scope_or_binding_ended: "Class or sign-in ended", binding_ended: "Student signed out" }[value] || "Monitoring no longer expected");

export default function MonitoringInterruptionsPanel() {
  const query = useQuery({ queryKey: [API], queryFn: () => apiRequest("GET", API), refetchInterval: 60_000, refetchIntervalInBackground: false });
  const groups = useMemo(() => {
    const result = new Map();
    for (const incident of query.data?.incidents || []) {
      const key = `${incident.scopeType}:${incident.scopeId}`;
      if (!result.has(key)) result.set(key, { name: incident.scopeName, incidents: [] });
      result.get(key).incidents.push(incident);
    }
    return [...result.entries()];
  }, [query.data]);
  const uncertain = query.error || ["uncertain", "unknown"].includes(query.data?.scanStatus);
  return <Card className="mb-6" data-testid="monitoring-interruptions-panel">
    <CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><CircleAlert className="h-4 w-4" />Monitoring interruptions</CardTitle><CardDescription>Previously observed students whose expected classroom telemetry stopped for more than 60 seconds. Cause unknown.</CardDescription></div><Button variant="ghost" size="icon" aria-label="Refresh monitoring interruptions" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw className="h-4 w-4" /></Button></div></CardHeader>
    <CardContent className="space-y-3">
      {query.isLoading ? <p role="status" className="text-sm">Checking monitoring status…</p> : null}
      {uncertain ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{query.error ? errorText(query.error) : "Monitoring status is uncertain. A service interruption may affect these readings."}</p> : null}
      {query.data?.scanStatus === "not_expected" ? <p className="text-sm text-muted-foreground">Full classroom monitoring is not currently expected.</p> : null}
      {!query.isLoading && !groups.length ? <p className="text-sm text-muted-foreground">{uncertain ? "No confirmed interruptions to display." : "No monitoring interruptions in your visible classes during the last day."}</p> : null}
      {groups.map(([key, group]) => <details key={key} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{group.name} · {group.incidents.filter((incident) => !incident.endedAt).length} open · {group.incidents.length} in the last day</summary><div className="mt-3 space-y-2">{group.incidents.map((incident) => <div key={incident.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"><div><p className="font-medium">{incident.studentName || "Student"}</p><p className="text-xs text-muted-foreground">Last observed {new Date(incident.lastObservedAt).toLocaleString()}{incident.endedAt ? ` · ${endReason(incident.endReason)}` : " · Cause unknown"}</p></div><Badge variant={incident.status === "open" ? "destructive" : "outline"}>{incident.status}</Badge></div>)}</div></details>)}
      {query.data?.truncated ? <p className="text-xs text-muted-foreground">Showing the latest 500 visible interruptions.</p> : null}
    </CardContent>
  </Card>;
}

export function MonitoringDigestSettings() {
  const query = useQuery({ queryKey: settingsKey, queryFn: () => apiRequest("GET", `${API}/settings`) });
  const save = useMutation({ mutationFn: (digestEnabled) => apiRequest("PUT", `${API}/settings`, { digestEnabled, expectedRevision: query.data.revision }),
    onSuccess: (data) => queryClient.setQueryData(settingsKey, data), onError: () => queryClient.invalidateQueries({ queryKey: settingsKey }) });
  return <div className="space-y-2 rounded-lg border p-4" data-testid="monitoring-digest-settings">
    <div className="flex items-center justify-between gap-4"><Label htmlFor="monitoring-digest-enabled">Daily monitoring interruption digest</Label><Switch id="monitoring-digest-enabled" checked={query.data?.digestEnabled === true} onCheckedChange={(enabled) => save.mutate(enabled)} disabled={!query.data || query.isFetching || save.isPending} /></div>
    <p className="text-sm text-muted-foreground">Off by default. Send active school administrators one operational summary 30 minutes after the configured tracking end time on tracking days, when interruptions occurred. Student safety notifications are separate.</p>
    {query.error || save.error ? <p role="alert" className="text-sm text-destructive">{errorText(save.error || query.error)}</p> : null}
  </div>;
}
