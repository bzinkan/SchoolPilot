import { CalendarDays } from 'lucide-react';
import { useSchoolDayStatus } from '../hooks/useSchoolDayStatus';

export default function SchoolDayClosureNotice({ product }) {
  const status = useSchoolDayStatus(product);
  if (!status) return null;
  let message = null;
  if (status.calendarClosed) {
    message = product === 'classpilot' && status.classpilotInstructionalOverride === true
      ? 'School calendar marks today as closed. ClassPilot has an instructional-day override.'
      : 'School is closed today.';
  } else if (product === 'classpilot' && status.classpilotInstructionalOverride === false) {
    message = 'ClassPilot classes are not scheduled today.';
  }
  if (!message) return null;
  return (
    <div role="status" aria-live="polite" data-testid="school-day-closure-notice"
      className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground">
      <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}
