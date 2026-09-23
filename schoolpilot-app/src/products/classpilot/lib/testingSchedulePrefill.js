const MAX_AGE_MS = 15 * 60_000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function testingScheduleNavigation({ schoolId, actorId, groupId }, now = Date.now()) {
  if (![schoolId, actorId, groupId].every(validId)) return null;
  return { pathname: '/classpilot/admin/scheduling', state: { testingGroupPrefill: {
    schoolId, actorId, groupId, requestId: crypto.randomUUID(), createdAt: now,
  } } };
}

export function readTestingSchedulePrefill(state, { schoolId, actorId, isAdmin }, now = Date.now()) {
  const value = state?.testingGroupPrefill;
  if (!isAdmin || !value || value.schoolId !== schoolId || value.actorId !== actorId
    || ![value.schoolId, value.actorId, value.groupId, value.requestId].every(validId)
    || !Number.isFinite(value.createdAt) || value.createdAt > now || now - value.createdAt > MAX_AGE_MS) return null;
  return { groupId: value.groupId, requestId: value.requestId };
}

export function testingGroupDraft(catalog, groupId, blockId = crypto.randomUUID()) {
  const group = catalog?.supervisionGroups?.find(row => row.id === groupId);
  if (!group) throw new Error('This supervision group is no longer available. Return to Supervision and choose an active group.');
  const staffIds = group.staffIds.filter(id => catalog.staff.some(person => person.id === id));
  return { name: `${group.name} testing`.slice(0, 80), grades: [], classIds: [], classRules: [],
    testingBlocks: [{ id: blockId, name: group.name.slice(0, 80), coverageGroupId: group.id,
      assignedStaffId: staffIds.length === 1 ? staffIds[0] : '', startTime: '', endTime: '' }] };
}
