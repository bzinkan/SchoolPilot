import { useEffect, useRef, useState } from 'react';
import { Monitor, Maximize2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { useDecodedDesktopFrame, useNativeDesktopPreview } from '../hooks/useNativeDesktopPreview';
import { desktopSourceKey, desktopStateLabel } from '../lib/nativeDesktop';

function observationTime(value) {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleTimeString() : 'Unknown';
}

export default function NativeDesktopPreview({ student, desktop, autoStart = false, initiallyExpanded = false,
  onActivationConsumed, onOpenBrowser, sourceControls = null }) {
  const canView = desktop.source.state === 'available';
  const [viewRequest, setViewRequest] = useState({ attempt: autoStart ? 1 : 0, active: autoStart && canView });
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const viewButtonRef = useRef(null);
  const bound = Boolean(desktopSourceKey(desktop.source));
  const { attempt } = viewRequest;
  const requested = viewRequest.active && bound && canView;
  useEffect(() => {
    if (!autoStart && !initiallyExpanded) return undefined;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) onActivationConsumed?.(); });
    return () => { cancelled = true; };
  }, [autoStart, initiallyExpanded, onActivationConsumed]);
  useEffect(() => {
    if (canView || !viewRequest.active) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setViewRequest(current => ({ ...current, active: false }));
    });
    return () => { cancelled = true; };
  }, [canView, viewRequest.active]);
  const preview = useNativeDesktopPreview({ requested, attempt, studentId: student.studentId, ...desktop });
  const { frame, expired } = useDecodedDesktopFrame(preview);
  const app = frame?.row.foregroundApplication;
  const status = requested
    ? expired ? 'stale' : preview.status
    : desktop.source.state;
  const message = !requested ? desktopStateLabel(status)
    : frame ? 'Desktop thumbnail' : status === 'available' ? 'Loading desktop thumbnail' : desktopStateLabel(status);
  const canRetry = requested && ['unavailable', 'stale'].includes(status);
  const image = frame ? (
    <img src={frame.row.screenshot} alt={`Selected desktop source for ${student.studentName || 'student'}`}
      className="h-full w-full object-contain" data-testid={`desktop-image-${student.studentId}`} />
  ) : null;
  const stopViewing = () => {
    setViewRequest(current => ({ ...current, active: false }));
    setExpanded(false);
  };

  return (
    <div className="space-y-2" data-testid={`desktop-preview-${student.studentId}`} onClick={event => event.stopPropagation()}>
      <div className="flex min-h-8 items-center justify-between gap-2 text-xs">
        <span className="font-medium" role="status" data-testid={`desktop-state-${student.studentId}`}>{message}</span>
        {viewRequest.active ? <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={stopViewing}>
          Stop viewing
        </Button> : null}
      </div>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-slate-950 text-slate-100">
        {image || <div className="px-4 text-center">
          <Monitor className="mx-auto mb-2 h-6 w-6 text-slate-400" aria-hidden="true" />
          <p className="text-xs">{requested ? message : 'Desktop capture starts only while you view this source.'}</p>
          {bound && canView && (!requested || canRetry) ? <Button className="mt-3 h-8 text-xs" size="sm"
            ref={viewButtonRef}
            onClick={() => setViewRequest(current => ({ attempt: current.attempt + 1, active: true }))} data-testid={`view-desktop-${student.studentId}`}>
            {canRetry ? 'Retry desktop' : 'View desktop'}
          </Button> : null}
        </div>}
        {frame ? <Button variant="secondary" size="sm" className="absolute right-2 top-2 h-7 px-2 text-xs"
          onClick={() => setExpanded(true)} aria-label={`Enlarge desktop for ${student.studentName || 'student'}`}>
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
        </Button> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">Windows · {desktop.source.sourceLabel || 'Selected source'} · Screenshots, not live video</p>
      {frame ? <div className="space-y-1 text-xs text-muted-foreground" data-testid={`desktop-observation-${student.studentId}`}>
        <p>Desktop observed at {observationTime(frame.row.observedAt)}</p>
        <p>{app?.displayName || 'Unknown application'} · Foreground app — computer session{app?.observedAt ? ` · observed at ${observationTime(app.observedAt)}` : ''}</p>
      </div> : null}
      <Dialog open={expanded} onOpenChange={open => { if (open) setExpanded(true); else stopViewing(); }}>
        <DialogContent className="flex h-[85vh] w-[95vw] max-w-6xl flex-col" data-testid="expanded-desktop-dialog"
          onCloseAutoFocus={event => { event.preventDefault(); queueMicrotask(() => viewButtonRef.current?.focus()); }}>
          <DialogHeader>
            <DialogTitle>{student.studentName || 'Student'} — desktop preview</DialogTitle>
            <DialogDescription>Selected desktop source. Automatically refreshed screenshots, not live video.</DialogDescription>
          </DialogHeader>
          {sourceControls || <div className="flex gap-2" role="group" aria-label="Enlarged preview source">
            <Button size="sm" variant="outline" aria-pressed={false} disabled={!onOpenBrowser}
              data-testid="expanded-native-source-browser" onClick={() => { stopViewing(); onOpenBrowser?.(); }}>Browser</Button>
            <Button size="sm" variant="secondary" aria-pressed data-testid="expanded-native-source-desktop">Desktop</Button>
          </div>}
          <div className="min-h-0 flex-1 overflow-hidden rounded bg-slate-950" data-testid="expanded-desktop-preview">
            {frame ? image : <div className="p-6 text-center text-slate-200">
              <p>{message}</p>
              {bound && canView && (!requested || canRetry) ? <Button className="mt-3" size="sm"
                data-testid="expanded-view-desktop" onClick={() => setViewRequest(current => ({ attempt: current.attempt + 1, active: true }))}>
                {canRetry ? 'Retry desktop' : 'View desktop'}
              </Button> : null}
            </div>}
          </div>
          {frame ? <p className="text-xs text-muted-foreground">Observed at {observationTime(frame.row.observedAt)} · {app?.displayName || 'Unknown application'} · Foreground app — computer session</p> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
