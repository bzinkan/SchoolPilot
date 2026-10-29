import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../../../components/ui/sheet';
import StudentBrowsingHistory from './StudentBrowsingHistory';
import { windowsBrowserLabel, windowsBrowserSourceKey } from '../lib/windowsBrowsers';

export default function WindowsBrowserHistoryDrawer({ student, onClose }) {
  const source = student.selectedWindowsBrowser;
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-testid="windows-browser-history-drawer">
      <SheetHeader><SheetTitle>{student.studentName || 'Student'} — {windowsBrowserLabel(source)}</SheetTitle>
        <SheetDescription>History for the selected Windows browser session. Access is limited to your permitted dates.</SheetDescription></SheetHeader>
      <div className="pt-6">{source ? <StudentBrowsingHistory key={`${student.windowsBrowserScopeKey}:${windowsBrowserSourceKey(source)}`}
        studentId={student.studentId} windowsSource={source} authorityScope={student.windowsBrowserScopeKey} />
        : <p role="status">The selected browser session is unavailable. Close history and choose its current source.</p>}</div>
    </SheetContent>
  </Sheet>;
}
