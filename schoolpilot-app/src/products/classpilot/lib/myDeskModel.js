export const MY_DESK_ROOT = 'mydesk-private';
export const MY_DESK_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MY_DESK_MAX_BYTES = 10 * 1024 * 1024;
export const MY_DESK_MAX_ATTACHMENTS = 5;
let privateIdentityEpoch = 0;
export const myDeskIdentityEpoch = () => privateIdentityEpoch;

export const myDeskKeys = {
  root: (schoolId, viewerId) => [MY_DESK_ROOT, schoolId || 'no-school', viewerId || 'no-viewer'],
  capabilities: (schoolId, viewerId) => [...myDeskKeys.root(schoolId, viewerId), 'capabilities'],
  classes: (schoolId, viewerId) => [...myDeskKeys.root(schoolId, viewerId), 'classes'],
  categories: (schoolId, viewerId) => [...myDeskKeys.root(schoolId, viewerId), 'categories'],
  students: (schoolId, viewerId, groupId) => [...myDeskKeys.root(schoolId, viewerId), 'students', groupId],
  noteStudents: (schoolId, viewerId, groupId) => [...myDeskKeys.root(schoolId, viewerId), 'note-students', groupId],
  notes: (schoolId, viewerId, filters) => [...myDeskKeys.root(schoolId, viewerId), 'notes', buildMyDeskQuery(filters)],
  attachment: (schoolId, viewerId, noteId, attachmentId) => [...myDeskKeys.root(schoolId, viewerId), 'attachment', noteId, attachmentId],
  seatingCharts: (schoolId, viewerId, filters) => [...myDeskKeys.root(schoolId, viewerId), 'seating-charts', JSON.stringify(filters)],
  seatingChart: (schoolId, viewerId, chartId) => [...myDeskKeys.root(schoolId, viewerId), 'seating-chart', chartId],
  imports: (schoolId, viewerId) => [...myDeskKeys.root(schoolId, viewerId), 'imports'],
  import: (schoolId, viewerId, id) => [...myDeskKeys.root(schoolId, viewerId), 'import', id],
  importAsset: (schoolId, viewerId, id, assetId) => [...myDeskKeys.root(schoolId, viewerId), 'import-asset', id, assetId],
};

export function buildMyDeskQuery(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ['scope', 'classId', 'studentId', 'category', 'from', 'to', 'q', 'cursor', 'limit']) {
    if (filters[key] !== undefined && filters[key] !== null && String(filters[key]).trim()) params.set(key, String(filters[key]).trim());
  }
  return params.toString();
}

export function validateMyDeskAttachment(file) {
  if (!MY_DESK_ATTACHMENT_TYPES.includes(file.type)) return 'Choose a JPEG, PNG, WebP photo or PDF.';
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MY_DESK_MAX_BYTES) return 'Each attachment must be 10 MiB or smaller.';
  return '';
}

export function myDeskTarget(note) {
  if (note?.targetKind === 'student') return note.studentName || 'Former student';
  if (note?.targetKind === 'class') return note.groupName || 'Past class';
  return 'General';
}

export function targetInput(targetKind, groupId, studentId) {
  return { targetKind, ...(targetKind !== 'general' && groupId ? { groupId } : {}), ...(targetKind === 'student' && studentId ? { studentId } : {}) };
}

export function schoolDate(timeZone = 'America/New_York', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = key => parts.find(item => item.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function myDeskSidebarVisible({ hasPassPilot, hasGoPilot, canUseMyDesk }) {
  return Boolean(hasPassPilot || hasGoPilot || canUseMyDesk);
}

export function myDeskError(error) {
  return error?.response?.data?.error || error?.message || 'Something went wrong. Please try again.';
}

export function isMyDeskNoteMissing(error) {
  return error?.response?.status === 404 && error?.response?.data?.code === 'MYDESK_NOTE_NOT_FOUND';
}

export function clearMyDeskQueries(queryClient) {
  privateIdentityEpoch += 1;
  void queryClient.cancelQueries({ queryKey: [MY_DESK_ROOT] });
  queryClient.removeQueries({ queryKey: [MY_DESK_ROOT] });
}
