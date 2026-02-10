import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import api from '../../../shared/utils/api';

export default function GoPilotDashboard() {
  const [stats, setStats] = useState({ students: 0, homerooms: 0, sessions: 0 });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [studRes, hrRes] = await Promise.allSettled([
          api.get('/students'),
          api.get('/gopilot/homerooms'),
        ]);
        if (!mounted) return;
        const students = studRes.status === 'fulfilled'
          ? (Array.isArray(studRes.value.data) ? studRes.value.data : studRes.value.data.students || [])
          : [];
        const homerooms = hrRes.status === 'fulfilled'
          ? (Array.isArray(hrRes.value.data) ? hrRes.value.data : hrRes.value.data.homerooms || [])
          : [];
        setStats({
          students: students.length,
          homerooms: homerooms.length,
          sessions: 0,
        });
      } catch { /* ignore */ }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">GoPilot Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-l-4 border-l-blue-400">
          <p className="text-sm text-slate-500">Students</p>
          <p className="text-3xl font-bold text-slate-900">{stats.students}</p>
        </Card>
        <Card className="border-l-4 border-l-green-400">
          <p className="text-sm text-slate-500">Homerooms</p>
          <p className="text-3xl font-bold text-slate-900">{stats.homerooms}</p>
        </Card>
        <Card className="border-l-4 border-l-amber-400">
          <p className="text-sm text-slate-500">Sessions Today</p>
          <p className="text-3xl font-bold text-slate-900">{stats.sessions}</p>
        </Card>
      </div>
    </div>
  );
}
