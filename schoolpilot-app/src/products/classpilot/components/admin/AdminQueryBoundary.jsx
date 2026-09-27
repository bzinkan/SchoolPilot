import { useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { legacyAdminQuery } from '../../lib/adminNavigation';

export default function AdminQueryBoundary({ scopeKey, children }) {
  const client = useQueryClient();
  const [ready, setReady] = useState(null);
  useLayoutEffect(() => {
    let active = true;
    // Children from the old identity are already absent from this commit. Wait
    // for cancellation before removing caches and mounting the new identity.
    void client.cancelQueries({ predicate: legacyAdminQuery }).then(() => {
      if (!active) return;
      client.removeQueries({ predicate: legacyAdminQuery });
      setReady(scopeKey);
    });
    return () => { active = false; };
  }, [client, scopeKey]);
  return ready === scopeKey ? children : <p role="status" className="p-6 text-sm text-muted-foreground">Checking school access…</p>;
}
