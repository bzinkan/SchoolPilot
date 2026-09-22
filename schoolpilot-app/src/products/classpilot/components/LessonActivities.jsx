import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';

const STATUSES = [['not_reported', 'Not reported'], ['working', 'Working'], ['stuck', 'Stuck'], ['ready_for_review', 'Ready for review'], ['finished', 'Finished']];

export function LessonEditor({ activity, onSave, onCancel, pending, submitLabel }) {
  const [title, setTitle] = useState(activity?.title || 'Independent work');
  const [instructions, setInstructions] = useState(activity?.instructions || '');
  const [resources, setResources] = useState(activity?.resources || []);
  const [checklist, setChecklist] = useState(activity?.checklist || []);
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); onSave({ title, instructions, resources, checklist }); }}>
    <label className="block text-xs font-medium">Activity title<Input value={title} onChange={event => setTitle(event.target.value)} required maxLength={200} /></label>
    <label className="block text-xs font-medium">Pinned instructions<Textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} rows={4} /></label>
    {resources.map((resource, index) => <div key={index} className="flex gap-1">
      <Input aria-label={`Resource ${index + 1} title`} placeholder="Resource name" required maxLength={100} value={resource.title} onChange={event => setResources(rows => rows.map((row, at) => at === index ? { ...row, title: event.target.value } : row))} />
      <Input aria-label={`Resource ${index + 1} URL`} placeholder="https://…" required type="url" value={resource.url} onChange={event => setResources(rows => rows.map((row, at) => at === index ? { ...row, url: event.target.value } : row))} />
      <Button type="button" variant="ghost" aria-label={`Remove resource ${index + 1}`} onClick={() => setResources(rows => rows.filter((_, at) => at !== index))}>×</Button>
    </div>)}
    {resources.length < 10 && <Button type="button" variant="outline" size="sm" onClick={() => setResources(rows => [...rows, { title: '', url: '' }])}>Add resource</Button>}
    {checklist.map((item, index) => <div key={item.id} className="flex gap-1"><Input aria-label={`Checklist item ${index + 1}`} required maxLength={200} value={item.text} onChange={event => setChecklist(rows => rows.map(row => row.id === item.id ? { ...row, text: event.target.value } : row))} />
      <Button type="button" variant="ghost" aria-label={`Remove checklist item ${index + 1}`} onClick={() => setChecklist(rows => rows.filter(row => row.id !== item.id))}>×</Button></div>)}
    {checklist.length < 20 && <Button type="button" size="sm" variant="outline" onClick={() => setChecklist(rows => [...rows, { id: crypto.randomUUID(), text: '' }])}>Add checklist item</Button>}
    <p className="text-xs text-slate-500">Students choose their work status. Checklist completion does not change it.</p>
    <div className="flex gap-2"><Button disabled={pending}>{submitLabel || (activity ? 'Save instructions' : 'Start activity')}</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </form>;
}

export function FollowUp({ tools, group, onClose }) {
  const [recipients, setRecipients] = useState(null);
  const [kind, setKind] = useState('teacher-message');
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const preview = async () => {
    setError(''); try { const response = await tools.mutate({ path: 'follow-up-preview', data: group }); setRecipients(response.recipients); } catch (failure) { setError(failure.message); }
  };
  return <section className="border rounded-lg p-3 space-y-3" aria-label="Follow-up recipients">
    <div className="flex items-center justify-between"><h4 className="font-medium text-sm">Follow up with this group</h4><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>
    {!recipients && <Button onClick={preview} disabled={tools.pending}>Preview exact recipients</Button>}
    {recipients && <>
      <ul className="max-h-36 overflow-auto text-sm space-y-1">{recipients.map(student => <li key={student.studentId}>{student.name}{!student.available && <span className="text-amber-700"> — {student.reason}</span>}</li>)}</ul>
      {recipients.length === 0 ? <p className="text-sm">No students in this group.</p> : <>
        <label className="block text-xs">Action<select className="block w-full border rounded p-2 bg-transparent" value={kind} onChange={event => { setKind(event.target.value); setValue(''); }}><option value="teacher-message">Send message</option><option value="open-tab">Open resource</option></select></label>
        <label className="block text-xs">{kind === 'teacher-message' ? 'Message' : 'Resource URL'}<Textarea value={value} maxLength={kind === 'teacher-message' ? 500 : 2048} onChange={event => setValue(event.target.value)} /></label>
        <Button disabled={pending || !value.trim()} onClick={async () => { setPending(true); setError(''); try { setResult(await tools.mutate({ path: 'follow-up', data: { kind: group.kind, resourceId: group.resourceId, targetStudentIds: recipients.map(row => row.studentId), commandType: kind, commandPayload: kind === 'teacher-message' ? { message: value.trim() } : { url: value.trim() } } })); } catch (failure) { setError(failure.message); } finally { setPending(false); } }}>Send to these {recipients.length} students</Button>
      </>}
    </>}
    {result && <DeliveryOutcomes targets={result.command?.targets || []} />}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>;
}

