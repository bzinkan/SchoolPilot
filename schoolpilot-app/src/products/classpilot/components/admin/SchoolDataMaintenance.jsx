import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../../components/ui/card';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../../components/ui/alert-dialog';
import { apiRequest, queryClient } from '../../../../lib/queryClient';
import { useAdminNavigationBlocker } from '../../hooks/useAdminNavigation';
import { SettingsAccessContext, settingsAccessDenied, settingsError, settingsSectionTransition } from '../../hooks/useSettingsDraft';

export default function SchoolDataMaintenance({ schoolId }) {
  const accessLost = useContext(SettingsAccessContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useAdminNavigationBlocker({ id: 'school-data-cleanup', busy, shouldBlock: settingsSectionTransition });
  const cleanup = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      await apiRequest('POST', '/admin/cleanup-students', undefined, { headers: { 'X-School-Id': schoolId } });
      if (!alive.current) return;
      void queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      setOpen(false); setNotice('Student devices and monitoring data cleared.');
    } catch (failure) { if (alive.current) { if (settingsAccessDenied(failure)) accessLost?.(); else setError(settingsError(failure)); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <Card className="border-destructive/40"><CardHeader><CardTitle className="text-lg">Device and monitoring data cleanup</CardTitle><CardDescription>Remove registered student devices and monitoring history for this school.</CardDescription></CardHeader><CardContent className="space-y-4">
    <p className="text-sm">This permanently deletes registered student/Chromebook devices, heartbeat and activity history, and URL visit records. Extensions must register again after cleanup.</p>
    <Button variant="destructive" data-testid="button-cleanup-students" disabled={busy} onClick={() => setOpen(true)}>Clear student device and monitoring data</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <AlertDialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><AlertDialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><AlertDialogHeader><AlertDialogTitle>Clear student device and monitoring data?</AlertDialogTitle><AlertDialogDescription>This permanently deletes all registered student devices, activity history, and monitoring data for this school. This action cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy} data-testid="button-cancel-cleanup">Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} data-testid="button-confirm-cleanup" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={event => { event.preventDefault(); void cleanup(); }}>{busy ? 'Clearing…' : 'Yes, clear this data'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
