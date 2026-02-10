import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import api from '../../../shared/utils/api';

export default function PassPilotDashboard() {
  const [stats, setStats] = useState({ active: 0, today: 0, overdue: 0 });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await api.get('/passpilot/passes/active');
        const passes = res.data.passes || [];
        if (!mounted) return;
        setStats({
          active: passes.length,
          today: passes.length,
          overdue: passes.filter((p) => p.isOverdue).length,
        });
      } catch { /* ignore */ }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">PassPilot Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-l-4 border-l-purple-400">
          <p className="text-sm text-slate-500">Active Passes</p>
          <p className="text-3xl font-bold text-purple-600">{stats.active}</p>
        </Card>
        <Card className="border-l-4 border-l-green-400">
          <p className="text-sm text-slate-500">Issued Today</p>
          <p className="text-3xl font-bold text-slate-900">{stats.today}</p>
        </Card>
        <Card className="border-l-4 border-l-red-400">
          <p className="text-sm text-slate-500">Overdue</p>
          <p className="text-3xl font-bold text-red-600">{stats.overdue}</p>
        </Card>
      </div>
    </div>
  );
}