export function DeliveryOutcomes({ targets = [] }) {
  if (!targets.length) return null;
  const unsupported = targets.filter(row => row.errorMessage?.startsWith('Unsupported client:')).length;
  const reached = targets.filter(row => ['received', 'completed'].includes(row.status)).length;
  const unavailable = targets.filter(row => ['failed', 'unavailable', 'expired'].includes(row.status) && !row.errorMessage?.startsWith('Unsupported client:')).length;
  const pending = targets.length - reached - unavailable - unsupported;
  return <div className="text-xs space-y-1" data-testid="class-tools-delivery"><p>{reached} reached · {unavailable} unavailable · {unsupported} unsupported · {pending} pending</p>
    {targets.filter(row => row.errorMessage).map(row => <p key={row.studentId}>{row.studentName || row.studentId}: {row.errorMessage}</p>)}</div>;
}

export default function LessonActivities({ tools, onCommand, onShowHistory }) {
  const activity = tools.data?.activity;
  const [editor, setEditor] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [group, setGroup] = useState(null);
  const targets = tools.data?.activityTargets || [];
  const progress = tools.data?.progress || [];
  const counts = new Map(STATUSES.map(([status]) => [status, status === 'not_reported' ? targets.filter(target => !progress.some(row => row.studentId === target.studentId && row.status !== 'not_reported')).length : progress.filter(row => row.status === status).length]));
  const command = async payload => { setPending(true); setError(''); try { await onCommand('lesson-activity', payload); await tools.refresh(); setEditor(null); setGroup(null); } catch (failure) { setError(failure.message); } finally { setPending(false); } };
  return <section className="space-y-3 border-b pb-4">
    <div className="flex justify-between items-center"><h3 className="font-semibold text-sm">Lesson activity</h3><Button size="sm" variant="ghost" onClick={onShowHistory}>History</Button></div>
    {editor ? <LessonEditor key={editor} activity={editor === 'edit' ? activity : null} pending={pending} onCancel={() => setEditor(null)} onSave={content => command(editor === 'edit' ? { ...content, action: 'update', activityId: activity.id, expectedRevision: activity.revision } : { ...content, action: 'start' })} /> : activity ? <>
      <h4 className="font-medium">{activity.title}</h4><p className="text-sm whitespace-pre-wrap">{activity.instructions}</p>
      <div className="flex flex-wrap gap-2">{STATUSES.map(([status, label]) => <Button key={status} variant="outline" size="sm" onClick={() => setGroup({ kind: 'work_status', resourceId: activity.id, status })}>{label} {counts.get(status)}</Button>)}</div>
      <DeliveryOutcomes targets={targets} />
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setEditor('edit')}>Edit instructions</Button><Button variant="outline" size="sm" onClick={() => setEditor('new')}>New activity</Button><Button variant="ghost" size="sm" disabled={pending} onClick={() => command({ action: 'end', activityId: activity.id, expectedRevision: activity.revision })}>End activity</Button></div>
      {group && <FollowUp key={JSON.stringify(group)} tools={tools} group={group} onCommand={onCommand} onClose={() => setGroup(null)} />}
    </> : <><p className="text-xs text-slate-500">Pin directions and let students report how their work is going.</p><Button onClick={() => setEditor('new')}>Start lesson activity</Button></>}
    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
  </section>;
}

