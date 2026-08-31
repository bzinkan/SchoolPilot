import { useLayoutEffect, useRef, useState } from 'react';
import { Monitor, Search } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { deriveScreenshotDisplay } from '../lib/studentMonitoringDisplay';

const ZOOM_OPTIONS = Object.freeze([
  { value: 'fit', label: 'Fit' },
  { value: 100, label: '100%' },
  { value: 125, label: '125%' },
  { value: 150, label: '150%' },
  { value: 200, label: '200%' },
]);
const CAPTURE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

function captureAgeLabel(observedAtMs, nowMs) {
  if (observedAtMs === null) return null;
  const ageSeconds = Math.max(0, Math.floor((nowMs - observedAtMs) / 1000));
  if (ageSeconds < 5) return 'just now';
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  return `${Math.floor(ageSeconds / 60)}m ago`;
}

function AtomicDecodedScreenshot({ src, privacyKey, alt, className, style }) {
  const imageRef = useRef(null);
  const privacyKeyRef = useRef(null);
  const requestedSrcRef = useRef(null);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return undefined;

    if (privacyKeyRef.current !== privacyKey) {
      image.removeAttribute('src');
      privacyKeyRef.current = privacyKey;
    }
    requestedSrcRef.current = src;
    if (!src) {
      image.removeAttribute('src');
      return undefined;
    }

    let cancelled = false;
    const candidate = new Image();
    const isCurrent = () => (
      !cancelled
      && privacyKeyRef.current === privacyKey
      && requestedSrcRef.current === src
    );
    const commit = () => {
      if (!isCurrent()) return;
      image.src = src;
    };
    const clearFailedCandidate = () => {
      if (isCurrent()) image.removeAttribute('src');
    };
    const loaded = new Promise((resolve, reject) => {
      candidate.onload = resolve;
      candidate.onerror = reject;
    });
    candidate.src = src;
    const decoded = typeof candidate.decode === 'function'
      ? candidate.decode().catch(() => loaded)
      : loaded;
    void decoded.then(commit).catch(clearFailedCandidate);

    return () => {
      cancelled = true;
      candidate.onload = null;
      candidate.onerror = null;
    };
  }, [privacyKey, src]);

  return (
    <img
      ref={imageRef}
      alt={alt}
      className={className}
      style={style}
      decoding="async"
      data-testid="expanded-screenshot-image"
    />
  );
}

export default function ScreenshotPreviewDialog({
  studentName,
  screenshotData,
  freshnessNowMs,
  privacyKey,
  refreshUnavailable = false,
  unavailableMessage = 'Current screenshot unavailable. Waiting for the next authorized capture.',
  onReturnFocus,
  onOpenChange,
}) {
  const [zoom, setZoom] = useState('fit');
  const display = deriveScreenshotDisplay(screenshotData, freshnessNowMs);
  const captureTime = display.observedAtMs === null
    ? null
    : CAPTURE_TIME_FORMATTER.format(new Date(display.observedAtMs));
  const captureAge = captureAgeLabel(display.observedAtMs, freshnessNowMs);
  const retained = !display.fresh && display.retained;
  const imageStyle = zoom === 'fit'
    ? { maxHeight: '100%', maxWidth: '100%', height: 'auto', width: 'auto' }
    : { height: 'auto', maxWidth: 'none', width: `${zoom}%` };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[92vh] w-[96vw] max-w-[96rem] grid-rows-none flex-col gap-3 overflow-hidden p-4 sm:p-6"
        data-testid="expanded-screenshot-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus?.();
        }}
      >
        <DialogHeader className="min-w-0 pr-10">
          <DialogTitle className="truncate">{studentName} — screen preview</DialogTitle>
          <DialogDescription>
            Automatically refreshed screenshot. Not live video.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3 border-y py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Monitor className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
            <span
              className={retained || refreshUnavailable ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}
              data-testid="expanded-screenshot-status"
            >
              {!display.available
                ? 'Preview unavailable'
                : retained
                ? `Updating…${captureAge ? ` Last captured ${captureAge}` : ''}${captureTime ? ` at ${captureTime}` : ''}`
                : refreshUnavailable
                  ? `Refresh unavailable${captureAge ? ` · Last captured ${captureAge}` : ''}${captureTime ? ` at ${captureTime}` : ''}`
                  : captureAge
                    ? `Updated ${captureAge}${captureTime ? ` · Captured ${captureTime}` : ''}`
                    : 'Current screenshot'}
            </span>
            {screenshotData?.tabTitle ? (
              <span className="hidden max-w-[32rem] truncate text-muted-foreground lg:inline">
                · {screenshotData.tabTitle}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1" aria-label="Screenshot zoom">
            <Search className="mr-1 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {ZOOM_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={zoom === option.value ? 'default' : 'outline'}
                className="h-8 px-2.5 text-xs"
                aria-pressed={zoom === option.value}
                onClick={() => setZoom(option.value)}
                data-testid={`expanded-screenshot-zoom-${option.value}`}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div
          className={`flex min-h-0 flex-1 overflow-auto rounded-lg border bg-slate-950 p-2 ${zoom === 'fit' ? 'items-center justify-center' : 'items-start justify-start'}`}
          data-testid="expanded-screenshot-viewport"
        >
          {display.available ? (
            <AtomicDecodedScreenshot
              src={screenshotData?.screenshot || ''}
              privacyKey={privacyKey}
              alt={`Latest screen preview for ${studentName}`}
              className="block rounded shadow-2xl"
              style={imageStyle}
            />
          ) : (
            <div className="max-w-md px-6 text-center text-slate-200" data-testid="expanded-screenshot-unavailable">
              <Monitor className="mx-auto mb-3 h-10 w-10 text-slate-400" aria-hidden="true" />
              <p className="font-semibold">Screen preview unavailable</p>
              <p className="mt-1 text-sm text-slate-400">{unavailableMessage}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
