import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function Dismissal() {
  const [session, setSession] = useState(null);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/gopilot/dismissal/sessions/active');
        if (res.data) {
          setSession(res.data);
          // Fetch queue for active session
          try {
            const qRes = await api.get(`/gopilot/dismissal/queue/${res.data.id}`);
            setQueue(Array.isArray(qRes.data) ? qRes.data : qRes.data.queue || []);
          } catch { /* no queue */ }
        }
      } catch { /* no active session */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Dismissal</h1>
        {!session && (
          <button className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600">
            Start Session
          </button>
        )}
      </div>

      {session ? (
        <div className="space-y-4">
          <Card className="border-l-4 border-l-blue-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900">Active Dismissal Session</p>
                <p className="text-sm text-slate-500">
                  Started {new Date(session.startedAt || session.createdAt).toLocaleTimeString()}
                </p>
              </div>
              <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700">
                Active
              </span>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold text-slate-900">Queue ({queue.length})</h2>
            {queue.length === 0 ? (
              <p className="py-4 text-center text-slate-500">No students in queue.</p>
            ) : (
              <div className="space-y-2">
                {queue.map((q) => (
                  <div key={q.id} className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium">{q.studentName || 'Unknown Student'}</p>
                      <p className="text-xs text-slate-500">{q.dismissalType || 'pickup'}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      q.status === 'called' ? 'bg-yellow-100 text-yellow-700' :
                      q.status === 'released' ? 'bg-blue-100 text-blue-700' :
                      q.status === 'dismissed' ? 'bg-green-100 text-green-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {q.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <p className="py-8 text-center text-slate-500">
            No active dismissal session. Start one to begin dismissing students.
          </p>
        </Card>
      )}
    </div>
  );
}
