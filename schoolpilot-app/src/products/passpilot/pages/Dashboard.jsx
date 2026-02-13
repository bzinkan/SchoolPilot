import { useState } from 'react';
import { usePassPilotAuth } from '../../../hooks/usePassPilotAuth';
import AppShell from '../components/AppShell';
import PassesTab from '../components/tabs/PassesTab';
import MyClassTab from '../components/tabs/MyClassTab';
import RosterTab from '../components/tabs/RosterTab';
import ReportsTab from '../components/tabs/ReportsTab';
import SetupView from '../components/admin/SetupView';
import BillingView from '../components/admin/BillingView';

export default function Dashboard() {
  const { isLoading, user, isAdmin } = usePassPilotAuth();
  const [currentTab, setCurrentTab] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash.startsWith('setup')) {
      window.history.replaceState(null, '', window.location.pathname);
      return 'setup';
    }
    return 'passes';
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-12 w-48 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  const renderTabContent = () => {
    switch (currentTab) {
      case 'passes': return <PassesTab user={user} />;
      case 'myclass': return <MyClassTab user={user} />;
      case 'roster': return <RosterTab user={user} />;
      case 'reports': return <ReportsTab user={user} />;
      case 'setup': return <SetupView />;
      case 'billing': return <BillingView />;
      default: return <PassesTab user={user} />;
    }
  };

  return (
    <AppShell currentTab={currentTab} onTabChange={setCurrentTab}>
      {renderTabContent()}
    </AppShell>
  );
}
