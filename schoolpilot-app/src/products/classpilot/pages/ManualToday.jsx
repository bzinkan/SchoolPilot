import { Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useAdminNavigation } from '../hooks/useAdminNavigation';
import { useManualToday } from '../hooks/useManualToday';
import ManualTodayManager from '../components/ManualTodayManager';
import { TeacherSettingsTabs } from '../components/ScheduleRouteTabs';
import { SchedulePageHeader } from '../components/ScheduleChangeUI';

function ManualTodayWorkspace({ schoolId, viewerId, admin }) {
  const { navigate } = useAdminNavigation();
  const query = useManualToday({ schoolId, viewerId, accessScope: admin ? 'admin' : 'teacher' });
  return <div className="min-h-screen bg-background">
    <SchedulePageHeader eyebrow="Teaching tools" title="Manual for today"
      description="Prepare selected classes for manual starts today. This does not start a class or change its saved schedule."
      actions={<><ThemeToggle /><Button variant="outline" className="border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 hover:text-white" onClick={() => navigate('/classpilot')} data-testid="button-back-classpilot"><ArrowLeft className="mr-2 h-4 w-4" />Back to ClassPilot</Button></>}>
      <TeacherSettingsTabs />
    </SchedulePageHeader>
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="rounded-lg border bg-card p-4 sm:p-6">
        <ManualTodayManager query={query} schoolId={schoolId} />
      </div>
    </main>
  </div>;
}

export default function ManualToday() {
  const { currentUser, isAdmin, isTeacher, isLoading } = useClassPilotAuth();
  if (isLoading) return <p role="status" className="p-6">Loading Teaching tools…</p>;
  if (!currentUser?.schoolId || !(isAdmin || isTeacher || currentUser.isSuperAdmin)) return <Navigate to="/classpilot" replace />;
  const admin = isAdmin || currentUser.isSuperAdmin;
  return <ManualTodayWorkspace key={`${currentUser.schoolId}:${currentUser.id}:${admin ? 'admin' : 'teacher'}`}
    schoolId={currentUser.schoolId} viewerId={currentUser.id} admin={admin} />;
}
