import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';

export default function ClassStartReviewDialog({ review, currentSessionId, targetAvailable, pending, onClose, onConfirm, onRefresh, returnFocusRef }) {
  const changedSession = currentSessionId !== review.expectedActiveSessionId;
  const action = review.expectedActiveSessionId ? 'Switch' : 'Start';
  const title = `${action} ${review.groupName}?`;
  const overlapCount = review.overlap?.totalOverlapCount || 0;
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="dialog-class-start-review"
      onCloseAutoFocus={event => {
        event.preventDefault();
        const trigger = returnFocusRef?.current;
        if (!trigger?.isConnected) return;
        if (!trigger.disabled) trigger.focus();
        else {
          const picker = trigger.closest('[data-testid="dashboard-header-row"]')?.querySelector('[data-testid="select-start-session-group"],[data-testid="select-admin-start-session-group"]')
            || trigger.closest('[data-testid="class-start-controls"],[data-testid="admin-class-start-controls"]')?.querySelector('select');
          picker?.focus();
        }
      }}
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
        Review the class you are about to teach.
      </DialogDescription></DialogHeader>
      <div className="space-y-3 text-sm">
        <p><strong>{review.groupName}</strong> will become your teaching class.</p>
        {review.expectedActiveSessionId ? <p data-testid="class-start-replacement">{review.previousSessionOwned ? <>Your current class, <strong>{review.previousClassName || 'the active class'}</strong>, will end through the normal Session Summary process.</> : <>The shared class, <strong>{review.previousClassName || 'the active class'}</strong>, remains running for its teacher. You will switch to the selected class.</>}</p> : null}
        {overlapCount > 0 ? <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="class-start-review-overlap">
          <p><strong>{overlapCount} student{overlapCount === 1 ? '' : 's'}</strong> are already active in another class. Continuing will move their control to you.</p>
          {(review.overlap.groups || []).map(group => <p key={group.sessionId}>{group.teacherName} · {group.className} · {group.affectedCount} student{group.affectedCount === 1 ? '' : 's'}</p>)}
        </div> : null}
        {changedSession || !targetAvailable ? <p role="alert">The class or active session changed. Review the latest state before starting.</p> : null}
        {review.error ? <p role="alert" className="text-destructive">{review.error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
        {changedSession ? <Button variant="outline" onClick={onRefresh} disabled={pending}>Review again</Button> : null}
        <Button onClick={onConfirm} disabled={pending || changedSession || !targetAvailable} data-testid="button-confirm-class-start-review">
          {pending ? 'Starting…' : overlapCount > 0 ? `${action} and move ${overlapCount} student${overlapCount === 1 ? '' : 's'}` : `${action} Class`}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
