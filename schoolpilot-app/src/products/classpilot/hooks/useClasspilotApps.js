import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { apiRequest } from '../../../lib/queryClient';
import { appLibraryKey } from '../lib/appLibrary';

const EMPTY_APPS = Object.freeze([]);
const SUPPORT_UNAVAILABLE = 'App buttons are unavailable in support sessions. Exit support mode to use your personal and school apps.';

export function useClasspilotApps({ enabled = true } = {}) {
  const { currentUser } = useClassPilotAuth();
  const schoolId = currentUser?.schoolId, viewerId = currentUser?.id;
  const impersonating = currentUser?.impersonating === true;
  const scopeId = `${schoolId || ''}:${viewerId || ''}:${impersonating ? 'support' : 'staff'}`;
  const key = appLibraryKey(schoolId, viewerId);
  const client = useQueryClient();
  const scope = useRef(null);
  const [mutation, setMutation] = useState({ scopeId, busy: false, error: null });
  const authorized = !impersonating && Boolean(currentUser?.roles?.some(role => ['teacher', 'school_admin', 'admin'].includes(role)));

  useLayoutEffect(() => {
    const current = { id: scopeId, controller: new AbortController(), pending: false, alive: true };
    scope.current = current;
    if (impersonating) void client.cancelQueries({ queryKey: appLibraryKey(schoolId, viewerId), exact: true });
    return () => { current.alive = false; current.controller.abort(); };
  }, [scopeId, client, schoolId, viewerId, impersonating]);

  const query = useQuery({
    queryKey: key,
    enabled: Boolean(enabled && authorized && schoolId && viewerId),
    queryFn: ({ signal }) => apiRequest('GET', '/classpilot/apps', undefined, { signal, headers: { 'X-School-Id': schoolId } }),
    retry: false,
  });

  async function write(method, suffix, body) {
    const current = scope.current;
    if (!authorized || !current?.alive || current.id !== scopeId) throw new DOMException('App library context changed', 'AbortError');
    if (current.pending) throw new Error('An app update is already in progress.');
    current.pending = true; setMutation({ scopeId, busy: true, error: null });
    try {
      const response = await apiRequest(method, `/classpilot/apps${suffix}`, body, { signal: current.controller.signal, headers: { 'X-School-Id': schoolId } });
      if (!current.alive || scope.current !== current) throw new DOMException('App library context changed', 'AbortError');
      client.setQueryData(key, data => {
        if (!data) return data;
        const appKey = decodeURIComponent(suffix.split('/')[1] || '');
        if (method === 'DELETE') return { ...data, apps: data.apps.filter(app => app.key !== appKey) };
        if (!response?.app) return data;
        const exists = data.apps.some(app => app.key === response.app.key);
        return { ...data, apps: exists ? data.apps.map(app => app.key === response.app.key ? response.app : app) : [...data.apps, response.app] };
      });
      await client.invalidateQueries({ queryKey: key, exact: true });
      if (!current.alive || scope.current !== current) throw new DOMException('App library context changed', 'AbortError');
      return response?.app;
    } catch (error) {
      if (error?.response?.status === 409 && current.alive && scope.current === current) {
        // Refresh definitions for review, while the editor/confirmation keeps
        // its original revision. A stale write is never retried automatically.
        await client.invalidateQueries({ queryKey: key, exact: true });
      }
      if (current.alive && scope.current === current) setMutation({ scopeId, busy: true, error });
      throw error;
    } finally {
      current.pending = false;
      if (current.alive && scope.current === current) setMutation(value => ({ ...value, busy: false }));
    }
  }

  return {
    scopeId,
    apps: authorized ? query.data?.apps || EMPTY_APPS : EMPTY_APPS,
    canManageSchoolApps: authorized && query.data?.canManageSchoolApps === true,
    isLoading: authorized && query.isPending && query.fetchStatus !== 'idle',
    unavailableReason: impersonating ? SUPPORT_UNAVAILABLE : null,
    loadError: query.error,
    retry: () => authorized && scope.current?.alive && scope.current.id === scopeId ? query.refetch() : Promise.resolve(),
    busy: mutation.scopeId === scopeId && mutation.busy,
    error: mutation.scopeId === scopeId ? mutation.error : null,
    clearError: () => setMutation({ scopeId, busy: false, error: null }),
    createApp: (appScope, values) => write('POST', '', { scope: appScope, ...values }),
    updateApp: (appKey, values, expectedRevision) => write('PATCH', `/${encodeURIComponent(appKey)}`, { ...values, expectedRevision }),
    deleteApp: (appKey, expectedRevision) => write('DELETE', `/${encodeURIComponent(appKey)}`, { expectedRevision }),
    setPreferences: (appKey, values) => write('PUT', `/${encodeURIComponent(appKey)}/preferences`, values),
  };
}
