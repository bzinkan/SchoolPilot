import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Download, ExternalLink, MonitorCheck, RefreshCw, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
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
