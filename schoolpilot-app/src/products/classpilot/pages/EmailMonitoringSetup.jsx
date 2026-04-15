import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useToast } from "../../../hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Badge } from "../../../components/ui/badge";
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, ExternalLink, Mail, Power, PowerOff, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";

export default function EmailMonitoringSetup() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [testEmail, setTestEmail] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);

  const { data: info, isLoading, refetch } = useQuery({
    queryKey: ["/api/mailpilot/setup/info"],
    queryFn: () => apiRequest("GET", "/mailpilot/setup/info"),
  });

  const verifyMutation = useMutation({
    mutationFn: (email) => apiRequest("POST", "/mailpilot/setup/verify", { testEmail: email }),
    onSuccess: (data) => {
      setVerifyResult({ ok: true, data });
      toast({ title: "Verification succeeded", description: `Service account can read ${data.email}'s mailbox.` });
    },
    onError: (err) => {
      const body = err?.response?.data || {};
      setVerifyResult({ ok: false, error: body.error || err?.message, detail: body.detail });
    },
  });

  const enableMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/mailpilot/setup/enable", {}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mailpilot/setup/info"] });
      toast({
        title: "Email monitoring enabled",
        description: `Started watches on ${data.watchesStarted} mailbox${data.watchesStarted === 1 ? "" : "es"}${data.failed ? ` • ${data.failed} failed` : ""}`,
      });
      refetch();
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Enable failed", description: err?.message || "" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/mailpilot/setup/disable", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mailpilot/setup/info"] });
      toast({ title: "Monitoring disabled" });
      refetch();
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Disable failed", description: err?.message || "" });
    },
  });

  const resyncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/mailpilot/setup/resync", {}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mailpilot/setup/info"] });
      toast({ title: "Resync complete", description: `Added ${data.added}, removed ${data.removed}` });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Resync failed", description: err?.message || "" });
    },
  });

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  const clientId = info?.serviceAccountClientId;
  const scope = info?.scope;
  const configured = info?.configured === true;
  const enabled = info?.enabled === true;

  const copy = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied", description: label });
    });
  };

  return (
    <div className="container mx-auto p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <Mail className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Email Monitoring Setup</h1>
            <p className="text-muted-foreground">One-time Google Workspace authorization</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => navigate("/classpilot/admin/email-monitoring")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
      </div>

      {!configured && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-600" />Service not configured</CardTitle>
          </CardHeader>
          <CardContent>
            The SchoolPilot server is missing MailPilot service-account credentials. Contact support before proceeding.
          </CardContent>
        </Card>
      )}

      {enabled ? (
        /* ====================================================================
           Already-enabled state: management controls
           ==================================================================== */
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <CardTitle>Monitoring is active</CardTitle>
            </div>
            <CardDescription>
              {info.mailboxesMonitored} active mailbox{info.mailboxesMonitored === 1 ? "" : "es"}
              {info.mailboxesWithErrors ? ` • ${info.mailboxesWithErrors} with errors` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => resyncMutation.mutate()} disabled={resyncMutation.isPending}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Resync with roster
              </Button>
              <Button variant="destructive" onClick={() => disableMutation.mutate()} disabled={disableMutation.isPending}>
                <PowerOff className="h-4 w-4 mr-2" />
                Disable monitoring
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Resync adds watches for newly-added students and stops watches for removed students. Disable halts all monitoring and stops every active Gmail watch — you can re-enable later.
            </p>
          </CardContent>
        </Card>
      ) : (
        /* ====================================================================
           Setup wizard: 3 steps
           ==================================================================== */
        <>
          <StepHeader step={step} />

          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Before you begin</CardTitle>
                <CardDescription>Understand what will be scanned and who gets alerted.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>Email monitoring scans every student's inbound and outbound Gmail for AI-detected safety concerns:</p>
                <ul className="list-disc pl-6 space-y-1">
                  <li><strong>Self-harm</strong> — suicidal ideation, self-injury, hopelessness</li>
                  <li><strong>Violence</strong> — threats of violence, weapons, graphic content</li>
                  <li><strong>Sexual content</strong> — explicit material, grooming, sexting</li>
                  <li><strong>Drugs</strong> — drug use, acquisition, distribution</li>
                  <li><strong>Bullying / harassment</strong> — targeted insults, exclusion campaigns</li>
                </ul>
                <p>Alerts are sent by email to all active admins and school admins at your school, and appear in the Email Monitoring dashboard for review.</p>
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3">
                  <AlertTriangle className="inline-block h-4 w-4 mr-1 text-amber-700" />
                  <strong>Not scanned:</strong> staff accounts, Gmail drafts, Google Docs/Drive, attachments. Most states require disclosing student monitoring to parents — review your policy before enabling.
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  You must be a <strong>Google Workspace super administrator</strong> for your organization to complete the next step.
                </div>
              </CardContent>
              <CardContent>
                <Button onClick={() => setStep(2)}>Continue <ArrowRight className="h-4 w-4 ml-2" /></Button>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Authorize MailPilot in Google Workspace</CardTitle>
                <CardDescription>Paste these two values into Google Admin Console.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Service account Client ID</Label>
                  <div className="flex gap-2 mt-1">
                    <Input readOnly value={clientId || ""} className="font-mono text-sm" />
                    <Button variant="outline" size="icon" onClick={() => clientId && copy(clientId, "Client ID copied")}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div>
                  <Label>OAuth scope</Label>
                  <div className="flex gap-2 mt-1">
                    <Input readOnly value={scope || ""} className="font-mono text-sm" />
                    <Button variant="outline" size="icon" onClick={() => scope && copy(scope, "Scope copied")}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
                  <p className="font-medium">Steps in Google Admin Console:</p>
                  <ol className="list-decimal pl-5 space-y-1">
                    <li>Open <a className="underline" href="https://admin.google.com" target="_blank" rel="noreferrer">admin.google.com <ExternalLink className="inline h-3 w-3" /></a></li>
                    <li>Go to <strong>Security → Access and data control → API controls</strong></li>
                    <li>Click <strong>Manage Domain Wide Delegation</strong></li>
                    <li>Click <strong>Add new</strong></li>
                    <li>Paste the Client ID and OAuth scope above</li>
                    <li>Click <strong>Authorize</strong></li>
                  </ol>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4 mr-2" />Back</Button>
                  <Button onClick={() => setStep(3)}>I've authorized — continue <ArrowRight className="h-4 w-4 ml-2" /></Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Verify and enable</CardTitle>
                <CardDescription>Test your authorization, then enable monitoring for all students.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="testEmail">Test with a student email address</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      id="testEmail"
                      type="email"
                      placeholder="student@yourdomain.edu"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                    />
                    <Button
                      onClick={() => verifyMutation.mutate(testEmail)}
                      disabled={!testEmail || verifyMutation.isPending}
                    >
                      {verifyMutation.isPending ? "Verifying…" : "Verify"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Uses the authorized service account to read one student's Gmail profile. No data is stored.
                  </p>
                </div>

                {verifyResult?.ok && (
                  <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-950/20 p-3 text-sm">
                    <ShieldCheck className="inline h-4 w-4 mr-1 text-green-700" />
                    Verified: service account can access <strong>{verifyResult.data.email}</strong>.
                  </div>
                )}
                {verifyResult?.ok === false && (
                  <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 text-sm">
                    <AlertTriangle className="inline h-4 w-4 mr-1 text-red-700" />
                    {verifyResult.error}
                    {verifyResult.detail && <pre className="mt-2 text-xs whitespace-pre-wrap">{verifyResult.detail}</pre>}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft className="h-4 w-4 mr-2" />Back</Button>
                  <Button
                    onClick={() => enableMutation.mutate()}
                    disabled={!verifyResult?.ok || enableMutation.isPending}
                  >
                    <Power className="h-4 w-4 mr-2" />
                    {enableMutation.isPending ? "Starting watches…" : "Enable monitoring"}
                  </Button>
                </div>
                {!verifyResult?.ok && (
                  <p className="text-xs text-muted-foreground">Run a successful verification first.</p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function StepHeader({ step }) {
  const steps = ["Overview", "Authorize", "Verify & Enable"];
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, idx) => {
        const n = idx + 1;
        return (
          <div key={label} className="flex items-center">
            <Badge variant={n === step ? "default" : n < step ? "secondary" : "outline"}>
              {n}. {label}
            </Badge>
            {n < steps.length && <div className="w-4 h-px bg-border mx-1" />}
          </div>
        );
      })}
    </div>
  );
}
