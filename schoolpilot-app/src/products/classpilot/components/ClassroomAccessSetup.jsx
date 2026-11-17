import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import ClassPilotAdminOperationGuard from '../../../shared/components/ClassPilotAdminOperationGuard';

const BASE = '/google/roster-connector/classroom-access';

export default function ClassroomAccessSetup({ schoolId, viewerId }) {
  if (!schoolId || !viewerId) return null;
  return <SetupEditor key={`${schoolId}:${viewerId}`} schoolId={schoolId} viewerId={viewerId} />;
}

function SetupEditor({ schoolId, viewerId }) {
  const client = useQueryClient();
  const queryKey = [BASE, 'setup-info', schoolId, viewerId];
  const [studentId, setStudentId] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const lifetime = useRef({ alive: true, controller: new AbortController(), busy: false });
  useEffect(() => {
    const current = lifetime.current;
    current.alive = true;
    if (current.controller.signal.aborted) current.controller = new AbortController();
    return () => { current.alive = false; current.controller.abort(); };
  }, []);
  const query = useQuery({ queryKey, staleTime: 0, refetchOnMount: 'always', retry: false,
    queryFn: ({ signal }) => apiRequest('GET', `${BASE}/setup-info`, undefined, { signal, headers: { 'X-School-Id': schoolId } }),
  });
  const data = query.data;
  const students = data?.verificationStudents || [];
  const selected = students.find(student => student.id === studentId);
  const change = useMutation({
    mutationFn: action => apiRequest(action === 'verify' ? 'POST' : 'DELETE', action === 'verify' ? `${BASE}/verify` : BASE,
      action === 'verify' ? { studentId: selected.id } : undefined,
      { signal: lifetime.current.controller.signal, headers: { 'X-School-Id': schoolId } }),
    onSuccess: async (response, action) => {
      if (!lifetime.current.alive) return;
      setStudentId('');
      setNotice(response?.classroomAccess?.enabled === true && action === 'verify'
        ? 'Classroom assignment access enabled.' : 'Classroom assignment access disabled.');
      await client.invalidateQueries({ queryKey, exact: true });
    },
    onError: error => {
      if (lifetime.current.alive && error?.name !== 'AbortError') setNotice(error?.response?.data?.error || error.message || 'Classroom authorization could not be changed.');
    },
    onSettled: () => { lifetime.current.busy = false; },
  });
  const submit = action => {
    if (lifetime.current.busy || query.isFetching || query.isError || !data || (action === 'verify' && (!data.available || !selected))) return;
    lifetime.current.busy = true; setNotice(''); change.mutate(action);
  };
  return <Card data-testid="student-classroom-access-setup">
    <ClassPilotAdminOperationGuard id="student-classroom-access-setup" dirty={Boolean(studentId)} busy={change.isPending}
      onDiscard={() => { setStudentId(''); setNotice(''); }} />
    <CardHeader><CardTitle>Classroom assignment access</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm">Allow Focus and Flight Paths to include each student's own published work across their Google Classroom courses. This read-only permission is separate from roster imports.</p>
      {query.isLoading && <p role="status" className="text-sm">Loading Classroom authorization…</p>}
      {query.isError && <div role="alert" className="text-sm text-destructive">Classroom authorization could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></div>}
      {data && <>
        <p className="text-sm font-medium">{data.enabled ? 'Assignment access verified' : 'Assignment access not verified'}</p>
        <p className="text-sm text-muted-foreground">{data.setupCopy?.description}</p>
        {!data.available && <p role="alert" className="text-sm text-muted-foreground">Verify the Google Workspace Roster Connector and import student Google identities before enabling assignment access.</p>}
        <div className="space-y-2">
          <p className="text-sm">In Google Admin Console, edit this client's permissions using the combined scope list below. It preserves the existing roster permissions.</p>
          <p className="break-all text-xs">Client ID: {data.serviceAccountClientId || 'Not configured'}</p>
          <code className="block break-all rounded bg-muted p-3 text-xs">{data.scopesCsv}</code>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={!data.scopesCsv} onClick={async () => {
              await navigator.clipboard?.writeText(data.scopesCsv);
              if (lifetime.current.alive) setCopied(true);
            }}>Copy combined scopes</Button>
            {data.adminConsoleUrl && <Button type="button" variant="outline" asChild><a href={data.adminConsoleUrl} target="_blank" rel="noreferrer">Open Google Admin Console</a></Button>}
          </div>
          {copied && <p role="status" className="text-xs">Combined scopes copied.</p>}
          {data.manualAdminConsolePath && <p className="text-xs text-muted-foreground">{data.manualAdminConsolePath}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="classroom-access-verification-student">Student to verify</Label>
          <select id="classroom-access-verification-student" className="w-full rounded border bg-background p-2" value={studentId}
            disabled={!data.available || change.isPending} onChange={event => { setStudentId(event.target.value); setNotice(''); }}>
            <option value="">Choose an imported student</option>
            {students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Verification checks this student's Google identity and read permissions. It does not change their account or assignments.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!data.available || !selected || change.isPending || query.isFetching || query.isError} onClick={() => submit('verify')}>
            {change.isPending && change.variables === 'verify' ? 'Verifying Classroom access…' : 'Verify Classroom access'}</Button>
          <Button type="button" variant="outline" disabled={!data.enabled || change.isPending || query.isFetching || query.isError} onClick={() => submit('disable')}>Disable Classroom access</Button>
        </div>
        <p className="text-xs text-muted-foreground">{data.setupCopy?.revocation}</p>
        <p className="text-xs text-muted-foreground">This does not publish the extension or activate Classroom controls. Managed devices and the school's Classroom feature must be verified separately.</p>
      </>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </CardContent>
  </Card>;
}
