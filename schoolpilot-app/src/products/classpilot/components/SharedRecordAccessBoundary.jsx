import { Fragment, useEffect, useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { sharedRecordQuery, subscribeSharedRecordRefresh } from '../lib/sharedRecordRefresh';

export function SharedRecordAccessSession({ schoolId, viewerId, token, role, importId, children }) {
  const client = useQueryClient();
  const [state, setState] = useState({ epoch: 0, checking: false });
  useLayoutEffect(() => {
    if (!state.checking) return;
    let active = true;
    const predicate = query => sharedRecordQuery(query, schoolId, viewerId, importId);
    // React has committed the empty access-check screen before cleanup begins.
    // Keep it mounted until old requests/cache are gone; remounting then creates
    // fresh editor lifetimes, so a late result cannot restore the removed draft.
    void client.cancelQueries({ predicate }).then(() => {
      if (!active) return;
      client.removeQueries({ predicate });
      void client.invalidateQueries({ queryKey: ['mydesk-private', schoolId, viewerId, 'classes'] });
      setState(previous => ({ ...previous, checking: false }));
    });
    return () => { active = false; };
  }, [client, schoolId, viewerId, importId, state.checking]);
  useEffect(() => {
    let active = true;
    const predicate = query => sharedRecordQuery(query, schoolId, viewerId, importId);
    const onRefresh = () => { void client.refetchQueries({ predicate, type: 'active' }); };
    const onAccessChange = () => {
      if (!active) return;
      setState(previous => previous.checking ? previous : { epoch: previous.epoch + 1, checking: true });
    };
    const release = subscribeSharedRecordRefresh({ schoolId, viewerId, token, role, onRefresh, onAccessChange });
    return () => { active = false; release(); };
  }, [client, schoolId, viewerId, token, role, importId]);
  return <>{state.epoch > 0 && <p role="status" className="mydesk-access">School access changed. Records were refreshed; reopen any unfinished editor.</p>}
    {state.checking ? <p role="status" className="mydesk-access">Checking current student access…</p> : <Fragment key={state.epoch}>{children}</Fragment>}</>;
}

export default function SharedRecordAccessBoundary({ children, importId }) {
  const { currentUser, school, token } = useClassPilotAuth();
  return <SharedRecordAccessSession key={`${school?.id}:${currentUser?.id}:${currentUser?.impersonating}`}
    schoolId={school?.id} viewerId={currentUser?.id} token={token} role={currentUser?.role} importId={importId}>{children}</SharedRecordAccessSession>;
}
