import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function Passes() {
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/passpilot/passes');
        setPasses(Array.isArray(res.data) ? res.data : res.data.passes || []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Hall Passes</h1>
        <button className="rounded-md bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600">
          Issue Pass
        </button>
      </div>
      {passes.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-slate-500">No passes found.</p>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Destination</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {passes.slice(0, 50).map((p) => (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{p.studentName || 'Unknown'}</td>
                    <td className="px-3 py-2">{p.destination || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.status === 'active' ? 'bg-green-100 text-green-700' :
                        p.status === 'returned' ? 'bg-slate-100 text-slate-600' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {p.issuedAt ? new Date(p.issuedAt).toLocaleTimeString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
