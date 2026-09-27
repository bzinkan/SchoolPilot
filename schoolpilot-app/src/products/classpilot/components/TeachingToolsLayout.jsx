import { useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { adminIdentityKey } from '../lib/adminNavigation';
import { teachingToolsQuery } from '../lib/teachingTools';
import AdminNavigationProvider from './admin/AdminNavigationProvider';

export default function TeachingToolsLayout() {
  const { user, activeMembership, activeSchoolId } = useAuth();
  const scopeKey = adminIdentityKey(user, activeMembership, activeSchoolId);
  const client = useQueryClient();
  const [ready, setReady] = useState(null);
  useLayoutEffect(() => {
    let active = true;
    void client.cancelQueries({ predicate: teachingToolsQuery }).then(() => {
      if (!active) return;
      client.removeQueries({ predicate: teachingToolsQuery });
      setReady(scopeKey);
    });
    return () => {
      active = false;
      // Cancellation aborts consumed signals before these scoped entries are removed.
      void client.cancelQueries({ predicate: teachingToolsQuery });
      client.removeQueries({ predicate: teachingToolsQuery });
    };
  }, [client, scopeKey]);
  if (ready !== scopeKey) return <p role="status" className="p-6 text-sm text-muted-foreground">Checking teaching access…</p>;
  return <AdminNavigationProvider key={scopeKey} scopeKey={scopeKey} shell={false}><Outlet /></AdminNavigationProvider>;
}
