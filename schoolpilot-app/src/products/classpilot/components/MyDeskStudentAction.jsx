import { lazy, Suspense, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { Button } from '../../../components/ui/button';

const NoteComposerDialog = lazy(() => import('./NoteComposerDialog'));

export default function MyDeskStudentAction({ student, groupId, access }) {
  const [composer, setComposer] = useState(null);
  const identity = `${access.schoolId}:${access.viewerId}:${student.id}`;
  if (!access.enabled) return null;
  return <>
    <Button size="sm" variant="outline" onClick={() => setComposer({ id: crypto.randomUUID(), identity })}><NotebookPen className="size-4" />Add private note</Button>
    {composer?.identity === identity && <Suspense fallback={<p role="status" className="text-sm">Opening note…</p>}><NoteComposerDialog key={`${identity}:${composer.id}`} sessionId={composer.id} open schoolId={access.schoolId} viewerId={access.viewerId} today={access.schoolDate} timeZone={access.school?.timezone} student={student} groupId={groupId} onOpenChange={open => { if (!open) setComposer(null); }} /></Suspense>}
  </>;
}
