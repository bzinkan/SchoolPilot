import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { passPilotClassRequest } from '../classData';

const inputClass = 'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900';
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const errorMessage = error => error?.response?.data?.error || error?.message || 'The schedule could not be saved.';
const newBlock = weekly => ({ id: crypto.randomUUID(), classId: '', startTime: '08:00', endTime: '09:00',
  ...(weekly ? { weekdays: [1, 2, 3, 4, 5], startsOn: null, endsOn: null } : {}) });

function BlockEditor({ block, classes, weekly, onChange, onRemove }) {
  const change = (key, value) => onChange({ ...block, [key]: value });
  return <fieldset className="rounded-lg border border-slate-200 p-4 space-y-3">
    <legend className="px-1 text-sm font-medium">Class block</legend>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Class<select aria-label="Class" className={inputClass} value={block.classId} onChange={e => change('classId', e.target.value)} required>
        <option value="">Choose a class</option>{classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      <label className="text-sm">Start time<input className={inputClass} type="time" value={block.startTime} onChange={e => change('startTime', e.target.value)} required /></label>
      <label className="text-sm">End time<input className={inputClass} type="time" value={block.endTime} onChange={e => change('endTime', e.target.value)} required /></label>
    </div>
    {weekly ? <>
      <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-sm">Meeting days</legend>
        {days.map((label, day) => <label key={day} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={block.weekdays.includes(day)} onChange={e => change('weekdays', e.target.checked
          ? [...block.weekdays, day].sort() : block.weekdays.filter(d => d !== day))} />{label}</label>)}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">First date (optional)<input className={inputClass} type="date" value={block.startsOn || ''} onChange={e => change('startsOn', e.target.value || null)} /></label>
        <label className="text-sm">Last date (optional)<input className={inputClass} type="date" value={block.endsOn || ''} onChange={e => change('endsOn', e.target.value || null)} /></label>
      </div>
    </> : null}
    <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove block</Button>
  </fieldset>;
}

function ScheduleForm({ data, teacherId, queryKey }) {
  const [mode, setMode] = useState(data.preference.mode);
  const [schedule, setSchedule] = useState(data.preference.schedule);
  const [notice, setNotice] = useState('');
  const save = useMutation({
    mutationFn: () => passPilotClassRequest('PUT', `/passpilot/kiosk/preferences?teacherId=${encodeURIComponent(teacherId)}`, { mode, schedule, expectedRevision: data.preference.revision }),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey }), queryClient.invalidateQueries({ queryKey: ['passpilot', 'kiosk-sessions'] })]),
  });
  const resume = useMutation({
    mutationFn: () => passPilotClassRequest('POST', `/passpilot/kiosk/preferences/resume?teacherId=${encodeURIComponent(teacherId)}`, {}),
    onSuccess: () => { setNotice('Automatic scheduling resumed on this teacher’s kiosks.'); queryClient.invalidateQueries({ queryKey: ['passpilot', 'kiosk-sessions'] }); },
  });
  const updateException = (index, value) => setSchedule(previous => ({ ...previous, exceptions: previous.exceptions.map((e, i) => i === index ? value : e) }));
  const preview = data.preview;
  return <form onSubmit={event => { event.preventDefault(); save.mutate(); }} className="space-y-6">
    <section className="rounded-xl border bg-white p-5 space-y-4">
      <label className="block max-w-md font-medium">Kiosk mode<select aria-label="Kiosk mode" value={mode} onChange={e => setMode(e.target.value)} className={inputClass}>
        <option value="manual">Manual — use Send to Kiosk</option>
        {data.source === 'legacy_grades' ? <option value="passpilot">Follow PassPilot schedule</option>
          : <option value="classpilot" disabled={data.canFollowClasspilot === false}>Follow ClassPilot schedule</option>}
      </select></label>
      <p className="text-sm text-slate-600">Applies to this teacher’s kiosks, including future sessions. Send to Kiosk temporarily overrides an automatic schedule until its next transition.</p>
      <p className="text-sm text-slate-600">Times use the school timezone: <strong>{preview.timezone || 'school local time'}</strong>.</p>
      {data.source === 'classpilot_groups' && data.canFollowClasspilot === false ? <p className="text-sm text-amber-800">Active ClassPilot access is required to follow its schedule.</p> : null}
      {data.preference.mode !== 'manual' ? <Button variant="outline" type="button" onClick={() => resume.mutate()} disabled={resume.isPending}>Resume automatic on all kiosks</Button> : null}
    </section>
    {data.source === 'legacy_grades' ? <>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="text-lg font-semibold">Weekly class schedule</h2>
        <p className="text-sm text-slate-600">Choose assigned classes and their meeting times. Blocks must not overlap.</p>
        {!data.classes.length ? <p className="text-sm text-amber-800">Assign classes to this teacher before creating a schedule.</p> : null}
        {schedule.blocks.map((block, index) => <BlockEditor key={block.id} block={block} weekly classes={data.classes}
          onChange={value => setSchedule(previous => ({ ...previous, blocks: previous.blocks.map((b, i) => i === index ? value : b) }))}
          onRemove={() => setSchedule(previous => ({ ...previous, blocks: previous.blocks.filter((_, i) => i !== index) }))} />)}
        <Button type="button" variant="outline" disabled={!data.classes.length} onClick={() => setSchedule(previous => ({ ...previous, blocks: [...previous.blocks, newBlock(true)] }))}>Add weekly block</Button>
      </section>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="text-lg font-semibold">Dated exceptions</h2>
        <p className="text-sm text-slate-600">Replace the entire schedule for a date. Leave its blocks empty for a day off. School closures still apply.</p>
        {schedule.exceptions.map((exception, index) => <div key={index} className="rounded-lg border border-slate-200 p-4 space-y-3">
          <label className="block max-w-xs text-sm">Exception date<input type="date" className={inputClass} value={exception.date} required onChange={e => updateException(index, { ...exception, date: e.target.value })} /></label>
          {!exception.blocks.length ? <p className="text-sm text-slate-600">No classes on this date.</p> : null}
          {exception.blocks.map((block, blockIndex) => <BlockEditor key={block.id} block={block} classes={data.classes}
            onChange={value => updateException(index, { ...exception, blocks: exception.blocks.map((b, i) => i === blockIndex ? value : b) })}
            onRemove={() => updateException(index, { ...exception, blocks: exception.blocks.filter((_, i) => i !== blockIndex) })} />)}
          <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => updateException(index, { ...exception, blocks: [...exception.blocks, newBlock(false)] })}>Add block</Button>
            <Button type="button" variant="ghost" onClick={() => setSchedule(previous => ({ ...previous, exceptions: previous.exceptions.filter((_, i) => i !== index) }))}>Remove exception</Button></div>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setSchedule(previous => ({ ...previous, exceptions: [...previous.exceptions, { date: '', blocks: [] }] }))}>Add dated exception</Button>
      </section>
    </> : <section className="rounded-xl border bg-white p-5 space-y-3">
      <h2 className="text-lg font-semibold">ClassPilot schedule</h2>
      <p className="text-sm text-slate-600">Uses official class times, approved schedule changes, testing, and scheduled coverage. Ordinary classes do not require an open ClassPilot dashboard.</p>
      <Link className="text-sm text-blue-700 underline" to="/classpilot/my-settings/schedule-changes">View ClassPilot schedule changes</Link>
    </section>}
    <section className="rounded-xl border bg-slate-50 p-5 text-sm" aria-label="Saved schedule preview">
      <h2 className="font-semibold mb-2">Saved schedule now</h2>
      <p>{preview.message || (preview.current ? `${preview.current.name} · ${preview.status}` : 'No current assignment')}</p>
      {preview.current ? <p className="mt-1">{new Date(preview.current.startsAt).toLocaleTimeString([], { timeZone: preview.timezone, hour: 'numeric', minute: '2-digit' })}–{new Date(preview.current.endsAt).toLocaleTimeString([], { timeZone: preview.timezone, hour: 'numeric', minute: '2-digit' })}</p> : null}
      {preview.next ? <p className="mt-1">Next: {preview.next.name} · {new Date(preview.next.startsAt).toLocaleString([], { timeZone: preview.timezone })}</p> : null}
    </section>
    {save.error || resume.error ? <div><p role="alert" className="text-sm text-red-700">{errorMessage(save.error || resume.error)}</p>
      <Button type="button" variant="outline" className="mt-2" onClick={() => queryClient.invalidateQueries({ queryKey })}>Reload saved schedule</Button></div> : null}
    {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
    <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save kiosk schedule'}</Button>
  </form>;
}

