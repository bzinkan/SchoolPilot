import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Clock3,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import {
  allowedActions,
  changeLegs,
  classId,
  className,
  effectiveWindow,
  formatSchoolDate,
  formatWindow,
  isRevisionConflict,
  originalWindow,
  pairClasses,
  pairPreviewLegs,
  scheduleChangeApi,
  scheduleChangeError,
  scheduleChangeKeys,
  schoolLocalDate,
  teacherName,
  unwrapEligibility,
} from "../lib/scheduleChanges";

const STATUS_PRESENTATION = {
  pending_counterpart: { label: "Teacher response needed", className: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200" },
  pending_admin: { label: "Admin review needed", className: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" },
  approved: { label: "Approved", className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" },
  applied: { label: "In effect", className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" },
  completed: { label: "Completed", className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  declined: { label: "Declined", className: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" },
  denied: { label: "Denied", className: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" },
  cancelled: { label: "Cancelled", className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  expired: { label: "Expired", className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  superseded: { label: "Needs a new request", className: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200" },
};

const ACTION_LABELS = {
  accept: "Accept",
  decline: "Decline",
  approve: "Approve",
  deny: "Deny",
  withdraw: "Withdraw",
  cancel: "Cancel change",
};

const DESTRUCTIVE_ACTIONS = new Set(["decline", "deny", "withdraw", "cancel"]);

export function SchedulePageHeader({ eyebrow, title, description, actions, children }) {
  return (
    <>
      <header className="relative overflow-hidden border-b border-slate-700 bg-slate-900 text-white">
        <div className="absolute inset-x-0 top-0 h-0.5 bg-amber-400" aria-hidden="true" />
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-7 sm:px-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-amber-300">{eyebrow}</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{description}</p>
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        </div>
      </header>
      <div className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 pt-3 sm:px-6">{children}</div>
      </div>
    </>
  );
}

function ScheduleWindow({ label, window, emphasized = false }) {
  return (
    <div className={`min-w-0 rounded-md border px-3 py-2 ${
      emphasized
        ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
        : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
    }`}>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">{formatWindow(window)}</p>
    </div>
  );
}

export function TimetablePreview({ legs, compact = false }) {
  if (!Array.isArray(legs) || legs.length !== 2) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-950/30">
      {legs.map((leg, index) => (
        <div
          key={classId(leg) || index}
          className={`grid items-center gap-3 px-3 py-3 sm:grid-cols-[minmax(130px,1fr)_minmax(125px,0.75fr)_24px_minmax(125px,0.75fr)] ${
            index === 0 ? "border-b border-slate-200 dark:border-slate-700" : ""
          }`}
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{className(leg)}</p>
            {!compact ? <p className="truncate text-xs text-muted-foreground">{teacherName(leg)}</p> : null}
          </div>
          <ScheduleWindow label="Normal" window={originalWindow(leg)} />
          <ArrowRight className="mx-auto hidden h-4 w-4 text-amber-600 sm:block" aria-hidden="true" />
          <ScheduleWindow label="Event day" window={effectiveWindow(leg)} emphasized />
        </div>
      ))}
    </div>
  );
}

export function ScheduleChangeEmpty({ title, description }) {
  return (
    <div className="border-y border-dashed border-slate-300 px-4 py-10 text-center dark:border-slate-700">
      <CalendarClock className="mx-auto h-7 w-7 text-slate-400" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function ScheduleChangeSection({ title, description, count, children, testId }) {
  return (
    <section aria-labelledby={`${testId}-heading`} data-testid={testId}>
      <div className="mb-3 flex items-end justify-between gap-3 border-b border-slate-300 pb-2 dark:border-slate-700">
        <div>
          <h2 id={`${testId}-heading`} className="text-lg font-semibold text-slate-950 dark:text-slate-50">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        <span className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  );
}

function ConfirmActionDialog({ action, change, open, onOpenChange, onConfirm, pending }) {
  const classNames = changeLegs(change).map(className).join(" and ");
  const destructive = DESTRUCTIVE_ACTIONS.has(action);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ACTION_LABELS[action]}?</DialogTitle>
          <DialogDescription>
            {action === "cancel"
              ? `${classNames || "These classes"} will return to their normal times on ${formatSchoolDate(change?.scheduledDate)}.`
              : `${ACTION_LABELS[action]} this one-day time swap for ${classNames || "the paired classes"}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Keep change</Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
            data-testid={`button-confirm-${action}-${change?.id}`}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {ACTION_LABELS[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduleChangeRow({ change, onAction, pendingAction }) {
  const [confirmAction, setConfirmAction] = useState(null);
  const status = STATUS_PRESENTATION[change?.status] ?? {
    label: String(change?.status || "Pending").replaceAll("_", " "),
    className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  };
  const actions = allowedActions(change);
  const legs = changeLegs(change);

  const submitAction = (action) => {
    if (DESTRUCTIVE_ACTIONS.has(action)) {
      setConfirmAction(action);
      return;
    }
    onAction(change, action);
  };

  return (
    <article className="border-b border-slate-200 py-5 last:border-b-0 dark:border-slate-800" data-testid={`schedule-change-${change.id}`}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-950 dark:text-slate-50">{formatSchoolDate(change.scheduledDate)}</p>
            <Badge variant="outline" className={status.className}>{status.label}</Badge>
          </div>
          {change.reason ? <p className="mt-1 text-sm text-muted-foreground">{change.reason}</p> : null}
        </div>
        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={DESTRUCTIVE_ACTIONS.has(action) ? "outline" : "default"}
                onClick={() => submitAction(action)}
                disabled={Boolean(pendingAction)}
                data-testid={`button-${action}-${change.id}`}
              >
                {pendingAction === action ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {action === "accept" || action === "approve" ? <Check className="mr-2 h-4 w-4" /> : null}
                {action === "decline" || action === "deny" ? <X className="mr-2 h-4 w-4" /> : null}
                {action === "withdraw" ? <RotateCcw className="mr-2 h-4 w-4" /> : null}
                {ACTION_LABELS[action] || action}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <TimetablePreview legs={legs} />
      {change.requestedByName || change.requesterName ? (
        <p className="mt-2 text-xs text-muted-foreground">Requested by {change.requestedByName || change.requesterName}</p>
      ) : null}
      {confirmAction ? (
        <ConfirmActionDialog
          action={confirmAction}
          change={change}
          open
          onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
          onConfirm={() => onAction(change, confirmAction, () => setConfirmAction(null))}
          pending={pendingAction === confirmAction}
        />
      ) : null}
    </article>
  );
}

export function ScheduleChangeRequestDialog({
  open,
  onOpenChange,
  schoolId,
  timeZone,
  mode = "teacher",
  onSubmit,
  isPending,
}) {
  const [scheduledDate, setScheduledDate] = useState("");
  const [pairId, setPairId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const minimumDate = schoolLocalDate(timeZone);

  const eligibilityQuery = useQuery({
    queryKey: scheduleChangeKeys.eligibility(schoolId, scheduledDate),
    queryFn: () => scheduleChangeApi.getEligibility(scheduledDate),
    select: unwrapEligibility,
    enabled: open && Boolean(schoolId && scheduledDate),
    refetchInterval: open && scheduledDate ? 30_000 : false,
  });

  const eligiblePairs = useMemo(
    () => eligibilityQuery.data?.eligiblePairs ?? [],
    [eligibilityQuery.data?.eligiblePairs],
  );
  const selectedPair = useMemo(
    () => eligiblePairs.find((pair) => String(pair.id ?? pair.pairId) === String(pairId)) || null,
    [eligiblePairs, pairId],
  );
  const previewLegs = selectedPair
    ? (selectedPair.legs?.length === 2 ? selectedPair.legs : pairPreviewLegs(selectedPair))
    : [];

  const reset = () => {
    setScheduledDate("");
    setPairId("");
    setReason("");
    setError("");
  };

  const changeOpen = (nextOpen) => {
    if (!nextOpen && !isPending) reset();
    onOpenChange(nextOpen);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!selectedPair || !scheduledDate || !reason.trim()) return;
    setError("");
    try {
      await onSubmit({
        pairId: selectedPair.id ?? selectedPair.pairId,
        scheduledDate,
        reason: reason.trim(),
      });
      reset();
      onOpenChange(false);
    } catch (submitError) {
      setError(isRevisionConflict(submitError)
        ? "This schedule changed while you were reviewing it. Your date and reason are still here; refresh the eligible pairs and try again."
        : scheduleChangeError(submitError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="dialog-schedule-change-request">
        <DialogHeader>
          <DialogTitle>{mode === "admin" ? "Create approved schedule change" : "Request time swap"}</DialogTitle>
          <DialogDescription>
            Choose one school day and exchange the two class periods. Teachers, rosters, and recurring schedules stay the same.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-change-date">School day</Label>
              <Input
                id="schedule-change-date"
                type="date"
                min={minimumDate}
                value={scheduledDate}
                onChange={(event) => { setScheduledDate(event.target.value); setPairId(""); setError(""); }}
                required
                data-testid="input-schedule-change-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-change-pair">Class pair</Label>
              <Select value={pairId} onValueChange={(value) => { setPairId(value); setError(""); }} disabled={!scheduledDate || eligibilityQuery.isLoading}>
                <SelectTrigger id="schedule-change-pair" data-testid="select-schedule-change-pair">
                  <SelectValue placeholder={scheduledDate ? "Choose two classes" : "Choose a date first"} />
                </SelectTrigger>
                <SelectContent>
                  {eligiblePairs.map((pair) => {
                    const classes = pairClasses(pair);
                    return (
                      <SelectItem key={pair.id ?? pair.pairId} value={String(pair.id ?? pair.pairId)}>
                        {classes.map(className).join(" ↔ ")}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          {eligibilityQuery.isLoading ? (
            <div className="flex items-center gap-2 border-y py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking that day’s schedule…
            </div>
          ) : eligibilityQuery.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {scheduleChangeError(eligibilityQuery.error, "Eligibility could not be checked.")}
              <Button type="button" variant="link" className="ml-2 h-auto p-0" onClick={() => eligibilityQuery.refetch()}>Try again</Button>
            </div>
          ) : scheduledDate && eligiblePairs.length === 0 ? (
            <div className="border-y border-dashed py-4 text-sm text-muted-foreground">
              No eligible class pairs are available on this date. Class times may conflict, the date may be closed, or the request cutoff may have passed.
            </div>
          ) : null}

          {previewLegs.length === 2 ? (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Clock3 className="h-4 w-4 text-amber-600" aria-hidden="true" />
                Review event-day times
              </div>
              <TimetablePreview legs={previewLegs} />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="schedule-change-reason">Reason</Label>
            <Textarea
              id="schedule-change-reason"
              value={reason}
              onChange={(event) => { setReason(event.target.value); setError(""); }}
              maxLength={500}
              placeholder="e.g., Grade-level assembly changes the Math and ELA rotation."
              className="min-h-24 resize-y"
              required
              data-testid="textarea-schedule-change-reason"
            />
            <p className="text-xs text-muted-foreground">Visible to the affected teachers and school administrators.</p>
          </div>

          {error ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="schedule-change-submit-error">
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => eligibilityQuery.refetch()}
                disabled={eligibilityQuery.isFetching}
                data-testid="button-refresh-schedule-eligibility"
              >
                {eligibilityQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Refresh eligible pairs
              </Button>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={!selectedPair || !reason.trim() || isPending} data-testid="button-submit-schedule-change">
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {mode === "admin" ? "Create approved change" : "Send request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
