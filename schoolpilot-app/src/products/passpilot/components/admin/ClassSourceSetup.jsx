import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

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
import { Checkbox } from "../../../../components/ui/checkbox";
import { Label } from "../../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { toast } from "../../../../hooks/use-toast";
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
const EMPTY_LIST = Object.freeze([]);

const CONFLICT_REASON_LABELS = {
  duplicate_legacy_name: "More than one legacy class has this name.",
  no_exact_name_match: "No ClassPilot class has the same name.",
  duplicate_canonical_name: "More than one ClassPilot class has this name.",
  teacher_mismatch: "Teacher assignments differ.",
  roster_mismatch: "Student rosters differ.",
};

function apiErrorMessage(error, fallback) {
  const data = error?.response?.data;
  const message = data?.error || error?.message || fallback;
  if (data?.code === "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED") {
    return `${message} Refresh SchoolPilot before continuing.`;
  }
  return message;
}

function isRevisionConflict(error) {
  return error?.response?.status === 409
    && error?.response?.data?.code === "PASSPILOT_CLASS_MIGRATION_CONFLICT";
}

function normalizeMigration(data) {
  const rawItems = Array.isArray(data) ? data : (data?.legacyGrades ?? data?.items ?? []);
  const canonicalClasses = (data?.canonicalClasses ?? [])
    .map(normalizePassPilotClass)
    .filter((item) => item.id);

  return {
    source: data?.source || null,
    revision: Number(data?.revision ?? data?.migrationRevision ?? 0),
    kioskGradeId: data?.kioskGradeId || null,
    kioskClasspilotGroupId: data?.kioskClasspilotGroupId || null,
    canonicalClasses,
    items: rawItems.map((item) => ({
      ...item,
      id: item.legacyGradeId || item.gradeId || item.id,
      name: item.legacyName || item.name || item.gradeName || "Legacy PassPilot class",
      studentCount: Number(item.studentCount ?? item.legacyStudentCount ?? 0),
      teacherCount: Number(item.teacherCount ?? item.legacyTeacherCount ?? 0),
      teacherNames: item.teacherNames || item.assignedTeachers || [],
      activePassCount: Number(item.activePassCount ?? 0),
      historicalPassCount: Number(item.historicalPassCount ?? item.passCount ?? 0),
      suggestedClassId:
        item.suggestedClasspilotGroupId
        || item.suggestedClassId
        || null,
      selectedClassId: item.classpilotGroupId || null,
      migrationState: item.migrationState || "pending",
      autoLinkEligible: item.autoLinkEligible === true,
      conflictReasons: Array.isArray(item.conflictReasons) ? item.conflictReasons : [],
      comparison: item.comparison || null,
      comparisons: Array.isArray(item.comparisons) ? item.comparisons : [],
    })).filter((item) => item.id),
  };
}

function memberLabel(member) {
  const name = member?.name || "Unknown record";
  return member?.detail ? `${name} — ${member.detail}` : name;
}

function isResolvedMigrationItem(item, officialClasses) {
  if (item.migrationState === "history_only") return true;
  if (item.migrationState !== "confirmed") return false;
  return officialClasses.some((candidate) => candidate.id === item.selectedClassId);
}

function statusLabel(item, officialClasses) {
  if (item.migrationState === "confirmed" && isResolvedMigrationItem(item, officialClasses)) return "Reviewed link";
  if (item.migrationState === "confirmed") return "Official class unavailable";
  if (item.migrationState === "history_only") return "History only";
  if (item.migrationState === "auto_linked" || item.autoLinkEligible) return "Exact match suggested";
  return "Review required";
}

function differenceCount(comparison, type) {
  if (!comparison) return 0;
  if (type === "roster") {
    return Number(comparison.rosterAddedCount ?? 0) + Number(comparison.rosterRemovedCount ?? 0);
  }
  return Number(comparison.teacherAddedCount ?? 0) + Number(comparison.teacherRemovedCount ?? 0);
}

