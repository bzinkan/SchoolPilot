export default function ClassStartControls({ groups, selectedId, onSelect, activeSession, manualToday, onStart, disabled, pending, admin = false, part = 'all' }) {
  const selected = groups.find(group => group.id === selectedId);
  const teaching = !!selected && activeSession?.groupId === selected.id;
  const isManualToday = manualToday?.isManualToday === true;
  const status = isManualToday ? 'Manual today' : selected?.scheduleEnabled ? 'Automatic' : 'Manual';
  const action = activeSession ? 'Switch Class' : 'Start Class';
  const buttonClass = 'inline-flex h-8 shrink-0 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';
  return <div className="dashboard-header-group" data-testid={part === 'action' ? (admin ? 'admin-class-start-action' : 'class-start-action') : (admin ? 'admin-class-start-controls' : 'class-start-controls')}>
    {part !== 'action' ? <>
    <select value={selectedId} onChange={event => onSelect(event.target.value)} disabled={disabled || pending || !groups.length} title={selected?.name || 'Choose a class'}
      className="h-8 w-[160px] max-w-[160px] rounded-md border border-chrome-control-border bg-chrome-control px-2 text-xs font-medium text-chrome-fg shadow-sm focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={admin ? 'Select ClassPilot class to teach' : 'Select ClassPilot class'} data-testid={admin ? 'select-admin-start-session-group' : 'select-start-session-group'}>
      {!groups.length ? <option value="">No classes assigned</option> : groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select>
    {selected ? <span className="text-xs text-chrome-muted" data-testid="selected-class-schedule-status">{status}{teaching ? ' · Teaching' : ''}</span> : null}
    </> : null}
    {part !== 'picker' ?
    <button type="button" className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={disabled || pending || !selected || teaching}
      onClick={() => onStart(selected)} data-testid={admin ? 'button-admin-start-session' : 'button-start-session'}>{teaching ? 'Teaching' : pending ? 'Starting…' : action}</button> : null}
  </div>;
}
