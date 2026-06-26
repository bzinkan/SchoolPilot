import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, ExternalLink, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { apiRequest } from "../../lib/queryClient";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";

function joinScopes(scopes) {
  return (scopes || []).join(",");
}

function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function GoogleRosterConnectorPanel({
  basePath = "/google/roster-connector",
  onConnected,
  className = "",
}) {
  const queryClient = useQueryClient();
  const [delegatedAdminEmail, setDelegatedAdminEmail] = useState("");
  const [copied, setCopied] = useState("");

  const setupQuery = useQuery({
    queryKey: [basePath, "setup-info"],
    queryFn: () => apiRequest("GET", `${basePath}/setup-info`),
  });

  const verifyMutation = useMutation({
    mutationFn: () => apiRequest("POST", `${basePath}/verify`, { delegatedAdminEmail: delegatedAdminEmail.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [basePath, "setup-info"] });
      onConnected?.();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", basePath),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [basePath, "setup-info"] });
    },
  });

  const data = setupQuery.data || {};
  const connector = data.connector;
  const connected = connector?.status === "verified";
  const scopes = data.scopes || [];
  const scopesCsv = data.scopesCsv || joinScopes(scopes);
  const clientId = data.serviceAccountClientId || "";
  const serviceConfigured = data.serviceAccount?.configured;
  const adminConsoleUrl =
    data.adminConsoleUrl ||
    data.setupCopy?.adminConsoleUrl ||
    "https://admin.google.com/ac/owl/domainwidedelegation";
  const manualAdminConsolePath =
    data.manualAdminConsolePath ||
    data.setupCopy?.manualAdminConsolePath ||
    data.setupCopy?.adminConsolePath ||
    "Security > Access and data control > API controls > Domain-wide delegation > Manage Domain Wide Delegation";
  const verifiedAt = formatDateTime(connector?.verifiedAt || data.verifiedAt);
  const lastSyncAt = formatDateTime(connector?.lastSyncAt || data.lastSyncAt);
  const statusText = connected ? "Verified" : connector?.status || "Not connected";

  const copyText = async (label, text) => {
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1500);
  };

  if (setupQuery.isLoading) {
    return (
      <div className={`rounded-md border p-4 text-sm text-muted-foreground ${className}`}>
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
        Loading Google Workspace connector...
      </div>
    );
  }

  if (setupQuery.isError) {
    return (
      <div className={`rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive ${className}`}>
        Failed to load the Google Workspace Roster Connector setup.
      </div>
    );
  }

  return (
    <div className={`space-y-4 rounded-md border p-4 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <h3 className="text-base font-semibold">Google Workspace Roster Connector</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only Directory and Classroom roster import, approved by IT in Google Admin Console.
          </p>
        </div>
        <Badge
          variant={connected ? "secondary" : "outline"}
          className={
            connected
              ? "gap-1 border-emerald-200 bg-emerald-100 text-emerald-800"
              : "gap-1"
          }
        >
          {connected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
          {statusText}
        </Badge>
      </div>

      {connected ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Verified
            </span>
            {verifiedAt ? <span>Last verified: {verifiedAt}</span> : null}
            {lastSyncAt ? <span>Last sync: {lastSyncAt}</span> : null}
          </div>
        </div>
      ) : null}

      {!serviceConfigured ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Roster connector service account is not configured on the SchoolPilot server.
        </div>
      ) : null}

      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              1
            </span>
            <p className="text-sm font-medium">Copy SchoolPilot's roster-sync Client ID</p>
          </div>
          <div className="mt-1 flex gap-2">
            <code className="min-w-0 flex-1 rounded bg-muted px-2 py-2 text-xs">{clientId || "Not configured"}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => copyText("client", clientId)} disabled={!clientId}>
              <Clipboard className="h-4 w-4" />
              Copy Client ID
            </Button>
          </div>
          {copied === "client" ? <p className="mt-1 text-xs text-emerald-600">Copied client ID</p> : null}
        </div>

        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              2
            </span>
            <p className="text-sm font-medium">Copy the approved read-only OAuth scopes</p>
          </div>
          <div className="mt-1 flex gap-2">
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-2 text-xs">
              {scopesCsv}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => copyText("scopes", scopesCsv)} disabled={!scopesCsv}>
              <Clipboard className="h-4 w-4" />
              Copy Scopes
            </Button>
          </div>
          {copied === "scopes" ? <p className="mt-1 text-xs text-emerald-600">Copied scopes</p> : null}
        </div>
      </div>

      <div className="space-y-2 rounded-md bg-muted/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Authorize SchoolPilot in Google Admin</p>
            <p className="text-xs text-muted-foreground">{manualAdminConsolePath}</p>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={adminConsoleUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open Google Admin Console
            </a>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.setupCopy?.googleAdminInstruction ||
            "Click Add new, paste the Client ID, paste the copied OAuth scopes, then click Authorize."}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            3
          </span>
          <p className="text-sm font-medium">Return to SchoolPilot and verify access</p>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <Input
            type="email"
            value={delegatedAdminEmail}
            onChange={(event) => setDelegatedAdminEmail(event.target.value)}
            placeholder={connector?.delegatedAdminEmail || `admin@${data.schoolDomain || "school.edu"}`}
          />
          <Button
            type="button"
            onClick={() => verifyMutation.mutate()}
            disabled={!serviceConfigured || !delegatedAdminEmail.trim() || verifyMutation.isPending}
          >
            {verifyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Verify
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => disconnectMutation.mutate()}
            disabled={!connector || disconnectMutation.isPending}
          >
            Disable
          </Button>
        </div>
      </div>

      {verifyMutation.error ? (
        <p className="text-sm text-destructive">
          {verifyMutation.error?.response?.data?.error || verifyMutation.error?.message || "Verification failed."}
        </p>
      ) : null}
      {connector?.lastError ? <p className="text-sm text-destructive">{connector.lastError}</p> : null}

      <p className="text-xs text-muted-foreground">
        {data.setupCopy?.revocation}
      </p>
    </div>
  );
}
