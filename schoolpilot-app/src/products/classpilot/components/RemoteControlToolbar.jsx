import { lazy, Suspense, useState } from "react";
import { BarChart3, Route, ClipboardCheck } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { apiRequest } from "../../../lib/queryClient";
import { useQuery } from "@tanstack/react-query";

const StudentDataDialog = lazy(() => import("./StudentDataDialog"));

function RemoteControlToolbar({
  selectedStudentIds,
  students,
  selectedGrade,
  onGradeChange,
  userRole,
  coverageCount = 0,
  availableCount = 0,
  claimedCount = 0,
  pickupView = "class",
  showCoverageRail = true,
  onPickupViewChange,
  onOpenCoverage,
  canReroute = false,
  onReroute,
  canViewHistoricalTelemetry = false,
}) {
  const [showStudentDataDialog, setShowStudentDataDialog] = useState(false);
  const coverageRailButtonClass = (active = false) => [
    "h-9 rounded-md border px-4 text-sm font-semibold text-slate-950 shadow-sm transition-colors",
    "focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-1",
    active
      ? "border-yellow-500 bg-yellow-400 hover:bg-yellow-300"
      : "border-yellow-300 bg-yellow-50 hover:bg-yellow-100",
  ].join(" ");
  const coverageActionButtonClass = [
    "h-9 rounded-md border border-yellow-500 bg-yellow-400 px-4 text-sm font-semibold text-slate-950 shadow-sm",
    "hover:bg-yellow-300 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-1",
    "disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:disabled:border-slate-700 dark:disabled:bg-slate-800 dark:disabled:text-slate-500",
  ].join(" ");
  const coverageCountClass = "ml-1 min-w-5 rounded-full bg-white/85 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-slate-950 ring-1 ring-yellow-700/20";

  const { data: settings } = useQuery({
    queryKey: ['/api/settings'],
    queryFn: () => apiRequest('GET', '/settings'),
    select: (data) => data?.settings ?? data ?? null,
  });

  return (
    <>
      <div className="border-b border-border bg-muted/30 px-6 py-4 mb-8">
        <div className="max-w-screen-2xl mx-auto">
          <div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 lg:justify-start">
              {userRole === 'admin' && settings?.gradeLevels && settings.gradeLevels.length > 0 && (
                <Tabs value={selectedGrade} onValueChange={onGradeChange}>
                  <TabsList className="flex-wrap h-auto gap-2 p-1.5 bg-muted/50 rounded-xl">
                    {settings.gradeLevels.map((grade) => (
                      <TabsTrigger
                        key={grade}
                        value={grade}
                        data-testid={`tab-grade-${grade}`}
                        className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg px-5 py-2.5 font-medium transition-all duration-200 data-[state=active]:shadow-md"
                      >
                        {grade}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              {canViewHistoricalTelemetry && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowStudentDataDialog(true)}
                  data-testid="button-student-data-tab"
                >
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Student Data
                </Button>
              )}
            </div>

            <div className="flex justify-center">
              {showCoverageRail ? (
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-yellow-300 bg-yellow-50/80 p-1.5 shadow-sm" data-testid="coverage-action-rail">
                {onPickupViewChange && (
                  <div className="flex flex-wrap items-center justify-center gap-1.5" data-testid="student-pickup-view-tabs">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onPickupViewChange("class")}
                      data-testid="button-view-class-students"
                      className={coverageRailButtonClass(pickupView === "class")}
                    >
                      Class
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onPickupViewChange("available")}
                      data-testid="button-view-available-students"
                      className={coverageRailButtonClass(pickupView === "available")}
                    >
                      Available
                      {availableCount > 0 && (
                        <span className={coverageCountClass}>{availableCount}</span>
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onPickupViewChange("claimed")}
                      data-testid="button-view-claimed-students"
                      className={coverageRailButtonClass(pickupView === "claimed")}
                    >
                      Claimed
                      {claimedCount > 0 && (
                        <span className={coverageCountClass}>{claimedCount}</span>
                      )}
                    </Button>
                  </div>
                )}
                {onOpenCoverage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onOpenCoverage}
                    data-testid="button-coverage-tab"
                    title={coverageCount > 0 ? `${coverageCount} claimed group${coverageCount === 1 ? "" : "s"} assigned to you` : "Open coverage setup"}
                    className={coverageActionButtonClass}
                  >
                    <ClipboardCheck className="h-4 w-4 mr-2" />
                    Coverage
                    {coverageCount > 0 && (
                      <span className={coverageCountClass}>{coverageCount}</span>
                    )}
                  </Button>
                )}
                {onReroute && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onReroute}
                    disabled={selectedStudentIds.size === 0 || !canReroute}
                    data-testid="button-reroute-selected"
                    title={!canReroute ? "Create a Supervision Group with assigned staff before sending students" : "Send selected students to assigned staff"}
                    className={coverageActionButtonClass}
                  >
                    <Route className="h-4 w-4 mr-2" />
                    Send to...
                  </Button>
                )}
              </div>
              ) : null}
            </div>

            <div className="hidden lg:block" />
          </div>
        </div>
      </div>

      {showStudentDataDialog && (
        <Suspense fallback={<div className="sr-only" role="status">Loading Student Data…</div>}>
          <StudentDataDialog
            open
            students={students}
            onOpenChange={setShowStudentDataDialog}
          />
        </Suspense>
      )}
    </>
  );
}

export default RemoteControlToolbar;
