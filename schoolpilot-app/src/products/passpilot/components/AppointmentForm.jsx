import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { appointmentRequest, appointmentScope } from '../appointmentData';
import { chosenSchoolInstant, schoolWallTime, schoolWallTimeCandidates } from '../appointmentModel';

const fieldClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
const destinations = [['bathroom', 'Bathroom'], ['nurse', 'Nurse'], ['office', 'Office'], ['counselor', 'Counselor'], ['other_classroom', 'Other classroom'], ['custom', 'Custom destination']];

function SchoolTimeField({ id, label, wallTime, setWallTime, selected, setSelected, timeZone }) {
  const choices = useMemo(() => schoolWallTimeCandidates(wallTime, timeZone), [wallTime, timeZone]);
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label>
    <Input id={id} type="datetime-local" value={wallTime} required onChange={event => { setWallTime(event.target.value); setSelected(''); }} />
    {wallTime && !choices.length ? <p role="alert" className="text-sm text-destructive">This time does not exist in {timeZone}. Choose another time.</p> : null}
    {choices.length > 1 ? <><Label htmlFor={`${id}-offset`}>Choose {label.toLowerCase()} offset</Label>
      <select id={`${id}-offset`} className={fieldClass} required value={choices.some(choice => choice.instant === selected) ? selected : ''} onChange={event => setSelected(event.target.value)}>
        <option value="">This clock time occurs twice</option>{choices.map((choice, index) => <option key={choice.instant} value={choice.instant}>{index ? 'Later' : 'Earlier'} occurrence — UTC{choice.offset}</option>)}
      </select></> : null}
  </div>;
}

export default function AppointmentForm({ initial, school, user, timeZone, busy, onSave, onCancel }) {
  const id = useId(), [requestId] = useState(() => crypto.randomUUID());
  const [selectedStudent, setSelectedStudent] = useState(initial ? { id: initial.studentId, name: initial.studentName } : null);
  const [search, setSearch] = useState(''), [destination, setDestination] = useState(initial?.destination || 'office');
  const [customDestination, setCustomDestination] = useState(initial?.customDestination || ''), [staffNotes, setStaffNotes] = useState(initial?.staffNotes || '');
  const [duration, setDuration] = useState(initial?.duration || school.defaultPassDuration || 5);
  const [startsWall, setStartsWall] = useState(() => schoolWallTime(initial?.startsAt || Date.now() + 10 * 60000, timeZone));
  const [endsWall, setEndsWall] = useState(() => schoolWallTime(initial?.endsAt || Date.now() + 40 * 60000, timeZone));
  const [startsInstant, setStartsInstant] = useState(initial?.startsAt || ''), [endsInstant, setEndsInstant] = useState(initial?.endsAt || '');
  const [error, setError] = useState('');
  const students = useQuery({ queryKey: ['passpilot-appointments', ...appointmentScope(user, school), 'student-search', search.trim()],
    enabled: !selectedStudent && search.trim().length >= 2, retry: false,
    queryFn: ({ signal }) => appointmentRequest(school.id, 'GET', `/students?search=${encodeURIComponent(search.trim())}`, undefined, signal) });
  const submit = event => {
    event.preventDefault(); setError('');
    try {
      if (!selectedStudent) throw new Error('Choose a current student.');
      const startsAt = chosenSchoolInstant(startsWall, startsInstant, timeZone), endsAt = chosenSchoolInstant(endsWall, endsInstant, timeZone);
      const elapsed = new Date(endsAt).getTime() - new Date(startsAt).getTime();
      if (elapsed <= 0 || elapsed > 24 * 60 * 60 * 1000) throw new Error('Choose an appointment window of no more than 24 hours, with the end after the start.');
      onSave({ studentId: selectedStudent.id, destination, customDestination: destination === 'custom' ? customDestination.trim() : null,
        staffNotes: staffNotes.trim() || null, startsAt, endsAt, duration: Number(duration),
        ...(initial ? { expectedRevision: initial.revision } : { requestId }) });
    } catch (cause) { setError(cause.message); }
  };
  return <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-4" aria-label={initial ? 'Edit appointment' : 'Schedule appointment'}>
    <h3 className="font-semibold">{initial ? 'Edit pending appointment' : 'Schedule an appointment'}</h3>
    <p className="text-sm text-muted-foreground">Times are in {timeZone}. A teacher opens the pass manually during this window.</p>
    <fieldset disabled={busy} className="space-y-4">
      {selectedStudent ? <div><Label>Student</Label><p>{selectedStudent.name || 'Selected student'} <Button type="button" variant="outline" size="sm" onClick={() => setSelectedStudent(null)}>Change student</Button></p></div> : <div className="space-y-2">
        <Label htmlFor={`${id}-student`}>Search students</Label><Input id={`${id}-student`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Type at least two characters" />
        {students.isFetching ? <p role="status">Finding students…</p> : null}
        {students.isError ? <p role="alert">Students could not be loaded. <Button type="button" variant="outline" onClick={() => students.refetch()}>Retry student search</Button></p> : null}
        {students.isSuccess ? <ul className="max-h-48 space-y-1 overflow-y-auto">{(students.data?.students || []).slice(0, 20).map(student => <li key={student.id}><Button type="button" variant="outline" size="sm" onClick={() => setSelectedStudent({ id: student.id, name: [student.firstName, student.lastName].filter(Boolean).join(' ') })}>{[student.firstName, student.lastName].filter(Boolean).join(' ')}{student.gradeLevel ? ` — Grade ${student.gradeLevel}` : ''}</Button></li>)}
          {!students.data?.students?.length ? <li>No current students match.</li> : null}</ul> : null}
      </div>}
      <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor={`${id}-destination`}>Destination</Label><select id={`${id}-destination`} className={fieldClass} value={destination} onChange={event => setDestination(event.target.value)}>{destinations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div><Label htmlFor={`${id}-duration`}>Pass duration (minutes)</Label><Input id={`${id}-duration`} type="number" min="1" max="120" required value={duration} onChange={event => setDuration(event.target.value)} /></div></div>
      {destination === 'custom' ? <div><Label htmlFor={`${id}-custom`}>Custom destination</Label><Input id={`${id}-custom`} required maxLength={200} value={customDestination} onChange={event => setCustomDestination(event.target.value)} /></div> : null}
      <div className="grid gap-4 sm:grid-cols-2"><SchoolTimeField id={`${id}-starts`} label="Window start" wallTime={startsWall} setWallTime={setStartsWall} selected={startsInstant} setSelected={setStartsInstant} timeZone={timeZone} />
        <SchoolTimeField id={`${id}-ends`} label="Window end" wallTime={endsWall} setWallTime={setEndsWall} selected={endsInstant} setSelected={setEndsInstant} timeZone={timeZone} /></div>
      <div><Label htmlFor={`${id}-notes`}>Private manager note</Label><textarea id={`${id}-notes`} className={fieldClass} rows={3} maxLength={2000} value={staffNotes} onChange={event => setStaffNotes(event.target.value)} />
        <p className="text-xs text-muted-foreground">Visible to PassPilot managers. This note is omitted from teacher reminders and passes.</p></div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit">{busy ? 'Saving…' : initial ? 'Save appointment changes' : 'Schedule appointment'}</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel editing</Button></div>
    </fieldset>
  </form>;
}
