import { useQuery } from '@tanstack/react-query';
import api from '../../shared/utils/api';
import { PASSPILOT_CLASS_MODEL_HEADER } from './classData';

export function appointmentScope(user, school) {
  return [school?.id || '', user?.id || '', (user?.roles || [user?.role]).filter(Boolean).join(',')];
}

export async function appointmentRequest(schoolId, method, url, data, signal) {
  const response = await api({ method, url, data, signal,
    headers: { ...PASSPILOT_CLASS_MODEL_HEADER, 'X-School-Id': schoolId } });
  return response.data;
}

export function useAppointmentCapabilities(user, school) {
  return useQuery({ queryKey: ['passpilot-appointment-capabilities', ...appointmentScope(user, school)],
    queryFn: async ({ signal }) => {
      try { return await appointmentRequest(school.id, 'GET', '/passpilot/appointments/capabilities', undefined, signal); }
      catch (error) { if (error.response?.status === 404) return { enabled: false }; throw error; }
    }, enabled: Boolean(user?.id && school?.id), retry: false, staleTime: 10000, refetchOnWindowFocus: true });
}

export function appointmentErrorText(error) {
  return error?.response?.data?.error || error?.message || 'The request could not be completed. Try again.';
}
