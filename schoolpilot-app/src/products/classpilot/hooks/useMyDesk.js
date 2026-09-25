import { useQuery } from '@tanstack/react-query';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useAuth } from '../../../contexts/AuthContext';
import { myDeskApi } from '../lib/myDesk';
import { myDeskKeys } from '../lib/myDeskModel';

export function useMyDeskAccess() {
  const { currentUser, school, isAdmin, isTeacher, isLoading } = useClassPilotAuth();
  const { hasClassPilot } = useLicenses();
  const { privateNotebookAuthReady } = useAuth();
  const schoolId = school?.id;
  const viewerId = currentUser?.id;
  const eligible = Boolean(privateNotebookAuthReady && !isLoading && schoolId && viewerId && hasClassPilot && (isAdmin || isTeacher) && !currentUser?.impersonating);
  const capabilities = useQuery({
    queryKey: myDeskKeys.capabilities(schoolId, viewerId),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).get('/capabilities'),
    enabled: eligible, retry: false, staleTime: 15_000, refetchOnWindowFocus: true,
  });
  const failureStatus = capabilities.error?.response?.status;
  const recoverableRefresh = capabilities.data && (!failureStatus || failureStatus === 429 || failureStatus >= 500);
  const capabilityAccepted = !capabilities.isError || recoverableRefresh;
  return { schoolId, viewerId, school, eligible, enabled: eligible && capabilityAccepted && capabilities.data?.enabled === true,
    seatingEnabled: eligible && capabilityAccepted && capabilities.data?.enabled === true && capabilities.data?.seatingEnabled === true,
    importsEnabled: eligible && capabilityAccepted && capabilities.data?.enabled === true && capabilities.data?.aiImportEnabled === true,
    importProvider: capabilities.data?.importProvider || 'Anthropic',
    importLimits: capabilities.data?.importLimits,
    loading: isLoading || (eligible && capabilities.isPending), error: capabilities.error,
    schoolDate: capabilities.data?.schoolDate, refresh: capabilities.refetch };
}

export function useMyDeskClasses(schoolId, viewerId, enabled = true) {
  return useQuery({ queryKey: myDeskKeys.classes(schoolId, viewerId),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).get('/classes'),
    enabled: Boolean(enabled && schoolId && viewerId), staleTime: 30_000, retry: false });
}

export function useMyDeskCategories(schoolId, viewerId) {
  return useQuery({ queryKey: myDeskKeys.categories(schoolId, viewerId),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).get('/categories'),
    enabled: Boolean(schoolId && viewerId), staleTime: 300_000, retry: false });
}

export function useMyDeskStudents(schoolId, viewerId, groupId, options = {}) {
  return useQuery({ queryKey: myDeskKeys.students(schoolId, viewerId, groupId || ''),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).get(`/classes/${encodeURIComponent(groupId)}/students`),
    enabled: Boolean(schoolId && viewerId && groupId), retry: false, staleTime: 30_000, ...options });
}

export function useMyDeskNoteStudents(schoolId, viewerId, groupId) {
  return useQuery({ queryKey: myDeskKeys.noteStudents(schoolId, viewerId, groupId || ''),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).get(`/classes/${encodeURIComponent(groupId)}/note-students`),
    enabled: Boolean(schoolId && viewerId && groupId), retry: false, staleTime: 30_000 });
}

export function useMyDeskStudentClasses(schoolId, viewerId, studentId, currentClasses) {
  const ids = currentClasses.map(item => item.id);
  return useQuery({ queryKey: [...myDeskKeys.root(schoolId, viewerId), 'student-classes', studentId || '', ...ids],
    queryFn: async ({ signal }) => {
      const api = myDeskApi(schoolId, signal);
      const matches = [];
      for (let offset = 0; offset < currentClasses.length; offset += 5) {
        const batch = currentClasses.slice(offset, offset + 5);
        const rosters = await Promise.all(batch.map(item => api.get(`/classes/${encodeURIComponent(item.id)}/students`)));
        batch.forEach((item, index) => { if (rosters[index].students?.some(row => row.id === studentId)) matches.push(item); });
      }
      return matches;
    }, enabled: Boolean(schoolId && viewerId && studentId && ids.length), retry: false, staleTime: 30_000 });
}
