import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StudentTile from '../src/products/classpilot/components/StudentTile';
import { useDesktopMetadata } from '../src/products/classpilot/hooks/useDesktopMetadata';
import '../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const initialBrowser = new URLSearchParams(location.search).get('browser') !== 'false';
function Fixture() {
  const [context, setContext] = useState('class-a');
  const [studentId, setStudentId] = useState('student-a');
  const [browser, setBrowser] = useState(initialBrowser);
  const [mounted, setMounted] = useState(true);
  const student = { studentId, studentName: 'Synthetic Student', isLoggedIn: browser, loginState: browser ? 'logged_in' : 'not_logged_in',
    status: browser ? 'online' : 'offline', extensionVersion: browser ? '2.9.7' : null, realtimeBinding: browser ? 'browser-binding' : '',
    lastSeenAt: new Date().toISOString(), acceptedCapabilities: browser ? { scopedAuthorityChecksV1: true } : {},
  };
  const desktop = useDesktopMetadata({ enabled: mounted, students: [student], schoolId: 'school-a', viewerId: 'teacher-a', authority: { teachingSessionId: context } });
  window.nativeFixture = { setContext, setStudentId, setBrowser, setMounted,
    refresh: () => client.invalidateQueries({ queryKey: ['classpilot-native-desktop-metadata'] }),
    cache: () => client.getQueryCache().getAll().map(query => query.state.data),
  };
  return <div className="mx-auto max-w-md p-6">{mounted ? <StudentTile key={studentId} student={student}
    desktop={desktop.get(studentId) || null} freshnessNowMs={Date.now()}
    onManageTabs={() => {}} onOpenDetails={() => {}} /> : <p>Dashboard closed</p>}</div>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
