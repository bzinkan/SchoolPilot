import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { apiRequest } from '../../../lib/queryClient';
import { automaticFlightPathPolicyKey } from '../lib/automaticFlightPath';
import { manualTodayDateLabel } from '../hooks/useManualToday';

export default function ClassStartReviewDialog({ review, schoolId, viewerId, currentSessionId, manualTodayQuery, targetAvailable, pending, onClose, onConfirm, onRefresh, returnFocusRef }) {
  const manual = review.manualToday || review.alreadyManualToday;
  const policy = useQuery({
    queryKey: automaticFlightPathPolicyKey(review.groupId, schoolId, viewerId),
    queryFn: ({ signal }) => apiRequest('GET', `/classpilot/groups/${encodeURIComponent(review.groupId)}/automatic-flight-path`, undefined, { signal, headers: { 'X-School-Id': schoolId } }),
    enabled: manual,
    staleTime: 0,
  });
  const changedSession = currentSessionId !== review.expectedActiveSessionId;
  const changedDay = review.manualToday && (manualTodayQuery.isDayExpired || manualTodayQuery.data?.schoolDate !== review.schoolDate);
  const permissionLost = review.manualToday && manualTodayQuery.data?.canManageManualToday !== true;
  const action = review.expectedActiveSessionId ? 'Switch' : 'Start';
  const title = `${action} ${review.groupName}${review.manualToday ? ' manually today' : ''}?`;
  const overlapCount = review.overlap?.totalOverlapCount || 0;
  const flightPath = policy.data?.flightPath;
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="dialog-class-start-review"
      onCloseAutoFocus={event => {
        event.preventDefault();
        const trigger = returnFocusRef?.current;
        if (!trigger?.isConnected) return;
        if (!trigger.disabled) trigger.focus();
        else trigger.closest('[data-testid="class-start-controls"],[data-testid="admin-class-start-controls"]')?.querySelector('select')?.focus();
      }}
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
        {review.manualToday ? 'Review this class’s one-day change and start it in the same action.' : 'Review the class you are about to teach.'}
      </DialogDescription></DialogHeader>
      <div className="space-y-3 text-sm">
        <p><strong>{review.groupName}</strong> will become your teaching class.</p>
        {review.expectedActiveSessionId ? <p data-testid="class-start-replacement">{review.previousSessionOwned ? <>Your current class, <strong>{review.previousClassName || 'the active class'}</strong>, will end through the normal Session Summary process.</> : <>The shared class, <strong>{review.previousClassName || 'the active class'}</strong>, remains running for its teacher. You will switch to the selected class.</>}</p> : null}
        {review.manualToday ? <>
          <p>This class will use manual starts for all assigned teachers and co-teachers for the rest of today. Its running automatic session, if any, will end.</p>
          <p>Saved class times stay unchanged. Automatic scheduling resumes {manualTodayDateLabel(manualTodayQuery.data?.resumesOn)} ({manualTodayQuery.data?.timezone}). There is no same-day reset.</p>
        </> : null}
        {manual ? <>
          <p>These class adjustments last today. Other automatic classes may take over at their scheduled times. Manual sessions cannot continue past midnight in the school’s timezone.</p>
          {policy.isPending ? <p>Checking the saved class Flight Path…</p> : policy.isError ? <p role="alert">The saved Flight Path could not be checked. <Button variant="link" onClick={() => policy.refetch()}>Retry Flight Path</Button></p>
            : policy.data?.policy?.enabled ? <p data-testid="class-start-flight-path">{flightPath ? <>Saved Flight Path: <strong>{flightPath.flightPathName || flightPath.name || 'Class preset'}</strong>. It will apply to this manual session when available.</> : 'The saved class Flight Path is unavailable and cannot be applied.'}</p>
              : <p data-testid="class-start-flight-path">No automatic Flight Path is enabled for this class.</p>}
        </> : null}
        {overlapCount > 0 ? <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="class-start-review-overlap">
          <p><strong>{overlapCount} student{overlapCount === 1 ? '' : 's'}</strong> are already active in another class. Continuing will move their control to you.</p>
          {(review.overlap.groups || []).map(group => <p key={group.sessionId}>{group.teacherName} · {group.className} · {group.affectedCount} student{group.affectedCount === 1 ? '' : 's'}</p>)}
        </div> : null}
        {changedSession || changedDay || !targetAvailable ? <p role="alert">The class, active session, or school date changed. Review the latest state before starting.</p> : null}
        {permissionLost ? <p role="alert">Your administrator has not enabled teacher adjustments for today.</p> : null}
        {review.error ? <p role="alert" className="text-destructive">{review.error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
        {changedSession || changedDay ? <Button variant="outline" onClick={onRefresh} disabled={pending || manualTodayQuery.isFetching}>Review again</Button> : null}
        <Button onClick={onConfirm} disabled={pending || changedSession || changedDay || permissionLost || !targetAvailable || manual && (policy.isPending || policy.isError)} data-testid="button-confirm-class-start-review">
          {pending ? 'Starting…' : overlapCount > 0 ? `${action} and move ${overlapCount} student${overlapCount === 1 ? '' : 's'}` : `${action}${review.manualToday ? ' manually today' : ' Class'}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
