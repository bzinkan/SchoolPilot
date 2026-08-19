import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Check, Loader2, RefreshCw, Save } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import { useToast } from "../../../hooks/use-toast";
import {
  isRevisionConflict,
  invalidateScheduleChanges,
  scheduleChangeApi,
  scheduleChangeError,
  scheduleChangeKeys,
  unwrapSettings,
} from "../lib/scheduleChanges";

function toDraft(settings) {
  return {
    teacherRequestsEnabled: settings?.teacherRequestsEnabled === true,
    adminApprovalRequired: settings?.adminApprovalRequired !== false,
    sameDayCutoffEnforced: settings?.sameDayCutoffEnforced !== false,
    sameDayCutoff: settings?.sameDayCutoff || "07:00",
    reasonRequired: settings?.reasonRequired !== false,
    revision: Number.isInteger(settings?.revision) ? settings.revision : 0,
  };
}

function PolicyEditor({ schoolId, initialSettings, refetch }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(() => toDraft(initialSettings));
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(null);

  const mutation = useMutation({
    mutationFn: (payload) => scheduleChangeApi.updateSettings(payload),
    onSuccess: async (data) => {
      const authoritative = unwrapSettings(data);
      setDraft(toDraft(authoritative));
      setDirty(false);
      setConflict(null);
      await invalidateScheduleChanges(schoolId);
      toast({ title: "Schedule-change policy saved", description: "The verified school policy is now active." });
    },
    onError: (error) => {
      if (isRevisionConflict(error)) {
        setConflict(error.response?.data?.current ? unwrapSettings(error.response.data.current) : true);
        return;
      }
      toast({ variant: "destructive", title: "Policy was not saved", description: scheduleChangeError(error) });
    },
  });

  const updateDraft = (updates) => {
    setDraft((current) => ({ ...current, ...updates }));
    setDirty(true);
    setConflict(null);
  };

  const loadLatest = async () => {
    if (conflict && conflict !== true) {
      setDraft(toDraft(conflict));
      setDirty(false);
      setConflict(null);
      return;
    }
    const result = await refetch();
    if (result.data) {
      setDraft(toDraft(result.data));
      setDirty(false);
      setConflict(null);
    }
  };

  return (
    <div className="space-y-6">
            <div className="flex items-start justify-between gap-5 border-b pb-5">
              <div>
                <Label htmlFor="teacher-schedule-change-requests" className="text-sm font-semibold">Teacher requests</Label>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">Allow primary teachers to request swaps with administrator-enabled class pairs.</p>
              </div>
              <Switch
                id="teacher-schedule-change-requests"
                checked={draft.teacherRequestsEnabled}
                onCheckedChange={(checked) => updateDraft({ teacherRequestsEnabled: checked })}
                data-testid="switch-teacher-schedule-change-requests"
              />
            </div>

            <div className="flex items-start justify-between gap-5 border-b pb-5">
              <div>
                <Label htmlFor="schedule-change-admin-approval" className="text-sm font-semibold">Administrator approval</Label>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">Require an administrator decision after the counterpart teacher accepts.</p>
              </div>
              <Switch
                id="schedule-change-admin-approval"
                checked={draft.adminApprovalRequired}
                onCheckedChange={(checked) => updateDraft({ adminApprovalRequired: checked })}
                data-testid="switch-schedule-change-admin-approval"
              />
            </div>

            <div className="flex items-start justify-between gap-5 border-b pb-5">
              <div>
                <Label htmlFor="schedule-change-cutoff-enforced" className="text-sm font-semibold">Enforce same-day cutoff</Label>
                <p id="schedule-change-cutoff-enforced-description" className="mt-1 max-w-xl text-sm text-muted-foreground">
                  Close teacher requests at the configured school-local time.
                </p>
              </div>
              <Switch
                id="schedule-change-cutoff-enforced"
                checked={draft.sameDayCutoffEnforced}
                onCheckedChange={(checked) => updateDraft({ sameDayCutoffEnforced: checked })}
                aria-describedby="schedule-change-cutoff-enforced-description"
                data-testid="switch-schedule-change-cutoff-enforced"
              />
            </div>

            <div className="grid gap-3 border-b pb-5 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-end">
              <div>
                <Label htmlFor="schedule-change-cutoff" className="text-sm font-semibold">Teacher same-day cutoff</Label>
                <p id="schedule-change-cutoff-description" className="mt-1 text-sm text-muted-foreground">
                  {draft.sameDayCutoffEnforced
                    ? "Teachers cannot submit after this time."
                    : "This saved time will be used again if enforcement is turned on."}
                  {" "}The earlier affected class start is always the final deadline.
                </p>
              </div>
              <Input
                id="schedule-change-cutoff"
                type="time"
                value={draft.sameDayCutoff}
                onChange={(event) => updateDraft({ sameDayCutoff: event.target.value })}
                disabled={!draft.sameDayCutoffEnforced}
                aria-describedby="schedule-change-cutoff-description"
                data-testid="input-schedule-change-cutoff"
              />
            </div>

            <div className="flex items-start justify-between gap-5 border-b pb-5">
              <div>
                <Label htmlFor="schedule-change-reason-required" className="text-sm font-semibold">Require a reason</Label>
                <p id="schedule-change-reason-required-description" className="mt-1 max-w-xl text-sm text-muted-foreground">
                  Require teachers to explain a request. Administrator-created changes always require a reason.
                </p>
              </div>
              <Switch
                id="schedule-change-reason-required"
                checked={draft.reasonRequired}
                onCheckedChange={(checked) => updateDraft({ reasonRequired: checked })}
                aria-describedby="schedule-change-reason-required-description"
                data-testid="switch-schedule-change-reason-required"
              />
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-emerald-600" /> Counterpart teacher acceptance is always required</p>
            </div>

            {conflict ? (
              <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" role="alert" data-testid="schedule-policy-conflict">
                <p>Another administrator changed this policy. Your draft is still here.</p>
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={loadLatest}><RefreshCw className="mr-2 h-4 w-4" /> Load latest policy</Button>
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => mutation.mutate({
                  teacherRequestsEnabled: draft.teacherRequestsEnabled,
                  adminApprovalRequired: draft.adminApprovalRequired,
                  sameDayCutoffEnforced: draft.sameDayCutoffEnforced,
                  sameDayCutoff: draft.sameDayCutoff,
                  reasonRequired: draft.reasonRequired,
                  expectedRevision: draft.revision,
                })}
                disabled={!dirty || mutation.isPending || !draft.sameDayCutoff}
                data-testid="button-save-schedule-change-policy"
              >
                {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save schedule policy
              </Button>
            </div>
    </div>
  );
}

export function ScheduleChangePolicyCard({ schoolId, canManage }) {
  const settingsQuery = useQuery({
    queryKey: scheduleChangeKeys.settings(schoolId),
    queryFn: scheduleChangeApi.getSettings,
    select: unwrapSettings,
    enabled: Boolean(schoolId && canManage),
  });

  useEffect(() => {
    if (!canManage || window.location.hash !== "#schedule-changes") return undefined;

    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById("schedule-changes");
      if (!card) return;
      card.scrollIntoView({ block: "start" });
      card.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [canManage]);

  if (!canManage) return null;

  return (
    <Card
      id="schedule-changes"
      role="region"
      aria-labelledby="schedule-changes-title"
      tabIndex={-1}
      className="scroll-mt-6 border-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-slate-700"
      data-testid="card-schedule-change-policy"
    >
      <CardHeader className="border-b border-slate-200 bg-slate-900 text-white dark:border-slate-700">
        <CardTitle id="schedule-changes-title" className="flex items-center gap-2 text-base">
          <CalendarClock className="h-5 w-5 text-amber-300" /> Schedule Changes
        </CardTitle>
        <CardDescription className="text-slate-300">
          Set who may request one-day class-time swaps and when teacher requests close.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {settingsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading schedule policy…</div>
        ) : settingsQuery.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {scheduleChangeError(settingsQuery.error, "Schedule policy could not be loaded.")}
            <Button type="button" variant="link" className="ml-2 h-auto p-0 text-destructive" onClick={() => settingsQuery.refetch()}>Try again</Button>
          </div>
        ) : settingsQuery.data ? (
          <PolicyEditor
            key={schoolId}
            schoolId={schoolId}
            initialSettings={settingsQuery.data}
            refetch={settingsQuery.refetch}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
