import { useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { legacyAdminQuery } from '../../lib/adminNavigation';

export default function AdminQueryBoundary({ scopeKey, blockChildren = true, children }) {
  const client = useQueryClient();
  const [ready, setReady] = useState(null);
  useLayoutEffect(() => {
    let active = true;
    // Admin-route children from the old identity are absent from this commit.
    // Cancel their reads before removing caches and mounting the new identity.
    void client.cancelQueries({ predicate: legacyAdminQuery }).then(() => {
      if (!active) return;
      client.removeQueries({ predicate: legacyAdminQuery });
      setReady(scopeKey);
    });
    return () => { active = false; };
  }, [client, scopeKey]);
  // Authentication callbacks must stay mounted while they finish accepting an
  // identity. Only admin routes wait for the legacy admin cache cleanup; the
  // teacher workspace keeps ownership of its existing identity lifecycle.
  return !blockChildren || ready === scopeKey ? children : <p role="status" className="p-6 text-sm text-muted-foreground">Checking school access…</p>;
}