export default function ClassSourceSetup() {
  const navigate = useNavigate();
  const { canLinkToClassPilot } = useStudentImportHome();
  const [selections, setSelections] = useState({});
  const [editingDecisions, setEditingDecisions] = useState({});
  const [differenceAcknowledgements, setDifferenceAcknowledgements] = useState({});
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [clientsReady, setClientsReady] = useState(false);

  const discardItemDraft = (itemId) => {
    setSelections((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setDifferenceAcknowledgements((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${itemId}:`)),
    ));
    setEditingDecisions((current) => ({ ...current, [itemId]: false }));
  };

  const migrationQuery = useQuery({
    queryKey: MIGRATION_QUERY_KEY,
    queryFn: () => passPilotClassRequest("GET", "/passpilot/admin/class-migration"),
    select: normalizeMigration,
  });

  const refreshReview = async () => {
    const result = await migrationQuery.refetch();
    if (result.error) return;

    // Every local decision below is bound to the inventory revision that the
    // administrator reviewed. Never carry it across a reload after a 409.
    setSelections({});
    setEditingDecisions({});
    setDifferenceAcknowledgements({});
    setReviewConfirmed(false);
    setClientsReady(false);
    setRevisionConflict(false);
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
    onSuccess: (data, variables) => {
      setRevisionConflict(false);
      setReviewConfirmed(false);
      discardItemDraft(variables.item.id);
      queryClient.setQueryData(MIGRATION_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      toast({
        title: variables.action === "link" ? "Class link reviewed" : "Class preserved for history",
        description: "Existing pass history remains unchanged.",
      });
    },
    onError: (error) => {
      if (isRevisionConflict(error)) {
        setReviewConfirmed(false);
        setClientsReady(false);
        setRevisionConflict(true);
        return;
      }
      toast({
        title: "Class decision wasn’t saved",
        description: apiErrorMessage(error, "Review the class and try again."),
        variant: "destructive",
      });
    },
  });

  const completeMutation = useMutation({
    mutationFn: () => passPilotClassRequest("POST", "/passpilot/admin/class-migration/complete", {
      expectedRevision: migrationQuery.data?.revision ?? 0,
      classModelAcknowledged: true,
    }),
    onSuccess: async (data) => {
      setRevisionConflict(false);
      queryClient.setQueryData(MIGRATION_QUERY_KEY, data);
      // Leave the now-ineligible legacy setup tab before refreshing the shared
      // class query. Otherwise SetupView can normalize its stale tab URL and
      // race the intended post-cutover navigation.
      navigate("/passpilot/classes", { replace: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["passpilot", "class-students"] }),
        queryClient.invalidateQueries({ queryKey: ["students"] }),
      ]);
      toast({
        title: "PassPilot now uses ClassPilot classes",
        description: "Official ClassPilot rosters and teacher assignments are now authoritative.",
      });
    },
    onError: (error) => {
      if (isRevisionConflict(error)) {
        setRevisionConflict(true);
        return;
      }
      toast({
        title: "Class source wasn’t changed",
        description: apiErrorMessage(error, "Resolve the remaining blockers and try again."),
        variant: "destructive",
      });
    },
  });

  const migration = migrationQuery.data;
  const officialClasses = migration?.canonicalClasses ?? EMPTY_LIST;
  const migrationItems = migration?.items ?? EMPTY_LIST;
  const unresolvedItems = useMemo(
    () => migrationItems.filter((item) => !isResolvedMigrationItem(item, officialClasses)),
    [migrationItems, officialClasses],
  );
  const activePassTotal = useMemo(
    () => migrationItems.reduce((total, item) => total + item.activePassCount, 0),
    [migrationItems],
  );
  const hasOpenOrDirtyDecisions = migrationItems.some((item) => {
    const savedClassId = item.selectedClassId ?? NONE;
    const draftClassId = selections[item.id];
    return editingDecisions[item.id] === true
      || (draftClassId !== undefined && draftClassId !== savedClassId);
  });
  const isComplete = isCanonicalPassPilotSource(migration?.source);
  const completionBlocked = unresolvedItems.length > 0
    || activePassTotal > 0
    || officialClasses.length === 0
    || hasOpenOrDirtyDecisions
    || revisionConflict;

  return (
    <div className="space-y-5 pt-4" data-testid="passpilot-class-source-setup">
      <Card className="overflow-hidden border-amber-300/80 dark:border-amber-800">
        <div className="h-1 bg-amber-400" aria-hidden="true" />
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Choose where PassPilot classes are managed</CardTitle>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                {isComplete
                  ? "PassPilot now reads official classes, teachers, and roster membership directly from ClassPilot."
                  : "Review every legacy PassPilot class before switching. ClassPilot membership—not grade level—will become authoritative."}
              </p>
            </div>
            <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
              isComplete
                ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100"
                : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            }`}>
              <span className={`h-2 w-2 rounded-full ${isComplete ? "bg-green-500" : "bg-amber-500"}`} aria-hidden="true" />
              {isComplete ? "Managed in ClassPilot" : "Legacy PassPilot classes"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 border-t bg-muted/20 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold tabular-nums text-foreground">{officialClasses.length}</span>{" "}
            active official {officialClasses.length === 1 ? "class" : "classes"} in ClassPilot
          </p>
          {canLinkToClassPilot ? (
            <Button asChild variant="outline">
              <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fsetup%3Fsection%3Dclass-source">
                Manage official classes
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <p className="text-sm font-medium text-muted-foreground">Open SchoolPilot on the web to manage ClassPilot classes.</p>
          )}
        </CardContent>
      </Card>

      {migrationQuery.isLoading ? (
        <Card>
          <CardContent className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading class comparison…
          </CardContent>
        </Card>
      ) : migrationQuery.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex min-h-44 flex-col items-center justify-center p-6 text-center">
            <AlertCircle className="mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
            <h3 className="font-semibold">Class comparison couldn’t be loaded</h3>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              {apiErrorMessage(migrationQuery.error, "No migration decisions were changed.")}
            </p>
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
              <h3 className="font-semibold">ClassPilot is the live class source</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Refreshing PassPilot reloads current ClassPilot membership. Historical PassPilot classes remain available in reports.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {revisionConflict ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100" role="alert">
              <p className="font-semibold">This review changed in another session</p>
              <p className="mt-1">Your local class choices remain visible, but you must load the latest revision before saving.</p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={refreshReview}>
                Load latest revision
              </Button>
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Legacy-to-official class ledger</CardTitle>
              <p className="text-sm text-muted-foreground">
                Confirm an official target for every legacy class, or preserve the legacy class for history only. No student record or pass history is copied or deleted.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {migrationItems.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <p className="font-medium">No legacy classes need mapping</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {officialClasses.length === 0
                      ? "Create at least one official ClassPilot class before completing the switch."
                      : "There are no legacy class decisions to review. Confirm client readiness below to complete the switch."}
                  </p>
                </div>
              ) : migrationItems.map((item) => {
                const selectedClassId = selections[item.id]
                  ?? item.selectedClassId
                  ?? item.suggestedClassId
                  ?? NONE;
                const selectedTarget = officialClasses.find((candidate) => candidate.id === selectedClassId);
                const selectedComparison = item.comparisons.find(
                  (comparison) => comparison.classpilotGroupId === selectedClassId,
                ) || (item.comparison?.classpilotGroupId === selectedClassId ? item.comparison : null);
                const rosterDifferences = differenceCount(selectedComparison, "roster");
                const teacherDifferences = differenceCount(selectedComparison, "teacher");
                const hasDifferences = rosterDifferences + teacherDifferences > 0;
                const acknowledgementKey = `${item.id}:${selectedClassId}`;
                const differencesAcknowledged = !hasDifferences || differenceAcknowledgements[acknowledgementKey] === true;
                const resolved = isResolvedMigrationItem(item, officialClasses);
                const showEditor = !resolved || editingDecisions[item.id] === true;
                const isKioskClass = migration.kioskGradeId === item.id;
                const historyBlocked = item.activePassCount > 0 || isKioskClass;
                const teacherText = Array.isArray(item.teacherNames) && item.teacherNames.length > 0
                  ? item.teacherNames.join(", ")
                  : `${item.teacherCount} ${item.teacherCount === 1 ? "teacher" : "teachers"}`;
                const comparisonGroups = selectedComparison ? [
                  { key: "roster-added", label: "Only in ClassPilot", members: selectedComparison.rosterAdded || [] },
                  { key: "roster-removed", label: "Only in legacy PassPilot", members: selectedComparison.rosterRemoved || [] },
                  { key: "teachers-added", label: "Teachers only in ClassPilot", members: selectedComparison.teacherAdded || [] },
                  { key: "teachers-removed", label: "Teachers only in legacy PassPilot", members: selectedComparison.teacherRemoved || [] },
                ].filter((group) => group.members.length > 0) : [];

                return (
                  <section
                    key={item.id}
                    className="overflow-hidden rounded-xl border bg-background"
                    aria-labelledby={`legacy-class-${item.id}`}
                  >
                    <div className="grid gap-0 lg:grid-cols-[minmax(0,0.85fr)_minmax(360px,1.15fr)]">
                      <div className="border-b bg-muted/25 p-4 lg:border-b-0 lg:border-r">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 id={`legacy-class-${item.id}`} className="break-words font-semibold">{item.name}</h4>
                          <span className="rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
                            {statusLabel(item, officialClasses)}
                          </span>
                          {isKioskClass ? (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-900 dark:bg-blue-950 dark:text-blue-100">Kiosk class</span>
                          ) : null}
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          {item.studentCount} {item.studentCount === 1 ? "student" : "students"} · {teacherText}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.activePassCount} active · {item.historicalPassCount} historical {item.historicalPassCount === 1 ? "pass" : "passes"}
                        </p>
                        {item.conflictReasons.length > 0 ? (
                          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-amber-900 dark:text-amber-200">
                            {item.conflictReasons.map((reason) => (
                              <li key={reason}>{CONFLICT_REASON_LABELS[reason] || String(reason).replaceAll("_", " ")}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>

                      <div className="p-4">
                        {resolved && !showEditor ? (
                          <div className="flex min-h-24 flex-col justify-between gap-3 sm:flex-row sm:items-center">
                            <div>
                              <p className="font-medium text-green-700 dark:text-green-300">
                                {item.migrationState === "confirmed"
                                  ? `Linked to ${selectedTarget?.name || "an official ClassPilot class"}`
                                  : "Preserved for historical reports only"}
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">This decision is saved at revision {item.mappingRevision ?? migration.revision}.</p>
                            </div>
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
                          <div className="space-y-3">
                            <div className="space-y-1.5">
                              <Label htmlFor={`class-match-${item.id}`}>Official ClassPilot target</Label>
                              <Select
                                value={selectedClassId}
                                onValueChange={(value) => {
                                  setSelections((current) => ({ ...current, [item.id]: value }));
                                  setDifferenceAcknowledgements((current) => ({ ...current, [`${item.id}:${value}`]: false }));
                                }}
                              >
                                <SelectTrigger id={`class-match-${item.id}`}>
                                  <SelectValue placeholder="Choose an official class" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>Choose an official class</SelectItem>
                                  {officialClasses.map((candidate) => (
                                    <SelectItem key={candidate.id} value={candidate.id}>
                                      {candidate.name} · {candidate.studentCount} students
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {item.autoLinkEligible && selectedClassId === item.suggestedClassId ? (
                                <p className="text-xs font-medium text-green-700 dark:text-green-300">Exact name, roster, and teacher match suggested. Confirm it to save the decision.</p>
                              ) : null}
                            </div>

                            {selectedTarget ? (
                              <div className="rounded-lg border bg-muted/20 p-3 text-sm" data-testid={`class-comparison-${item.id}`}>
                                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                                  <span className="text-muted-foreground">Legacy PassPilot</span>
                                  <span className="text-right tabular-nums">{item.studentCount} students · {item.teacherCount} teachers</span>
                                  <span className="truncate font-medium">{selectedTarget.name}</span>
                                  <span className="text-right tabular-nums">{selectedTarget.studentCount} students · {Number(selectedTarget.teacherCount ?? 0)} teachers</span>
                                </div>
                                <div className={`mt-3 rounded-md px-3 py-2 text-xs font-semibold ${
                                  hasDifferences
                                    ? "bg-amber-100 text-amber-950 dark:bg-amber-950/60 dark:text-amber-100"
                                    : "bg-green-100 text-green-900 dark:bg-green-950/50 dark:text-green-100"
                                }`}>
                                  {hasDifferences
                                    ? `${rosterDifferences} roster and ${teacherDifferences} teacher differences`
                                    : "Roster and teacher assignments match"}
                                </div>
                                {comparisonGroups.length > 0 ? (
                                  <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2" data-testid={`class-comparison-details-${item.id}`}>
                                    {comparisonGroups.map((group) => (
                                      <div key={group.key}>
                                        <p className="text-xs font-semibold">{group.label}</p>
                                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                                          {group.members.map((member) => <li key={member.id}>{memberLabel(member)}</li>)}
                                        </ul>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            {hasDifferences ? (
                              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                                <Checkbox
                                  checked={differenceAcknowledgements[acknowledgementKey] === true}
                                  onCheckedChange={(checked) => setDifferenceAcknowledgements((current) => ({
                                    ...current,
                                    [acknowledgementKey]: checked === true,
                                  }))}
                                  aria-label={`Acknowledge roster differences for ${item.name}`}
                                />
                                <span>At cutover, the selected ClassPilot roster and teachers replace this legacy class for all future PassPilot activity.</span>
                              </label>
                            ) : null}

                            <div className="flex flex-wrap gap-2">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={!selectedTarget || !differencesAcknowledged || decisionMutation.isPending || revisionConflict}
                                  >
                                    Confirm official class
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Use {selectedTarget?.name || "this official class"} for {item.name}?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      ClassPilot membership and teacher assignments will control future PassPilot activity after the school completes cutover. Existing passes remain unchanged.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => decisionMutation.mutate({
                                      item,
                                      action: "link",
                                      classpilotGroupId: selectedClassId,
                                    })}>
                                      Confirm class link
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>

                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button type="button" size="sm" variant="outline" disabled={historyBlocked || decisionMutation.isPending || revisionConflict}>
                                    <History className="mr-2 h-4 w-4" aria-hidden="true" />
                                    Keep as history only
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Keep {item.name} for reports only?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Teachers will not use this legacy class for new passes after cutover. Its existing passes and report labels remain unchanged.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => decisionMutation.mutate({ item, action: "history_only" })}>
                                      Preserve history only
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>

                              {canLinkToClassPilot ? (
                                <Button asChild type="button" size="sm" variant="ghost">
                                  <Link to="/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fsetup%3Fsection%3Dclass-source">
                                    Fix roster in ClassPilot
                                  </Link>
                                </Button>
                              ) : null}
                              {resolved ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => discardItemDraft(item.id)}
                                >
                                  Cancel change
                                </Button>
                              ) : null}
                            </div>
                            {historyBlocked ? (
                              <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                                {isKioskClass
                                  ? "This class is selected by the kiosk and must link to an official class before cutover."
                                  : "End its active passes before preserving this class for history only."}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                );
              })}
            </CardContent>
          </Card>

          <Card className={completionBlocked ? "border-muted" : "border-green-300 dark:border-green-800"}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                Final cutover
              </CardTitle>
              <p className="text-sm text-muted-foreground">This changes the school’s live PassPilot class source and cannot be undone from Setup.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {unresolvedItems.length > 0 ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                  Review {unresolvedItems.length} remaining {unresolvedItems.length === 1 ? "class" : "classes"} before cutover.
                </p>
              ) : null}
              {activePassTotal > 0 ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                  End {activePassTotal} active legacy {activePassTotal === 1 ? "pass" : "passes"} before cutover.
                </p>
              ) : null}
              {officialClasses.length === 0 ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                  Create an active official ClassPilot class before cutover.
                </p>
              ) : null}

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox checked={reviewConfirmed} onCheckedChange={(checked) => setReviewConfirmed(checked === true)} />
                <span>I reviewed every mapping and understand that ClassPilot rosters and teachers become authoritative.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox checked={clientsReady} onCheckedChange={(checked) => setClientsReady(checked === true)} />
                <span>I confirmed the SchoolPilot web app, PassPilot Android app, and kiosks are updated for ClassPilot classes.</span>
              </label>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    disabled={completionBlocked || !reviewConfirmed || !clientsReady || completeMutation.isPending}
                  >
                    {completeMutation.isPending ? "Switching class source…" : "Switch to ClassPilot classes"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Make ClassPilot the live class source?</AlertDialogTitle>
                    <AlertDialogDescription>
                      PassPilot will immediately use official ClassPilot classes, rosters, and teacher assignments. Legacy class history remains in reports, but this cutover cannot be reversed here.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => completeMutation.mutate()}>
                      Confirm irreversible cutover
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
