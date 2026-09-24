export default function KioskActivityBanner({ activity }) {
  if (!activity) return null;
  const formatTime = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: activity.timezone });
  const status = {
    idle: 'No class scheduled. Outstanding passes can still be returned.',
    pending: 'Waiting for the scheduled testing activity to start.',
    failed: 'The scheduled testing activity could not start. Ask your teacher for help.',
    conflict: 'More than one assignment is scheduled. Ask your teacher to select a class.',
    unavailable: activity.message || 'Schedule unavailable. New passes are paused.',
  }[activity.status];
  return (
    <div className="w-full px-4 py-3 text-center text-sm text-slate-200 bg-slate-800/70" role="status">
      <p className="font-medium">
        {activity.overridden ? `Temporary override until ${formatTime(activity.overrideExpiresAt)}`
          : activity.mode === 'manual' ? 'Manual class selection' : 'Following schedule'}
        {activity.current && activity.status === 'ready' ? ` · ${activity.current.name} · until ${formatTime(activity.current.endsAt)}` : ''}
      </p>
      {status ? <p className="mt-1">{status}</p> : null}
      {activity.next ? <p className="mt-1 text-slate-400">Next: {activity.next.name} · {formatTime(activity.next.startsAt)}</p> : null}
    </div>
  );
}
