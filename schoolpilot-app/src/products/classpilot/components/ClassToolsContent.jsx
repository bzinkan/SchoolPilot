import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Switch } from '../../../components/ui/switch';
import { ClassTimerCountdown } from './ClassToolsPanel';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import LessonActivities, { DeliveryOutcomes, ExitTicketEditor, ToolsHistory, FollowUp } from './LessonActivities';
import ClassToolsTemplates from './ClassToolsTemplates';

const QUICK_CHECKS = [
  { name: 'Ready to move on?', question: 'Are you ready to move on?', options: ['Ready', 'One more example', 'I need help'] },
  { name: 'Confidence check', question: 'How confident are you?', options: ['Very confident', 'Getting there', 'Not yet'] },
];

function WaitTime({ timestamp }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(id); }, []);
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60000));
  return <span>Waiting {Number.isFinite(minutes) && minutes > 0 ? `${minutes} min` : 'less than a minute'}</span>;
}

function ParkingQuestion({ question, name, tools }) {
  const [answer, setAnswer] = useState(question.answer || '');
  const [groupLabel, setGroupLabel] = useState(question.groupLabel || '');
  const save = (resolve = false) => tools.mutate({ path: `questions/${question.id}`, data: { expectedRevision: question.revision, answer, groupLabel, resolve } }).catch(() => {});
  return <article className="border rounded-lg p-3 space-y-2"><p className="text-xs text-slate-500">{name}</p><p className="text-sm whitespace-pre-wrap">{question.question}</p>
    <Input aria-label={`Group question from ${name}`} placeholder="Group with similar questions" value={groupLabel} maxLength={100} onChange={event => setGroupLabel(event.target.value)} />
    <Textarea aria-label={`Answer question from ${name}`} placeholder="Answer (visible to this student)" value={answer} maxLength={500} onChange={event => setAnswer(event.target.value)} />
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={tools.pending} onClick={() => save()}>Save answer / group</Button><Button size="sm" disabled={tools.pending} onClick={() => save(true)}>Mark answered</Button></div>
  </article>;
}

export function ClassHelp({ tools, raisedHands, handRaisingEnabled, onToggleHandRaising, pending, onDismissHand }) {
  const requests = tools.data?.help;
  const questionGroups = new Map();
  for (const question of tools.data?.questions || []) {
    const group = question.groupLabel?.trim() || 'Ungrouped';
    questionGroups.set(group, [...(questionGroups.get(group) || []), question]);
  }
  const name = id => { const student = tools.data?.roster.find(row => row.studentId === id); return student ? `${student.firstName} ${student.lastName}` : 'Student'; };
  return <div className="p-4 space-y-4">
    <label className="flex items-center justify-between text-sm">Student help requests<Switch data-testid="hands-switch" aria-label="Allow student help requests" checked={handRaisingEnabled} onCheckedChange={onToggleHandRaising} disabled={pending} /></label>
    <p className="text-xs text-slate-500">Oldest request first · Visible only to authorized staff</p>
    {tools.error && <p className="text-xs text-red-600" role="alert">Help updates are unavailable. <button onClick={tools.refresh} type="button" className="underline">Retry</button></p>}
    {requests ? requests.length === 0 ? <p className="text-sm py-6 text-center text-slate-500">No students waiting for help.</p> : requests.map(hand => <article key={hand.id} className="border-b pb-3 space-y-2">
      <div className="flex items-center justify-between gap-2"><div><p className="font-medium text-sm">{name(hand.studentId)}</p><p className="text-xs text-slate-500"><WaitTime timestamp={hand.raisedAt} /> · {hand.status === 'acknowledged' ? 'Acknowledged' : 'Waiting'}</p></div>
        <Button size="sm" variant={hand.status === 'waiting' ? 'default' : 'outline'} disabled={tools.pending} onClick={() => tools.mutate({ path: `help/${hand.id}`, data: { expectedRevision: hand.revision, action: hand.status === 'waiting' ? 'acknowledge' : 'helped' } }).catch(() => {})}>{hand.status === 'waiting' ? 'Acknowledge' : 'Mark helped'}</Button></div>
      <p className="text-xs text-slate-500">{{ assignment: 'Assignment question', blocked_website: 'Blocked website', technical: 'Technical problem' }[hand.category]}</p>{hand.explanation && <p className="text-sm whitespace-pre-wrap">{hand.explanation}</p>}
    </article>) : raisedHands.size === 0 ? <p className="text-sm py-6 text-center text-slate-500">No students waiting for help.</p> : [...raisedHands.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).map(hand => <div key={hand.studentId} className="flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
      <div><p className="font-medium text-sm">{hand.studentName}</p><p className="text-xs text-slate-500"><WaitTime timestamp={hand.timestamp} /></p></div>
      <Button size="sm" variant="outline" onClick={() => onDismissHand(hand.studentId)}>Mark helped</Button>
    </div>)}
    {tools.phase >= 2 && <section className="space-y-3"><h3 className="font-semibold text-sm">Questions for later</h3><p className="text-xs text-slate-500">Group similar questions, then answer during a natural pause.</p>
      {[...questionGroups].map(([group, questions]) => <section key={group} className="space-y-2" aria-label={`Question group: ${group}`}>
        <h4 className="text-xs font-semibold text-slate-500">{group} · {questions.length}</h4>
        {questions.map(question => <ParkingQuestion key={`${question.id}:${question.revision}`} question={question} name={name(question.studentId)} tools={tools} />)}
      </section>)}
      {tools.data?.questions?.length === 0 && <p className="text-sm text-slate-500">No questions waiting.</p>}
    </section>}
  </div>;
}

