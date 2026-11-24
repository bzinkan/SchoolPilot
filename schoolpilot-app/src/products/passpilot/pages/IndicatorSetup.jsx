import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import BluetoothLightTest from '../components/BluetoothLightTest';
import { passPilotClassRequest, useCanonicalPassPilotClasses } from '../classData';
import { kioskLightPairingCode } from '../indicatorPairing';

const fieldClass = 'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const sectionClass = 'rounded-xl border bg-card p-5 space-y-4';
const lastSeenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function fetchKiosks() {
  const data = await passPilotClassRequest('GET', '/passpilot/indicators/pairings/kiosks');
  if (!Array.isArray(data?.kiosks)) throw new Error('Invalid kiosk list');
  return data.kiosks.map(({ kioskSessionId, className, lastSeenAt }) => ({ kioskSessionId, className, lastSeenAt }));
}

export default function IndicatorSetup({ user }) {
  const [target, setTarget] = useState('kiosk');
  const [kioskSessionId, setKioskSessionId] = useState('');
  const [classId, setClassId] = useState('');
  const [water, setWater] = useState('');
  const [pairing, setPairing] = useState(null);
  const [revokeId, setRevokeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const followsKiosk = target === 'kiosk';
  const kiosksQuery = useQuery({
    queryKey: ['passpilot', 'indicators', 'kiosks', user?.schoolId, user?.id],
    queryFn: fetchKiosks,
    enabled: followsKiosk && Boolean(user?.schoolId && user?.id),
  });
  const classesQuery = useCanonicalPassPilotClasses(!followsKiosk && Boolean(user?.schoolId), user?.schoolId);
  const kiosks = kiosksQuery.data || [];
  const classes = (classesQuery.data?.classes || []).filter(item => item.status === 'active');
  const selectedKiosk = kiosks.some(kiosk => kiosk.kioskSessionId === kioskSessionId) ? kioskSessionId : '';
  const selectedClass = classes.some(item => item.id === classId) ? classId : '';
  const locked = busy || Boolean(pairing);
  const canCreate = !locked && (followsKiosk
    ? !kiosksQuery.isFetching && !kiosksQuery.isError && Boolean(selectedKiosk)
    : Boolean(selectedClass));

  async function create(event) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { pairingId, token, expiresAt } = await passPilotClassRequest('POST', '/passpilot/indicators/pairings', {
        ...(followsKiosk ? { kioskSessionId: selectedKiosk } : { classId: selectedClass }),
        ...(water.trim() ? { waterCustomDestination: water } : {}),
      });
      setPairing({ pairingId, token, expiresAt }); setRevokeId(pairingId);
      setNotice('Pairing created. Download the private file before leaving this page.');
    } catch {
      setError(followsKiosk
        ? 'Pairing could not be created. Check that your kiosk is open in PassPilot, then refresh the kiosk list and try again.'
        : 'Pairing could not be created. Check your class access and try again.');
    }
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
    <header><h1 className="text-2xl font-semibold">Classroom light</h1></header>
    <BluetoothLightTest />
    <section className={sectionClass}>
      <h2 className="text-lg font-medium">What the lights show</h2>
      <p className="text-sm">Blue: restroom or water. Yellow: office. Red: nurse. A light stays on until all matching active passes are returned. Off means clear; pulsing white means status is unavailable.</p>
    </section>
    {error || (!followsKiosk && classesQuery.isError) ? <p role="alert" className="text-sm text-destructive">{error || 'Classes could not be loaded. Try refreshing.'}</p> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <form className={sectionClass} onSubmit={create}>
      <h2 className="text-lg font-medium">Create a pairing</h2>
      <p className="text-sm text-muted-foreground">Pair an ESP32 gateway with your kiosk or one class. Pairings expire after 30 days.</p>
      <fieldset className="space-y-2 text-sm" disabled={locked}>
        <legend className="mb-2 font-medium">What should the light follow?</legend>
        <label className="flex items-center gap-2"><input type="radio" name="indicator-target" checked={followsKiosk} onChange={() => setTarget('kiosk')} />Follow a kiosk</label>
        <label className="flex items-center gap-2"><input type="radio" name="indicator-target" checked={!followsKiosk} onChange={() => setTarget('class')} />Follow one class</label>
      </fieldset>
      {followsKiosk ? <div className="space-y-2">
        <label className="block text-sm">Kiosk<select className={fieldClass} value={selectedKiosk} onChange={e => setKioskSessionId(e.target.value)} required disabled={locked || kiosks.length === 0 || kiosksQuery.isFetching || kiosksQuery.isError} aria-describedby="indicator-target-help">
          <option value="">{kiosksQuery.isFetching ? 'Loading kiosks…' : 'Choose a kiosk'}</option>
          {kiosks.map(kiosk => <option key={kiosk.kioskSessionId} value={kiosk.kioskSessionId}>
            {kioskLightPairingCode(kiosk.kioskSessionId)} · {kiosk.className || 'No class selected'} · Last seen {lastSeenFormat.format(new Date(kiosk.lastSeenAt))}
          </option>)}
        </select></label>
        <p id="indicator-target-help" className="text-sm text-muted-foreground">Match the light pairing code shown on the kiosk. The light follows passes issued at that kiosk under your account as it changes classes.</p>
        {kiosksQuery.isError ? <p role="alert" className="text-sm text-destructive">Kiosks could not be loaded. Refresh the kiosk list to try again.</p> : null}
        {kiosksQuery.isSuccess && kiosks.length === 0 ? <p role="status" className="text-sm">No active kiosks found. Open your PassPilot kiosk, then refresh the kiosk list.</p> : null}
        <Button type="button" variant="outline" size="sm" disabled={locked || kiosksQuery.isFetching} onClick={() => kiosksQuery.refetch()}>Refresh kiosk list</Button>
      </div> : <div className="space-y-2">
        <label className="block text-sm">Class<select className={fieldClass} value={selectedClass} onChange={e => setClassId(e.target.value)} required disabled={locked} aria-describedby="indicator-target-help">
          <option value="">{classesQuery.isLoading ? 'Loading classes…' : 'Choose a class'}</option>
          {classes.map(item => <option key={item.id} value={item.id}>{item.name}{item.periodLabel ? ` · ${item.periodLabel}` : ''}</option>)}
        </select></label>
        <p id="indicator-target-help" className="text-sm text-muted-foreground">The light follows passes issued under your account for this class, including passes from your class-bound kiosk.</p>
      </div>}
      <label className="block text-sm">Water destination (optional)<input className={fieldClass} maxLength={100} value={water} onChange={e => setWater(e.target.value)} disabled={locked} aria-describedby="indicator-water-help" /></label>
      <p id="indicator-water-help" className="text-sm text-muted-foreground">Leave blank if you use the built-in restroom option for both restroom and water. If you have a separate custom water destination, enter its exact name.</p>
      <Button type="submit" disabled={!canCreate}>Create pairing</Button>
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
