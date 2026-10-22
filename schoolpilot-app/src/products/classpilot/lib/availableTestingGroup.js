// Saved group membership grants permission, not a current testing assignment.
// Only the server's applied-block projection may label the Available roster.
export function activeAvailableTestingGroup(student, nowMs) {
  const group = student.activeTestingGroup;
  if (!group || !['groupId', 'name', 'applicationId', 'blockId', 'date'].every(key => (
    typeof group[key] === 'string' && group[key].trim().length > 0
  ))) return null;
  const startsAt = Date.parse(group.startsAt);
  const endsAt = Date.parse(group.endsAt);
  return startsAt <= nowMs && nowMs < endsAt ? group : null;
}
