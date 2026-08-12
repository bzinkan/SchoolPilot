import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CheckCircle2, History, Loader2, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../../components/ui/alert-dialog";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Label } from "../../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { useToast } from "../../../../hooks/use-toast";
import { queryClient } from "../../../../lib/queryClient";
import { useStudentImportHome } from "../../../../shared/hooks/useStudentImportHome";
import {
  isCanonicalPassPilotSource,
  normalizePassPilotClass,
  passPilotClassRequest,
  PASSPILOT_CLASSES_QUERY_KEY,
} from "../../classData";

const MIGRATION_QUERY_KEY = ["passpilot", "admin", "class-migration"];
const NONE = "__none__";

function isRevisionConflict(error) {
  return error?.response?.data?.code === "PASSPILOT_CLASS_MIGRATION_CONFLICT";
}

function normalizeMigration(data) {
  const items = Array.isArray(data) ? data : (data?.legacyGrades ?? data?.items ?? []);
  const canonicalClasses = (data?.canonicalClasses ?? [])
    .map(normalizePassPilotClass)
    .filter((item) => item.id);
  return {
    source: data?.source || null,
    revision: Number(data?.revision ?? data?.migrationRevision ?? 0),
    status: isCanonicalPassPilotSource(data?.source) ? "complete" : "review_required",
    canonicalClasses,
    items: items.map((item) => ({
      ...item,
      id: item.legacyGradeId || item.gradeId || item.id,
      name: item.legacyName || item.name || item.gradeName || "Legacy PassPilot class",
      studentCount: Number(item.studentCount ?? item.legacyStudentCount ?? 0),
      teacherCount: Number(item.teacherCount ?? item.legacyTeacherCount ?? 0),
      teacherNames: item.teacherNames || item.assignedTeachers || [],
      activePassCount: Number(item.activePassCount ?? 0),
      historicalPassCount: Number(item.historicalPassCount ?? item.passCount ?? 0),
      suggestedClassId:
        item.classpilotGroupId
        || item.suggestedClasspilotGroupId
        || item.suggestedClassId
        || null,
      migrationState: item.migrationState || "pending",
      conflictReasons: Array.isArray(item.conflictReasons) ? item.conflictReasons : [],
      comparison: item.comparison || null,
      comparisons: Array.isArray(item.comparisons) ? item.comparisons : [],
      rosterDifferenceCount:
        item.rosterDifferenceCount
        ?? item.rosterDiffCount
        ?? (item.comparison
          ? Number(item.comparison.rosterAddedCount ?? 0)
            + Number(item.comparison.rosterRemovedCount ?? 0)
          : null),
      teacherDifferenceCount:
        item.teacherDifferenceCount
        ?? item.teacherDiffCount
        ?? (item.comparison
          ? Number(item.comparison.teacherAddedCount ?? 0)
            + Number(item.comparison.teacherRemovedCount ?? 0)
          : null),
    })).filter((item) => item.id),
  };
}

function migrationStatusLabel(item) {
  const labels = {
    suggested: "Suggested match",
    suggested_match: "Suggested match",
    no_match: "No match",
    roster_conflict: "Roster conflict",
    teacher_conflict: "Teacher conflict",
    linked: "Linked",
    confirmed: "Linked",
    auto_linked: "Automatically linked",
    history_only: "History only",
    ready: "Ready",
  };
  return labels[item.migrationState] || "Review required";
}

const CONFLICT_REASON_LABELS = {
  duplicate_legacy_name: "More than one legacy class has this name.",
  no_exact_name_match: "No ClassPilot class has the same name.",
  duplicate_canonical_name: "More than one ClassPilot class has this name.",
  teacher_mismatch: "Teacher assignments differ.",
  roster_mismatch: "Student rosters differ.",
};

function migrationMemberLabel(member) {
  const name = member?.name || "Unknown record";
  return member?.detail ? `${name} — ${member.detail}` : name;
}

