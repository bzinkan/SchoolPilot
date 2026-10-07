function negotiated(row, name) {
  const accepted = row?.acceptedCapabilities ?? row?.capabilities;
  return Array.isArray(accepted) ? accepted.includes(name) : accepted?.[name] === true;
}

export function focusTabCapability(row) {
  if (!negotiated(row, 'scopedAuthorityChecksV1') || !negotiated(row, 'focusTabV1'))
    return { enabled: false, reason: 'Focus and Bring Forward are unavailable for this student. A negotiated ClassPilot update is required.' };
  if (typeof row.studentId !== 'string' || !row.studentId || typeof row.tabRef !== 'string'
    || !row.tabRef.trim() || row.tabRef.length > 128 || !Number.isSafeInteger(row.observedRevision) || row.observedRevision < 1)
    return { enabled: false, reason: 'Refresh the tab list before selecting an exact tab.' };
  return { enabled: true, reason: '' };
}

export function exactFocusPayload(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50
    || new Set(rows.map(row => row.studentId)).size !== rows.length
    || rows.some(row => !focusTabCapability(row).enabled)) throw new Error('Choose one current exact tab per student.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

export function focusPayloadForStudents(payload, studentIds) {
  if (!Array.isArray(payload?.tabTargets) || !Array.isArray(studentIds) || !studentIds.length
    || new Set(studentIds).size !== studentIds.length) throw new Error('Exact tab targets changed. Refresh and try again.');
  const rows = payload.tabTargets.filter(row => studentIds.includes(row.studentId));
  if (rows.length !== studentIds.length || new Set(rows.map(row => row.studentId)).size !== rows.length)
    throw new Error('Exact tab targets changed. Refresh and try again.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

export function focusStatusLabel(student) {
  const state = student?.focus;
  const requested = student?.classroomState?.restrictions?.focus;
  if (requested?.active === true && typeof requested.assignmentId === 'string'
    && requested.assignmentId && requested.assignmentId !== state?.assignmentId)
    return 'Focus requested; awaiting confirmation';
  if (state?.state === 'active') return 'Focus confirmed';
  if (state?.state === 'suspended') return state.reason === 'attention' ? 'Focus paused for Attention'
    : state.reason === 'authentication' ? 'Focus paused for sign-in' : 'Focus waiting for the browser';
  if (state?.state === 'invalidated') return 'Focus ended: target unavailable';
  return requested?.active === true ? 'Focus requested; awaiting confirmation' : 'No Focus confirmed';
}

export function focusCommandFeedback(value, commandType) {
  const targets = value?.command?.targets || value?.targets || [];
  const completed = targets.filter(row => row.status === 'completed').length;
  const unsuccessful = targets.filter(row => ['failed', 'unavailable', 'expired'].includes(row.status)).length;
  const pending = targets.length - completed - unsuccessful;
  const name = commandType === 'activate-tab' ? 'Bring Forward' : commandType === 'stop-focus' ? 'Stop Focus' : 'Focus';
  return { title: `${name}: ${completed ? 'device confirmation received' : pending ? 'awaiting confirmation' : 'not confirmed'}`,
    description: `${completed} completed, ${pending} pending, ${unsuccessful} failed or unavailable. Per-student results remain visible below.`,
    variant: unsuccessful && !completed && !pending ? 'destructive' : undefined };
}
