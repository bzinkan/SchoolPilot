import { useCallback, useContext, useEffect, useMemo, useRef, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Copy, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useAdminShell, useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { SettingsAccessContext, settingsAccessDenied, useSettingsDraft, settingsSectionTransition, settingsError } from '../hooks/useSettingsDraft';
import SettingsSaveState from '../components/admin/SettingsSaveState';
import MonitoringHoursSettings from '../components/MonitoringHoursSettings';
import { MonitoringDigestSettings } from '../components/MonitoringInterruptionsPanel';
import SchoolDataMaintenance from '../components/admin/SchoolDataMaintenance';
import { SETTINGS_SECTIONS } from '../lib/adminNavigation';

const API = '/classpilot/admin/settings';
const fieldLabels = {
  classroom: { maxTabsPerStudent: 'Maximum tabs per student', allowedDomains: 'Educational domains' },
  blockedWebsites: { blockedDomains: 'Blocked websites' },
  signIn: { sharedChromebookSignInEnabled: 'Shared Chromebook sign-in' },
  email: { centralEmailRecipientUserId: 'Copy recipient' },
  retention: { retentionHours: 'Retention in hours' },
};
const normalizeDomain = value => value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].split(':')[0];

function SettingsCard({ title, description, children }) {
  return <Card><CardHeader><CardTitle className="text-lg">{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent className="space-y-5">{children}</CardContent></Card>;
}

function SectionEditor({ section, settings, schoolId, queryKey, title, description, saveLabel, children, formatValue }) {
  const labels = fieldLabels[section];
  const version = section === 'blockedWebsites' ? 'policyRevision' : 'version';
  const editor = useSettingsDraft({ id: `school-settings-${section}`, source: settings.sections[section], fields: Object.keys(labels), version,
    save: (draft, baseline) => {
      const payload = { ...draft, [version === 'version' ? 'expectedVersion' : version]: baseline[version] };
      if (section === 'classroom') { payload.maxTabsPerStudent = draft.maxTabsPerStudent === '' || draft.maxTabsPerStudent === null ? null : Number(draft.maxTabsPerStudent); payload.allowedDomains = draft.allowedDomains.map(normalizeDomain).filter(Boolean); }
      if (section === 'blockedWebsites') payload.blockedDomains = draft.blockedDomains.map(normalizeDomain).filter(Boolean);
      return apiRequest('PATCH', `${API}/${section}`, payload, { headers: { 'X-School-Id': schoolId } });
    },
    refresh: async () => (await apiRequest('GET', API, undefined, { headers: { 'X-School-Id': schoolId } })).sections[section],
    onSaved: saved => {
      queryClient.setQueryData(queryKey, current => current && ({ ...current, sections: { ...current.sections, [section]: saved } }));
      void queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      if (section === 'classroom') void queryClient.invalidateQueries({ queryKey: ['/api/classpilot/teacher/preferences', schoolId] });
      if (section === 'blockedWebsites') { void queryClient.invalidateQueries({ queryKey: ['classpilot-safety-center'] }); void queryClient.invalidateQueries({ queryKey: ['/api/classpilot/admin/sso-policy'] }); }
    },
  });
  const invalid = section === 'classroom' && editor.draft.maxTabsPerStudent !== '' && editor.draft.maxTabsPerStudent !== null
    && (!Number.isInteger(Number(editor.draft.maxTabsPerStudent)) || Number(editor.draft.maxTabsPerStudent) < 1 || Number(editor.draft.maxTabsPerStudent) > 100)
    || section === 'retention' && (!Number.isInteger(Number(editor.draft.retentionHours)) || Number(editor.draft.retentionHours) < 24 || Number(editor.draft.retentionHours) > 8760);
  return <SettingsCard title={title} description={description}><fieldset disabled={editor.busy} className="min-w-0 space-y-4">{children(editor)}</fieldset><SettingsSaveState editor={editor} labels={labels} saveLabel={saveLabel} version={version} invalid={invalid} formatValue={formatValue} /></SettingsCard>;
}

function StaffSignIn({ school, schoolId, refetchUser }) {
  const source = useMemo(() => ({ enabled: school?.staffPasswordLoginEnabled !== false, revision: school?.staffPasswordLoginEnabled !== false }), [school?.staffPasswordLoginEnabled]);
  const editor = useSettingsDraft({ id: 'staff-password-settings', source, fields: ['enabled'], version: 'revision',
    save: async draft => { const saved = await apiRequest('PUT', `/schools/${schoolId}/staff-password-login`, { enabled: draft.enabled }, { headers: { 'X-School-Id': schoolId } }); return { enabled: saved.school.staffPasswordLoginEnabled !== false, revision: saved.school.staffPasswordLoginEnabled !== false }; },
    onSaved: () => { void refetchUser(); },
  });
  return <SettingsCard title="Staff sign-in" description="Choose how staff sign in to the web app."><label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={editor.draft.enabled} disabled={editor.busy} onChange={event => editor.update('enabled', event.target.checked)} />Allow staff to sign in with email and password</label><p className="text-sm text-muted-foreground">When off, staff use Google sign-in. The GoPilot staff app keeps password access while the school has a GoPilot license.</p><SettingsSaveState editor={editor} labels={{ enabled: 'Email and password sign-in' }} version="revision" saveLabel="Save staff sign-in" /></SettingsCard>;
}

function buildManagedPolicy(settings) {
  const policy = { serverUrl: { Value: window.location.origin } };
  if (settings.schoolSlug) policy.schoolSlug = { Value: settings.schoolSlug };
  else policy.schoolId = { Value: settings.schoolId };
  policy.enrollmentKey = { Value: settings.key || '' };
  return JSON.stringify(policy, null, 2);
}

function EnrollmentKey({ schoolId, viewerId }) {
  const accessLost = useContext(SettingsAccessContext);
  const queryKey = ['/api/classpilot/enrollment-key', schoolId, viewerId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => apiRequest('GET', '/classpilot/enrollment-key', undefined, { signal, headers: { 'X-School-Id': schoolId } }) });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (settingsAccessDenied(query.error)) accessLost?.(); }, [query.error, accessLost]);
  useAdminNavigationBlocker({ id: 'enrollment-key', busy, shouldBlock: settingsSectionTransition });
  const rotate = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { const data = await apiRequest('POST', '/classpilot/enrollment-key/rotate', undefined, { headers: { 'X-School-Id': schoolId } });
      if (!alive.current) return;
      queryClient.setQueryData(queryKey, current => ({ ...current, key: data.key })); setConfirm(false); setNotice('Setup key saved. Update the managed policy in Google Admin.');
    } catch (failure) { if (alive.current) { if (settingsAccessDenied(failure)) accessLost?.(); else setError(settingsError(failure)); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const copy = async value => { try { await navigator.clipboard.writeText(value); if (alive.current) setNotice('Copied.'); } catch { if (alive.current) setError('Could not copy. Select and copy the value manually.'); } };
  return <SettingsCard title="Chromebook setup key" description="Use the school setup key and managed policy when deploying ClassPilot through Google Admin.">
    {query.isPending ? <p>Loading setup key…</p> : !query.data ? <p role="alert">Could not load the setup key. <Button variant="link" onClick={() => query.refetch()}>Try again</Button></p> : <>
      {query.error && <p role="alert">Could not refresh the setup key. <Button variant="link" onClick={() => query.refetch()}>Retry refresh</Button></p>}
      {query.data.key && <><Label htmlFor="enrollment-key">Setup key</Label><div className="flex gap-2"><Input id="enrollment-key" value={query.data.key} readOnly /><Button variant="outline" aria-label="Copy setup key" onClick={() => copy(query.data.key)}><Copy className="h-4 w-4" /></Button></div><Label htmlFor="managed-policy">Google Admin managed policy</Label><textarea id="managed-policy" className="min-h-44 w-full rounded-md border bg-muted p-3 font-mono text-xs" readOnly value={buildManagedPolicy(query.data)} /><Button variant="outline" onClick={() => copy(buildManagedPolicy(query.data))}>Copy managed policy</Button></>}
      <div><Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}><KeyRound className="mr-2 h-4 w-4" />{query.data.key ? 'Rotate setup key' : 'Generate setup key'}</Button></div>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <AlertDialog open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }}><AlertDialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><AlertDialogHeader><AlertDialogTitle>{query.data?.key ? 'Rotate the school setup key?' : 'Generate a school setup key?'}</AlertDialogTitle><AlertDialogDescription>This saves a new key immediately. Update the managed policy in Google Admin before enrolling Chromebooks with the new key.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void rotate(); }}>{busy ? 'Saving…' : 'Save new setup key'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </SettingsCard>;
}

