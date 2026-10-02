import { Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { usePassPilotAuth } from '../../../hooks/usePassPilotAuth';
import AppShell from '../components/AppShell';
import PassesTab from '../components/tabs/PassesTab';
import MyClassTab from '../components/tabs/MyClassTab';
import RosterTab from '../components/tabs/RosterTab';
import ReportsTab from '../components/tabs/ReportsTab';
import SetupView from '../components/admin/SetupView';
import BillingView from '../components/admin/BillingView';
import KioskScheduleSettings from '../components/KioskScheduleSettings';
const Appointments = lazy(() => import('./Appointments'));

export default function Dashboard() {
  const { isLoading, user, isAdmin, isSchoolwideManager, isTeacher } = usePassPilotAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-12 w-48 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  const legacyHash = location.hash.replace('#', '');
  if (legacyHash.startsWith('setup')) {
    const legacySection = legacyHash.split('/')[1];
    const target = legacySection ? `/passpilot/setup?section=${encodeURIComponent(legacySection)}` : '/passpilot/setup';
    return <Navigate to={target} replace />;
  }

  const routeSegment = location.pathname.replace(/^\/passpilot\/?/, '').split('/')[0];
  if (!routeSegment) return <Navigate to="/passpilot/my-class" replace />;

  const tabBySegment = {
    passes: 'passes',
    'my-class': 'myclass',
    classes: 'roster',
    reports: 'reports',
    setup: 'setup',
    billing: 'billing',
    settings: 'settings',
    appointments: 'appointments',
  };
  const currentTab = tabBySegment[routeSegment];
  if (!currentTab) return <Navigate to="/passpilot/my-class" replace />;
  if (currentTab === 'reports' && !isTeacher && !isSchoolwideManager) {
    return <Navigate to="/passpilot/my-class" replace />;
  }
  if (!isAdmin && ['setup', 'billing'].includes(currentTab)) {
    return <Navigate to="/passpilot/my-class" replace />;
  }

  const renderTabContent = () => {
    switch (currentTab) {
      case 'passes': return <PassesTab user={user} />;
      case 'myclass': return <MyClassTab user={user} />;
      case 'roster': return <RosterTab user={user} />;
      case 'reports': return <ReportsTab user={user} />;
      case 'setup': return <SetupView />;
      case 'billing': return <BillingView />;
      case 'settings': return isTeacher || isAdmin ? <KioskScheduleSettings /> : <Navigate to="/passpilot/my-class" replace />;
      case 'appointments': return <Suspense fallback={<p role="status" className="p-4">Loading appointments…</p>}><Appointments /></Suspense>;
      default: return <PassesTab user={user} />;
    }
  };

  return (
    <AppShell currentTab={currentTab}>
      {renderTabContent()}
    </AppShell>
  );
}
