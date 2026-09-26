import { apiRequest, queryClient } from '../../../lib/queryClient';
import { myDeskKeys, buildMyDeskQuery, myDeskIdentityEpoch } from './myDeskModel';

export function myDeskApi(schoolId, signal) {
  if (!schoolId) throw new Error('Select a school before opening My Desk.');
  const identityEpoch = myDeskIdentityEpoch();
  const request = async (method, path, data, config = {}) => {
    if (identityEpoch !== myDeskIdentityEpoch()) throw new DOMException('Notebook identity changed.', 'AbortError');
    signal?.throwIfAborted();
    try {
      const result = await apiRequest(method, `/mydesk${path}`, data, { signal, ...config, headers: { 'X-School-Id': schoolId, ...config.headers } });
      if (identityEpoch !== myDeskIdentityEpoch()) throw new DOMException('Notebook identity changed.', 'AbortError');
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      // Axios also returns error bodies as blobs for authenticated file/export reads.
      if (error.response?.data instanceof Blob && error.response.data.size <= 65536 && error.response.data.type.includes('json')) {
        try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* Keep the original error. */ }
      }
      throw error;
    }
  };
  return {
    get: path => request('GET', path),
    preferences: () => request('GET', '/preferences'),
    updatePreferences: data => request('PATCH', '/preferences', data),
    students: filters => request('POST', '/students/search', filters),
    studentHistory: (id, filters) => request('POST', `/students/${encodeURIComponent(id)}/history`, Object.fromEntries(new URLSearchParams(buildMyDeskQuery(filters)))),
    exportStudentHistory: (id, filters) => request('POST', `/students/${encodeURIComponent(id)}/export`, Object.fromEntries(new URLSearchParams(buildMyDeskQuery(filters))), { responseType: 'blob' }),
    search: filters => request('POST', '/notes/search', Object.fromEntries(new URLSearchParams(buildMyDeskQuery(filters)))),
    create: data => request('POST', '/notes', data),
    complete: (id, data) => request('POST', `/notes/${encodeURIComponent(id)}/complete`, data),
    update: (id, data) => request('PATCH', `/notes/${encodeURIComponent(id)}`, data),
    remove: (id, revision) => request('DELETE', `/notes/${encodeURIComponent(id)}`, { revision }),
    reserveAttachment: (id, data) => request('POST', `/notes/${encodeURIComponent(id)}/attachments`, data),
    upload: (noteId, id, file) => request('PUT', `/notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(id)}/content`, file, { headers: { 'Content-Type': file.type } }),
    content: (noteId, id) => request('GET', `/notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(id)}/content`, undefined, { responseType: 'blob' }),
    removeAttachment: (noteId, id, revision) => request('DELETE', `/notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(id)}`, { revision }),
    export: filters => request('POST', '/export', Object.fromEntries(new URLSearchParams(buildMyDeskQuery(filters))), { responseType: 'blob' }),
    seatingCharts: filters => request('GET', `/seating-charts?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value != null))}`),
    seatingChart: id => request('GET', `/seating-charts/${encodeURIComponent(id)}?layoutVersion=2`),
    createSeatingChart: data => request('POST', '/seating-charts', data),
    updateSeatingChart: (id, data) => request('PATCH', `/seating-charts/${encodeURIComponent(id)}`, data),
    deleteSeatingChart: (id, data) => request('DELETE', `/seating-charts/${encodeURIComponent(id)}`, data),
    duplicateSeatingChart: (id, data) => request('POST', `/seating-charts/${encodeURIComponent(id)}/duplicate?layoutVersion=2`, data),
    currentSeatingChart: (id, data) => request('PUT', `/seating-charts/${encodeURIComponent(id)}/current?layoutVersion=2`, data),
    imports: (cursor = '') => request('GET', `/imports?${new URLSearchParams({ limit: '30', ...(cursor ? { cursor } : {}) })}`),
    import: id => request('GET', `/imports/${encodeURIComponent(id)}`),
    createImport: data => request('POST', '/imports', data),
    importFromAttachment: data => request('POST', '/imports/from-attachment', data),
    updateImport: (id, data) => request('PATCH', `/imports/${encodeURIComponent(id)}`, data),
    reserveImportAsset: (id, data) => request('POST', `/imports/${encodeURIComponent(id)}/assets`, data),
    uploadImportAsset: (id, assetId, file) => request('PUT', `/imports/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/content`, file, { headers: { 'Content-Type': file.type } }),
    importContent: (id, assetId) => request('GET', `/imports/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/content`, undefined, { responseType: 'blob' }),
    processImport: (id, data) => request('POST', `/imports/${encodeURIComponent(id)}/process`, data),
    updateImportItem: (id, itemId, data) => request('PATCH', `/imports/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, data),
    createImportItem: (id, data) => request('POST', `/imports/${encodeURIComponent(id)}/items`, data),
    rereadImportItem: (id, itemId, data) => request('POST', `/imports/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/reread`, data),
    joinImportItem: (id, itemId, data) => request('POST', `/imports/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/join`, data),
    commitImport: (id, data) => request('POST', `/imports/${encodeURIComponent(id)}/commit`, data),
    cancelImport: (id, data) => request('DELETE', `/imports/${encodeURIComponent(id)}`, data),
  };
}

export function invalidateMyDesk(schoolId, viewerId) {
  return queryClient.invalidateQueries({ queryKey: myDeskKeys.root(schoolId, viewerId) });
}

export async function attachmentDigest(file) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
