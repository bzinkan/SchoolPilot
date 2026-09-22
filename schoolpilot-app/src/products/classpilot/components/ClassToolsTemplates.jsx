import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { DeliveryOutcomes, LessonEditor } from './LessonActivities';

const STEP_NAMES = { instructions: 'Publish instructions', resource: 'Open a resource', flight_path: 'Apply Flight Path', timer: 'Start timer', poll: 'Prepare poll', exit_ticket: 'Prepare exit ticket' };
function newStep(kind) {
  return { kind, title: STEP_NAMES[kind], payload: kind === 'instructions' ? { title: 'Independent work', instructions: '', resources: [], checklist: [] }
    : kind === 'resource' ? { url: '' } : kind === 'flight_path' ? { flightPathId: '' } : kind === 'timer' ? { seconds: 300, message: '' }
      : { purpose: kind === 'exit_ticket' ? 'exit_ticket' : 'poll', question: kind === 'exit_ticket' ? 'What is still confusing?' : 'Ready to move on?', responseType: kind === 'exit_ticket' ? 'short_text' : 'choice', options: kind === 'exit_ticket' ? [] : ['Ready', 'Need another example'] } };
}

function PromptFields({ value, onChange }) {
  return <div className="space-y-2"><label className="block text-xs">Question<Textarea required maxLength={500} value={value.question} onChange={event => onChange({ ...value, question: event.target.value })} /></label>
    {value.purpose === 'exit_ticket' && <label className="block text-xs">Response type<select className="w-full p-2 border rounded bg-transparent" value={value.responseType} onChange={event => onChange({ ...value, responseType: event.target.value, options: event.target.value === 'short_text' ? [] : ['Ready', 'Need help'] })}><option value="short_text">Short text</option><option value="choice">Multiple choice</option></select></label>}
    {value.responseType === 'choice' && <label className="block text-xs">Choices, one per line (2–5)<Textarea required value={value.options.join('\n')} onChange={event => onChange({ ...value, options: event.target.value.split('\n') })} /></label>}
  </div>;
}

