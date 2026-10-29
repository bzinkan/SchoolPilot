import { useMemo } from 'react';
import { Monitor, Maximize2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { useDecodedDesktopFrame } from '../hooks/useNativeDesktopPreview';
import { windowsBrowserLabel, windowsBrowserSourceKey } from '../lib/windowsBrowsers';

export default function WindowsBrowserPreview({ student, expanded, onExpandedChange, sourceControls }) {
  const source = student.selectedWindowsBrowser;
  const label = windowsBrowserLabel(source);
  const validImage = source?.isLoggedIn && typeof source.screenshot === 'string'
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(source.screenshot) && source.screenshot.length <= 700_000;
  const candidate = useMemo(() => validImage ? { ...source, observedAt: source.screenshotAt } : null, [source, validImage]);
  const { frame } = useDecodedDesktopFrame({ key: student.windowsBrowserPreviewKey,
    viewerInstanceId: windowsBrowserSourceKey(source), row: candidate,
    deadline: source?._imageDeadline || 0 });
  const message = student.windowsBrowserUnavailable ? 'Browser connection unavailable. Refreshing this source.'
    : student.windowsLegacyHandoff ? 'The student signed into a Chromebook. Choose View Chromebook to continue.'
    : student.windowsLegacyOwnerPending ? 'Waiting for the current Chromebook session to finish refreshing.'
    : student.windowsSession?.state === 'unavailable' ? 'Windows student session unavailable. Sign in again on the computer.'
    : !source ? student.windowsBrowserSelection?.sourceRef ? 'The selected browser session changed. Choose its current source to continue.'
      : !student.windowsBrowserSources?.length ? 'No browser is paired. Pair Chrome or Edge from the student computer.'
      : 'Choose Chrome or Edge to view this browser session.'
      : !source.isLoggedIn ? `${label} is signed out.` : `Waiting for a current ${label} screenshot.`;
  const image = frame ? <img src={frame.row.screenshot} alt={`${label} browser preview for ${student.studentName || 'student'}`}
    className="h-full w-full object-contain" data-testid={`windows-browser-image-${student.studentId}`} /> : null;
  const observed = frame ? new Date(frame.row.screenshotAt).toLocaleTimeString() : null;
  return <div className="space-y-2" data-testid={`windows-browser-preview-${student.studentId}`} onClick={event => event.stopPropagation()}>
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-slate-950 text-slate-100">
      {image || <div className="px-4 text-center"><Monitor className="mx-auto mb-2 h-6 w-6 text-slate-400" /><p className="text-xs" role="status">{message}</p></div>}
      {frame ? <Button variant="secondary" size="sm" className="absolute right-2 top-2 h-7 px-2 text-xs"
        onClick={() => onExpandedChange(true)} aria-label={`Enlarge ${label} for ${student.studentName || 'student'}`}>
        <Maximize2 className="h-3 w-3" /></Button> : null}
    </div>
    {frame ? <p className="truncate text-xs text-muted-foreground" data-testid={`windows-browser-observation-${student.studentId}`}>
      {label} observed at {observed}{frame.row.activeTabTitle ? ` · ${frame.row.activeTabTitle}` : ''}</p> : null}
    <Dialog open={expanded} onOpenChange={onExpandedChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-6xl flex-col" data-testid="expanded-windows-browser-dialog">
        <DialogHeader><DialogTitle>{student.studentName || 'Student'} — {label}</DialogTitle>
          <DialogDescription>Selected browser session. Automatically refreshed screenshots.</DialogDescription></DialogHeader>
        {sourceControls}
        <div className="min-h-0 flex-1 overflow-hidden rounded bg-slate-950">{image || <p className="p-6 text-center text-slate-200">{message}</p>}</div>
        {frame ? <p className="text-xs text-muted-foreground">{label} observed at {observed}</p> : null}
      </DialogContent>
    </Dialog>
  </div>;
}
