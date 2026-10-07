import { useAdminShell, useAdminNavigation } from "../hooks/useAdminNavigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { AlertCircle, ArrowLeft, BarChart3, Users, Monitor, Clock, Globe, TrendingUp, Layers } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";

function hourLabel(hour) {
  return `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
}

function errorMessage(error) {
  return error?.response?.data?.error || error?.message || "Request failed";
}

function ErrorState({ title, error }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <div className="flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4" />
        {title}
      </div>
      <div className="mt-1 text-destructive/80">{errorMessage(error)}</div>
    </div>
  );
}

export default function AdminAnalytics() {
  const adminShell = useAdminShell();
  const { navigate } = useAdminNavigation();
  const [summaryPeriod, setSummaryPeriod] = useState("today");
  const [groupPeriod, setGroupPeriod] = useState("7d");

  const { data: summaryData, isLoading: summaryLoading, isError: summaryIsError, error: summaryError } = useQuery({
    queryKey: ["/api/admin/analytics/summary", summaryPeriod],
    queryFn: () => apiRequest("GET", `/admin/analytics/summary?period=${summaryPeriod}`),
  });

  const { data: groupData, isLoading: groupLoading, isError: groupIsError, error: groupError } = useQuery({
    queryKey: ["/api/admin/analytics/by-group", groupPeriod],
    queryFn: () => apiRequest("GET", `/admin/analytics/by-group?period=${groupPeriod}`),
  });

  const formatMinutes = (minutes) => {
    const m = Number(minutes) || 0;
    if (m < 60) return `${m}m`;
    const hours = Math.floor(m / 60);
    const mins = m % 60;
    return `${hours}h ${mins}m`;
  };

  const hourlyActivity = Array.isArray(summaryData?.hourlyActivity) ? summaryData.hourlyActivity : [];
  const topWebsites = Array.isArray(summaryData?.topWebsites) ? summaryData.topWebsites : [];
  const groupsList = Array.isArray(groupData?.groups) ? groupData.groups : [];
  const isRosterBrowsing = groupData?.attributionMode === "roster";
  const classUsageTitle = isRosterBrowsing
    ? "Roster Browsing by Official Class"
    : "Class Session Usage by Official Class";

  const maxHourlyCount = hourlyActivity.length > 0
    ? Math.max(...hourlyActivity.map(h => h.count), 1)
    : 1;

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      {!adminShell && (<div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <BarChart3 className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Usage Analytics</h1>
            <p className="text-muted-foreground">School-wide activity reports and statistics</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => navigate("/classpilot/admin")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Admin
          </Button>
        </div>
      </div>)}
      {/* Summary Cards */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Activity Summary</h2>
        <Select value={summaryPeriod} onValueChange={setSummaryPeriod}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {summaryLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading analytics...</div>
      ) : summaryIsError ? (
        <ErrorState title="Could not load activity summary" error={summaryError} />
      ) : summaryData ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                    <Users className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.activeStudents ?? 0}</p>
                    <p className="text-sm text-muted-foreground">Active / Enrolled</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">of {summaryData.summary.totalStudents ?? 0} total</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900 flex items-center justify-center">
                    <Monitor className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.totalDevices ?? 0}</p>
                    <p className="text-sm text-muted-foreground">Recognized Chromebooks</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">unique devices seen by ClassPilot</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{formatMinutes(summaryData.summary.totalBrowsingMinutes)}</p>
                    <p className="text-sm text-muted-foreground">Total Browsing</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-amber-100 dark:bg-amber-900 flex items-center justify-center">
                    <TrendingUp className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.totalTeachers ?? 0}</p>
                    <p className="text-sm text-muted-foreground">Teachers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 items-start gap-6">
            {/* Top Domains */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5" />
                  Top Domains by Observed Time
                </CardTitle>
                <CardDescription>Estimated from heartbeat samples</CardDescription>
              </CardHeader>
              <CardContent>
                {topWebsites.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">No domain data available</p>
                ) : (
                  <div className="space-y-3">
                    {topWebsites.map((site, idx) => (
                      <div key={site.domain} className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-6">{idx + 1}.</span>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium truncate max-w-[200px]">{site.domain}</span>
                            <span className="text-xs text-muted-foreground">{formatMinutes(site.minutes)}</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{
                                width: `${(site.visits / topWebsites[0].visits) * 100}%`
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Activity by Hour */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Activity by Hour
                </CardTitle>
                <CardDescription>Recorded activity samples by school-local hour</CardDescription>
              </CardHeader>
              <CardContent>
                {hourlyActivity.length === 0 ? (
                  <p className="py-8 text-center text-muted-foreground">No hourly activity data available for this period.</p>
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">Activity samples</p>
                    <div className="flex gap-3">
                      <div aria-hidden="true" className="relative h-60 w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        <span className="absolute right-0 top-0 -translate-y-1/2">{maxHourlyCount.toLocaleString()}</span>
                        <span className="absolute right-0 bottom-0 translate-y-1/2">0</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          role="img"
                          aria-label="Activity samples by hour for the selected period. Exact counts are available in View hourly counts below."
                          className="relative h-60"
                        >
                          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                            {[0, 1, 2, 3, 4].map((line) => (
                              <div key={line} className="border-t border-muted-foreground/20" />
                            ))}
                          </div>
                          <div aria-hidden="true" className="relative flex h-full items-end gap-1">
                            {hourlyActivity.map((hour) => (
                              <div
                                key={hour.hour}
                                className="flex h-full min-w-0 flex-1 items-end"
                                title={`${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)}: ${hour.count.toLocaleString()} activity samples`}
                              >
                                <div
                                  className="w-full rounded-t bg-primary/80"
                                  style={{
                                    height: `${(hour.count / maxHourlyCount) * 100}%`,
                                    minHeight: hour.count > 0 ? "2px" : "0px",
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                        <div aria-hidden="true" className="mt-2 flex gap-1 text-xs text-muted-foreground">
                          {hourlyActivity.map((hour) => (
                            <div key={hour.hour} className="relative h-4 min-w-0 flex-1">
                              {[0, 6, 12, 18, 23].includes(hour.hour) ? (
                                <span className={`absolute whitespace-nowrap ${hour.hour === 0 ? "left-0" : hour.hour === 23 ? "right-0" : "left-1/2 -translate-x-1/2"}`}>
                                  {hourLabel(hour.hour)}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {hourlyActivity.every((hour) => hour.count === 0) ? (
                      <p className="mt-4 text-sm text-muted-foreground">No recorded activity samples for this period.</p>
                    ) : null}
                    <details className="mt-4 text-sm">
                      <summary className="cursor-pointer rounded-sm py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">View hourly counts</summary>
                      <p className="mb-3 text-xs text-muted-foreground">Each sample is a Chromebook check-in. Counts cover the selected period.</p>
                      <table className="w-full text-sm">
                        <caption className="sr-only">Activity samples by school-local hour</caption>
                        <thead>
                          <tr className="border-b">
                            <th scope="col" className="py-2 text-left font-medium">Hour</th>
                            <th scope="col" className="py-2 text-right font-medium">Activity samples</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hourlyActivity.map((hour) => (
                            <tr key={hour.hour} className="border-b border-border/60">
                              <th scope="row" className="py-2 text-left font-normal">{hourLabel(hour.hour)}–{hourLabel((hour.hour + 1) % 24)}</th>
                              <td className="py-2 text-right tabular-nums">{hour.count.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {/* Class Usage */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mt-8">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Layers className="h-5 w-5" />
          {classUsageTitle}
        </h2>
        <Select value={groupPeriod} onValueChange={setGroupPeriod}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6">
          {!isRosterBrowsing ? (
            <p className="mb-4 text-sm text-muted-foreground">
              Daily average includes only students with recorded class usage on each day. Total Usage covers the selected date range.
            </p>
          ) : null}
          {groupLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading class data...</div>
          ) : groupIsError ? (
            <ErrorState title="Could not load class usage" error={groupError} />
          ) : groupsList.length > 0 ? (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Class</th>
                    <th className="px-4 py-3 text-left font-medium">Teacher</th>
                    <th className="px-4 py-3 text-left font-medium">Total Usage</th>
                    {!isRosterBrowsing ? (
                      <th className="px-4 py-3 text-left font-medium">Days with Usage</th>
                    ) : null}
                    <th className="px-4 py-3 text-left font-medium">
                      {isRosterBrowsing ? "Avg / Active Student" : "Daily Avg / Active Student"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupsList.map((group) => (
                    <tr key={group.groupId} className="border-t">
                      <td className="px-4 py-3">
                        <div className="font-medium">{group.groupName}</div>
                        <div className="text-xs text-muted-foreground">
                          {[group.periodLabel, group.gradeLevel ? `Grade ${group.gradeLevel}` : null].filter(Boolean).join(" · ") || "\u00A0"}
                        </div>
                      </td>
                      <td className="px-4 py-3">{group.teacherName}</td>
                      <td className="px-4 py-3">{formatMinutes(group.totalBrowsingMinutes)}</td>
                      {!isRosterBrowsing ? (
                        <td className="px-4 py-3">{group.activeClassDayCount ?? "—"}</td>
                      ) : null}
                      <td className="px-4 py-3">
                        {isRosterBrowsing
                          ? formatMinutes(group.avgMinutesPerStudent)
                          : Number.isFinite(group.avgDailyMinutesPerActiveStudent)
                            ? formatMinutes(group.avgDailyMinutesPerActiveStudent)
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No class session usage data available for this period.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
