import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { apiRequest } from '../../../lib/queryClient';
import { activityRequestHeaders } from '../lib/dashboardActivity';
import { ClassTimerCountdown } from '../components/ClassToolsPanel';

/** This page mounts without SocketProvider, dashboard, chat, or notifications. */
export default function ClassToolsPresentation() {
  const [params] = useSearchParams();
  const { currentUser, school, isLoading } = useClassPilotAuth();
  const schoolId = params.get('schoolId');
  const teachingSessionId = params.get('teachingSessionId');
  const supervisionContextId = params.get('supervisionContextId');
  const revision = params.get('revision');
  const valid = Boolean(currentUser && school?.id === schoolId && Boolean(teachingSessionId) !== Boolean(supervisionContextId));
  const query = useQuery({ queryKey: ['class-tools-presentation', schoolId, currentUser?.id, teachingSessionId, supervisionContextId, revision],
    enabled: valid, refetchInterval: 5000, retry: false, gcTime: 0,
    queryFn: ({ signal }) => apiRequest('GET', `/classpilot/class-tools/presentation?${new URLSearchParams(teachingSessionId ? { teachingSessionId } : { supervisionContextId })}`, undefined,
      { signal, headers: activityRequestHeaders(schoolId, revision) }) });
  const snapshot = !query.error && valid ? query.data : null;
  return <main className="min-h-screen bg-slate-950 text-white p-8 md:p-16" data-testid="class-tools-presentation">
    <div className="max-w-5xl mx-auto space-y-10">
      <header className="flex justify-between gap-6 items-start"><p className="text-amber-400 text-xl font-medium">ClassPilot</p>{snapshot?.timer && <ClassTimerCountdown timer={snapshot.timer} className="text-5xl md:text-7xl font-semibold" />}</header>
      {!snapshot && <p className="text-xl text-slate-300">{isLoading || query.isFetching ? 'Loading presentation…' : !valid ? 'Sign in to the same school to open this presentation.' : 'This classroom presentation is unavailable.'}</p>}
      {snapshot?.activity && <section className="space-y-6"><h1 className="text-4xl md:text-6xl font-semibold">{snapshot.activity.title}</h1><p className="text-2xl md:text-3xl whitespace-pre-wrap leading-relaxed">{snapshot.activity.instructions}</p>
        {snapshot.activity.checklist?.length > 0 && <ul className="text-2xl space-y-3 list-disc pl-8">{snapshot.activity.checklist.map(item => <li key={item.id}>{item.text}</li>)}</ul>}
        {snapshot.activity.resources?.length > 0 && <ul className="text-xl space-y-2">{snapshot.activity.resources.map(resource => <li key={resource.url}><a className="text-amber-300 underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a></li>)}</ul>}
      </section>}
      {snapshot?.poll && <section className="space-y-4"><h2 className="text-3xl font-semibold">{snapshot.poll.question}</h2><ul className="text-2xl space-y-3">{snapshot.poll.options.map((option, index) => <li key={index} className="flex justify-between border-b border-slate-700 pb-3"><span>{option.label}</span><span className="tabular-nums">{option.count}</span></li>)}</ul></section>}
      {snapshot && !snapshot.activity && !snapshot.timer && !snapshot.poll && <p className="text-2xl text-slate-400">Ready for your next activity.</p>}
    </div>
  </main>;
}
