import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useToast } from "../../../hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { ArrowLeft, Mail, Settings as SettingsIcon, ShieldAlert, LogOut, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";

const SEVERITY_STYLES = {
  critical: "bg-red-900 text-white",
  high: "bg-red-600 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-slate-400 text-white",
};

const CATEGORY_LABELS = {
  "self-harm": "Self-harm",
  "violence": "Violence",
  "sexual": "Sexual content",
  "drugs": "Drugs",
  "bullying": "Bullying",
};

export default function EmailMonitoring() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [reviewStatus, setReviewStatus] = useState("unreviewed");
  const [severity, setSeverity] = useState("");
  const [safetyAlert, setSafetyAlert] = useState("");
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [reviewNote, setReviewNote] = useState("");

  const { data: setupInfo, isLoading: setupLoading, error: setupError } = useQuery({
    queryKey: ["/api/mailpilot/setup/info"],
    queryFn: () => apiRequest("GET", "/mailpilot/setup/info"),
  });

  useEffect(() => {
    if (setupError?.response?.status === 403) {
      navigate("/classpilot/admin", { replace: true });
    }
  }, [navigate, setupError]);

  const isEnabled = setupInfo?.enabled === true;

  const { data: statsData } = useQuery({
    queryKey: ["/api/mailpilot/alerts/stats"],
    queryFn: () => apiRequest("GET", "/mailpilot/alerts/stats"),
    enabled: isEnabled,
  });

  const { data: alertsData, isLoading: alertsLoading } = useQuery({
    queryKey: ["/api/mailpilot/alerts", reviewStatus, severity, safetyAlert],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (reviewStatus) params.set("reviewStatus", reviewStatus);
      if (severity) params.set("severity", severity);
      if (safetyAlert) params.set("safetyAlert", safetyAlert);
      return apiRequest("GET", `/mailpilot/alerts?${params.toString()}`);
    },
    enabled: isEnabled,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, reviewStatus: status, reviewNote: note }) =>
      apiRequest("PATCH", `/mailpilot/alerts/${id}/review`, { reviewStatus: status, reviewNote: note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mailpilot/alerts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mailpilot/alerts/stats"] });
      setSelectedAlert(null);
      setReviewNote("");
      toast({ title: "Alert reviewed" });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Review failed", description: err?.message || "" });
    },
  });

  if (setupLoading || setupError?.response?.status === 403) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  if (!isEnabled) {
    return (
      <div className="container mx-auto p-6 max-w-3xl space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
                <Mail className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <CardTitle>Email Monitoring</CardTitle>
                <CardDescription>Protect students with AI-powered Gmail safety scanning</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>Email Monitoring is not yet enabled for your school. Scanning student Gmail for bullying, self-harm, violence, sexual content, and drug-related messages runs automatically once setup is complete.</p>
            <div className="flex gap-2">
              <Button onClick={() => navigate("/classpilot/admin/email-monitoring/setup")}>
                Start setup
              </Button>
              <Button variant="outline" onClick={() => navigate("/classpilot/admin")}>
                <ArrowLeft className="h-4 w-4 mr-2" /> Back to admin
              </Button>
            </div>
            {setupInfo?.configured === false && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertTriangle className="inline-block h-4 w-4 mr-1" />
                Server is missing MailPilot service-account credentials. Contact SchoolPilot support to enable this feature for your organization.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const alerts = alertsData?.alerts || [];
  const stats = statsData?.last7d;

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <ShieldAlert className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Email Monitoring</h1>
            <p className="text-muted-foreground">
              {statsData?.mailboxesMonitored ?? 0} mailboxes monitored{statsData?.mailboxesWithErrors ? ` • ${statsData.mailboxesWithErrors} with errors` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="outline" onClick={() => navigate("/classpilot/admin/email-monitoring/setup")}>
            <SettingsIcon className="h-4 w-4 mr-2" /> Setup
          </Button>
          <Button variant="outline" onClick={() => navigate("/classpilot/admin")}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Admin
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate("/login")} title="Log out">
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="Last 7 days" value={stats.total} tone="slate" />
          <StatCard label="Unreviewed" value={stats.unreviewed} tone="amber" />
          <StatCard label="Critical" value={stats.bySeverity?.critical || 0} tone="red" />
          <StatCard label="High" value={stats.bySeverity?.high || 0} tone="red" />
          <StatCard label="Self-harm" value={stats.byCategory?.["self-harm"] || 0} tone="red" />
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap gap-3 pt-6">
          <Select value={reviewStatus} onValueChange={setReviewStatus}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unreviewed">Unreviewed</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity || "__any"} onValueChange={(v) => setSeverity(v === "__any" ? "" : v)}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Any severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">Any severity</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={safetyAlert || "__any"} onValueChange={(v) => setSafetyAlert(v === "__any" ? "" : v)}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Any category" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">Any category</SelectItem>
              <SelectItem value="self-harm">Self-harm</SelectItem>
              <SelectItem value="violence">Violence</SelectItem>
              <SelectItem value="sexual">Sexual</SelectItem>
              <SelectItem value="drugs">Drugs</SelectItem>
              <SelectItem value="bullying">Bullying</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Alert list */}
      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>{alertsLoading ? "Loading…" : `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!alertsLoading && alerts.length === 0 && (
            <p className="text-muted-foreground text-sm">No alerts match these filters.</p>
          )}
          {alerts.map((a) => (
            <button
              key={a.id}
              className="w-full text-left rounded-md border p-3 hover:bg-accent transition"
              onClick={() => { setSelectedAlert(a); setReviewNote(a.reviewNote || ""); }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={SEVERITY_STYLES[a.severity] || SEVERITY_STYLES.low}>{a.severity}</Badge>
                    <span className="font-medium">{CATEGORY_LABELS[a.safetyAlert] || a.safetyAlert || (a.bullying === "true" ? "Bullying" : "Flagged")}</span>
                    <span className="text-xs text-muted-foreground">{a.direction === "outbound" ? "Sent by student" : "Received by student"}</span>
                    {a.reviewStatus && <Badge variant="outline">{a.reviewStatus}</Badge>}
                  </div>
                  <div className="text-sm mt-1 truncate">
                    <span className="font-medium">{a.studentName || a.studentEmail}</span>
                    <span className="text-muted-foreground"> — {a.subject || "(no subject)"}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.snippet}</div>
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(a.alertedAt).toLocaleString()}
                </div>
              </div>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* Alert detail dialog */}
      <Dialog open={!!selectedAlert} onOpenChange={(o) => !o && setSelectedAlert(null)}>
        <DialogContent className="max-w-2xl">
          {selectedAlert && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Badge className={SEVERITY_STYLES[selectedAlert.severity] || SEVERITY_STYLES.low}>{selectedAlert.severity}</Badge>
                  {CATEGORY_LABELS[selectedAlert.safetyAlert] || selectedAlert.safetyAlert || "Flagged"}
                </DialogTitle>
                <DialogDescription>
                  {selectedAlert.studentName || selectedAlert.studentEmail} • {selectedAlert.direction === "outbound" ? "Sent by student" : "Received by student"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <DetailRow label="From" value={selectedAlert.sender} />
                <DetailRow label="Subject" value={selectedAlert.subject || "(no subject)"} />
                <DetailRow label="Time" value={new Date(selectedAlert.alertedAt).toLocaleString()} />
                {selectedAlert.confidence != null && (
                  <DetailRow label="AI confidence" value={`${selectedAlert.confidence}%`} />
                )}
                {selectedAlert.reasoning && (
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">AI reasoning</div>
                    <div className="italic">{selectedAlert.reasoning}</div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">Snippet</div>
                  <pre className="whitespace-pre-wrap bg-muted/50 rounded p-3 text-sm">{selectedAlert.snippet}</pre>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Review note (optional)</div>
                  <Textarea
                    rows={3}
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    placeholder="Add context for this review action…"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSelectedAlert(null)}>Close</Button>
                <Button
                  variant="outline"
                  onClick={() => reviewMutation.mutate({ id: selectedAlert.id, reviewStatus: "dismissed", reviewNote })}
                  disabled={reviewMutation.isPending}
                >
                  <XCircle className="h-4 w-4 mr-2" /> Dismiss
                </Button>
                <Button
                  variant="outline"
                  onClick={() => reviewMutation.mutate({ id: selectedAlert.id, reviewStatus: "confirmed", reviewNote })}
                  disabled={reviewMutation.isPending}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" /> Confirm
                </Button>
                <Button
                  onClick={() => reviewMutation.mutate({ id: selectedAlert.id, reviewStatus: "escalated", reviewNote })}
                  disabled={reviewMutation.isPending}
                >
                  <AlertTriangle className="h-4 w-4 mr-2" /> Escalate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  const toneClass = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex gap-3">
      <div className="w-24 shrink-0 text-xs text-muted-foreground uppercase tracking-wide pt-0.5">{label}</div>
      <div className="break-words">{value || "—"}</div>
    </div>
  );
}