export function ExitTicketEditor({ tools, onCommand, activePoll }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('What is still confusing?');
  const [responseType, setResponseType] = useState('short_text');
  const [options, setOptions] = useState('Ready for more\nNeed another example\nNeed help');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <section className="space-y-2"><h3 className="font-semibold text-sm">Exit ticket</h3>
    {open ? <form className="space-y-2" onSubmit={async event => { event.preventDefault(); setPending(true); setError(''); try { await onCommand('poll', { action: 'start', purpose: 'exit_ticket', responseType, question, options: responseType === 'choice' ? options.split('\n').filter(Boolean) : [] }); tools.refresh(); setOpen(false); } catch (failure) { setError(failure.message); } finally { setPending(false); } }}>
      <label className="text-xs">Question<Textarea maxLength={500} required value={question} onChange={event => setQuestion(event.target.value)} /></label>
      <select className="w-full border rounded p-2 bg-transparent" aria-label="Exit ticket response type" value={responseType} onChange={event => setResponseType(event.target.value)}><option value="short_text">Short text (500 characters)</option><option value="choice">Multiple choice</option></select>
      {responseType === 'choice' && <label className="text-xs">Choices, one per line (2–5)<Textarea value={options} onChange={event => setOptions(event.target.value)} /></label>}
      <div className="flex gap-2"><Button disabled={pending || Boolean(activePoll)}>Send exit ticket</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form> : <Button variant="outline" disabled={Boolean(activePoll)} onClick={() => setOpen(true)}>Prepare exit ticket</Button>}
    {activePoll && <p className="text-xs text-slate-500">Close the current response prompt before starting another.</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>;
}

export function ToolsHistory({ tools, events, onClose, onMore, pending }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const review = async event => {
    try { setError(''); setItem(await tools.read(`history/${event.kind.startsWith('activity_') ? 'activity' : 'prompt'}/${encodeURIComponent(event.resourceId)}`)); } catch (failure) { setError(failure.message); }
  };
  return <section className="space-y-3"><div className="flex justify-between"><h3 className="font-semibold">Activity history</h3><Button size="sm" variant="ghost" onClick={onClose}>Back</Button></div>
    {item && <article className="rounded-lg border p-3 space-y-2"><Button variant="ghost" size="sm" onClick={() => setItem(null)}>Close review</Button>
      {item.activity ? <><h4 className="font-medium">{item.activity.title}</h4><p className="whitespace-pre-wrap text-sm">{item.activity.instructions}</p><p className="text-xs">{item.progress.length} students reported progress</p></> : <><h4 className="font-medium">{item.prompt.question}</h4><p className="text-xs">{item.responses.length} responses</p><ul className="space-y-2 text-sm">{item.responses.map(response => <li key={response.studentId}><strong>{response.firstName} {response.lastName}</strong><p className="whitespace-pre-wrap">{response.textResponse ?? item.prompt.options[response.selectedOption]}</p></li>)}</ul></>}
    </article>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {events.length === 0 && <p className="text-sm text-slate-500">No Class tools activity recorded yet.</p>}
    <ol className="space-y-2 text-sm">{events.map(event => <li key={event.id} className="border-b pb-2"><p>{event.kind.replaceAll('_', ' ')}</p><time className="text-xs text-slate-500" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>{/^(activity_|prompt_|exit_ticket_response)/.test(event.kind) && <Button variant="link" size="sm" onClick={() => review(event)}>Review</Button>}</li>)}</ol>
    {onMore && <Button variant="outline" disabled={pending} onClick={onMore}>Load earlier activity</Button>}
  </section>;
}
