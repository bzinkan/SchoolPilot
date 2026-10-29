import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StudentTile from '../src/products/classpilot/components/StudentTile';
import { useWindowsBrowsers } from '../src/products/classpilot/hooks/useWindowsBrowsers';
import { useDesktopMetadata } from '../src/products/classpilot/hooks/useDesktopMetadata';
import { projectWindowsBrowserStudent } from '../src/products/classpilot/lib/windowsBrowsers';
import '../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const roster = [{ studentId: 'student-a', studentName: 'Synthetic Student', isLoggedIn: false, loginState: 'not_logged_in', status: 'offline' }];
function Fixture() {
  const [context, setContext] = useState('class-a');
  const [selections, setSelections] = useState({});
  const authority = useMemo(() => ({ teachingSessionId: context }), [context]);
  const args = { enabled: true, students: roster, schoolId: 'school-a', viewerId: 'teacher-a', authority };
  const windows = useWindowsBrowsers({ ...args, selections });
  const desktop = useDesktopMetadata(args);
  const student = projectWindowsBrowserStudent(roster[0], windows.get('student-a'), selections['student-a']);
  window.windowsFixture = { setContext, refresh: () => client.invalidateQueries({ queryKey: ['classpilot-windows-browsers'] }),
    snapshot: () => ({ selected: student.selectedWindowsBrowser?.sourceRef, tabs: student.allOpenTabs, capabilities: student.acceptedCapabilities }) };
  const select = source => setSelections(current => ({ ...current, 'student-a': source
    ? { sourceRef: source.sourceRef, bindingRevision: source.bindingRevision, browserFamily: source.browserFamily, scopeKey: student.windowsBrowserScopeKey, active: true }
    : { ...current['student-a'], active: false } }));
  return <div className="mx-auto max-w-md p-6"><StudentTile student={student} desktop={desktop.get('student-a') || null}
    onWindowsBrowserSelection={select} freshnessNowMs={Date.now()} onManageTabs={student.selectedWindowsBrowser ? () => {} : undefined} /></div>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