export default function KioskScheduleSettings() {
  const { user, activeSchoolId } = useAuth();
  const [selectedTeacher, setSelectedTeacher] = useState(null);
  const teacherId = selectedTeacher || user?.id;
  const queryKey = ['passpilot', 'kiosk-preferences', activeSchoolId, teacherId];
  const teacherQuery = useQuery({ queryKey: ['passpilot', 'schedule-teachers', activeSchoolId],
    queryFn: () => passPilotClassRequest('GET', '/passpilot/kiosk/preferences/teachers') });
  const query = useQuery({ queryKey, enabled: !!teacherId, refetchOnWindowFocus: false,
    queryFn: () => passPilotClassRequest('GET', `/passpilot/kiosk/preferences?teacherId=${encodeURIComponent(teacherId)}`) });
  return <div className="max-w-4xl mx-auto space-y-6 pb-8">
    <div><h1 className="text-2xl font-bold text-slate-900">Kiosk schedule</h1><p className="mt-2 text-slate-600">Have the right class ready when students need a pass.</p></div>
    {teacherQuery.data?.teachers.length > 1 ? <label className="block max-w-md text-sm font-medium">Teacher<select aria-label="Teacher" className={inputClass} value={teacherId} onChange={e => setSelectedTeacher(e.target.value)}>
      {teacherQuery.data.teachers.map(t => <option key={t.id} value={t.id}>{t.name || `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Staff member'}</option>)}
    </select></label> : null}
    {query.isLoading ? <p role="status">Loading schedule…</p> : query.error ? <p role="alert">{errorMessage(query.error)}</p>
      : query.data ? <ScheduleForm key={`${activeSchoolId}:${teacherId}:${query.data.preference.revision}`} data={query.data} teacherId={teacherId} queryKey={queryKey} /> : null}
  </div>;
}