function PromptResults({ tools, onCommand }) {
  const prompt = tools.data?.prompt;
  const responses = tools.data?.responses || [];
  const [group, setGroup] = useState(null);
  const [pending, setPending] = useState(false);
  if (!prompt) return null;
  const name = id => { const student = tools.data.roster.find(row => row.studentId === id); return student ? `${student.firstName} ${student.lastName}` : 'Student'; };
  return <section className="border rounded-lg p-3 space-y-3"><h3 className="font-semibold text-sm">{prompt.purpose === 'exit_ticket' ? 'Exit ticket' : prompt.purpose === 'volunteer' ? 'Volunteer responses' : 'Current poll'}</h3><p className="text-sm">{prompt.question}</p><p className="text-xs">{responses.length} responses</p><DeliveryOutcomes targets={tools.data.promptTargets} />
    {prompt.responseType === 'short_text' ? <ul className="space-y-3 text-sm">{responses.map(response => <li key={response.studentId}><p className="font-medium">{name(response.studentId)}</p><p className="whitespace-pre-wrap">{response.textResponse}</p></li>)}</ul> : prompt.options.map((option, index) => <Button key={index} size="sm" variant="outline" className="w-full justify-between" onClick={() => setGroup({ kind: 'answer', resourceId: prompt.id, selectedOption: index })}><span>{option}</span><span>{responses.filter(response => response.selectedOption === index).length}</span></Button>)}
    {group && tools.phase >= 3 && <FollowUp key={JSON.stringify(group)} group={group} tools={tools} onCommand={onCommand} onClose={() => setGroup(null)} />}
    <Button variant="outline" size="sm" disabled={pending} onClick={async () => { setPending(true); try { await onCommand('poll', { action: 'close', pollId: prompt.id }); } catch { /* Shared command feedback. */ } finally { setPending(false); } }}>Close response prompt</Button>
  </section>;
}

export function ClassActivityShortcuts({ tools, onCommand, activePoll, responseCount, onPollClick, pollPending, onPreset, flightPaths, getRecipients }) {
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const loadHistory = async (more = false) => {
    try { const cursor = more ? history?.nextCursor : null; const response = await tools.read(`history${cursor ? `?beforeId=${encodeURIComponent(cursor.id)}&beforeTime=${encodeURIComponent(cursor.createdAt)}` : ''}`); setHistory(current => ({ ...response, events: more ? [...current.events, ...response.events] : response.events })); } catch (error) { setHistoryError(error.message); }
  };
  return <div className="p-4 space-y-4">
    {history ? <ToolsHistory tools={tools} events={history.events} onClose={() => setHistory(null)} onMore={history.nextCursor ? () => loadHistory(true) : null} /> : tools.phase >= 3 && <LessonActivities tools={tools} onCommand={onCommand} onShowHistory={() => loadHistory()} />}
    {historyError && <p role="alert" className="text-sm text-red-600">{historyError}</p>}
    <div><h3 className="font-semibold text-sm">Quick checks</h3><p className="text-xs text-slate-500 mt-1">Check understanding before the next step.</p></div>
    {tools.data?.prompt ? <PromptResults tools={tools} onCommand={onCommand} /> : activePoll ? <Button variant="outline" className="w-full" onClick={onPollClick} disabled={pollPending}>View responses ({responseCount})</Button> : <>
      {QUICK_CHECKS.map(preset => <Button key={preset.name} variant="outline" className="w-full justify-start" onClick={() => onPreset(preset)} disabled={pollPending}>{preset.name}</Button>)}
      <Button className="w-full" onClick={onPollClick} disabled={pollPending}>Create poll</Button>
    </>}
    {(tools.data?.templates || []).filter(template => template.kind === 'poll').map(template => <Button key={template.id} variant="outline" className="w-full justify-start" onClick={() => onPreset(template.content)} disabled={pollPending || Boolean(activePoll)}>{template.name}</Button>)}
    {tools.phase >= 3 && <ExitTicketEditor tools={tools} onCommand={onCommand} activePoll={tools.data?.prompt || activePoll} />}
    {tools.phase >= 2 && <ClassToolsTemplates tools={tools} onCommand={onCommand} flightPaths={flightPaths} getRecipients={getRecipients} />}
  </div>;
}

