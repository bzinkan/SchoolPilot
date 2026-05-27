import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../../../lib/queryClient";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";

function StatusIcon({ status }) {
  if (status === "ok") return <CheckCircle2 className="h-5 w-5 text-green-600" />;
  if (status === "critical") return <XCircle className="h-5 w-5 text-red-600" />;
  if (status === "warning") return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
  return <HelpCircle className="h-5 w-5 text-gray-400" />;
}

function severityBadge(severity) {
  const variants = {
    critical: "destructive",
    high: "destructive",
    medium: "default",
    low: "secondary",
  };
  return <Badge variant={variants[severity] || "secondary"}>{severity.toUpperCase()}</Badge>;
}

function FindingCard({ finding }) {
  const borderClass =
    finding.status === "critical"
      ? "border-red-500/50 bg-red-50/40 dark:bg-red-950/10"
      : finding.status === "warning"
      ? "border-yellow-500/40 bg-yellow-50/40 dark:bg-yellow-950/10"
      : finding.status === "ok"
      ? "border-green-500/30 bg-green-50/30 dark:bg-green-950/10"
      : "border-muted";
  return (
    <Card className={borderClass}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <StatusIcon status={finding.status} />
            <div className="min-w-0">
              <CardTitle className="text-base leading-snug">{finding.title}</CardTitle>
              <CardDescription className="mt-1">{finding.description}</CardDescription>
            </div>
          </div>
          {severityBadge(finding.severity)}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Current</div>
            <div className="mt-0.5 font-mono break-words">{finding.currentValue}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Recommended</div>
            <div className="mt-0.5 font-mono break-words">{finding.recommendedValue}</div>
          </div>
        </div>
        {finding.fixInstructions && (
          <div className="rounded-md bg-muted p-3 text-xs">
            <span className="font-medium">How to fix: </span>
            {finding.fixInstructions}
          </div>
        )}
        {finding.fixUrl && finding.status !== "ok" && (
          <a
            href={finding.fixUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open in Admin Console
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function ScoreSummary({ report }) {
  const total = report.scoreTotal || 0;
  const ok = report.scoreOk || 0;
  const pct = total > 0 ? Math.round((ok / total) * 100) : 0;
  const color =
    pct >= 85 ? "text-green-600" : pct >= 60 ? "text-yellow-600" : "text-red-600";
  const criticalCount = report.findings.filter((f) => f.status === "critical").length;
  const warningCount = report.findings.filter((f) => f.status === "warning").length;
  const unknownCount = report.findings.filter((f) => f.status === "unknown").length;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Workspace Security Score
            </CardTitle>
            <CardDescription>
              Last scanned: {new Date(report.scannedAt).toLocaleString()}
            </CardDescription>
          </div>
          <div className={`text-4xl font-bold ${color}`}>
            {ok}<span className="text-2xl text-muted-foreground">/{total}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Domain</div>
            <div className="font-medium">{report.customerDomain || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Enrolled Chromebooks</div>
            <div className="font-medium">{report.deviceCount ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Org Units</div>
            <div className="font-medium">{report.orgUnitsCount ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Issues</div>
            <div className="font-medium">
              {criticalCount > 0 && <span className="text-red-600">{criticalCount} critical </span>}
              {warningCount > 0 && <span className="text-yellow-600">{warningCount} warning </span>}
              {unknownCount > 0 && <span className="text-gray-500">{unknownCount} unknown</span>}
              {criticalCount + warningCount + unknownCount === 0 && (
                <span className="text-green-600">None</span>
              )}
            </div>
          </div>
        </div>
        {report.errors?.length > 0 && (
          <div className="mt-4 rounded-md bg-yellow-50 dark:bg-yellow-950/20 p-3 text-xs text-yellow-800 dark:text-yellow-200">
            <div className="font-medium mb-1">Some data could not be read:</div>
            <ul className="list-disc list-inside space-y-0.5">
              {report.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WorkspaceAudit() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useClassPilotAuth();
  const [report, setReport] = useState(null);

  // Gated to super-admin while the new OAuth scopes are pending Google
  // verification. Remove this block once verification completes and the
  // backend route is reopened to school admins.
  if (currentUser && !currentUser.isSuperAdmin) {
    return (
      <div className="container mx-auto p-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Workspace Audit is not available for your account
            </CardTitle>
            <CardDescription>
              This feature is currently in restricted preview while we complete
              Google&apos;s OAuth verification for the additional scopes it
              requires. It will be enabled for school administrators once
              verification is complete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/classpilot/admin")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Admin
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { data: connectionStatus, isLoading: statusLoading } = useQuery({
    queryKey: ["/api/google/status"],
    queryFn: () => apiRequest("GET", "/google/status"),
  });

  const runAuditMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/google/workspace-audit/run"),
    onSuccess: (data) => {
      setReport(data);
      toast({
        title: "Audit complete",
        description: `${data.scoreOk} of ${data.scoreTotal} checks passed.`,
      });
    },
    onError: (err) => {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.error || err?.message;
      if (code === "NO_TOKENS") {
        toast({
          variant: "destructive",
          title: "Google Workspace not connected",
          description: "Connect your Google admin account first.",
        });
      } else if (code === "INSUFFICIENT_PERMISSIONS") {
        toast({
          variant: "destructive",
          title: "Admin access required",
          description:
            "Sign in with a Google Workspace administrator account that has Chrome management permissions.",
        });
      } else {
        toast({ variant: "destructive", title: "Audit failed", description: msg || "" });
      }
    },
  });

  const connectGoogle = async () => {
    try {
      const returnTo = encodeURIComponent(window.location.href);
      const data = await apiRequest("GET", `/google/auth-url?returnTo=${returnTo}`);
      if (data?.url) window.location.href = data.url;
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to start Google connect",
        description: err?.response?.data?.error || err?.message,
      });
    }
  };

  const isConnected = connectionStatus?.connected === true;

  return (
    <div className="container mx-auto p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <ShieldCheck className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Workspace Security Audit</h1>
            <p className="text-muted-foreground">
              Check your Google Workspace Chrome policies for gaps that let students bypass monitoring.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => navigate("/classpilot/admin")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Admin
        </Button>
      </div>

      {statusLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Checking Google connection…
          </CardContent>
        </Card>
      ) : !isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Connect Google Workspace (read-only)
            </CardTitle>
            <CardDescription>
              The audit needs read-only access to your Workspace to check Chrome device and user policies. We do not modify any settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-muted p-4 text-sm space-y-2">
              <div className="font-medium">What we read:</div>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>Your Chromebook inventory (count + org units)</li>
                <li>Sign-in restrictions, guest mode, add-user policy</li>
                <li>Incognito mode and developer tools availability</li>
                <li>Which Chrome extensions are force-installed</li>
              </ul>
              <div className="font-medium pt-2">What we never do:</div>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>Change any Workspace setting</li>
                <li>Read student email, files, or browsing data</li>
                <li>Access anything outside Chrome management policies</li>
              </ul>
            </div>
            <Button onClick={connectGoogle}>Connect Google Workspace</Button>
            <p className="text-xs text-muted-foreground">
              You can revoke access anytime at{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                myaccount.google.com/permissions
              </a>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Run Audit</CardTitle>
                  <CardDescription>
                    Scans your Chrome management policies and produces a scorecard. Takes about 10 seconds.
                  </CardDescription>
                </div>
                <Button
                  onClick={() => runAuditMutation.mutate()}
                  disabled={runAuditMutation.isPending}
                >
                  {runAuditMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Scanning…</>
                  ) : report ? (
                    <><RefreshCw className="h-4 w-4 mr-2" />Re-scan</>
                  ) : (
                    <><ShieldCheck className="h-4 w-4 mr-2" />Run Audit</>
                  )}
                </Button>
              </div>
            </CardHeader>
          </Card>

          {report && (
            <>
              <ScoreSummary report={report} />
              <div className="space-y-3">
                {report.findings.map((finding) => (
                  <FindingCard key={finding.id} finding={finding} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
