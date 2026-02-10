import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function Homerooms() {
  const [homerooms, setHomerooms] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/gopilot/homerooms');
        setHomerooms(Array.isArray(res.data) ? res.data : res.data.homerooms || []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Homerooms</h1>
        <button className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600">
          Add Homeroom
        </button>
      </div>
      {homerooms.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-slate-500">No homerooms created yet.</p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {homerooms.map((h) => (
            <Card key={h.id}>
              <p className="font-medium text-slate-900">{h.name}</p>
              <p className="text-sm text-slate-500">Teacher: {h.teacherName || '—'}</p>
              <p className="text-sm text-slate-500">{h.studentCount || 0} students</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
