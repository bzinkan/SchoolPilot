import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Clock3, Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import { DayPicker, TZDate } from "react-day-picker";

import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
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
import { Skeleton } from "../../../components/ui/skeleton";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { cn } from "../../../lib/utils";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isRealDateKey(value) {
  const match = DATE_PATTERN.exec(value || "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseMonthKey(monthKey) {
  const match = MONTH_PATTERN.exec(monthKey || "");
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function dateFromKey(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new TZDate(year, month - 1, day, 12, timeZone);
}

function monthDateFromKey(monthKey, timeZone) {
  const parsed = parseMonthKey(monthKey);
  return new TZDate(parsed.year, parsed.month - 1, 1, 12, timeZone);
}

function formatMonthKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function monthEndKey(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

function shiftMonthKey(monthKey, amount) {
  const { year, month } = parseMonthKey(monthKey);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1, 12));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isWeekendKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatMonthLabel(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)));
}

function normalizeProjection(value, expectedMonth) {
  if (!value || value.month !== expectedMonth || !parseMonthKey(value.month)) return null;
  if (typeof value.schoolTimezone !== "string" || !value.schoolTimezone.trim()) return null;
  if (!isRealDateKey(value.schoolLocalToday)) return null;
  if (!Number.isInteger(value.revision) || value.revision < 0) return null;
  if (value.updatedAt !== null && typeof value.updatedAt !== "string") return null;
  if (!Array.isArray(value.nonInstructionalDates)) return null;

  const dates = [...new Set(value.nonInstructionalDates)];
  if (
    dates.length !== value.nonInstructionalDates.length
    || dates.some((date) => !isRealDateKey(date) || !date.startsWith(`${expectedMonth}-`) || isWeekendKey(date))
  ) {
    return null;
  }

  return {
    month: value.month,
    schoolTimezone: value.schoolTimezone,
    schoolLocalToday: value.schoolLocalToday,
    nonInstructionalDates: dates.sort(),
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function sameDates(left, right) {
  if (left.length !== right.length) return false;
  return left.every((date, index) => date === right[index]);
}

function sameProjection(left, right) {
  return left.month === right.month
    && left.schoolTimezone === right.schoolTimezone
    && left.revision === right.revision
    && left.updatedAt === right.updatedAt
    && sameDates(left.nonInstructionalDates, right.nonInstructionalDates);
}

function getErrorMessage(error) {
  return error?.response?.data?.error || error?.message || "The calendar request failed.";
}

function SchoolCalendarDayButton({ day, modifiers, className, children, disabled, ...buttonProps }) {
  const buttonRef = useRef(null);
  const dateKey = day.isoDate;
  const isClosure = Boolean(modifiers.nonInstructional);
  const isLocked = disabled || modifiers.past || modifiers.weekend;
  let status = "Automatic classes run";

  if (modifiers.weekend) status = "Weekend · locked";
  else if (isClosure && modifiers.past) status = "No automatic classes · locked";
  else if (modifiers.past) status = "Past date · locked";
  else if (isClosure) status = "No automatic classes";

  const action = isLocked
    ? ""
    : isClosure
      ? " Activate automatic classes for this date."
      : " Mark this date as no automatic classes.";

  useEffect(() => {
    if (modifiers.focused) buttonRef.current?.focus();
  }, [modifiers.focused]);

  return (
    <button
      ref={buttonRef}
      type="button"
      {...buttonProps}
      disabled={disabled}
      className={cn(
        className,
        "group flex min-h-14 w-full flex-col items-start justify-between gap-1 rounded-none p-1.5 text-left text-xs transition-colors sm:min-h-20 sm:p-2 sm:text-sm",
        "focus-visible:relative focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        !isLocked && !isClosure && "hover:bg-sky-50 dark:hover:bg-sky-950/30",
        isClosure && "bg-amber-100 text-amber-950 hover:bg-amber-200 dark:bg-amber-950/45 dark:text-amber-100 dark:hover:bg-amber-900/55",
        isLocked && !isClosure && "cursor-not-allowed bg-muted/35 text-muted-foreground",
        modifiers.today && "outline outline-2 -outline-offset-2 outline-primary",
      )}
      aria-label={`${formatDateLabel(dateKey)}. ${status}.${action}`}
      aria-pressed={isClosure}
      data-testid={`calendar-day-${dateKey}`}
      data-date={dateKey}
    >
      <span className={cn("font-semibold tabular-nums", modifiers.today && "text-primary")}>{children}</span>
      <span className="hidden text-xs font-medium leading-tight sm:block" aria-hidden="true">
        {modifiers.today ? "Today · " : ""}{status.replace(" · locked", "")}
      </span>
      <span
        className={cn(
          "mt-auto h-1 w-5 rounded-full sm:hidden",
          isClosure ? "bg-amber-600 dark:bg-amber-300" : modifiers.today ? "bg-primary" : "bg-transparent",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

const SCHOOL_CALENDAR_COMPONENTS = { DayButton: SchoolCalendarDayButton };

function CalendarLoading() {
  return (
    <Card aria-busy="true" data-testid="school-calendar-loading">
      <CardHeader>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border">
          {Array.from({ length: 35 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-none bg-background" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CalendarLoadError({ error, onRetry }) {
  return (
    <Card className="border-destructive/40" data-testid="school-calendar-load-error">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <CircleAlert className="h-5 w-5" />
          Calendar could not be loaded
        </CardTitle>
        <CardDescription>
          No dates were assumed. Try again before changing automatic scheduling dates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-destructive" role="alert">{getErrorMessage(error)}</p>
        <Button type="button" variant="outline" onClick={onRetry} data-testid="button-retry-calendar-load">
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function LoadedSchoolCalendar({ initialProjection, queryKey, onDirtyChange, onMonthChange }) {
  const { toast } = useToast();
  const [baseline, setBaseline] = useState(initialProjection);
  const [draft, setDraft] = useState(() => new Set(initialProjection.nonInstructionalDates));
  const [saveError, setSaveError] = useState("");
  const [unverifiedProjection, setUnverifiedProjection] = useState(null);
  const [conflictProjection, setConflictProjection] = useState(null);
  const [pendingMonth, setPendingMonth] = useState(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeAction, setRangeAction] = useState("close");
  const [rangeError, setRangeError] = useState("");
  const saveInFlightRef = useRef(false);

  const sortedDraft = useMemo(() => [...draft].sort(), [draft]);
  const dirty = !sameDates(sortedDraft, baseline.nonInstructionalDates);
  const timeZone = baseline.schoolTimezone;
  const firstEditableDate = baseline.schoolLocalToday > `${baseline.month}-01`
    ? baseline.schoolLocalToday
    : `${baseline.month}-01`;
  const lastMonthDate = monthEndKey(baseline.month);
  const hasEditableDate = firstEditableDate <= lastMonthDate;

  useLayoutEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const clearTransientSaveState = () => {
    setSaveError("");
    setConflictProjection(null);
    setUnverifiedProjection(null);
  };

  const adoptProjection = (projection) => {
    queryClient.setQueryData(queryKey, projection);
    setBaseline(projection);
    setDraft(new Set(projection.nonInstructionalDates));
    setSaveError("");
    setConflictProjection(null);
    setUnverifiedProjection(null);
  };

  const saveMutation = useMutation({
    mutationFn: async ({ mode, expectedRevision, dates, candidate }) => {
      let saved = candidate;
      if (mode === "save") {
        const response = await apiRequest(
          "PUT",
          `/classpilot/admin/instructional-calendar/${baseline.month}`,
          { expectedRevision, nonInstructionalDates: dates },
        );
        saved = normalizeProjection(response, baseline.month);
        if (!saved) throw new Error("The server returned an invalid saved calendar.");
        queryClient.setQueryData(queryKey, saved);
      }

      try {
        const response = await apiRequest(
          "GET",
          `/classpilot/admin/instructional-calendar?month=${encodeURIComponent(baseline.month)}`,
        );
        const verified = normalizeProjection(response, baseline.month);
        if (verified && saved && verified.revision > saved.revision) {
          const conflict = new Error("The calendar changed again while this save was being verified.");
          conflict.code = "CALENDAR_SAVE_CONFLICT";
          conflict.currentProjection = verified;
          throw conflict;
        }
        if (!verified || !sameProjection(saved, verified) || !sameDates(verified.nonInstructionalDates, dates)) {
          const mismatch = new Error("Save may have completed but the saved calendar could not be verified. Your draft is still here.");
          mismatch.code = "CALENDAR_SAVE_UNVERIFIED";
          mismatch.savedProjection = saved;
          throw mismatch;
        }
        return verified;
      } catch (error) {
        if (error?.code === "CALENDAR_SAVE_UNVERIFIED" || error?.code === "CALENDAR_SAVE_CONFLICT") throw error;
        const unverified = new Error("Save may have completed but the saved calendar could not be verified. Your draft is still here.");
        unverified.code = "CALENDAR_SAVE_UNVERIFIED";
        unverified.savedProjection = saved;
        unverified.cause = error;
        throw unverified;
      }
    },
    onSuccess: (verified) => {
      adoptProjection(verified);
      toast({
        title: "Calendar saved",
        description: `${formatMonthLabel(verified.month)} was saved and verified.`,
      });
    },
    onError: (error) => {
      const conflict = error?.code === "CALENDAR_SAVE_CONFLICT"
        ? error.currentProjection
        : error?.response?.status === 409
          ? normalizeProjection(error.response?.data?.current, baseline.month)
          : null;
      if (conflict) {
        setConflictProjection(conflict);
        setSaveError("");
        setUnverifiedProjection(null);
        return;
      }
      if (error?.code === "CALENDAR_SAVE_UNVERIFIED") {
        setUnverifiedProjection(error.savedProjection || null);
        setSaveError(error.message);
        return;
      }
      setSaveError(`${getErrorMessage(error)} Your draft is still here.`);
    },
    onSettled: () => {
      saveInFlightRef.current = false;
    },
  });

  const toggleDate = (dateKey) => {
    if (
      saveMutation.isPending
      || dateKey < baseline.schoolLocalToday
      || isWeekendKey(dateKey)
      || !dateKey.startsWith(`${baseline.month}-`)
    ) return;
    clearTransientSaveState();
    setDraft((previous) => {
      const next = new Set(previous);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  const handleSave = () => {
    if (!dirty || saveInFlightRef.current || saveMutation.isPending) return;
    saveInFlightRef.current = true;
    setSaveError("");
    setConflictProjection(null);
    saveMutation.mutate({
      mode: unverifiedProjection ? "verify" : "save",
      expectedRevision: baseline.revision,
      dates: sortedDraft,
      candidate: unverifiedProjection,
    });
  };

  const handleDiscard = () => {
    setDraft(new Set(baseline.nonInstructionalDates));
    clearTransientSaveState();
  };

  const requestMonthChange = (date) => {
    const month = formatMonthKey(date, timeZone);
    requestMonthKey(month);
  };

  const requestMonthKey = (month) => {
    if (month === baseline.month) return;
    if (dirty) setPendingMonth(month);
    else onMonthChange(month);
  };

  const openRangeDialog = () => {
    const start = hasEditableDate ? firstEditableDate : `${baseline.month}-01`;
    setRangeStart(start);
    setRangeEnd(start);
    setRangeAction("close");
    setRangeError("");
    setRangeOpen(true);
  };

  const applyRange = () => {
    if (
      !isRealDateKey(rangeStart)
      || !isRealDateKey(rangeEnd)
      || !rangeStart.startsWith(`${baseline.month}-`)
      || !rangeEnd.startsWith(`${baseline.month}-`)
      || rangeStart > rangeEnd
      || rangeStart < firstEditableDate
      || rangeEnd > lastMonthDate
    ) {
      setRangeError(`Choose an editable range within ${formatMonthLabel(baseline.month)}.`);
      return;
    }

    clearTransientSaveState();
    setDraft((previous) => {
      const next = new Set(previous);
      let cursor = new Date(`${rangeStart}T12:00:00Z`);
      const end = new Date(`${rangeEnd}T12:00:00Z`);
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        if (!isWeekendKey(key)) {
          if (rangeAction === "close") next.add(key);
          else next.delete(key);
        }
        cursor = new Date(cursor.getTime() + 86_400_000);
      }
      return next;
    });
    setRangeOpen(false);
  };

  const calendarModifiers = useMemo(() => ({
    nonInstructional: sortedDraft.map((date) => dateFromKey(date, timeZone)),
    past: (date) => formatMonthKey(date, timeZone) !== baseline.month
      || formatDateKeyForZone(date, timeZone) < baseline.schoolLocalToday,
    weekend: { dayOfWeek: [0, 6] },
  }), [baseline.month, baseline.schoolLocalToday, sortedDraft, timeZone]);

  const disabledDays = useMemo(() => [
    { dayOfWeek: [0, 6] },
    (date) => formatDateKeyForZone(date, timeZone) < baseline.schoolLocalToday,
  ], [baseline.schoolLocalToday, timeZone]);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-slate-300/70 shadow-sm dark:border-slate-700">
        <CardHeader className="border-b bg-slate-950 text-slate-50 dark:bg-slate-900">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-xl text-white">
                <CalendarDays className="h-5 w-5 text-amber-300" />
                School Calendar
              </CardTitle>
              <CardDescription className="max-w-2xl text-slate-300">
                Mark school closures and other non-instructional weekdays. Automatic ClassPilot sessions will not run on amber dates.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge className="border-amber-300/40 bg-amber-300/15 text-amber-100 hover:bg-amber-300/15">
                {sortedDraft.length} {sortedDraft.length === 1 ? "closure" : "closures"}
              </Badge>
              <Badge variant="outline" className="border-slate-600 text-slate-200">
                {timeZone}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-3 sm:p-5">
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p>
                Click an editable weekday to toggle it. Past dates and weekends are locked. Changes apply only after <strong className="text-foreground">Save Month</strong>.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openRangeDialog}
              disabled={!hasEditableDate || saveMutation.isPending}
              data-testid="button-calendar-range"
            >
              Mark a range
            </Button>
          </div>

          <div className="min-w-0 overflow-hidden rounded-xl border bg-background shadow-inner">
            <div className="flex items-center justify-between gap-2 border-b bg-slate-50 p-2 dark:bg-slate-900/40" aria-label="Calendar month navigation">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => requestMonthKey(shiftMonthKey(baseline.month, -1))}
                disabled={saveMutation.isPending}
                aria-label={`Previous month, ${formatMonthLabel(shiftMonthKey(baseline.month, -1))}`}
                data-testid="button-calendar-previous-month"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Previous</span>
              </Button>
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-semibold sm:text-base">{formatMonthLabel(baseline.month)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => requestMonthKey(baseline.schoolLocalToday.slice(0, 7))}
                  disabled={saveMutation.isPending || baseline.month === baseline.schoolLocalToday.slice(0, 7)}
                  data-testid="button-calendar-today"
                >
                  Today
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => requestMonthKey(shiftMonthKey(baseline.month, 1))}
                disabled={saveMutation.isPending}
                aria-label={`Next month, ${formatMonthLabel(shiftMonthKey(baseline.month, 1))}`}
                data-testid="button-calendar-next-month"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <DayPicker
              aria-label={`School instructional calendar for ${formatMonthLabel(baseline.month)}`}
              month={monthDateFromKey(baseline.month, timeZone)}
              today={dateFromKey(baseline.schoolLocalToday, timeZone)}
              timeZone={timeZone}
              fixedWeeks
              showOutsideDays={false}
              hideNavigation
              onMonthChange={requestMonthChange}
              onDayClick={(date) => toggleDate(formatDateKeyForZone(date, timeZone))}
              disabled={saveMutation.isPending ? true : disabledDays}
              modifiers={calendarModifiers}
              components={SCHOOL_CALENDAR_COMPONENTS}
              className="min-w-0 p-0"
              classNames={{
                root: "w-full",
                months: "w-full",
                month: "w-full",
                month_caption: "sr-only",
                caption_label: "sr-only",
                nav: "hidden",
                button_previous: "inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-foreground shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                button_next: "inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-foreground shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                month_grid: "w-full table-fixed border-collapse",
                weekdays: "bg-slate-100 dark:bg-slate-900/60",
                weekday: "h-8 border-b border-r px-0.5 text-center text-[0.62rem] font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0 sm:h-10 sm:px-2 sm:text-left sm:text-xs",
                week: "border-b last:border-b-0",
                day: "h-14 border-r p-0 align-top last:border-r-0 sm:h-24",
                day_button: "h-full w-full",
                outside: "invisible",
                hidden: "invisible",
                disabled: "opacity-100",
              }}
              data-testid="school-calendar-grid"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-label="Calendar legend">
            <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm border bg-background" /> Automatic classes run</span>
            <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm border border-amber-300 bg-amber-100 dark:bg-amber-950" /> No automatic classes</span>
            <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-muted" /> Locked</span>
            <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm outline outline-2 outline-primary" /> Today</span>
          </div>
        </CardContent>
      </Card>

      {conflictProjection ? (
        <Alert className="border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/35 dark:text-amber-100" data-testid="calendar-conflict-alert">
          <CircleAlert className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          <AlertTitle>Someone else changed this month</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Your draft is still here. Load the latest calendar only when you are ready to discard your draft.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => adoptProjection(conflictProjection)} data-testid="button-load-latest-calendar">
              Load latest
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {saveError ? (
        <Alert variant="destructive" data-testid="calendar-save-error">
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>{unverifiedProjection ? "Saved state could not be verified" : "Calendar was not saved"}</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}

      {dirty ? (
        <div
          className="sticky bottom-4 z-30 flex flex-col gap-3 rounded-xl border border-slate-300 bg-background/95 p-3 shadow-xl backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          role="status"
          aria-live="polite"
          data-testid="calendar-dirty-bar"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <Clock3 className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">Unsaved changes for {formatMonthLabel(baseline.month)}</p>
              <p className="text-xs text-muted-foreground">Automatic schedules are unchanged until this month is saved and verified.</p>
            </div>
          </div>
          <div className="flex gap-2 sm:shrink-0">
            <Button type="button" variant="outline" onClick={handleDiscard} disabled={saveMutation.isPending} data-testid="button-discard-calendar">
              Discard
            </Button>
            <Button type="button" onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-save-calendar">
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saveMutation.isPending ? "Checking…" : unverifiedProjection ? "Verify saved state" : "Save Month"}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={rangeOpen} onOpenChange={setRangeOpen}>
        <DialogContent data-testid="dialog-calendar-range">
          <DialogHeader>
            <DialogTitle>Update a date range</DialogTitle>
            <DialogDescription>
              Choose dates within {formatMonthLabel(baseline.month)}. Weekends are skipped and past dates stay locked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1" role="group" aria-label="Range action">
              <Button
                type="button"
                variant={rangeAction === "close" ? "default" : "ghost"}
                aria-pressed={rangeAction === "close"}
                onClick={() => setRangeAction("close")}
              >
                No automatic classes
              </Button>
              <Button
                type="button"
                variant={rangeAction === "open" ? "default" : "ghost"}
                aria-pressed={rangeAction === "open"}
                onClick={() => setRangeAction("open")}
              >
                Automatic classes run
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="calendar-range-start">Start date</Label>
                <Input id="calendar-range-start" type="date" min={firstEditableDate} max={lastMonthDate} value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="calendar-range-end">End date</Label>
                <Input id="calendar-range-end" type="date" min={firstEditableDate} max={lastMonthDate} value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} />
              </div>
            </div>
            {rangeError ? <p className="text-sm text-destructive" role="alert">{rangeError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRangeOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyRange} data-testid="button-apply-calendar-range">Apply to draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingMonth)} onOpenChange={(open) => { if (!open) setPendingMonth(null); }}>
        <AlertDialogContent data-testid="dialog-calendar-month-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this month’s unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Moving to another month will discard the current draft. Saved dates will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay on this month</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const month = pendingMonth;
                setPendingMonth(null);
                if (month) onMonthChange(month);
              }}
              data-testid="button-discard-month-draft"
            >
              Discard and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDateKeyForZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function SchoolCalendarMonth({ month, onDirtyChange, onMonthChange }) {
  const queryKey = ["classpilot-admin-instructional-calendar", month];
  const calendarQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/classpilot/admin/instructional-calendar?month=${encodeURIComponent(month)}`,
      );
      const projection = normalizeProjection(response, month);
      if (!projection) throw new Error("The server returned an invalid school calendar.");
      return projection;
    },
  });

  if (calendarQuery.isLoading) return <CalendarLoading />;
  if (calendarQuery.isError || !calendarQuery.data) {
    return <CalendarLoadError error={calendarQuery.error} onRetry={() => calendarQuery.refetch()} />;
  }

  return (
    <LoadedSchoolCalendar
      key={month}
      initialProjection={calendarQuery.data}
      queryKey={queryKey}
      onDirtyChange={onDirtyChange}
      onMonthChange={onMonthChange}
    />
  );
}
