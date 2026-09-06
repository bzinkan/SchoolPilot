import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ShieldAlert, RefreshCw, FileArchive } from "lucide-react";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../../../components/ui/alert-dialog";

const endpoint = "/classpilot/safety-center";
const key = ["classpilot-safety-center"];
function time(value, timezone) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return new Date(value).toLocaleString(); }
}
const name = row => [row?.first_name, row?.last_name].filter(Boolean).join(" ") || "Student";
const selectClass = "rounded-md border bg-background p-2 text-sm";

export default function SafetyCenter() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();
  const [view, setView] = useState("reports");
  const [status, setStatus] = useState("open");
  const [review, setReview] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [studentId, setStudentId] = useState("");
  const [cursor, setCursor] = useState(null);
  const [approvedCursor, setApprovedCursor] = useState(null);
  const [notes, setNotes] = useState({});
  const [caseNote, setCaseNote] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [packet, setPacket] = useState(null);
  const caseId = params.get("case");
  const alertCursor = params.get("alertCursor");
  const eventCursor = params.get("eventCursor");
  const cases = useQuery({
    queryKey: [...key, "cases", status, review, from, to, studentId, cursor], enabled: view === "reports",
    queryFn: ({ signal }) => {
      const q = new URLSearchParams();
      for (const [field, value] of Object.entries({ status, review, from, to, student: studentId, cursor })) if (value) q.set(field, value);
      return apiRequest("GET", `${endpoint}/cases?${q}`, undefined, { signal });
    },
  });
  const report = useQuery({
    queryKey: [...key, "report", caseId, alertCursor, eventCursor], enabled: !!caseId && view === "reports",
    queryFn: async ({ signal }) => {
      const paging = new URLSearchParams();
      if (alertCursor) paging.set("alertCursor", alertCursor);
      if (eventCursor) paging.set("eventCursor", eventCursor);
      let data = await apiRequest("GET", `${endpoint}/cases/${encodeURIComponent(caseId)}${paging.size ? `?${paging}` : ""}`, undefined, { signal });
      if (data.redirectCaseId) data = await apiRequest("GET", `${endpoint}/cases/${encodeURIComponent(data.redirectCaseId)}`, undefined, { signal });
      return data;
    },
  });
  const approved = useQuery({ queryKey: [...key, "approved", approvedCursor], enabled: view === "approved", queryFn: ({ signal }) => apiRequest("GET", `${endpoint}/approved-urls${approvedCursor ? `?cursor=${encodeURIComponent(approvedCursor)}` : ''}`, undefined, { signal }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const mutation = useMutation({
    mutationFn: ({ method = "POST", path, body }) => apiRequest(method, `${endpoint}${path}`, body),
    onSuccess: () => { refresh(); setConfirmation(null); toast({ title: "Safety report updated" }); },
    onError: error => { toast({ variant: "destructive", title: "Action could not be saved", description: error.response?.data?.error || error.message }); refresh(); },
  });
  const packetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/classpilot/evidence-packets", { studentId: report.data.case.student_id, caseId: report.data.case.id,
      from: report.data.case.opened_at, to: new Date().toISOString(), includeFlags: { screenshots: true, mailpilot: true, attendance: true, passes: true, dismissal: true } }),
    onSuccess: setPacket, onError: error => toast({ variant: "destructive", title: "Export failed", description: error.message }),
  });
  const alertAction = (alert, action) => mutation.mutate({ path: `/alerts/${alert.id}/${action === "block" ? "block-website" : "review"}`,
    body: { revision: alert.revision, note: notes[alert.id] || undefined, ...(action === "block" ? { policyRevision: alert.websitePolicy?.policyRevision ?? 0 } : { action }) } });
  const caseAction = (action, assignedTo) => mutation.mutate({ path: `/cases/${report.data.case.id}/actions`, body: { action, revision: report.data.case.revision, note: caseNote || undefined, ...(action === "assign" ? { assignedTo: assignedTo || null } : {}) } });
  const changeFilter = (setter, value) => { setter(value); setCursor(null); };
  const changeReportPage = (field, value) => setParams(previous => {
    const updated = new URLSearchParams(previous);
    if (value) updated.set(field, value); else updated.delete(field);
    return updated;
  });
  const data = report.data;
  const zone = data?.timezone || "America/New_York";
  return <div className="min-h-screen bg-background">
    <header className="border-b"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-4">
      <div className="flex items-center gap-3"><Button variant="ghost" size="icon" aria-label="Back to Admin panel" onClick={() => navigate("/classpilot/admin")}><ArrowLeft className="h-5 w-5" /></Button><div><h1 className="text-xl font-semibold">Safety Center</h1><p className="text-sm text-muted-foreground">Review student concerns and decide what action is appropriate.</p></div></div>
      <div className="flex gap-2"><ThemeToggle /><Button variant="outline" onClick={refresh}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
    </div></header>
    <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
      <div className="flex flex-wrap gap-2"><Button variant={view === "reports" ? "default" : "outline"} onClick={() => setView("reports")}>Student reports</Button><Button variant={view === "approved" ? "default" : "outline"} onClick={() => setView("approved")}>Approved URLs</Button></div>
      <p className="text-sm text-muted-foreground">All new distinct safety alerts notify every active school administrator. Repeated observations are grouped. An unacknowledged alert receives one follow-up after fifteen minutes.</p>
      {view === "approved" ? <Card><CardHeader><CardTitle>Approved URLs</CardTitle></CardHeader><CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">These exact pages do not generate new safety alerts for students in this school. Other pages, queries and fragments remain eligible. Website blocks still apply.</p>
        {approved.isPending ? <p>Loading approved URLs…</p> : approved.isError ? <p role="alert">Approved URLs could not be loaded.</p> : !approved.data?.items?.length ? <p>No approved URLs.</p> : approved.data.items.map(rule => <div key={rule.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="break-all text-sm">{rule.url || "URL unavailable"}</p><p className="mt-1 text-xs text-muted-foreground">Approved {time(rule.created_at, zone)}</p></div><Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ method: "DELETE", path: `/approved-urls/${rule.id}` })}>Revoke approval</Button></div>)}
        <div className="flex gap-2">{approvedCursor && <Button variant="outline" onClick={() => setApprovedCursor(null)}>First page</Button>}{approved.data?.nextCursor && <Button variant="outline" onClick={() => setApprovedCursor(approved.data.nextCursor)}>Next page</Button>}</div>
      </CardContent></Card> : <div className="grid gap-5 lg:grid-cols-[330px_1fr]">
        <Card><CardHeader><CardTitle className="flex gap-2 text-base"><ShieldAlert className="h-5 w-5" />Student reports</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2"><label className="text-xs">Case status<select className={`${selectClass} mt-1 w-full`} value={status} onChange={e => changeFilter(setStatus, e.target.value)}><option value="">All cases</option><option value="open">Open</option><option value="closed">Closed</option></select></label><label className="text-xs">Review status<select className={`${selectClass} mt-1 w-full`} value={review} onChange={e => changeFilter(setReview, e.target.value)}><option value="">All alerts</option><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option></select></label></div>
          <label className="block text-xs">Student name<Input className="mt-1" value={studentId} onChange={e => changeFilter(setStudentId, e.target.value)} placeholder="Find a student" /></label>
          <div className="grid grid-cols-2 gap-2"><label className="text-xs">From<Input type="date" value={from} onChange={e => changeFilter(setFrom, e.target.value)} /></label><label className="text-xs">Through<Input type="date" value={to} onChange={e => changeFilter(setTo, e.target.value)} /></label></div>
          {cases.isPending ? <p>Loading reports…</p> : cases.isError ? <p role="alert">Reports could not be loaded. Try Refresh.</p> : !cases.data?.items?.length ? <p className="text-sm text-muted-foreground">No reports match these filters.</p> : cases.data.items.map(item => <button type="button" key={item.id} className={`w-full rounded-md border p-3 text-left ${caseId === item.id ? "border-primary bg-muted" : "hover:bg-muted"}`} onClick={() => { setParams({ case: item.id }); setCaseNote(""); setPacket(null); }}><p className="font-medium">{name(item)}</p><p className="mt-1 text-xs text-muted-foreground">{item.status} · {item.unreviewed_count} unreviewed</p><p className="text-xs text-muted-foreground">{time(item.opened_at, zone)}</p></button>)}
          <div className="flex gap-2">{cursor && <Button variant="outline" size="sm" onClick={() => setCursor(null)}>First page</Button>}{cases.data?.nextCursor && <Button variant="outline" size="sm" onClick={() => setCursor(cases.data.nextCursor)}>Next page</Button>}</div>
        </CardContent></Card>
        <div className="space-y-4">{!caseId ? <Card><CardContent className="py-8 text-muted-foreground">Choose a student report.</CardContent></Card> : report.isPending ? <p>Loading student report…</p> : report.isError ? <p role="alert">The report is unavailable or you do not have access.</p> : data?.case && <>
          <Card><CardHeader><CardTitle role="heading" aria-level={2}>{name(data.case)}</CardTitle><p className="text-sm text-muted-foreground">{data.case.status} · Times shown in {zone}</p></CardHeader><CardContent className="space-y-3">
            <label className="block text-sm">Assigned administrator<select className={`${selectClass} ml-2`} value={data.case.assigned_to || ""} disabled={mutation.isPending} onChange={e => caseAction("assign", e.target.value)}><option value="">Unassigned</option>{data.administrators.map(admin => <option key={admin.id} value={admin.id}>{name(admin)} ({admin.email})</option>)}</select></label>
            <Textarea aria-label="Case note or resolution" value={caseNote} onChange={e => setCaseNote(e.target.value)} maxLength={2000} placeholder="Case note (required to close the case)" />
            <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={mutation.isPending || data.case.status === "closed"} onClick={() => caseAction("acknowledge")}>Acknowledge current alerts</Button><Button variant="outline" disabled={mutation.isPending || !caseNote.trim()} onClick={() => caseAction("note")}>Save note</Button><Button variant="outline" disabled={mutation.isPending || !caseNote.trim() || data.case.status === "closed"} onClick={() => caseAction("close")}>Close case</Button><Button variant="outline" disabled={packetMutation.isPending} onClick={() => packetMutation.mutate()}><FileArchive className="mr-2 h-4 w-4" />Export evidence</Button>{packet?.packetId && <Button asChild><a href={`/api/classpilot/evidence-packets/${packet.packetId}/download`}>Download packet</a></Button>}</div>
            {data.case.resolution_note && <p className="text-sm">Resolution: {data.case.resolution_note}</p>}
            <details className="text-sm"><summary className="cursor-pointer">Available evidence</summary><div className="mt-2 space-y-1">{data.evidence?.length ? data.evidence.map(item => <p key={item.id}>{item.label || item.artifact_type} · {item.status} · {time(item.captured_at, zone)}</p>) : <p className="text-muted-foreground">No retained screenshot evidence is attached. Available source activity is included in the evidence export.</p>}</div></details>
          </CardContent></Card>
          {data.alerts.length === 0 && <p className="text-sm text-muted-foreground">{alertCursor ? "No older alerts remain on this page." : "This retained legacy case has no individual alerts in the new workflow. Its existing evidence remains available through export."}</p>}
          <div className="flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">{data.alerts.length} alert(s) on this page</p>{alertCursor && <Button size="sm" variant="outline" onClick={() => changeReportPage("alertCursor", null)}>Newest alerts</Button>}{data.alertPage?.nextCursor && <Button size="sm" variant="outline" onClick={() => changeReportPage("alertCursor", data.alertPage.nextCursor)}>Older alerts</Button>}</div>
          {data.alerts.map(alert => <Card key={alert.id}><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{alert.concern}</CardTitle><Badge variant={["high", "critical"].includes(alert.severity) ? "destructive" : "secondary"}>{alert.severity}</Badge><Badge variant="outline">{alert.reviewed_at ? "Reviewed" : "Unreviewed"}</Badge>{alert.suppressed && <Badge>URL approved</Badge>}</div></CardHeader><CardContent className="space-y-3">
            <p className="text-sm">{alert.reason || "No explanation was retained for this detection."}</p><p className="text-xs text-muted-foreground">Source: {alert.classification_source || alert.source_type}{alert.matched_term ? ` · Matched rule/term: ${alert.matched_term}` : ""}{alert.confidence !== null ? ` · Confidence: ${alert.confidence}%` : ""}</p>
            <p className="text-xs text-muted-foreground">First observed {time(alert.first_seen_at, zone)} · Last observed {time(alert.last_seen_at, zone)} · {alert.observation_count} observation(s)</p>
            {alert.acknowledged_at && <p className="text-xs text-muted-foreground">Acknowledged {time(alert.acknowledged_at, zone)} · Follow-up stopped{alert.reviewed_at ? "" : " · Assessment still pending"}</p>}
            <p className="break-all rounded-md bg-muted p-3 text-sm">{alert.url || "No trustworthy retained browser URL is available. URL-specific actions are unavailable."}</p>
            {alert.domain && <p className="text-xs text-muted-foreground">Website: {alert.domain} · {alert.websitePolicy?.blocked ? "Block saved" : "Not blocked"} · Enforcement: {Object.entries(alert.websitePolicy?.enforcement || {}).map(([state, count]) => `${count} ${state}`).join(", ") || "No device confirmation available"}</p>}
            {alert.review_note && <p className="text-sm">Review: {alert.review_note}</p>}<Textarea aria-label={`Review note for ${alert.concern}`} rows={2} maxLength={2000} placeholder="Administrator review note (optional)" value={notes[alert.id] || ""} onChange={e => setNotes(previous => ({ ...previous, [alert.id]: e.target.value }))} />
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => alertAction(alert, "review")}>Mark reviewed</Button><Button size="sm" variant="outline" disabled={mutation.isPending || !alert.url || alert.suppressed} onClick={() => setConfirmation({ alert, action: "suppress" })}>Stop alerts for this URL</Button><Button size="sm" variant="destructive" disabled={mutation.isPending || !alert.domain} onClick={() => setConfirmation({ alert, action: "block" })}>Block website{alert.domain ? `: ${alert.domain}` : ""}</Button></div>
            <details className="text-xs"><summary className="cursor-pointer">Email delivery and follow-up</summary><ul className="mt-2 space-y-1">{data.notifications.filter(item => item.alert_id === alert.id).map((item, index) => <li key={index}>{item.recipient} · {item.kind} · {item.status} · {time(item.completed_at || item.due_at, zone)}{item.error_code ? ` · ${item.error_code}` : ""}</li>)}</ul></details>
          </CardContent></Card>)}
          <Card><CardHeader><CardTitle className="text-base">Administrator action history</CardTitle></CardHeader><CardContent className="space-y-2">{data.events.map(event => <div key={event.id} className="border-b pb-2 text-sm"><p>{event.kind.replaceAll("_", " ")} · {time(event.created_at, zone)}</p>{event.note && <p className="text-muted-foreground">{event.note}</p>}<p className="text-xs text-muted-foreground">{data.administrators.find(admin => admin.id === event.actor_id)?.email || (event.actor_id ? "Former administrator" : "System")}</p></div>)}<div className="flex flex-wrap gap-2">{eventCursor && <Button size="sm" variant="outline" onClick={() => changeReportPage("eventCursor", null)}>Newest actions</Button>}{data.eventPage?.nextCursor && <Button size="sm" variant="outline" onClick={() => changeReportPage("eventCursor", data.eventPage.nextCursor)}>Older actions</Button>}</div></CardContent></Card>
        </>}</div>
      </div>}
    </main>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.action === "block" ? "Block this website for the school?" : "Stop safety alerts for this exact URL?"}</AlertDialogTitle><AlertDialogDescription className="break-all">{confirmation?.action === "block" ? `${confirmation.alert.domain} will be added to the school website blocklist. Connected supported devices apply the policy; offline devices remain pending.` : `${confirmation?.alert.url || ""} — This approval applies across students in this school. Other URLs remain eligible. You can revoke it in Approved URLs.`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={mutation.isPending} onClick={event => { event.preventDefault(); if (confirmation) alertAction(confirmation.alert, confirmation.action); }}>{confirmation?.action === "block" ? "Block website" : "Approve exact URL"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
