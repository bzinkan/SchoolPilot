import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { createWindowsBrowserRequests, WINDOWS_TILES_PATH, windowsBrowserMetadata, windowsBrowserSources,
  windowsBrowserSourceKey } from '../lib/windowsBrowsers';

const combineQueries = queries => queries.map(query => [query.data, query.isError, query.isPlaceholderData, query.error?.response?.status]);

export function useWindowsBrowsers({ enabled, students, schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts, selections }) {
  const [metadata, setMetadata] = useState(() => new Map());
  const [visibility, setVisibility] = useState(() => ({ visible: document.visibilityState === 'visible', epoch: 0 }));
  useEffect(() => {
    const changed = () => setVisibility(current => ({ visible: document.visibilityState === 'visible', epoch: current.epoch + 1 }));
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const requests = useMemo(() => enabled ? createWindowsBrowserRequests(students, {
    schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts,
  }, selections, visibility.epoch) : [],
  [enabled, students, schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts, selections, visibility.epoch]);
  const queryStates = useQueries({ combine: combineQueries, queries: requests.map(request => ({
    queryKey: request.queryKey,
    enabled: visibility.visible,
    queryFn: async ({ signal }) => {
      const started = performance.now();
      const response = await apiRequest('POST', WINDOWS_TILES_PATH, request.body, { signal, headers: request.headers, timeout: 8_000 });
      const received = performance.now();
      if (response?.enabled === false) return { enabled: false, tiles: [] };
      if (response?.enabled !== true || !Array.isArray(response.tiles) || !Number.isFinite(Date.parse(response.serverTime))) {
        throw new Error('Browser source discovery returned an invalid response.');
      }
      const requested = new Set(request.selectedSources.map(target => `${target.studentId}:${windowsBrowserSourceKey(target)}`));
      return { enabled: true, tiles: response.tiles.map(tile => ({ studentId: tile.studentId,
        platform: tile.platform, windowsSession: tile.windowsSession, browserCoverage: tile.browserCoverage, browserOwner: tile.browserOwner,
        browserSources: windowsBrowserSources(tile.browserSources).map(source => {
          if (!requested.has(`${tile.studentId}:${windowsBrowserSourceKey(source)}`)) {
            return windowsBrowserMetadata({ tiles: [{ studentId: tile.studentId, browserSources: [source] }] }).tiles[0].browserSources[0];
          }
          const remaining = Date.parse(source.expiresAt) - Date.parse(response.serverTime);
          return { ...source, _imageDeadline: Number.isFinite(remaining)
            ? received + Math.max(0, remaining - (received - started)) : 0 };
        }) })) };
    },
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey?.[1] === request.contextKey
      ? windowsBrowserMetadata(previous) : undefined,
    refetchInterval: query => query.state.data?.enabled === false
      || [401, 403, 404, 409].includes(query.state.error?.response?.status) ? false : request.selectedSources.length ? 5_000 : 15_000,
    refetchIntervalInBackground: false, retry: false, gcTime: 0,
  })) });
  const result = useMemo(() => {
  const result = new Map();
  requests.forEach((request, index) => {
    const [data, isError, isPlaceholderData, errorStatus] = queryStates[index];
    const query = { data, isError, isPlaceholderData };
    const cached = metadata.get(JSON.stringify([request.contextKey, request.body.studentIds]));
    if (!cached && data?.enabled !== false && (!data || isError) && errorStatus !== 404) {
      for (const studentId of request.body.studentIds) result.set(studentId, { contextKey: request.contextKey, pending: true, unavailable: isError, browserSources: [] });
      return;
    }
    if (query.data?.enabled !== true && !cached) return;
    const response = query.isError || !visibility.visible || query.isPlaceholderData
      ? windowsBrowserMetadata(query.data || cached) : query.data?.enabled === true ? query.data : windowsBrowserMetadata(cached);
    const tiles = new Map((response?.tiles || []).map(tile => [tile.studentId, tile]));
    for (const studentId of request.body.studentIds) {
      result.set(studentId, { contextKey: request.contextKey, authority: request.authority, headers: request.headers,
        platform: tiles.get(studentId)?.platform, windowsSession: tiles.get(studentId)?.windowsSession, browserCoverage: tiles.get(studentId)?.browserCoverage,
        browserOwner: tiles.get(studentId)?.browserOwner,
        browserSources: tiles.get(studentId)?.browserSources || [], unavailable: query.isError || !visibility.visible || query.data?.enabled === false,
        visibilityEpoch: visibility.epoch });
    }
  });
  return result;
  }, [requests, queryStates, visibility, metadata]);
  useEffect(() => {
    setMetadata(current => {
      const next = new Map();
      requests.forEach((request, index) => {
        const key = JSON.stringify([request.contextKey, request.body.studentIds]);
        const data = queryStates[index][0];
        const value = data?.enabled === true ? windowsBrowserMetadata(data) : current.get(key);
        if (value) next.set(key, value);
      });
      return JSON.stringify([...current]) === JSON.stringify([...next]) ? current : next;
    });
  }, [requests, queryStates]);
  return result;
}
