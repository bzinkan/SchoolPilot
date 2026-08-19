import { useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../../components/ui/sheet';
import { commandOutcomeBreakdown, normalizeCommandSummary } from '../lib/commandDeliveryTruth';

const STATUS_STYLES = {
  completed: 'border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
  received: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  unavailable: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
  expired: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  sent: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  requested: 'border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
};

function displayStatus(target, deliveryPolicy) {
  if (target.status === 'unavailable' && deliveryPolicy === 'persistent_control') {
    return 'saved — waiting for monitoring';
  }
  return String(target.status || 'requested').replaceAll('-', ' ');
}

export default function CommandResultsDrawer({ open, onOpenChange, batches = [] }) {
  const [selectedBatchKey, setSelectedBatchKey] = useState(null);
  const keyForBatch = (entry, index) => entry?.command?.id
    || entry?.commands?.map((command) => command?.id).filter(Boolean).join(',')
    || entry?.createdAt
    || String(index);
  const batch = batches.find((entry, index) => keyForBatch(entry, index) === selectedBatchKey) || batches[0] || null;
  const summary = normalizeCommandSummary(batch || {});
  const targets = batch?.command?.targets || batch?.targets || [];
  const policy = batch?.command?.deliveryPolicy || batch?.deliveryPolicy;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg" data-testid="command-results-drawer">
        <SheetHeader>
          <SheetTitle>Command results</SheetTitle>
          <SheetDescription aria-live="polite" data-testid="command-results-summary">
            {batch ? commandOutcomeBreakdown(summary) || 'Waiting for target outcomes' : 'Send a classroom command to see delivery results.'}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 flex-1 space-y-5 overflow-y-auto pr-1">
          {!batch ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No command results yet.</p>
          ) : (
            <>
              {batches.length > 1 ? (
                <div className="space-y-2" aria-label="Command history">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent commands</p>
                  <div className="grid gap-2">
                    {batches.map((entry, index) => {
                      const entryKey = keyForBatch(entry, index);
                      const entrySummary = normalizeCommandSummary(entry);
                      const active = entry === batch;
                      return (
                        <button key={entryKey} type="button" onClick={() => setSelectedBatchKey(entryKey)} className={`rounded-md border px-3 py-2 text-left text-xs ${active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`} aria-pressed={active}>
                          <span className="font-semibold capitalize">{String(entry.command?.commandType || 'classroom command').replaceAll('-', ' ')}</span>
                          <span className="ml-2 text-muted-foreground">{commandOutcomeBreakdown(entrySummary) || 'Waiting for outcomes'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold capitalize">{String(batch.command?.commandType || 'classroom command').replaceAll('-', ' ')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {batch.targetLabel || `${summary.requested || targets.length} targeted student${(summary.requested || targets.length) === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  {batch.partial ? <Badge variant="outline" className={STATUS_STYLES.failed}>Partial request</Badge> : null}
                </div>
              </div>

              <ul className="space-y-2" aria-label="Per-student command outcomes">
                {targets.map((target, index) => {
                  const status = target.status || 'requested';
                  const error = target.error || target.errorMessage || target.result?.error;
                  return (
                    <li key={`${target.studentId || 'target'}-${target.commandId || index}`} className="rounded-lg border p-3" data-testid={`command-result-${target.studentId || index}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{target.studentName || batch.studentNames?.[target.studentId] || 'Student'}</p>
                          {error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
                        </div>
                        <Badge variant="outline" className={STATUS_STYLES[status] || STATUS_STYLES.requested}>
                          {displayStatus(target, policy)}
                        </Badge>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="mt-4 border-t pt-4">
          <Button type="button" variant="outline" className="w-full" onClick={() => onOpenChange(false)}>Close results</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
