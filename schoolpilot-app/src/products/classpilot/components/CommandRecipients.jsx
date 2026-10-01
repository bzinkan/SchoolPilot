import { cn } from '../../../lib/utils';
import {
  RECIPIENTS_MISSING_MESSAGE,
  commandRecipientsHeadline,
  snapshotRecipientNames,
  unavailableRecipientsMessage,
} from '../lib/dashboardCommandContext';

/**
 * The frozen recipients of a classroom dialog: who it was opened for, by name,
 * and who can no longer receive it. Pass the dialog's description component as
 * `summaryAs` so the headline is announced when the dialog opens. `open` is the
 * dialog's own flag; nothing is drawn while a closing dialog animates out.
 */
export default function CommandRecipients({
  open = true,
  snapshot,
  unavailableIds = null,
  confirmIds = null,
  notice = '',
  summaryAs: Summary = 'p',
  className,
}) {
  if (!open) return null;
  if (!snapshot) {
    return (
      <div className={cn('space-y-2', className)} data-testid="command-recipients">
        <Summary className="text-sm font-medium text-foreground" data-testid="command-recipients-summary">
          No recipients
        </Summary>
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" data-testid="command-recipients-unavailable">
          {notice || RECIPIENTS_MISSING_MESSAGE}
        </p>
      </div>
    );
  }

  const unavailable = new Set(unavailableIds || []);
  const unavailableNames = snapshotRecipientNames(snapshot, unavailableIds);
  const alert = notice || (unavailableNames.length > 0
    ? unavailableRecipientsMessage(unavailableNames, { availableCount: confirmIds?.length || 0 })
    : '');

  return (
    <div className={cn('space-y-2', className)} data-testid="command-recipients">
      <Summary className="text-sm font-medium text-foreground" data-testid="command-recipients-summary">
        {commandRecipientsHeadline(snapshot)}
      </Summary>
      {/* A keyboard stop, so a long list can be scrolled without a pointer.
          The dialog still opens in its first field (data-recipient-autofocus). */}
      <ul
        className="max-h-32 overflow-y-auto rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Recipients"
        tabIndex={0}
        data-testid="command-recipients-list"
      >
        {snapshot.ids.map((id, index) => (
          <li
            key={id}
            className={unavailable.has(id) ? 'text-muted-foreground' : undefined}
            data-testid={`command-recipient-${id}`}
            data-unavailable={unavailable.has(id) ? 'true' : undefined}
          >
            {snapshot.names[index]}
            {unavailable.has(id) ? (
              <span className="text-xs text-amber-700 dark:text-amber-300">{" · can't receive right now"}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {alert ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="command-recipients-unavailable"
        >
          {alert}
        </p>
      ) : null}
    </div>
  );
}
