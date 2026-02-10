import Card from '../../../shared/components/Card';
import { useAuth } from '../../../contexts/AuthContext';

export default function ClassPilotSettings() {
  const { activeMembership } = useAuth();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">ClassPilot Settings</h1>
      <Card>
        <h2 className="mb-4 text-lg font-semibold">School Information</h2>
        <div className="space-y-2 text-sm">
          <p><span className="text-slate-500">School:</span> {activeMembership?.schoolName || '—'}</p>
          <p><span className="text-slate-500">Role:</span> {activeMembership?.role || '—'}</p>
        </div>
      </Card>
    </div>
  );
}