function SettingsWorkspace({ currentUser, school, refetchUser }) {
  const shell = useAdminShell();
  const location = useLocation();
  const requested = new URLSearchParams(location.search).get('section');
  const section = SETTINGS_SECTIONS.some(item => item.section === requested) ? requested : 'school';
  const schoolId = currentUser.schoolId;
  const queryKey = ['/api/classpilot/admin/settings', schoolId, currentUser.id];
  const [accessDenied, setAccessDenied] = useState(false);
  const cleared = useRef(false);
  const accessLost = useCallback(() => setAccessDenied(true), []);
  const query = useQuery({ queryKey, enabled: !accessDenied, queryFn: ({ signal }) => apiRequest('GET', API, undefined, { signal, headers: { 'X-School-Id': schoolId } }) });
  const staff = useQuery({ queryKey: ['/api/admin/users', schoolId, currentUser.id], enabled: !accessDenied, queryFn: ({ signal }) => apiRequest('GET', '/admin/users', undefined, { signal, headers: { 'X-School-Id': schoolId } }) });
  const denied = accessDenied || settingsAccessDenied(query.error) || settingsAccessDenied(staff.error);
  if (denied && !accessDenied) setAccessDenied(true);
  useEffect(() => {
    if (!denied || cleared.current) return;
    cleared.current = true;
    const belongs = query => ['/api/classpilot/admin/settings', '/api/admin/users', '/api/classpilot/enrollment-key', '/classpilot/monitoring-interruptions'].includes(query.queryKey?.[0]) && query.queryKey[1] === schoolId;
    void queryClient.cancelQueries({ predicate: belongs }); queryClient.removeQueries({ predicate: belongs });
    void refetchUser();
  }, [denied, schoolId, refetchUser]);
  const users = (staff.data?.users || []).map(row => ({ ...row, ...row.user, id: row.user?.id || row.userId || row.id })).sort((left, right) => (left.name || left.email || '').localeCompare(right.name || right.email || ''));
  if (denied) return <p role="alert">School settings access is no longer available. Return to ClassPilot or select an authorized school.</p>;
  if (query.isPending) return <p className="flex items-center gap-2 py-10"><Loader2 className="h-4 w-4 animate-spin" />Loading school settings…</p>;
  if (!query.data) return <div role="alert"><p>School settings could not be loaded.</p><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></div>;
  const settings = query.data;
  const common = { settings, schoolId, queryKey };
  return <SettingsAccessContext.Provider value={accessLost}><div className="max-w-4xl space-y-5" data-testid="school-settings-workspace">
    {!shell && <><h1 className="text-2xl font-semibold">School settings</h1><nav aria-label="Settings sections" className="flex flex-wrap gap-3">{SETTINGS_SECTIONS.map(item => <Link key={item.section} to={`/classpilot/settings?section=${item.section}`} aria-current={item.section === section ? 'page' : undefined}>{item.label}</Link>)}</nav></>}
    {query.error && <p role="alert" className="rounded-md border p-3 text-sm">Could not refresh settings. Your drafts are still here. <Button variant="link" onClick={() => query.refetch()}>Retry refresh</Button></p>}
    <section hidden={section !== 'school'} aria-label="School details" className="space-y-5">
      <SettingsCard title="School profile" description="The saved school identity is shared across SchoolPilot."><dl className="grid gap-5 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">School name</dt><dd className="mt-1 font-medium">{settings.schoolName || 'Not configured'}</dd></div><div><dt className="text-sm text-muted-foreground">School timezone</dt><dd className="mt-1 font-medium">{settings.schoolTimezone}</dd></div></dl><p className="text-sm text-muted-foreground">Name and timezone are managed in the school profile. Contact your SchoolPilot administrator to request a change. The timezone also controls class schedules and school-local dates.</p>{currentUser.isSuperAdmin && <Link className="inline-block text-sm underline" to={`/super-admin/schools/${schoolId}`}>Open school profile</Link>}</SettingsCard>
      <SettingsCard title="School calendar" description="Set the actual start and end of the school year, closures, and class schedules."><Link className="text-sm underline" to="/classpilot/admin/scheduling?section=school-year">Open School year</Link></SettingsCard>
    </section>
    <section hidden={section !== 'browsing'} aria-label="Browsing and monitoring" className="space-y-5">
      <SectionEditor {...common} section="classroom" title="Browsing defaults" description="Set school-wide tab limits and educational domains used to classify classroom activity." saveLabel="Save browsing defaults">{editor => <><div className="space-y-2"><Label htmlFor="school-max-tabs">Maximum tabs per student</Label><Input id="school-max-tabs" type="number" min="1" max="100" value={editor.draft.maxTabsPerStudent ?? ''} onChange={event => editor.update('maxTabsPerStudent', event.target.value)} /><p className="text-xs text-muted-foreground">Choose 1 to 100, or leave blank for no school-wide tab limit.</p></div><div className="space-y-2"><Label htmlFor="school-allowed-domains">Educational domains (comma-separated)</Label><textarea id="school-allowed-domains" className="min-h-24 w-full rounded-md border bg-background p-3 text-sm" value={editor.draft.allowedDomains.join(',')} onChange={event => editor.update('allowedDomains', event.target.value.split(','))} /><p className="text-sm text-muted-foreground">These domains help classify educational activity. They do not suppress safety alerts or override website blocks.</p></div></>}</SectionEditor>
      <SectionEditor {...common} section="blockedWebsites" title="Blocked websites" description="Block matching websites in the monitored Chrome profile." saveLabel="Save blocked websites">{editor => <><Label htmlFor="school-blocked-domains">Website domains (comma-separated)</Label><textarea id="school-blocked-domains" className="min-h-24 w-full rounded-md border bg-background p-3 text-sm" value={editor.draft.blockedDomains.join(',')} onChange={event => editor.update('blockedDomains', event.target.value.split(','))} /><p className="text-sm text-muted-foreground">Website rules do not disable Chrome features, extensions, apps, Incognito, Guest, or other profiles. Blocking lens.google.com blocks that website; school IT manages Chrome's built-in Lens features.</p></>}</SectionEditor>
      <MonitoringHoursSettings settings={{ ...settings.sections.monitoring, schoolTimezone: settings.schoolTimezone }} schoolId={schoolId} queryKey={queryKey} />
      <p className="text-sm text-muted-foreground">AI detections leave tabs open for administrator review. Only exact URL approvals in the <Link className="underline" to="/classpilot/admin/safety">Safety Center</Link> suppress subsequent safety alerts; independent website blocks still apply.</p>
    </section>
    <section hidden={section !== 'notifications'} aria-label="Staff notifications" className="space-y-5">
      <SectionEditor {...common} section="email" formatValue={(_field, value) => { const recipient = users.find(user => user.id === value); return !value ? 'No central copy' : recipient ? recipient.name || [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || recipient.email : 'Saved recipient unavailable'; }} title="Central email copy" description="Send one staff member a copy of session summaries and browser safety emails." saveLabel="Save email recipient">{editor => <><Label htmlFor="central-email-recipient">Copy recipient</Label><select id="central-email-recipient" className="w-full rounded-md border bg-background p-2" value={editor.draft.centralEmailRecipientUserId || ''} onChange={event => editor.update('centralEmailRecipientUserId', event.target.value || null)} disabled={!staff.data || staff.isFetching}><option value="">No central copy</option>{editor.draft.centralEmailRecipientUserId && !users.some(user => user.id === editor.draft.centralEmailRecipientUserId) && <option value={editor.draft.centralEmailRecipientUserId}>Saved recipient unavailable</option>}{users.map(user => <option key={user.id} value={user.id}>{user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}{user.email ? ` (${user.email})` : ''}</option>)}</select>{staff.error && <p role="alert" className="text-sm text-destructive">Staff choices could not be refreshed. The saved recipient is unchanged. <Button variant="link" onClick={() => staff.refetch()}>Retry staff list</Button></p>}<p className="text-sm text-muted-foreground">Password, billing, parent, and student emails are not copied. Student safety notifications continue to reach school administrators.</p></>}</SectionEditor>
      <MonitoringDigestSettings />
    </section>
    <section hidden={section !== 'sign-in'} aria-label="Sign-in and devices" className="space-y-5">
      <StaffSignIn school={school} schoolId={schoolId} refetchUser={refetchUser} />
      <SectionEditor {...common} section="signIn" title="Shared Chromebook sign-in" description="Identify students on shared Chromebooks using Grade, Name, and a four-digit PIN." saveLabel="Save shared Chromebook sign-in">{editor => <label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={editor.draft.sharedChromebookSignInEnabled} onChange={event => editor.update('sharedChromebookSignInEnabled', event.target.checked)} />Enable shared Chromebook sign-in</label>}</SectionEditor>
      <EnrollmentKey schoolId={schoolId} viewerId={currentUser.id} />
      <p className="text-sm text-muted-foreground">Configure the starting website and approved identity providers separately in <Link className="underline" to="/classpilot/admin?tab=student-portal">Student portal</Link>. Deployment checks are in <Link className="underline" to="/classpilot/admin/it-readiness">Integrations &amp; IT readiness</Link>.</p>
    </section>
    <section hidden={section !== 'data'} aria-label="Data and maintenance" className="space-y-5">
      <SectionEditor {...common} section="retention" title="Student activity-history retention" description="Choose how long ClassPilot keeps activity data before automatic deletion." saveLabel="Save activity-history retention">{editor => <><Label htmlFor="retention-days">Student activity-history retention (days)</Label><Input id="retention-days" type="number" min="1" max="365" value={editor.draft.retentionHours === '' ? '' : Number(editor.draft.retentionHours) / 24} onChange={event => editor.update('retentionHours', event.target.value === '' ? '' : String(Number(event.target.value) * 24))} /><p className="text-sm text-muted-foreground">Choose 1 to 365 days. This setting applies to activity retention, not private notebooks, school discipline records, or student contact history.</p></>}</SectionEditor>
      {currentUser.isSuperAdmin || currentUser.roles?.includes('admin') ? <SchoolDataMaintenance schoolId={schoolId} /> : <p className="text-sm text-muted-foreground">Device and monitoring data cleanup requires the school administrator account with cleanup access.</p>}
    </section>
  </div></SettingsAccessContext.Provider>;
}

export default function Settings() {
  const { currentUser, school, isAdmin, isLoading, refetchUser } = useClassPilotAuth();
  const shell = useAdminShell();
  if (isLoading) return <p>Loading school settings…</p>;
  if (!currentUser || !currentUser.schoolId || !(isAdmin || currentUser.isSuperAdmin)) return <Navigate to="/classpilot" replace />;
  const scope = shell?.scopeKey || JSON.stringify([currentUser.schoolId, currentUser.id, currentUser.roles, currentUser.isSuperAdmin]);
  return <SettingsWorkspace key={scope} currentUser={currentUser} school={school} refetchUser={refetchUser} />;
}
