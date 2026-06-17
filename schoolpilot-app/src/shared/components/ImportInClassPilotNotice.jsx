export default function ImportInClassPilotNotice({ canLink, onGoToClassPilot }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100"
      data-testid="import-in-classpilot-notice"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Students are imported in ClassPilot</p>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
            One ClassPilot roster import feeds ClassPilot, PassPilot, and GoPilot automatically.
          </p>
          {!canLink && (
            <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">
              Open ClassPilot on the web to import students.
            </p>
          )}
        </div>
        {canLink && (
          <button
            type="button"
            onClick={onGoToClassPilot}
            className="inline-flex shrink-0 items-center justify-center rounded-md bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 dark:focus:ring-offset-slate-950"
          >
            Go to ClassPilot Students
          </button>
        )}
      </div>
    </div>
  );
}
