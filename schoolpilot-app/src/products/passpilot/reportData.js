import { useQuery } from '@tanstack/react-query';
import api from '../../shared/utils/api';
import { PASSPILOT_CLASS_MODEL_HEADER } from './classData';
import { reportScope } from './reportModel';
export async function reportRequest(schoolId, url, signal, responseType) {
  const response = await api({ method: 'GET', url, signal, responseType, headers: { ...PASSPILOT_CLASS_MODEL_HEADER, 'X-School-Id': schoolId } });
  return response.data;
}
export function useReportCapabilities(user, school) {
  return useQuery({ queryKey: ['passpilot-reports-capabilities', ...reportScope(user, school)], enabled: Boolean(user?.id && school?.id), retry: false,
    staleTime: 10000, refetchOnWindowFocus: true, queryFn: async ({ signal }) => {
      try { return await reportRequest(school.id, '/passpilot/reports/capabilities', signal); }
      catch (error) { if (error.response?.status === 404) return { enabled: false }; throw error; }
    } });
}
export async function reportError(error) {
  let body = error?.response?.data;
  if (body instanceof Blob) { try { body = JSON.parse(await body.text()); } catch { body = null; } }
  return body?.error || error?.message || 'The report could not be loaded. Try again.';
}