function RoutineEditor({ value, onChange, flightPaths }) {
  const update = (at, patch) => onChange({ ...value, steps: value.steps.map((step, index) => index === at ? { ...step, ...patch } : step) });
  return <div className="space-y-3"><label className="block text-xs">Routine title<Input required maxLength={200} value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <p className="text-xs text-slate-500">You advance every step. A timer finishing never starts the next step.</p>
    {value.steps.map((step, index) => <fieldset key={index} className="border rounded-lg p-3 space-y-2"><legend className="px-1 text-xs font-medium">Step {index + 1}</legend>
      <label className="block text-xs">Action<select className="block w-full border rounded p-2 bg-transparent" value={step.kind} onChange={event => update(index, newStep(event.target.value))}>{Object.entries(STEP_NAMES).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label className="block text-xs">Step name<Input required maxLength={200} value={step.title} onChange={event => update(index, { title: event.target.value })} /></label>
      {step.kind === 'instructions' && <><label className="block text-xs">Activity title<Input required maxLength={200} value={step.payload.title} onChange={event => update(index, { payload: { ...step.payload, title: event.target.value } })} /></label><label className="block text-xs">Instructions<Textarea maxLength={4000} value={step.payload.instructions} onChange={event => update(index, { payload: { ...step.payload, instructions: event.target.value } })} /></label></>}
      {step.kind === 'resource' && <label className="block text-xs">Resource URL<Input required type="url" maxLength={2048} value={step.payload.url} onChange={event => update(index, { payload: { url: event.target.value } })} /></label>}
      {step.kind === 'flight_path' && <label className="block text-xs">Saved Flight Path<select required className="block w-full border rounded p-2 bg-transparent" value={step.payload.flightPathId} onChange={event => update(index, { payload: { flightPathId: event.target.value } })}><option value="">Choose Flight Path</option>{flightPaths.map(path => <option key={path.id} value={path.id}>{path.flightPathName}</option>)}</select></label>}
      {step.kind === 'timer' && <><label className="block text-xs">Minutes (1–60)<Input type="number" required min={1} max={60} value={step.payload.seconds / 60} onChange={event => update(index, { payload: { ...step.payload, seconds: Number(event.target.value) * 60 } })} /></label><label className="block text-xs">Timer label<Input maxLength={500} value={step.payload.message} onChange={event => update(index, { payload: { ...step.payload, message: event.target.value } })} /></label></>}
      {['poll', 'exit_ticket'].includes(step.kind) && <PromptFields value={step.payload} onChange={payload => update(index, { payload })} />}
      <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => { const steps = [...value.steps]; [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; onChange({ ...value, steps }); }}>Move up</Button><Button type="button" variant="ghost" size="sm" disabled={value.steps.length === 1} onClick={() => onChange({ ...value, steps: value.steps.filter((_, at) => at !== index) })}>Remove step</Button></div>
    </fieldset>)}
    <Button type="button" variant="outline" disabled={value.steps.length >= 20} onClick={() => onChange({ ...value, steps: [...value.steps, newStep('resource')] })}>Add step</Button>
  </div>;
}

function RoutineRun({ tools }) {
  const run = tools.data?.routine;
  const [result, setResult] = useState(null);
  const act = async (action, step) => { try { setResult(await tools.mutate({ path: `routines/${run.id}`, data: { action, expectedRevision: run.revision, ...(step !== undefined ? { step } : {}) } })); } catch { /* Shared mutation toast. */ } };
  if (!run) return null;
  const next = run.steps[run.currentStep];
  const prepared = run.outcomes.find(outcome => outcome.step === run.currentStep)?.state === 'prepared';
  const roster = tools.data?.roster || [];
  return <section className="border rounded-lg p-3 space-y-3" aria-label="Current routine"><h3 className="font-semibold">{run.title}</h3>
    <details><summary className="text-xs cursor-pointer">Original recipients ({run.targetStudentIds.length})</summary><ul className="text-xs">{run.targetStudentIds.map(id => { const student = roster.find(row => row.studentId === id); return <li key={id}>{student ? `${student.firstName} ${student.lastName}` : 'Student no longer in this classroom'}</li>; })}</ul></details>
    {next ? <><p className="text-sm">Next: {next.title}</p>{prepared && <p className="text-xs whitespace-pre-wrap">{next.payload.question}</p>}<div className="flex flex-wrap gap-2"><Button size="sm" disabled={tools.pending} onClick={() => act(prepared ? 'launch' : 'next')}>{prepared ? 'Send prepared prompt' : STEP_NAMES[next.kind]}</Button><Button size="sm" variant="ghost" disabled={tools.pending} onClick={() => act('skip')}>Skip step</Button></div></> : <p className="text-sm">All steps have been advanced.</p>}
    <ol className="space-y-3">{(tools.data?.routineOutcomes || []).map(outcome => <li key={outcome.step} className="text-xs border-t pt-2"><p className="font-medium">{run.steps[outcome.step]?.title} · {outcome.state}</p><DeliveryOutcomes targets={outcome.targets} />{outcome.commandIds.length > 0 && <Button size="sm" variant="outline" disabled={tools.pending} onClick={() => act('retry', outcome.step)}>Retry eligible unsuccessful students</Button>}</li>)}</ol>
    {result?.command && <DeliveryOutcomes targets={result.command.targets} />}
    <Button size="sm" variant="ghost" disabled={tools.pending} onClick={() => act('end')}>End routine</Button>
  </section>;
}

export default function ClassToolsTemplates({ tools, onCommand, flightPaths = [], getRecipients }) {
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const kinds = [['attention', 'Attention message'], ['poll', 'Poll'], ...(tools.phase >= 3 ? [['exit_ticket', 'Exit ticket'], ['activity', 'Lesson activity']] : []), ...(tools.phase >= 5 ? [['routine', 'Routine']] : [])];
  const create = kind => setEditor({ kind, name: '', content: kind === 'attention' ? { message: 'Eyes up, please.' } : kind === 'activity' ? null : kind === 'routine' ? { title: 'Independent work', steps: [newStep('instructions'), newStep('timer'), newStep('exit_ticket')] } : newStep(kind).payload });
  const save = async content => { if (!editor.name.trim()) { setError('Give this template a name.'); return; } try { setError(''); await tools.mutate({ path: 'templates', data: { name: editor.name, kind: editor.kind, content: content ?? editor.content, ...(editor.id ? { id: editor.id, expectedRevision: editor.revision } : {}) } }); setEditor(null); } catch { /* Shared mutation toast. */ } };
  const use = async template => {
    try {
      setError('');
      const ids = getRecipients();
      if (!ids.length) throw new Error('Choose students before preparing this action.');
      setPreview({ template, ids });
    } catch (failure) { setError(failure.message); }
  };
  const send = async () => {
    setPending(true); setError('');
    try {
      const { template, ids } = preview;
      if (template.kind === 'routine') await tools.mutate({ path: 'routines', data: { templateId: template.id, targetStudentIds: ids } });
      else await onCommand(template.kind === 'attention' ? 'attention-mode' : template.kind === 'activity' ? 'lesson-activity' : 'poll', { ...template.content, ...(template.kind === 'attention' ? { active: true } : { action: 'start' }) }, { studentIds: ids });
      setPreview(null);
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  };
  return <section className="space-y-3 border-t pt-4"><RoutineRun tools={tools} /><h3 className="font-semibold text-sm">My templates</h3><p className="text-xs text-slate-500">Private to you in this school.</p>
    {preview && <article className="rounded-lg border p-3 space-y-2"><h4 className="font-medium">{preview.template.name}</h4><p className="text-xs">For these {preview.ids.length} students:</p><ul className="max-h-32 overflow-auto text-sm">{preview.ids.map(id => { const student = tools.data?.roster.find(row => row.studentId === id); return <li key={id}>{student ? `${student.firstName} ${student.lastName}` : 'Student unavailable'}</li>; })}</ul><Button disabled={pending || tools.pending} onClick={send}>{preview.template.kind === 'routine' ? 'Start routine' : 'Send to these students'}</Button><Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button></article>}
    {editor ? <div className="space-y-3 border rounded p-3"><label className="block text-xs">Template name<Input required maxLength={100} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      {editor.kind === 'activity' ? <LessonEditor activity={editor.content} submitLabel="Save template" pending={tools.pending} onCancel={() => setEditor(null)} onSave={save} /> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
        {editor.kind === 'attention' ? <label className="block text-xs">Attention message<Textarea required maxLength={500} value={editor.content.message} onChange={event => setEditor({ ...editor, content: { message: event.target.value } })} /></label> : editor.kind === 'routine' ? <RoutineEditor value={editor.content} onChange={content => setEditor({ ...editor, content })} flightPaths={flightPaths} /> : <PromptFields value={editor.content} onChange={content => setEditor({ ...editor, content })} />}
        <Button disabled={tools.pending}>Save template</Button><Button type="button" variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
      </form>}
    </div> : <div className="flex flex-wrap gap-2">{kinds.map(([kind, label]) => <Button key={kind} size="sm" variant="outline" onClick={() => create(kind)}>Save {label.toLowerCase()}</Button>)}</div>}
    <ul className="space-y-2">{(tools.data?.templates || []).filter(template => kinds.some(([kind]) => kind === template.kind)).map(template => <li key={template.id} className="border rounded p-2 text-sm"><p className="font-medium">{template.name}</p><div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => use(template)} disabled={tools.pending}>Use</Button><Button size="sm" variant="ghost" onClick={() => setEditor({ id: template.id, revision: template.revision, name: template.name, kind: template.kind, content: template.content })}>Edit</Button><Button size="sm" variant="ghost" disabled={tools.pending} onClick={() => tools.mutate({ method: 'DELETE', path: `templates/${template.id}`, data: { expectedRevision: template.revision } }).catch(() => {})}>Delete</Button></div></li>)}</ul>
    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
  </section>;
}
