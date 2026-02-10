import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import api from '../../../shared/utils/api';

export default function ClassPilotDashboard() {
  const [stats, setStats] = useState({ devices: 0, online: 0, students: 0, sessions: 0 });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [devRes, sessRes] = await Promise.allSettled([
          api.get('/classpilot/devices'),
          api.get('/classpilot/sessions'),
        ]);
        if (!mounted) return;
        const devices = devRes.status === 'fulfilled' ? devRes.value.data : [];
        const deviceList = Array.isArray(devices) ? devices : devices.devices || [];
        const sessions = sessRes.status === 'fulfilled' ? sessRes.value.data : [];
        const sessionList = Array.isArray(sessions) ? sessions : sessions.sessions || [];
        setStats({
          devices: deviceList.length,
          online: deviceList.filter((d) => d.isOnline || d.status === 'online').length,
          students: 0,
          sessions: sessionList.length,
        });
      } catch { /* ignore */ }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">ClassPilot Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-4 border-l-yellow-400">
          <p className="text-sm text-slate-500">Total Devices</p>
          <p className="text-3xl font-bold text-slate-900">{stats.devices}</p>
        </Card>
        <Card className="border-l-4 border-l-green-400">
          <p className="text-sm text-slate-500">Online Now</p>
          <p className="text-3xl font-bold text-green-600">{stats.online}</p>
        </Card>
        <Card className="border-l-4 border-l-blue-400">
          <p className="text-sm text-slate-500">Active Sessions</p>
          <p className="text-3xl font-bold text-slate-900">{stats.sessions}</p>
        </Card>
        <Card className="border-l-4 border-l-purple-400">
          <p className="text-sm text-slate-500">Students Enrolled</p>
          <p className="text-3xl font-bold text-slate-900">{stats.students}</p>
        </Card>
      </div>
    </div>
  );
}
