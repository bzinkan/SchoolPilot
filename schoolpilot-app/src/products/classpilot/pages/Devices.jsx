import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function ClassPilotDevices() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/classpilot/devices');
        setDevices(Array.isArray(res.data) ? res.data : res.data.devices || []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Devices</h1>
      {devices.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-slate-500">No devices registered yet.</p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((d) => (
            <Card key={d.id} className="flex items-center gap-3">
              <div className={`h-3 w-3 rounded-full ${d.isOnline || d.status === 'online' ? 'bg-green-500' : 'bg-slate-300'}`} />
              <div>
                <p className="font-medium text-slate-900">{d.deviceName || d.hostname || 'Unknown'}</p>
                <p className="text-xs text-slate-500">{d.os || '—'}</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
