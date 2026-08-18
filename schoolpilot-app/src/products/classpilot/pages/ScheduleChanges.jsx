import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarPlus, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

import { Button } from "../../../components/ui/button";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { TeacherSettingsTabs } from "../components/ScheduleRouteTabs";
import {
  ScheduleChangeEmpty,
  ScheduleChangeRequestDialog,
  ScheduleChangeRow,
  ScheduleChangeSection,
  SchedulePageHeader,
} from "../components/ScheduleChangeUI";
import { useScheduleChangeRefresh } from "../hooks/useScheduleChangeRefresh";
import {
  invalidateScheduleChanges,
  isRevisionConflict,
  scheduleChangeApi,
  scheduleChangeError,
  scheduleChangeKeys,
  unwrapChanges,
  unwrapSettings,
} from "../lib/scheduleChanges";

const EMPTY = Object.freeze([]);

function ListLoading() {
  return (
    <div className="flex items-center justify-center gap-2 border-y py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule changes…
    </div>
  );
}

function ListError({ error, onRetry }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
      <p>{scheduleChangeError(error, "Schedule changes could not be loaded.")}</p>
      <Button type="button" variant="link" className="mt-1 h-auto p-0 text-destructive" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export default function ScheduleChanges() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser, school, isTeacher, isLoading, token } = useClassPilotAuth();
  const [requestOpen, setRequestOpen] = useState(false);
  const schoolId = school?.id || currentUser?.schoolId || null;

  useScheduleChangeRefresh({ schoolId, token, currentUser, enabled: !isLoading });

  const settingsQuery = useQuery({
    queryKey: scheduleChangeKeys.settings(schoolId),
    queryFn: scheduleChangeApi.getSettings,
    select: unwrapSettings,
    enabled: Boolean(schoolId),
  });
  const needsActionQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "needs_action"),
    queryFn: () => scheduleChangeApi.getChanges("needs_action"),
    select: unwrapChanges,
    enabled: Boolean(schoolId),
    refetchInterval: 30_000,
  });
  const upcomingQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "upcoming"),
    queryFn: () => scheduleChangeApi.getChanges("upcoming"),
    select: unwrapChanges,
    enabled: Boolean(schoolId),
    refetchInterval: 30_000,
  });
  const historyQuery = useQuery({
    queryKey: scheduleChangeKeys.list(schoolId, "history"),
    queryFn: () => scheduleChangeApi.getChanges("history"),
    select: unwrapChanges,
    enabled: Boolean(schoolId),
  });

  const createMutation = useMutation({
    mutationFn: scheduleChangeApi.createChange,
    onSuccess: async () => {
      await invalidateScheduleChanges(schoolId);
      toast({
        title: "Time swap requested",
        description: "The other class teacher will be asked to review it.",
      });
    },
  });

  const actionMutation = useMutation({
    mutationFn: ({ change, action }) => scheduleChangeApi.actOnChange(change.id, action, change.revision),
    onSuccess: async (_data, variables) => {
      await invalidateScheduleChanges(schoolId);
      variables.onDone?.();
      const labels = {
        accept: "Time swap accepted",
        approve: "Time swap approved",
        decline: "Time swap declined",
        deny: "Time swap denied",
        withdraw: "Request withdrawn",
        cancel: "Schedule change cancelled",
      };
      toast({ title: labels[variables.action] || "Schedule change updated" });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: isRevisionConflict(error) ? "Schedule change updated elsewhere" : "Action failed",
        description: isRevisionConflict(error)
          ? "The latest version has been loaded. Review it before trying again."
          : scheduleChangeError(error),
      });
      void invalidateScheduleChanges(schoolId);
    },
  });

  const performAction = (change, action, onDone) => {
    actionMutation.mutate({ change, action, onDone });
  };
  const pendingAction = (change) => actionMutation.isPending && actionMutation.variables?.change?.id === change.id
    ? actionMutation.variables.action
    : null;

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const settings = settingsQuery.data;
  const teacherRequestsEnabled = settings?.teacherRequestsEnabled === true;
  const canRequest = isTeacher && teacherRequestsEnabled;
  const needsAction = needsActionQuery.data ?? EMPTY;
  const upcoming = upcomingQuery.data ?? EMPTY;
  const history = historyQuery.data ?? EMPTY;

  return (
    <div className="min-h-screen bg-muted/30">
      <SchedulePageHeader
        eyebrow="My Settings"
        title="Schedule Changes"
        description="Request a one-day time swap with a shared class. Your teachers, student rosters, and recurring schedules do not change."
        actions={(
          <>
            <ThemeToggle />
            <Button type="button" variant="outline" className="border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 hover:text-white" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Dashboard
            </Button>
            {isTeacher ? (
              <Button
                type="button"
                className="bg-amber-400 text-slate-950 hover:bg-amber-300"
                onClick={() => setRequestOpen(true)}
                disabled={!canRequest || settingsQuery.isLoading}
                data-testid="button-request-time-swap"
              >
                <CalendarPlus className="mr-2 h-4 w-4" /> Request time swap
              </Button>
            ) : null}
          </>
        )}
      >
        <TeacherSettingsTabs />
      </SchedulePageHeader>

      <main className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6">
        {isTeacher && !settingsQuery.isLoading && !teacherRequestsEnabled ? (
          <div className="border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="teacher-schedule-requests-disabled">
            Teacher requests are currently off. A school administrator can still create an approved schedule change.
          </div>
        ) : null}

        <ScheduleChangeSection
          title="Needs Action"
          description="Requests waiting for your response."
          count={needsAction.length}
          testId="schedule-needs-action"
        >
          {needsActionQuery.isLoading ? <ListLoading /> : needsActionQuery.error ? (
            <ListError error={needsActionQuery.error} onRetry={() => needsActionQuery.refetch()} />
          ) : needsAction.length === 0 ? (
            <ScheduleChangeEmpty title="Nothing needs your response" description="Incoming time-swap requests will appear here." />
          ) : needsAction.map((change) => (
            <ScheduleChangeRow key={change.id} change={change} onAction={performAction} pendingAction={pendingAction(change)} />
          ))}
        </ScheduleChangeSection>

        <ScheduleChangeSection
          title="Upcoming"
          description="Approved changes and requests still moving through review."
          count={upcoming.length}
          testId="schedule-upcoming"
        >
          {upcomingQuery.isLoading ? <ListLoading /> : upcomingQuery.error ? (
            <ListError error={upcomingQuery.error} onRetry={() => upcomingQuery.refetch()} />
          ) : upcoming.length === 0 ? (
            <ScheduleChangeEmpty title="No upcoming changes" description="Your recurring ClassPilot schedule remains in effect." />
          ) : upcoming.map((change) => (
            <ScheduleChangeRow key={change.id} change={change} onAction={performAction} pendingAction={pendingAction(change)} />
          ))}
        </ScheduleChangeSection>

        <ScheduleChangeSection
          title="History"
          description="Completed, declined, cancelled, and expired requests."
          count={history.length}
          testId="schedule-history"
        >
          {historyQuery.isLoading ? <ListLoading /> : historyQuery.error ? (
            <ListError error={historyQuery.error} onRetry={() => historyQuery.refetch()} />
          ) : history.length === 0 ? (
            <ScheduleChangeEmpty title="No schedule-change history" description="Past decisions will remain available here for reference." />
          ) : history.map((change) => (
            <ScheduleChangeRow key={change.id} change={change} onAction={performAction} pendingAction={pendingAction(change)} />
          ))}
        </ScheduleChangeSection>
      </main>

      <ScheduleChangeRequestDialog
        key={`request-${schoolId ?? "none"}`}
        open={requestOpen}
        onOpenChange={setRequestOpen}
        schoolId={schoolId}
        timeZone={settings?.schoolTimezone || school?.schoolTimezone || school?.timezone}
        onSubmit={(payload) => createMutation.mutateAsync(payload)}
        isPending={createMutation.isPending}
      />
    </div>
  );
}