function ParticipationPicker({ tools, onCommand }) {
  const picker = tools.data?.picker;
  const roster = tools.data?.roster || [];
  const selected = roster.find(student => student.studentId === picker?.selectedStudentId);
  const update = (action, extra = {}) => tools.mutate({ path: 'picker', data: { action, expectedRevision: picker?.revision ?? 0, ...extra } }).catch(() => {});
  return <section className="space-y-2 border-t pt-4"><h3 className="font-semibold text-sm">Participation</h3>
    {selected && <p className="text-xl font-semibold" aria-live="polite">{selected.firstName} {selected.lastName}</p>}
    <p className="text-xs text-slate-500">{picker?.usedStudentIds?.length || 0} turns this round. Marked-absent and excluded students are skipped.</p>
    <div className="flex gap-2 flex-wrap"><Button size="sm" onClick={() => update('pick')} disabled={tools.pending}>Pick a student</Button><Button size="sm" variant="outline" disabled={!selected || tools.pending} onClick={() => update('pass')}>Pass</Button><Button size="sm" variant="ghost" disabled={tools.pending} onClick={() => update('reset')}>New round</Button></div>
    <details><summary className="cursor-pointer text-xs">Exclude students for this round</summary><div className="max-h-36 overflow-auto space-y-1 mt-2">{roster.map(student => <label key={student.studentId} className="flex gap-2 text-sm"><input type="checkbox" checked={picker?.excludedStudentIds?.includes(student.studentId) || false} disabled={tools.pending} onChange={event => update('exclude', { excludedStudentIds: event.target.checked ? [...(picker?.excludedStudentIds || []), student.studentId] : (picker?.excludedStudentIds || []).filter(id => id !== student.studentId) })} />{student.firstName} {student.lastName}</label>)}</div></details>
    <Button size="sm" variant="outline" onClick={() => onCommand('poll', { action: 'start', purpose: 'volunteer', responseType: 'choice', question: 'Would you like to share?', options: ['Yes', 'Pass'] }).catch(() => {})}>Ask for volunteers</Button>
    {tools.data?.prompt?.purpose === 'volunteer' && <Button size="sm" variant="outline" disabled={tools.pending} onClick={() => update('pick', { volunteerPollId: tools.data.prompt.id })}>Pick from volunteers</Button>}
  </section>;
}

export function ClassToolShortcuts({ tools, onCommand, onTimerAction, onPresentation, timer, timerActive, timerPending, onTimerClick, attentionActive, attentionPending, onAttentionClick, onReleaseAttention }) {
  return <div className="p-4 space-y-5">
    <section className="space-y-2"><h3 className="text-sm font-semibold">Timer</h3>
      {timer && <ClassTimerCountdown timer={timer} className="block text-3xl font-semibold" />}
      <div className="flex gap-2 flex-wrap">{timer?.id && tools.phase >= 2 && <><Button variant="outline" disabled={timerPending} onClick={() => onTimerAction({ action: timer.pausedRemainingMs != null ? 'resume' : 'pause', timerId: timer.id, expectedRevision: timer.revision })}>{timer.pausedRemainingMs != null ? 'Resume' : 'Pause'}</Button>
        <Button variant="outline" disabled={timerPending} onClick={() => onTimerAction({ action: 'extend', seconds: 60, timerId: timer.id, expectedRevision: timer.revision })}>+1 minute</Button></>}
        <Button variant="outline" disabled={timerPending} onClick={() => timer?.id ? onTimerAction({ action: 'stop', timerId: timer.id, expectedRevision: timer.revision }) : onTimerClick()}>{timer || timerActive ? 'Stop timer' : 'Start timer'}</Button></div>
      <DeliveryOutcomes targets={tools.data?.timerTargets} />
    </section>
    <section className="space-y-2"><h3 className="text-sm font-semibold">Attention</h3><p className="text-xs text-slate-500">Bring the class back together.</p>
      <Button disabled={attentionPending} onClick={attentionActive ? onReleaseAttention : onAttentionClick} className={attentionActive ? 'bg-amber-600 hover:bg-amber-700' : ''}>{attentionActive ? 'Release attention' : 'Eyes up'}</Button>
    </section>
    {tools.phase >= 4 && <><ParticipationPicker tools={tools} onCommand={onCommand} /><Button variant="outline" onClick={onPresentation}>Open presentation view</Button><p className="text-xs text-slate-500">Shows instructions, timer and aggregate choice results.</p></>}
  </div>;
}
