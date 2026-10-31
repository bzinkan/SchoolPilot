import { useState } from 'react';
import { Dialog, DialogContent } from '../../../components/ui/dialog';
import ManualTodayManager from './ManualTodayManager';

export default function ManualTodayDialog({ query, schoolId, onClose, startLabel = 'Start Class' }) {
  const [pending, setPending] = useState(false);
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-w-xl" data-testid="dialog-manual-today"
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}
      onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
      <ManualTodayManager query={query} schoolId={schoolId} startLabel={startLabel} dialog onClose={onClose} onPendingChange={setPending} />
    </DialogContent>
  </Dialog>;
}
