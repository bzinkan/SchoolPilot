import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { passPilotClassRequest, useCanonicalPassPilotClasses } from '../classData';

const fieldClass = 'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const sectionClass = 'rounded-xl border bg-card p-5 space-y-4';

export default function IndicatorSetup({ user }) {
  const classesQuery = useCanonicalPassPilotClasses(Boolean(user?.schoolId), user?.schoolId);
  const classes = (classesQuery.data?.classes || []).filter(item => item.status === 'active');
  const [classId, setClassId] = useState('');
  const [water, setWater] = useState('');
  const [pairing, setPairing] = useState(null);
  const [revokeId, setRevokeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function create(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await passPilotClassRequest('POST', '/passpilot/indicators/pairings', {
        classId, ...(water ? { waterCustomDestination: water } : {}),
      });
      setPairing(result); setRevokeId(result.pairingId);
      setNotice('Pairing created. Download the private file before leaving this page.');
    } catch { setError('Pairing could not be created. Check your class access and try again.'); }
    finally { setBusy(false); }
  }

  function download() {
    const blob = new Blob([JSON.stringify({ ...pairing, apiUrl: `${window.location.origin}/api/passpilot/indicators/state` }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `pairing-${pairing.pairingId}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function revoke(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await passPilotClassRequest('DELETE', `/passpilot/indicators/pairings/${encodeURIComponent(revokeId)}`);
      if (pairing?.pairingId === revokeId) setPairing(null);
      setRevokeId(''); setNotice('Pairing revoked. The light will show unavailable when its current status expires.');
    } catch { setError('Pairing could not be revoked. Check the ID and that you created it in this school.'); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
    <header><h1 className="text-2xl font-semibold">Classroom light prototype</h1>
      <p className="mt-2 text-sm text-muted-foreground">Pair a gateway with passes you issue for one class. Create a new pairing if you change classes. Pairings expire after 30 days.</p></header>
    <section className={sectionClass}>
      <h2 className="text-lg font-medium">What the lights show</h2>
      <p className="text-sm">Blue: restroom or your selected water destination. Yellow: office. Red: nurse. A light stays on until all matching active passes are returned. Off means clear; pulsing white means status is unavailable.</p>
      <p className="text-sm text-muted-foreground">Only passes issued under your account for this class count, including your class-bound kiosk. This prototype stays with the class you select here when your kiosk changes classes.</p>
      <p className="text-sm text-muted-foreground">Use a kiosk displaying this exact class from the same class list. If your kiosk uses a separate ClassPilot class schedule, check that its class is available here before using the light.</p>
    </section>
    {error || classesQuery.isError ? <p role="alert" className="text-sm text-destructive">{error || 'Classes could not be loaded. Try refreshing.'}</p> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <form className={sectionClass} onSubmit={create}>
      <h2 className="text-lg font-medium">Create a pairing</h2>
      <label className="block text-sm">Class<select className={fieldClass} value={classId} onChange={e => setClassId(e.target.value)} required disabled={busy || Boolean(pairing)}>
        <option value="">{classesQuery.isLoading ? 'Loading classes…' : 'Choose a class'}</option>
        {classes.map(item => <option key={item.id} value={item.id}>{item.name}{item.periodLabel ? ` · ${item.periodLabel}` : ''}</option>)}
      </select></label>
      <label className="block text-sm">Water destination (optional)<input className={fieldClass} maxLength={100} value={water} onChange={e => setWater(e.target.value)} disabled={busy || Boolean(pairing)} aria-describedby="indicator-water-help" /></label>
      <p id="indicator-water-help" className="text-sm text-muted-foreground">Enter the exact custom destination name used in PassPilot, including capitalization. Leave blank for restroom only.</p>
      <Button type="submit" disabled={busy || Boolean(pairing) || !classes.some(item => item.id === classId)}>Create pairing</Button>
      {pairing ? <div className="space-y-3 border-t pt-4">
        <p className="break-all text-sm">Pairing ID: {pairing.pairingId}</p>
        <p className="text-sm">Expires: {new Date(pairing.expiresAt).toLocaleDateString()}</p>
        <p className="text-sm text-muted-foreground">The file contains a private gateway credential. Save it on your setup computer; keep it off shared student devices. It cannot be downloaded again after you leave this page.</p>
        <Button type="button" onClick={download} disabled={busy}>Download private pairing file</Button>
      </div> : null}
    </form>
    <form className={sectionClass} onSubmit={revoke}>
      <h2 className="text-lg font-medium">Revoke a pairing</h2>
      <p className="text-sm text-muted-foreground">Use the ID from the private file if you lose a gateway or need to replace its pairing.</p>
      <label className="block text-sm">Pairing ID<input className={fieldClass} required pattern="[0-9a-fA-F-]{36}" value={revokeId} onChange={e => setRevokeId(e.target.value)} disabled={busy} /></label>
      <Button type="submit" variant="outline" disabled={busy || !revokeId}>Revoke pairing</Button>
    </form>
  </div>;
}
