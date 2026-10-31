import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarDays, Check, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '../../../components/ui/dialog';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { MANUAL_TODAY_QUERY, manualTodayDateLabel } from '../hooks/useManualToday';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';

const errorMessage = error => error?.response?.data?.error || error?.message || 'Could not enable manual mode. Try again.';

export default function ManualTodayManager({ query, schoolId, onClose, onPendingChange, startLabel = 'Start Class', dialog = false }) {
  const lifetime = useRef(true);
  useLayoutEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  const [selectionReview, setSelectionReview] = useState(null);
  const reviewId = selectionReview?.id;
  const [notice, setNotice] = useState('');
  const data = query.data;
  const classes = data?.classes || [];
  const reviewedClass = classes.find(group => group.id === reviewId);
  const resumeLabel = manualTodayDateLabel(data?.resumesOn);
  const canManage = data?.canManageManualToday === true;
  const staleReview = reviewId && (selectionReview.schoolDate !== data?.schoolDate || query.isDayExpired);

  const mutation = useMutation({
    mutationFn: ({ groupId, expectedSchoolDate }) => apiRequest('POST', `/classpilot/groups/${encodeURIComponent(groupId)}/manual-today`, { expectedSchoolDate }, {
      headers: { 'X-School-Id': schoolId },
    }),
    onMutate: () => onPendingChange?.(true),
    onSettled: () => { if (lifetime.current) onPendingChange?.(false); },
    onSuccess: result => {
      if (!lifetime.current) return;
      queryClient.setQueryData(query.manualTodayQueryKey, current => current && ({
        ...current,
        schoolDate: result.schoolDate,
        timezone: result.timezone,
        resumesOn: result.resumesOn,
        resumesAt: result.resumesAt,
        classes: current.classes.map(group => group.id === result.class.id ? result.class : group),
      }));
      for (const key of [MANUAL_TODAY_QUERY, '/api/sessions/active', '/api/groups', '/api/teacher/groups',
        '/api/classpilot/dashboard-activity', '/api/classpilot/observable-activities', '/api/students-aggregated',
        '/api/coverage/summary', '/api/classpilot/teaching-sessions/recent', 'classpilot-admin-classes']) {
        void queryClient.invalidateQueries({ queryKey: [key], exact: false });
      }
      setSelectionReview(null);
      setNotice(`${result.class.name} is manual for today. Choose it and click ${startLabel} when you are ready.`);
    },
    onError: () => {
      // Permission or day changes must be re-read; keep the named review visible.
      if (lifetime.current) void query.refetch();
    },
  });

  useAdminNavigationBlocker({ id: 'manual-today-manager', busy: mutation.isPending });

  const review = groupId => {
    mutation.reset();
    setNotice('');
    setSelectionReview({ id: groupId, schoolDate: data.schoolDate });
  };

  const Header = dialog ? DialogHeader : 'div';
  const Title = dialog ? DialogTitle : 'h2';
  const Description = dialog ? DialogDescription : 'p';
  const Footer = dialog ? DialogFooter : 'div';
  return <section className="space-y-4" data-testid="manual-today-manager">
      <Header className="space-y-2">
        <Title className="text-lg font-semibold leading-tight">{reviewId ? `Make ${reviewedClass?.name || 'this class'} manual for today?` : dialog ? 'Manual for today' : 'Choose classes'}</Title>
        <Description className="text-sm text-muted-foreground">
          {reviewId
            ? `Pause automatic starts for this class today, then use ${startLabel} whenever you need it.`
            : `Choose which classes you want to start yourself today. Enabling this option does not start a class.`}
        </Description>
      </Header>

      {query.isPending || query.isDayExpired && !query.isError ? <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading today’s classes…</p>
        : !data || query.isError ? <div role="alert" className="space-y-3 text-sm">
          <p>Today’s class settings could not be refreshed. Try again before making changes.</p>
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Retry class settings</Button>
        </div>
          : <>
            <p className="text-sm text-muted-foreground" data-testid="manual-today-date">
              For {manualTodayDateLabel(data.schoolDate)} · {data.timezone}. Your normal schedule and saved class times resume {resumeLabel}.
            </p>
            {!canManage ? <p role="status" className="rounded-md border p-3 text-sm">Your school administrator has not enabled teacher adjustments. An administrator can make a class manual for today.</p> : null}

            {reviewId ? <div className="space-y-3 rounded-md border p-4 text-sm" data-testid="manual-today-review">
              {staleReview ? <p role="alert">The school date changed while this review was open. Return to the class list and review today’s adjustment again.</p> : null}
              {!reviewedClass ? <p role="alert">This class is no longer available. Return to the class list and refresh.</p> : <>
                <p><strong>{reviewedClass.name}</strong> will use manual starts for all assigned teachers and co-teachers for the rest of this school day.</p>
                <p>If an automatic session for this class is running, it will end. Existing session history and summaries are kept.</p>
                <p>Use End Class when you finish. Manual sessions cannot continue past midnight in your school’s timezone.</p>
                <p>Other classes remain automatic and may take over at their scheduled times. This class returns to automatic scheduling tomorrow; there is no same-day reset.</p>
              </>}
            </div> : <div className={dialog ? "max-h-[45vh] space-y-2 overflow-y-auto" : "space-y-2"} aria-label="Classes for manual starts">
              {classes.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No automatically scheduled classes are available.</p> : classes.map(group => <div
                key={group.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                data-testid={`manual-today-class-${group.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{group.name}</p>
                  {group.periodLabel || group.gradeLevel ? <p className="text-xs text-muted-foreground">{[group.periodLabel, group.gradeLevel ? `Grade ${group.gradeLevel}` : null].filter(Boolean).join(' · ')}</p> : null}
                  {group.isManualToday ? <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><Check className="h-3 w-3" />Manual for today · resumes {resumeLabel}</p> : null}
                </div>
                {canManage && !group.isManualToday ? <Button size="sm" variant="outline" onClick={() => review(group.id)} data-testid={`button-review-manual-today-${group.id}`}>
                  <CalendarDays className="mr-1.5 h-4 w-4" />Manual for today
                </Button> : null}
              </div>)}
            </div>}
          </>}

      {mutation.error ? <p role="alert" className="text-sm text-destructive">{errorMessage(mutation.error)}</p> : null}
      {notice ? <p role="status" className="text-sm" data-testid="manual-today-success">{notice}</p> : null}
      <Footer className={dialog ? undefined : "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"}>
        {reviewId ? <>
          <Button variant="outline" onClick={() => { setSelectionReview(null); mutation.reset(); }} disabled={mutation.isPending}>Back to classes</Button>
          <Button data-testid="button-confirm-manual-today" disabled={!reviewedClass || !canManage || staleReview || query.isError || query.isFetching || reviewedClass.isManualToday || mutation.isPending}
            onClick={() => mutation.mutate({ groupId: reviewedClass.id, expectedSchoolDate: selectionReview.schoolDate })}>
            {mutation.isPending ? 'Saving…' : 'Make manual for today'}
          </Button>
        </> : onClose ? <Button variant="outline" onClick={onClose}>Done</Button> : null}
      </Footer>
  </section>;
}
