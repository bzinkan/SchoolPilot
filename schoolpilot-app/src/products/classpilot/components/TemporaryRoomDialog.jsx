import SupervisionSessionDialog from './SupervisionSessionDialog';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useState } from 'react';

export default function TemporaryRoomDialog({ open, onOpenChange, students, room, schoolId, onCommitted }) {
  const { currentUser } = useClassPilotAuth();
  // Keep the reviewed dialog mounted while its commit invalidates the activity
  // feed. A first claim changes null→room; it must not erase its own outcome.
  const [initialRoom] = useState(() => room);
  if (!open || currentUser?.schoolId !== schoolId) return null;
  const context = initialRoom ? { ...initialRoom, id: initialRoom.authority?.supervisionContextId || initialRoom.id } : undefined;
  return <SupervisionSessionDialog key={`${schoolId}:${context?.id || 'new'}`} open onOpenChange={onOpenChange}
    action="claim_room" students={students} context={context} onSuccess={onCommitted} />;
}
