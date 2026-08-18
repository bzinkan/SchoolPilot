import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarPlus,
  Link2,
  Loader2,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { apiRequest } from "../../../lib/queryClient";
import { AdminClassesTabs } from "../components/ScheduleRouteTabs";
import {
  ScheduleChangeEmpty,
  ScheduleChangeRequestDialog,
  ScheduleChangeRow,
  ScheduleChangeSection,
  SchedulePageHeader,
} from "../components/ScheduleChangeUI";
import { useScheduleChangeRefresh } from "../hooks/useScheduleChangeRefresh";
import {
  classId,
  className,
  formatWindow,
  invalidateScheduleChanges,
  isRevisionConflict,
  originalWindow,
  pairClasses,
  scheduleChangeApi,
  scheduleChangeError,
  scheduleChangeKeys,
  teacherName,
  unwrapChanges,
  unwrapPairs,
} from "../lib/scheduleChanges";

const EMPTY = Object.freeze([]);

function PairDialog({ open, onOpenChange, classes, onSubmit, pending }) {
  const [firstGroupId, setFirstGroupId] = useState("");
  const [secondGroupId, setSecondGroupId] = useState("");
  const [error, setError] = useState("");
  const sortedClasses = useMemo(
    () => [...classes].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [classes],
  );

  const reset = () => {
    setFirstGroupId("");
    setSecondGroupId("");
    setError("");
  };
  const changeOpen = (nextOpen) => {
    if (!nextOpen && !pending) reset();
    onOpenChange(nextOpen);
  };
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    try {
      await onSubmit({ firstGroupId, secondGroupId });
      reset();
      onOpenChange(false);
    } catch (submitError) {
      setError(scheduleChangeError(submitError, "This class pair could not be enabled."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent data-testid="dialog-schedule-pair">
        <DialogHeader>
          <DialogTitle>Enable a class pair</DialogTitle>
          <DialogDescription>
            Teachers can request one-day swaps only between pairs enabled here. Both classes must have active automatic schedules.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="schedule-pair-first">First class</Label>
            <Select value={firstGroupId} onValueChange={(value) => { setFirstGroupId(value); setError(""); }}>
              <SelectTrigger id="schedule-pair-first" data-testid="select-schedule-pair-first"><SelectValue placeholder="Choose a class" /></SelectTrigger>
              <SelectContent>
                {sortedClasses.map((group) => (
                  <SelectItem key={group.id} value={String(group.id)} disabled={String(group.id) === secondGroupId}>
                    {group.name} · {formatWindow(originalWindow(group))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="schedule-pair-second">Second class</Label>
            <Select value={secondGroupId} onValueChange={(value) => { setSecondGroupId(value); setError(""); }}>
              <SelectTrigger id="schedule-pair-second" data-testid="select-schedule-pair-second"><SelectValue placeholder="Choose a class" /></SelectTrigger>
              <SelectContent>
                {sortedClasses.map((group) => (
                  <SelectItem key={group.id} value={String(group.id)} disabled={String(group.id) === firstGroupId}>
                    {group.name} · {formatWindow(originalWindow(group))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!firstGroupId || !secondGroupId || pending} data-testid="button-enable-schedule-pair">
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              Enable pair
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeletePairDialog({ pair, open, onOpenChange, onConfirm, pending }) {
  const names = pairClasses(pair).map(className).join(" and ");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable this class pair?</DialogTitle>
          <DialogDescription>
            Teachers will no longer be able to request new swaps between {names || "these classes"}. Pending requests will be superseded; cancel any approved future change before disabling the pair.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Keep pair</Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending} data-testid="button-confirm-disable-pair">
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Disable pair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueryContent({ query, emptyTitle, emptyDescription, onAction, pendingAction }) {
  const changes = query.data ?? EMPTY;
  if (query.isLoading) {
    return <div className="flex items-center justify-center gap-2 border-y py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading schedule changes…</div>;
  }
  if (query.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
        {scheduleChangeError(query.error, "Schedule changes could not be loaded.")}
        <Button type="button" variant="link" className="ml-2 h-auto p-0 text-destructive" onClick={() => query.refetch()}>Try again</Button>
      </div>
    );
  }
  if (changes.length === 0) return <ScheduleChangeEmpty title={emptyTitle} description={emptyDescription} />;
  return changes.map((change) => (
    <ScheduleChangeRow key={change.id} change={change} onAction={onAction} pendingAction={pendingAction(change)} />
  ));
}

export default function AdminScheduleChanges() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser, school, isAdmin, isLoading, token } = useClassPilotAuth();
  const [requestOpen, setRequestOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [deletePair, setDeletePair] = useState(null);
  const schoolId = school?.id || currentUser?.schoolId || null;
  const canManage = isAdmin || currentUser?.isSuperAdmin === true;
  const canView = canManage || currentUser?.role === "office_staff";

  useScheduleChangeRefresh({ schoolId, token, currentUser, enabled: canView });

  const pairsQuery = useQuery({
    queryKey: scheduleChangeKeys.pairs(schoolId),
    queryFn: scheduleChangeApi.getPairs,
    select: unwrapPairs,
    enabled: Boolean(schoolId && canView),
  });
  const classesQuery = useQuery({
    queryKey: scheduleChangeKeys.classes(schoolId),
    queryFn: () => apiRequest("GET", "/classpilot/admin/classes?status=active"),
    select: (data) => (data?.classes ?? []).filter((group) => (
      group.scheduleEnabled === true && group.blockStartTime && group.blockEndTime
    )),
    enabled: Boolean(schoolId && canManage && pairOpen),
  });
  const needsActionQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "needs_action"),
    queryFn: () => scheduleChangeApi.getChanges("needs_action"),
    select: unwrapChanges,
    enabled: Boolean(schoolId && canView),
    refetchInterval: 30_000,
  });
  const upcomingQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "upcoming"),
    queryFn: () => scheduleChangeApi.getChanges("upcoming"),
    select: unwrapChanges,
    enabled: Boolean(schoolId && canView),
    refetchInterval: 30_000,
  });
  const historyQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "history"),
    queryFn: () => scheduleChangeApi.getChanges("history"),
    select: unwrapChanges,
    enabled: Boolean(schoolId && canView),
  });

  const createMutation = useMutation({
    mutationFn: (payload) => scheduleChangeApi.createChange({ ...payload, directApprove: true }),
    onSuccess: async () => {
      await invalidateScheduleChanges(schoolId);
      toast({ title: "Schedule change approved", description: "Both classes will use the exchanged times on the selected school day." });
    },
  });
  const createPairMutation = useMutation({
    mutationFn: scheduleChangeApi.createPair,
    onSuccess: async () => {
      await invalidateScheduleChanges(schoolId);
      toast({ title: "Class pair enabled", description: "The paired teachers can now request one-day time swaps." });
    },
  });
  const deletePairMutation = useMutation({
    mutationFn: (pair) => scheduleChangeApi.deletePair(pair.id ?? pair.pairId, pair.revision),
    onSuccess: async () => {
      setDeletePair(null);
      await invalidateScheduleChanges(schoolId);
      toast({ title: "Class pair disabled" });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Pair could not be disabled", description: scheduleChangeError(error) });
      if (isRevisionConflict(error)) void invalidateScheduleChanges(schoolId);
    },
  });
  const actionMutation = useMutation({
    mutationFn: ({ change, action }) => scheduleChangeApi.actOnChange(change.id, action, change.revision),
    onSuccess: async (_data, variables) => {
      variables.onDone?.();
      await invalidateScheduleChanges(schoolId);
      toast({ title: variables.action === "approve" ? "Schedule change approved" : variables.action === "cancel" ? "Schedule change cancelled" : "Schedule change updated" });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: isRevisionConflict(error) ? "Schedule change updated elsewhere" : "Action failed",
        description: isRevisionConflict(error) ? "The latest version has been loaded for review." : scheduleChangeError(error),
      });
      void invalidateScheduleChanges(schoolId);
    },
  });

  const performAction = (change, action, onDone) => actionMutation.mutate({ change, action, onDone });
  const pendingAction = (change) => actionMutation.isPending && actionMutation.variables?.change?.id === change.id
    ? actionMutation.variables.action
    : null;

  if (isLoading) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!canView) {
    return (
      <div className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-muted-foreground">Schedule Change administration is available to school administrators and office staff.</p>
        <Button className="mt-5" variant="outline" onClick={() => navigate("/classpilot")}><ArrowLeft className="mr-2 h-4 w-4" /> Dashboard</Button>
      </div>
    );
  }

  const pairs = pairsQuery.data ?? EMPTY;

  return (
    <div className="min-h-screen bg-muted/30">
      <SchedulePageHeader
        eyebrow="Class Management"
        title="Schedule Changes"
        description="Approve and coordinate one-day class-time swaps without changing recurring schedules or rosters."
        actions={(
          <>
            <ThemeToggle />
            <Button type="button" variant="outline" className="border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 hover:text-white" onClick={() => navigate("/classpilot/admin")}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Admin Panel
            </Button>
            {canManage ? (
              <Button type="button" className="bg-amber-400 text-slate-950 hover:bg-amber-300" onClick={() => setRequestOpen(true)} data-testid="button-admin-create-schedule-change">
                <CalendarPlus className="mr-2 h-4 w-4" /> Create schedule change
              </Button>
            ) : null}
          </>
        )}
      >
        <AdminClassesTabs canManageClasses={canManage} />
      </SchedulePageHeader>

      <main className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6">
        <section aria-labelledby="eligible-pairs-heading" data-testid="schedule-pairs">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-slate-300 pb-2 dark:border-slate-700">
            <div>
              <h2 id="eligible-pairs-heading" className="text-lg font-semibold">Eligible class pairs</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Enable the two scheduled classes that may exchange time windows.</p>
            </div>
            <div className="flex gap-2">
              {canManage ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setPairOpen(true)} data-testid="button-add-schedule-pair">
                  <Plus className="mr-2 h-4 w-4" /> Enable pair
                </Button>
              ) : null}
              {canManage ? (
                <Button type="button" variant="outline" size="sm" onClick={() => navigate("/classpilot/settings#schedule-changes")}>
                  <Settings2 className="mr-2 h-4 w-4" /> Policy
                </Button>
              ) : null}
            </div>
          </div>
          {pairsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading class pairs…</div>
          ) : pairsQuery.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{scheduleChangeError(pairsQuery.error)}</div>
          ) : pairs.length === 0 ? (
            <ScheduleChangeEmpty title="No eligible pairs enabled" description="Enable a pair before teachers can request a one-day time swap." />
          ) : (
            <div className="divide-y divide-slate-200 border-y dark:divide-slate-800 dark:border-slate-800">
              {pairs.map((pair) => {
                const classes = pairClasses(pair);
                return (
                  <div key={pair.id ?? pair.pairId} className="grid gap-3 py-4 sm:grid-cols-[1fr_32px_1fr_auto] sm:items-center" data-testid={`schedule-pair-${pair.id ?? pair.pairId}`}>
                    {classes.map((group, index) => (
                      <div key={classId(group) || index} className={index === 1 ? "sm:col-start-3" : ""}>
                        <p className="font-semibold">{className(group)}</p>
                        <p className="text-xs text-muted-foreground">{teacherName(group)} · {formatWindow(originalWindow(group))}</p>
                      </div>
                    ))}
                    <div className="hidden text-center font-mono text-amber-600 sm:col-start-2 sm:row-start-1 sm:block" aria-hidden="true">↔</div>
                    {canManage ? (
                      <Button type="button" variant="ghost" size="icon" className="sm:col-start-4 sm:row-start-1" onClick={() => setDeletePair(pair)} aria-label={`Disable pair ${classes.map(className).join(" and ")}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <ScheduleChangeSection title="Needs Action" description="Teacher-accepted requests waiting for an administrator decision." count={(needsActionQuery.data ?? EMPTY).length} testId="admin-schedule-needs-action">
          <QueryContent query={needsActionQuery} emptyTitle="Nothing needs review" emptyDescription="Teacher-accepted requests will appear here." onAction={performAction} pendingAction={pendingAction} />
        </ScheduleChangeSection>
        <ScheduleChangeSection title="Upcoming" description="Approved changes and requests still moving through review." count={(upcomingQuery.data ?? EMPTY).length} testId="admin-schedule-upcoming">
          <QueryContent query={upcomingQuery} emptyTitle="No upcoming changes" emptyDescription="All classes will follow their recurring schedules." onAction={performAction} pendingAction={pendingAction} />
        </ScheduleChangeSection>
        <ScheduleChangeSection title="History" description="Past decisions remain available for operational review." count={(historyQuery.data ?? EMPTY).length} testId="admin-schedule-history">
          <QueryContent query={historyQuery} emptyTitle="No schedule-change history" emptyDescription="Completed and terminal requests will appear here." onAction={performAction} pendingAction={pendingAction} />
        </ScheduleChangeSection>
      </main>

      <PairDialog key={`pair-${schoolId ?? "none"}`} open={pairOpen} onOpenChange={setPairOpen} classes={classesQuery.data ?? EMPTY} onSubmit={(payload) => createPairMutation.mutateAsync(payload)} pending={createPairMutation.isPending} />
      <DeletePairDialog pair={deletePair} open={Boolean(deletePair)} onOpenChange={(open) => { if (!open) setDeletePair(null); }} onConfirm={() => deletePairMutation.mutate(deletePair)} pending={deletePairMutation.isPending} />
      <ScheduleChangeRequestDialog key={`request-${schoolId ?? "none"}`} open={requestOpen} onOpenChange={setRequestOpen} schoolId={schoolId} timeZone={school?.schoolTimezone || school?.timezone} mode="admin" onSubmit={(payload) => createMutation.mutateAsync(payload)} isPending={createMutation.isPending} />
    </div>
  );
}
