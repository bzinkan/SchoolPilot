export default function ClassStartControls({ groups, selectedId, onSelect, activeSession, onStart, disabled, pending, admin = false }) {
  const selected = groups.find(group => group.id === selectedId);
  const teaching = !!selected && activeSession?.groupId === selected.id;
  const action = activeSession ? 'Switch Class' : 'Start Class';
  return <div className="dashboard-class-start-controls" data-testid={admin ? 'admin-class-start-controls' : 'class-start-controls'}>
    <select value={selectedId} onChange={event => onSelect(event.target.value)} disabled={disabled || pending || !groups.length}
      title={selected?.name || 'Choose a class'} aria-label={admin ? 'Select ClassPilot class to teach' : 'Select ClassPilot class'}
      data-testid={admin ? 'select-admin-start-session-group' : 'select-start-session-group'}>
      {!groups.length ? <option value="">No classes assigned</option> : groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select>
    <button type="button" className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled || pending || !selected || teaching} onClick={() => onStart(selected)}
      data-testid={admin ? 'button-admin-start-session' : 'button-start-session'}>{teaching ? 'Teaching' : pending ? 'Starting…' : action}</button>
  </div>;
}
