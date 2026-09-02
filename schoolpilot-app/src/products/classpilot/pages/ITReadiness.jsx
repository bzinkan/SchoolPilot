import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpenCheck, CheckCircle2, Download, ExternalLink, MonitorCheck, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import { apiRequest } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { ThemeToggle } from "../../../components/ThemeToggle";
import GoogleRosterConnectorPanel from "../../../shared/components/GoogleRosterConnectorPanel";

function statusBadge(status) {
  const icon = status === "pass" ? CheckCircle2 : status === "fail" ? XCircle : TriangleAlert;
  const Icon = icon;
  const variant = status === "fail" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="gap-1 capitalize">
      <Icon className="h-3.5 w-3.5" />
      {status}
    </Badge>
  );
}

function detailList(items, emptyText, render) {
  if (!items?.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <div className="divide-y rounded-md border">
      {items.slice(0, 8).map((item, index) => (
        <div key={item.id || item.deviceId || index} className="p-3 text-sm">
          {render(item)}
        </div>
      ))}
    </div>
  );
}

function integrityLabel(value) {
  return String(value || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function ClassOwnershipIntegrity({ integrity, onOpenClasses, onOpenStaff }) {
  if (!integrity) return null;

  const rows = [
    ...(integrity.invalidPrimaryAssignments || []).map((item) => ({
      key: `primary-${item.groupId}-${item.teacherId}`,
      type: "Invalid primary teacher",
      category: "Class",
      resourceId: item.groupId,
      staffId: item.teacherId,
      detail: "No active teachable membership",
    })),
    ...(integrity.invalidCoTeacherAssignments || []).map((item) => ({
      key: `co-${item.relationshipId}`,
      type: "Invalid co-teacher",
      category: "Class",
      resourceId: item.groupId,
      staffId: item.teacherId,
      detail: `Relationship ${item.relationshipId}`,
    })),
    ...(integrity.invalidClassRelationships || []).map((item) => ({
      key: `class-relationship-${item.relationshipId}`,
      type: "Invalid class relationship",
      category: "Class",
      resourceId: item.groupId,
      staffId: item.teacherId,
      detail: `${integrityLabel(item.role)} · Relationship ${item.relationshipId} · ${item.reasons.map(integrityLabel).join(", ")}`,
    })),
    ...(integrity.primaryMirrorMismatches || []).map((item) => ({
      key: `mirror-${item.groupId}`,
      type: "Primary relationship mismatch",
      category: "Class",
      resourceId: item.groupId,
      staffId: item.teacherId,
      detail: item.mirrorTeacherIds?.length
        ? `Recorded primary IDs: ${item.mirrorTeacherIds.join(", ")}`
        : "Primary relationship is missing",
    })),
    ...(integrity.homeroomPrimaryMirrorMismatches || []).map((item) => ({
      key: `homeroom-mirror-${item.homeroomId}`,
      type: "Primary relationship mismatch",
      category: "GoPilot homeroom",
      resourceId: item.homeroomId,
      staffId: item.teacherId,
      detail: item.mirrorTeacherIds?.length
        ? `Recorded primary IDs: ${item.mirrorTeacherIds.join(", ")}`
        : "Primary relationship is missing",
    })),
    ...(integrity.invalidHomeroomRelationships || []).map((item) => ({
      key: `homeroom-relationship-${item.relationshipId}`,
      type: "Invalid homeroom relationship",
      category: "GoPilot homeroom",
      resourceId: item.homeroomId,
      staffId: item.teacherId,
      detail: `${integrityLabel(item.role)} · Relationship ${item.relationshipId} · ${item.reasons.map(integrityLabel).join(", ")}`,
    })),
    ...(integrity.invalidTenantScopes || []).map((item) => ({
      key: `tenant-scope-${item.resourceType}-${item.resourceId}`,
      type: "Invalid tenant scope",
      category: integrityLabel(item.resourceType),
      resourceId: item.resourceId,
      staffId: "—",
      detail: [
        integrityLabel(item.reason),
        item.parentResourceId ? `Parent resource ${item.parentResourceId}` : null,
        `Stored school ${item.storedSchoolId || "missing"}`,
        `Parent school ${item.parentSchoolId || "missing"}`,
      ].filter(Boolean).join(" · "),
    })),
    ...(integrity.invalidLiveAssignments || []).map((item) => ({
      key: `assignment-${item.assignmentType}-${item.assignmentId}`,
      type: "Invalid live ownership",
      category: integrityLabel(item.assignmentType),
      resourceId: item.resourceId,
      staffId: item.ownerUserId,
      detail: `${integrityLabel(item.reason)} · Assignment ${item.assignmentId}`,
    })),
    ...(integrity.invalidLiveBlockers || []).map((item) => ({
      key: `blocker-${item.blockerType}-${item.blockerId}`,
      type: "Invalid active workflow",
      category: integrityLabel(item.blockerType),
      resourceId: item.resourceId || item.blockerId,
      staffId: item.ownerUserId,
      detail: `${integrityLabel(item.reason)} · Workflow ${item.blockerId}`,
    })),
  ];

  return (
    <Card data-testid="class-ownership-integrity">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {integrity.total === 0
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              : <ShieldAlert className="h-4 w-4 text-destructive" />}
            Class Ownership Integrity
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Live classes, teacher-owned records, and active workflows must reference eligible staff in this school.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onOpenStaff}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            Open Staff
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onOpenClasses}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            Open Class Management
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant={integrity.counts?.invalidPrimaryAssignments ? "destructive" : "secondary"}>
            Primary: {integrity.counts?.invalidPrimaryAssignments || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidCoTeacherAssignments ? "destructive" : "secondary"}>
            Co-teacher: {integrity.counts?.invalidCoTeacherAssignments || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidClassRelationships ? "destructive" : "secondary"}>
            Class relationships: {integrity.counts?.invalidClassRelationships || 0}
          </Badge>
          <Badge variant={integrity.counts?.primaryMirrorMismatches ? "destructive" : "secondary"}>
            Class mirror: {integrity.counts?.primaryMirrorMismatches || 0}
          </Badge>
          <Badge variant={integrity.counts?.homeroomPrimaryMirrorMismatches ? "destructive" : "secondary"}>
            Homeroom mirror: {integrity.counts?.homeroomPrimaryMirrorMismatches || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidHomeroomRelationships ? "destructive" : "secondary"}>
            Homeroom relationships: {integrity.counts?.invalidHomeroomRelationships || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidTenantScopes ? "destructive" : "secondary"}>
            Tenant scope: {integrity.counts?.invalidTenantScopes || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidLiveAssignments ? "destructive" : "secondary"}>
            Other ownership: {integrity.counts?.invalidLiveAssignments || 0}
          </Badge>
          <Badge variant={integrity.counts?.invalidLiveBlockers ? "destructive" : "secondary"}>
            Active workflows: {integrity.counts?.invalidLiveBlockers || 0}
          </Badge>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No live staff ownership issues were found.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Issue</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Resource ID</th>
                  <th className="px-3 py-2 text-left font-medium">Staff ID</th>
                  <th className="px-3 py-2 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.slice(0, 100).map((row) => (
                  <tr key={row.key}>
                    <td className="px-3 py-2 font-medium">{row.type}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.category}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{row.resourceId}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{row.staffId}</td>
                    <td className="break-all px-3 py-2 text-muted-foreground">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 100 ? (
          <p className="text-xs text-muted-foreground">
            Showing the first 100 of {rows.length} school-scoped issues. Use the repair inventory for the complete ID-only report.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function ITReadiness() {
  const navigate = useNavigate();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["/api/classpilot/it-readiness"],
    queryFn: () => apiRequest("GET", "/classpilot/it-readiness"),
  });

  const summary = data?.summary || {};

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/classpilot/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">IT Readiness</h1>
              <p className="text-xs text-muted-foreground">Google, roster, extension, and safety setup health</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button asChild>
              <a href="/api/classpilot/it-readiness/export.csv">
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <div className="grid gap-3 md:grid-cols-6">
          {[
            ["Pass", summary.pass || 0],
            ["Warn", summary.warn || 0],
            ["Fail", summary.fail || 0],
            ["Students", summary.students || 0],
            ["Devices", summary.devices || 0],
            ["Connected", summary.connectedDevices || 0],
          ].map(([label, value]) => (
            <Card key={label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <GoogleRosterConnectorPanel
          className="bg-background"
          onConnected={() => refetch()}
        />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorCheck className="h-5 w-5" />
              Readiness Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading readiness checks...</p>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Category</th>
                      <th className="px-3 py-2 text-left font-medium">Check</th>
                      <th className="px-3 py-2 text-left font-medium">Detail</th>
                      <th className="px-3 py-2 text-left font-medium">Fix</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(data?.issues || []).map((issue) => (
                      <tr key={`${issue.category}-${issue.title}`}>
                        <td className="px-3 py-2">{statusBadge(issue.status)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{issue.category}</td>
                        <td className="px-3 py-2 font-medium">{issue.title}</td>
                        <td className="px-3 py-2">{issue.detail}</td>
                        <td className="px-3 py-2">
                          {issue.fixPath ? (
                            <Button variant="ghost" size="sm" onClick={() => navigate(issue.fixPath)}>
                              <ExternalLink className="mr-1 h-3.5 w-3.5" />
                              Open
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="google-workspace-policy-checklist">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" />
                Google Workspace policy checklist
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Apply these in Google Admin Console. ClassPilot cannot read policy state, so the checks above do not confirm them.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/classpilot/settings/guide?topic=google-workspace-policies">
                <BookOpenCheck className="mr-2 h-3.5 w-3.5" />
                Open step-by-step guide
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Required</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>Force-install the ClassPilot extension on the student organizational unit.</li>
                <li>Restrict sign-in to the school domain.</li>
                <li>Disable Guest mode.</li>
                <li>Turn off adding new users at sign-in.</li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>Disallow Incognito mode for students.</li>
                <li>Never allow built-in developer tools for students.</li>
                <li>Force users to sign in to use the browser.</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        <ClassOwnershipIntegrity
          integrity={data?.details?.classOwnershipIntegrity}
          onOpenClasses={() => navigate("/classpilot/admin/classes")}
          onOpenStaff={() => navigate("/classpilot/admin")}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">Device Issues</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {detailList(data?.details?.staleDevices, "No stale devices reported.", (device) => (
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{device.deviceId}</span>
                  <span className="text-muted-foreground">{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "Never seen"}</span>
                </div>
              ))}
              {detailList(data?.details?.screenshotFailures, "No screenshot failures reported.", (device) => (
                <div>
                  <p className="font-mono">{device.deviceId}</p>
                  <p className="text-muted-foreground">{device.health?.lastError || "Screenshot attempts without success"}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="h-4 w-4" />Roster And Safety</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {detailList(data?.details?.missingEmail, "Student identity emails look complete.", (student) => (
                <div className="flex items-center justify-between gap-2">
                  <span>{student.name}</span>
                  <span className="text-muted-foreground">{student.email || "Missing email"}</span>
                </div>
              ))}
              {detailList(data?.details?.unmappedStudents, "All students have a known device mapping.", (student) => (
                <div className="flex items-center justify-between gap-2">
                  <span>{student.name}</span>
                  <span className="text-muted-foreground">{student.email || "No email"}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