export default function ClassSourceSetup() {
  const { canLinkToClassPilot } = useStudentImportHome();
  const { toast } = useToast();
  const migrationQuery = useQuery({
    queryKey: MIGRATION_QUERY_KEY,
    queryFn: () => passPilotClassRequest("GET", "/passpilot/admin/class-migration"),
    select: normalizeMigration,
  });
  const [selections, setSelections] = useState({});
  const [editingDecisions, setEditingDecisions] = useState({});
  const [revisionConflict, setRevisionConflict] = useState(false);

  const refreshReview = async () => {
    setRevisionConflict(false);
    await migrationQuery.refetch();
  };

  const decisionMutation = useMutation({
    mutationFn: ({ item, action, classpilotGroupId }) => passPilotClassRequest(
      "PUT",
      `/passpilot/admin/class-migration/${encodeURIComponent(item.id)}`,
      {
        expectedRevision: migrationQuery.data?.revision ?? 0,
        action,
        ...(action === "link" ? { classpilotGroupId } : {}),
      },
    ),
    onSuccess: (_data, variables) => {
      setRevisionConflict(false);
      setEditingDecisions((current) => ({ ...current, [variables.item.id]: false }));
      queryClient.invalidateQueries({ queryKey: MIGRATION_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      toast({ title: "Class review saved", description: "Existing pass history remains available." });
    },
    onError: (error) => {
      if (isRevisionConflict(error)) {
        setRevisionConflict(true);
        return;
      }
      toast({
        title: "Class review wasn’t saved",
        description: error?.response?.data?.error || error?.message || "Try again.",
        variant: "destructive",
      });
    },
  });

  const completeMutation = useMutation({
    mutationFn: () => passPilotClassRequest("POST", "/passpilot/admin/class-migration/complete", {
      expectedRevision: migrationQuery.data?.revision ?? 0,
      classModelAcknowledged: true,
    }),
    onSuccess: () => {
      setRevisionConflict(false);
      queryClient.invalidateQueries({ queryKey: MIGRATION_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      toast({ title: "Class review complete", description: "PassPilot now uses ClassPilot classes." });
    },
    onError: (error) => {
      if (isRevisionConflict(error)) {
        setRevisionConflict(true);
        return;
      }
      toast({
        title: "Review couldn’t be completed",
        description: error?.response?.data?.error || error?.message || "Resolve the remaining classes and try again.",
        variant: "destructive",
      });
    },
  });

  const migration = migrationQuery.data;
  const officialClasses = migration?.canonicalClasses || [];
  const unresolvedItems = (migration?.items || []).filter(
    (item) => !["confirmed", "auto_linked", "history_only"].includes(item.migrationState),
  );
  const isComplete = migration?.status === "complete";

  return (
    <div className="space-y-5 pt-4" data-testid="passpilot-class-source-setup">
      <Card className="border-l-4 border-l-amber-400">
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Class Source</CardTitle>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {isComplete
                  ? "Class names, teachers, and rosters are managed in ClassPilot and appear in PassPilot automatically."
                  : "Review existing PassPilot classes before switching to the official classes managed in ClassPilot."}
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              {isComplete ? "Managed in ClassPilot" : "Review before switching"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold tabular-nums text-foreground">{officialClasses.length}</span>{" "}
            active {officialClasses.length === 1 ? "class" : "classes"}
          </p>
          {canLinkToClassPilot ? (
            <Button asChild variant="outline">
              <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fsetup%3Fsection%3Dclass-source">
                Manage in ClassPilot
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Manage classes in Schoolpilot on the web.</p>
          )}
        </CardContent>
      </Card>

      {migrationQuery.isLoading ? (
        <Card>
          <CardContent className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading existing PassPilot classes…
          </CardContent>
        </Card>
      ) : migrationQuery.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex min-h-40 flex-col items-center justify-center p-6 text-center">
            <AlertCircle className="mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
            <h3 className="font-semibold">Existing classes couldn’t be loaded</h3>
            <p className="mt-1 text-sm text-muted-foreground">Try again. No migration decisions were changed.</p>
            <Button type="button" variant="outline" className="mt-4" onClick={refreshReview}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : isComplete ? (
        <Card>
          <CardContent className="flex items-start gap-3 p-5" role="status">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
            <div>
              <h3 className="font-semibold">All PassPilot classes now use ClassPilot</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Existing pass records and historical class names remain available in Reports.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Review Existing PassPilot Classes</CardTitle>
            <p className="text-sm text-muted-foreground">
              Link each legacy class to an official ClassPilot class, or keep it for history only. Nothing is deleted.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {revisionConflict ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100" role="alert">
                <p className="font-semibold">This migration changed in another session</p>
                <p className="mt-1">Your selections are still here. Load the latest version before saving.</p>
                <Button type="button" size="sm" variant="outline" className="mt-3" onClick={refreshReview}>
                  Load Latest
                </Button>
              </div>
            ) : null}

            {(migration?.items || []).map((item) => {
              const selectedClassId = selections[item.id] ?? item.suggestedClassId ?? NONE;
              const teacherText = Array.isArray(item.teacherNames)
                ? (item.teacherNames.join(", ") || `${item.teacherCount} ${item.teacherCount === 1 ? "teacher" : "teachers"}`)
                : String(item.teacherNames || "No legacy teacher assignment");
              const linked = ["confirmed", "auto_linked"].includes(item.migrationState);
              const resolved = linked || item.migrationState === "history_only";
              const showEditor = !resolved || editingDecisions[item.id];
              const selectedTarget = officialClasses.find((itemClass) => itemClass.id === selectedClassId);
              const selectedComparison = item.comparisons.find(
                (comparison) => comparison.classpilotGroupId === selectedClassId,
              ) || (
                item.comparison?.classpilotGroupId === selectedClassId
                  ? item.comparison
                  : null
              );
              const legacyDifferenceMatchesSelection = selectedClassId === item.suggestedClassId;
              const rosterDifferenceCount = Number(
                (selectedComparison
                  ? Number(selectedComparison.rosterAddedCount ?? 0)
                    + Number(selectedComparison.rosterRemovedCount ?? 0)
                  : null)
                  ?? (legacyDifferenceMatchesSelection ? item.rosterDifferenceCount : null)
                  ?? (selectedTarget ? Math.abs(item.studentCount - selectedTarget.studentCount) : 0),
              );
              const teacherDifferenceCount = Number(
                (selectedComparison
                  ? Number(selectedComparison.teacherAddedCount ?? 0)
                    + Number(selectedComparison.teacherRemovedCount ?? 0)
                  : null)
                  ?? (legacyDifferenceMatchesSelection ? item.teacherDifferenceCount : null)
                  ?? (selectedTarget ? Math.abs(item.teacherCount - Number(selectedTarget.teacherCount ?? 0)) : 0),
              );
              const comparisonDetails = selectedComparison ? [
                { key: "roster-added", label: "Only in the ClassPilot roster", members: selectedComparison.rosterAdded || [] },
                { key: "roster-removed", label: "Only in the legacy PassPilot roster", members: selectedComparison.rosterRemoved || [] },
                { key: "teachers-added", label: "Only assigned in ClassPilot", members: selectedComparison.teacherAdded || [] },
                { key: "teachers-removed", label: "Only assigned in legacy PassPilot", members: selectedComparison.teacherRemoved || [] },
              ].filter((entry) => entry.members.length > 0) : [];

              return (
                <section key={item.id} className="rounded-lg border p-4" aria-labelledby={`legacy-class-${item.id}`}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 id={`legacy-class-${item.id}`} className="break-words font-semibold">{item.name}</h4>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          {migrationStatusLabel(item)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {item.studentCount} {item.studentCount === 1 ? "student" : "students"} · {teacherText}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.activePassCount} active · {item.historicalPassCount} historical passes
                      </p>
                    </div>

                    {resolved && !showEditor ? (
                      <div className="flex flex-col items-start gap-2">
                        <p className="text-sm font-medium text-green-700 dark:text-green-300">
                          {linked ? "Linked to ClassPilot" : "Preserved for history"}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingDecisions((current) => ({ ...current, [item.id]: true }))}
                        >
                          Change decision
                        </Button>
                      </div>
                    ) : (
                      <div className="w-full space-y-3 lg:max-w-md">
                        <div className="space-y-1.5">
                          <Label htmlFor={`class-match-${item.id}`}>Official ClassPilot Class</Label>
                          <Select
                            value={selectedClassId}
                            onValueChange={(value) => setSelections((current) => ({ ...current, [item.id]: value }))}
                          >
                            <SelectTrigger id={`class-match-${item.id}`}>
                              <SelectValue placeholder="Choose a ClassPilot class" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>Choose a ClassPilot class</SelectItem>
                              {officialClasses.map((itemClass) => (
                                <SelectItem key={itemClass.id} value={itemClass.id}>{itemClass.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {selectedTarget ? (
                          <div className="rounded-md border bg-muted/30 p-3 text-xs" data-testid={`class-comparison-${item.id}`}>
                            <p className="font-semibold text-foreground">Compare before linking</p>
                            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                              <span>Legacy PassPilot</span>
                              <span>{item.studentCount} students · {item.teacherCount} teachers</span>
                              <span>{selectedTarget.name}</span>
                              <span>{selectedTarget.studentCount} students · {Number(selectedTarget.teacherCount ?? 0)} teachers</span>
                            </div>
                            <p className="mt-2 text-foreground">
                              {rosterDifferenceCount} roster {rosterDifferenceCount === 1 ? "difference" : "differences"} · {teacherDifferenceCount} teacher {teacherDifferenceCount === 1 ? "difference" : "differences"}
                            </p>
                            {comparisonDetails.length > 0 ? (
                              <div className="mt-3 space-y-2 border-t pt-3 text-foreground" data-testid={`class-comparison-details-${item.id}`}>
                                {comparisonDetails.map((entry) => (
                                  <div key={entry.key}>
                                    <p className="font-medium">{entry.label}</p>
                                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                                      {entry.members.map((member) => (
                                        <li key={member.id}>{migrationMemberLabel(member)}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            <p className="mt-1 text-muted-foreground">
                              Future access uses the ClassPilot roster and teachers. Make roster corrections in ClassPilot; existing pass history remains unchanged.
                            </p>
                          </div>
                        ) : null}
                        {item.conflictReasons.length > 0 ? (
                          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100" role="note">
                            <p className="font-semibold">Review these differences</p>
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              {item.conflictReasons.map((reason) => (
                                <li key={reason}>{CONFLICT_REASON_LABELS[reason] || String(reason).replaceAll("_", " ")}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                size="sm"
                                disabled={selectedClassId === NONE || decisionMutation.isPending || revisionConflict}
                              >
                                Link to ClassPilot Class
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Link {item.name} to {selectedTarget?.name || "this ClassPilot class"}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  PassPilot will use the selected ClassPilot roster and teacher assignments for future passes. Any roster corrections must be made in ClassPilot. Existing pass history remains unchanged.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => decisionMutation.mutate({
                                  item,
                                  action: "link",
                                  classpilotGroupId: selectedClassId,
                                })}>
                                  Confirm Link
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button type="button" size="sm" variant="outline" disabled={decisionMutation.isPending || revisionConflict}>
                                <History className="mr-2 h-4 w-4" aria-hidden="true" />
                                Keep as History Only
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Keep {item.name} for history only?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Teachers will no longer use this legacy class for new passes. Existing passes and reports remain unchanged.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => decisionMutation.mutate({ item, action: "history_only" })}>
                                  Keep as History Only
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          {canLinkToClassPilot ? (
                            <Button asChild type="button" size="sm" variant="ghost">
                              <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fsetup%3Fsection%3Dclass-source">
                                Create in ClassPilot
                              </Link>
                            </Button>
                          ) : null}
                          {resolved ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingDecisions((current) => ({ ...current, [item.id]: false }))}
                            >
                              Cancel change
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              );
            })}

            {unresolvedItems.length === 0 ? (
              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">Every existing class has a decision.</p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      disabled={completeMutation.isPending || revisionConflict}
                    >
                      {completeMutation.isPending ? "Completing…" : "Complete Class Review"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Switch PassPilot to ClassPilot classes?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Confirm that every PassPilot mobile app and kiosk has been refreshed or updated for ClassPilot classes. This changes the class source for the entire school and cannot be undone here.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => completeMutation.mutate()}>
                        Confirm and Switch
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
