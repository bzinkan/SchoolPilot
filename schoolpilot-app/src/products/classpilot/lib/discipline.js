import { apiRequest, queryClient } from '../../../lib/queryClient';
import { myDeskIdentityEpoch, myDeskKeys } from './myDeskModel';

export const disciplineKeys = {
  root: (schoolId, viewerId) => [...myDeskKeys.root(schoolId, viewerId), 'discipline'],
  capabilities: (schoolId, viewerId) => [...disciplineKeys.root(schoolId, viewerId), 'capabilities'],
  access: (schoolId, viewerId) => [...disciplineKeys.root(schoolId, viewerId), 'access'],
  records: (schoolId, viewerId, filters) => [...disciplineKeys.root(schoolId, viewerId), 'records', filters],
  record: (schoolId, viewerId, id) => [...disciplineKeys.root(schoolId, viewerId), 'record', id],
  attachment: (schoolId, viewerId, id, versionId, attachmentId) => [...disciplineKeys.root(schoolId, viewerId), 'attachment', id, versionId, attachmentId],
};

export function disciplineApi(schoolId, signal) {
  if (!schoolId) throw new Error('Select a school before opening discipline records.');
  const epoch = myDeskIdentityEpoch();
  const request = async (method, path, data, config = {}) => {
    const check = () => {
      signal?.throwIfAborted();
      if (epoch !== myDeskIdentityEpoch()) throw new DOMException('School identity changed.', 'AbortError');
    };
    check();
    try {
      const result = await apiRequest(method, `/classpilot/discipline-records${path}`, data, { ...config, signal, headers: { 'X-School-Id': schoolId } });
      check();
      return result;
    } catch (error) {
      check();
      if (error.response?.data instanceof Blob && error.response.data.size <= 65536 && error.response.data.type.includes('json')) {
        try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* Preserve the original failure. */ }
      }
      throw error;
    }
  };
  const id = encodeURIComponent;
  return {
    capabilities: () => request('GET', '/capabilities'),
    access: () => request('GET', '/access'),
    setAccess: (userId, data) => request('PUT', `/access/${id(userId)}`, data),
    search: data => request('POST', '/search', data),
    export: data => request('POST', '/export', data, { responseType: 'blob' }),
    record: (recordId, versionsCursor) => request('GET', `/${id(recordId)}${versionsCursor ? `?versionsCursor=${encodeURIComponent(versionsCursor)}` : ''}`),
    submit: data => request('POST', '/submit', data),
    correct: (recordId, data) => request('POST', `/${id(recordId)}/correct`, data),
    withdraw: (recordId, data) => request('POST', `/${id(recordId)}/withdraw`, data),
    content: (recordId, versionId, attachmentId) => request('GET', `/${id(recordId)}/versions/${id(versionId)}/attachments/${id(attachmentId)}/content`, undefined, { responseType: 'blob' }),
  };
}

export const invalidateDiscipline = (schoolId, viewerId) => queryClient.invalidateQueries({ queryKey: disciplineKeys.root(schoolId, viewerId) });
export const disciplineCategory = key => ({ note: 'Note', detention: 'Detention', referral: 'Referral', uniform: 'Uniform', positive: 'Positive', parent_contact: 'Parent contact', other: 'Other' })[key] || key;
export const disciplineStatus = status => ({ submitted: 'Submitted', withdrawn: 'Withdrawn', superseded: 'Superseded' })[status] || status;
export function downloadDisciplineExport(blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try { anchor.href = url; anchor.download = 'School-discipline-records.csv'; document.body.appendChild(anchor); anchor.click(); }
  finally { anchor.remove(); URL.revokeObjectURL(url); }
}
