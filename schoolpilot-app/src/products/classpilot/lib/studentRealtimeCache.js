import { normalizeObservedAtForOrdering } from './studentMonitoringDisplay.js';

const REALTIME_FIELDS = Object.freeze([
  'activeTabUrl',
  'activeTabTitle',
  'favicon',
  'allOpenTabs',
  'tabSnapshot',
  'tabSnapshotRevision',
  'extensionVersion',
  'capabilities',
  'acceptedCapabilities',
  'screenLocked',
  'isSharing',
  'cameraActive',
  'flightPathActive',
  'activeFlightPathName',
  'aiClassification',
  'aiCategory',
  'screenshotHealth',
  'realtimeBinding',
  'realtimeRevision',
  'realtimeObservedAt',
  'activityFresh',
  'activityState',
  'monitoringState',
  'monitoringLostAt',
  'classificationPending',
  'openTabCount',
  'tabsTruncated',
  'classroomState',
  'enforcementHealth',
  'status',
  'loginState',
  'isLoggedIn',
  'lastSeenAt',
]);

function rowsFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.students)) return data.students;
  return null;
}

function withRows(data, rows) {
  if (Array.isArray(data)) return rows;
  if (data && Array.isArray(data.students)) return { ...data, students: rows };
  return data;
}

function eventBody(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.data && typeof event.data === 'object') {
    return { ...event.data, ...event, data: undefined };
  }
  return event;
}

function finiteRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function normalizedRealtimeBinding(value) {
  if (typeof value !== 'string') return null;
  const binding = value.trim();
  return binding && binding.length <= 128 ? binding : null;
}

function retiredRealtimeBindings(row) {
  if (!Array.isArray(row?._retiredRealtimeBindings)) return [];
  return row._retiredRealtimeBindings
    .map(normalizedRealtimeBinding)
    .filter(Boolean)
    .slice(-8);
}

function resetForRealtimeBinding(row, binding) {
  const currentBinding = normalizedRealtimeBinding(row.realtimeBinding);
  const retired = new Set(retiredRealtimeBindings(row));
  if (currentBinding && currentBinding !== binding) retired.add(currentBinding);
  retired.delete(binding);

  const next = { ...row };
  for (const field of REALTIME_FIELDS) delete next[field];
  return {
    ...next,
    realtimeBinding: binding,
    activeTabUrl: '',
    activeTabTitle: '',
    favicon: null,
    allOpenTabs: [],
    tabSnapshot: null,
    tabSnapshotRevision: null,
    extensionVersion: null,
    capabilities: {},
    acceptedCapabilities: {},
    screenLocked: false,
    isSharing: false,
    cameraActive: false,
    flightPathActive: false,
    activeFlightPathName: undefined,
    aiClassification: null,
    aiCategory: null,
    screenshotHealth: undefined,
    realtimeRevision: null,
    realtimeObservedAt: null,
    activityFresh: false,
    activityState: 'unknown',
    monitoringState: 'signal_lost',
    monitoringLostAt: null,
    classificationPending: false,
    openTabCount: 0,
    tabsTruncated: false,
    classroomState: undefined,
    enforcementHealth: 'unsupported',
    status: 'offline',
    loginState: 'not_logged_in',
    isLoggedIn: false,
    lastSeenAt: null,
    _realtimeSignedOut: false,
    _retiredRealtimeBindings: [...retired].slice(-8),
  };
}

function prepareRealtimeBinding(row, event) {
  const incomingBinding = normalizedRealtimeBinding(event.realtimeBinding);
  const currentBinding = normalizedRealtimeBinding(row.realtimeBinding);

  // All public v2 messages carry a binding. Reject malformed v2 messages so
  // they cannot bypass the session-switch guard; unversioned legacy messages
  // remain supported during rollout.
  if (Number(event.eventVersion) >= 2 && !incomingBinding) {
    return { accepted: false, row, changed: false };
  }
  if (!incomingBinding) return { accepted: true, row, changed: false };
  if (incomingBinding === currentBinding) return { accepted: true, row, changed: false };
  if (retiredRealtimeBindings(row).includes(incomingBinding)) {
    return { accepted: false, row, changed: false };
  }
  if (!currentBinding) {
    return {
      accepted: true,
      row: resetForRealtimeBinding(row, incomingBinding),
      changed: true,
    };
  }
  // Compare before resetForRealtimeBinding removes the current revision/time.
  // A previously unseen but older binding can arrive after the real replacement
  // through Redis and must not retire that newer session.
  if (!isNewerRealtimeObservation(event, row)) {
    return { accepted: false, row, changed: false };
  }
  return {
    accepted: true,
    row: resetForRealtimeBinding(row, incomingBinding),
    changed: true,
  };
}

function firstNormalizedObservation(values, nowMs) {
  for (const value of values) {
    const normalized = normalizeObservedAtForOrdering(value, nowMs);
    if (normalized !== null) return normalized;
  }
  return null;
}

function eventObservedAt(event, nowMs = Date.now()) {
  return firstNormalizedObservation([
    event?.observedAtMs,
    event?.realtimeObservedAt,
    event?.timestamp,
    event?.lastSeenAt,
  ], nowMs);
}

function rowObservedAt(row, nowMs = Date.now()) {
  return firstNormalizedObservation([
    row?.realtimeObservedAt,
    row?.lastSeenAt,
  ], nowMs);
}

function isNewerRealtimeObservation(incoming, current) {
  const nowMs = Date.now();
  const incomingRevision = finiteRevision(incoming.revision ?? incoming.realtimeRevision);
  const currentRevision = finiteRevision(current.realtimeRevision);
  const incomingTime = eventObservedAt(incoming, nowMs);
  const currentTime = rowObservedAt(current, nowMs);

  // Server-observed time spans device/session bindings, whereas a revision may
  // restart lower when a student moves to a different Chromebook. Prefer time
  // when both sides provide it, then use the revision as a deterministic
  // same-time or rollout fallback.
  if (currentTime !== null && incomingTime === null) return false;
  if (incomingTime !== null && currentTime !== null && incomingTime !== currentTime) {
    return incomingTime > currentTime;
  }
  if (incomingRevision !== null && currentRevision !== null) {
    return incomingRevision > currentRevision;
  }
  if (incomingTime !== null && currentTime === null) return true;
  if (incomingRevision !== null && currentRevision === null) return true;
  return currentRevision === null && currentTime === null;
}

function sameSchool(event, schoolId) {
  if (!event.schoolId || !schoolId) return true;
  return String(event.schoolId) === String(schoolId);
}

export function aggregateSnapshotHasStudent(data, studentId) {
  if (typeof studentId !== 'string' || !studentId) return false;
  return (rowsFrom(data) || []).some((student) => student?.studentId === studentId);
}

function sameTeachingSession(event, teachingSessionId, allowSessionlessEvents) {
  const eventSessionId = event.teachingSessionId ?? event.sessionId;
  // Additive rollout compatibility: older events do not carry a session. The
  // dashboard accepts those only after the current session subscription ACKs.
  if (!teachingSessionId) return true;
  if (!eventSessionId) return allowSessionlessEvents === true;
  return String(eventSessionId) === String(teachingSessionId);
}

function sameDevice(event, row) {
  // Teacher-facing v2 events are student scoped and intentionally omit raw
  // device identifiers. Keep this compatibility guard only during rollout.
  if (!event.deviceId || !row.primaryDeviceId) return true;
  return String(event.deviceId) === String(row.primaryDeviceId);
}

function canApplyVersion(event, row) {
  const nowMs = Date.now();
  const incomingRevision = finiteRevision(event.revision ?? event.realtimeRevision);
  const currentRevision = finiteRevision(row.realtimeRevision);

  if (incomingRevision !== null) {
    return currentRevision === null || incomingRevision > currentRevision;
  }

  // Unversioned messages are accepted only until a versioned state has arrived.
  if (currentRevision !== null) return false;
  const incomingTime = eventObservedAt(event, nowMs);
  const currentTime = rowObservedAt(row, nowMs);
  return incomingTime === null || currentTime === null || incomingTime > currentTime;
}

function normalizedClassification(event) {
  const value = event.aiClassification ?? event.classification;
  if (!value || typeof value !== 'object') return null;
  return value;
}

function mapStudentUpdate(row, event) {
  if (row._realtimeSignedOut) return row;

  const next = { ...row };
  const copy = (field, sourceField = field) => {
    if (Object.prototype.hasOwnProperty.call(event, sourceField)) next[field] = event[sourceField];
  };

  copy('activeTabUrl');
  copy('activeTabTitle');
  copy('favicon');
  copy('allOpenTabs');
  copy('tabSnapshot');
  copy('tabSnapshotRevision');
  copy('extensionVersion');
  copy('capabilities');
  copy('acceptedCapabilities');
  copy('isSharing');
  copy('cameraActive');
  copy('screenshotHealth');
  copy('activityFresh');
  copy('activityState');
  copy('monitoringState');
  copy('monitoringLostAt');
  copy('classificationPending');
  copy('openTabCount');
  copy('tabsTruncated');
  copy('screenLocked');
  copy('flightPathActive');
  copy('activeFlightPathName');
  copy('classroomState');
  copy('enforcementHealth');

  const classification = normalizedClassification(event);
  if (classification) {
    next.aiClassification = classification;
    next.aiCategory = classification.category ?? next.aiCategory;
  } else if (event.classificationPending === true || event.aiClassification === null || event.classification === null) {
    next.aiClassification = null;
    next.aiCategory = null;
  } else if (Object.prototype.hasOwnProperty.call(event, 'aiCategory')) {
    next.aiCategory = event.aiCategory;
  }

  const revision = finiteRevision(event.revision ?? event.realtimeRevision);
  if (revision !== null) next.realtimeRevision = revision;
  const time = eventObservedAt(event);
  if (time !== null) {
    next.realtimeObservedAt = new Date(time).toISOString();
    next.lastSeenAt = next.realtimeObservedAt;
  }

  // A heartbeat means the authenticated browser is currently observable. Do not
  // copy event.status: legacy extensions use that field for tracking state.
  next.status = 'online';
  next.loginState = 'logged_in';
  next.isLoggedIn = true;
  if (!Object.prototype.hasOwnProperty.call(event, 'activityFresh')) next.activityFresh = true;
  if (!Object.prototype.hasOwnProperty.call(event, 'activityState')) next.activityState = 'active';
  if (!Object.prototype.hasOwnProperty.call(event, 'monitoringState')) next.monitoringState = 'observed';
  next._realtimeSignedOut = false;
  return next;
}

function mapClassification(row, event) {
  if (row._realtimeSignedOut) return row;
  const classifiedUrl = event.activeTabUrl ?? event.url;
  if (classifiedUrl && row.activeTabUrl && String(classifiedUrl) !== String(row.activeTabUrl)) return row;

  const classification = normalizedClassification(event);
  const hasClassificationResult = Object.prototype.hasOwnProperty.call(event, 'aiClassification')
    || Object.prototype.hasOwnProperty.call(event, 'classification');
  if (!classification && !hasClassificationResult) return row;
  const next = {
    ...row,
    aiClassification: classification,
    aiCategory: classification?.category ?? null,
    classificationPending: false,
  };
  const revision = finiteRevision(event.revision ?? event.realtimeRevision);
  if (revision !== null) next.realtimeRevision = revision;
  const time = eventObservedAt(event);
  if (time !== null) next.realtimeObservedAt = new Date(time).toISOString();
  return next;
}

function mapSignedOut(row, event) {
  const revision = finiteRevision(event.revision ?? event.realtimeRevision);
  const time = eventObservedAt(event);
  return {
    ...row,
    status: 'offline',
    loginState: 'not_logged_in',
    isLoggedIn: false,
    activeTabTitle: '',
    activeTabUrl: '',
    favicon: null,
    allOpenTabs: [],
    tabSnapshot: null,
    tabSnapshotRevision: null,
    extensionVersion: null,
    capabilities: {},
    acceptedCapabilities: {},
    isSharing: false,
    cameraActive: false,
    activityFresh: false,
    activityState: 'signed_out',
    monitoringState: 'not_expected',
    monitoringLostAt: null,
    classificationPending: false,
    openTabCount: 0,
    tabsTruncated: false,
    ...(revision === null ? {} : { realtimeRevision: revision }),
    ...(time === null ? {} : { realtimeObservedAt: new Date(time).toISOString() }),
    _realtimeSignedOut: true,
  };
}

function applyOne(rows, rawEvent, scope) {
  const event = eventBody(rawEvent);
  if (
    !event
    || !sameSchool(event, scope?.schoolId)
    || !sameTeachingSession(
      event,
      scope?.teachingSessionId,
      scope?.allowSessionlessEvents,
    )
  ) return rows;
  if (!['student-update', 'ai-classification', 'student-signed-out'].includes(event.type)) return rows;

  const studentId = event.studentId;
  if (!studentId && !event.deviceId) return rows;
  const index = rows.findIndex((row) => (
    (studentId && String(row.studentId) === String(studentId))
    || (!studentId && event.deviceId && String(row.primaryDeviceId) === String(event.deviceId))
  ));
  if (index < 0) return rows; // Socket messages never grant roster visibility.

  const row = rows[index];
  // The aggregate response is the authority for delegation boundaries. While
  // another staff member supervises this student, no queued or delayed socket
  // event may reintroduce browser telemetry into the original teacher's view.
  if (row._realtimeSuppressed) return rows;
  const prepared = prepareRealtimeBinding(row, event);
  if (!prepared.accepted) return rows;
  if (!normalizedRealtimeBinding(event.realtimeBinding) && !sameDevice(event, row)) return rows;
  if (!canApplyVersion(event, prepared.row)) return rows;

  let updated = prepared.row;
  if (event.type === 'student-update') updated = mapStudentUpdate(prepared.row, event);
  if (event.type === 'ai-classification') updated = mapClassification(prepared.row, event);
  if (event.type === 'student-signed-out') updated = mapSignedOut(prepared.row, event);
  if (updated === row) return rows;

  const nextRows = rows.slice();
  nextRows[index] = updated;
  return nextRows;
}

export function applyStudentRealtimeEvents(oldData, events, scope = {}) {
  const originalRows = rowsFrom(oldData);
  if (!originalRows || !Array.isArray(events) || events.length === 0) return oldData;
  let rows = originalRows;
  for (const event of events) rows = applyOne(rows, event, scope);
  return rows === originalRows ? oldData : withRows(oldData, rows);
}

export function coalesceStudentRealtimeEvents(events) {
  const best = new Map();
  const nowMs = Date.now();
  for (const rawEvent of events || []) {
    const event = eventBody(rawEvent);
    if (!event?.type) continue;
    const subject = event.studentId || event.deviceId;
    if (!subject) continue;
    const binding = normalizedRealtimeBinding(event.realtimeBinding) || 'legacy';
    const key = `${subject}\u0000${binding}\u0000${event.type}`;
    const prior = best.get(key);
    if (!prior) {
      best.set(key, rawEvent);
      continue;
    }
    const incomingRevision = finiteRevision(event.revision ?? event.realtimeRevision);
    const priorBody = eventBody(prior);
    const priorRevision = finiteRevision(priorBody.revision ?? priorBody.realtimeRevision);
    const incomingTime = eventObservedAt(event, nowMs) ?? -1;
    const priorTime = eventObservedAt(priorBody, nowMs) ?? -1;
    if (
      (incomingRevision !== null && (priorRevision === null || incomingRevision > priorRevision))
      || (incomingRevision === priorRevision && incomingTime > priorTime)
      || (incomingRevision === null && priorRevision === null && incomingTime > priorTime)
    ) {
      best.set(key, rawEvent);
    }
  }
  return [...best.values()];
}

function shallowEqual(left, right) {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

export function mergeAggregatedStudents(oldData, newData) {
  const oldRows = rowsFrom(oldData);
  const newRows = rowsFrom(newData);
  if (!oldRows || !newRows) return newData;

  const oldByStudent = new Map(oldRows.map((row) => [String(row.studentId), row]));
  const mergedRows = newRows.map((serverRow) => {
    const oldRow = oldByStudent.get(String(serverRow.studentId));
    if (!oldRow) return serverRow;

    if (serverRow.activityState === 'delegated') {
      const suppressed = { ...serverRow, _realtimeSuppressed: true };
      return shallowEqual(oldRow, suppressed) ? oldRow : suppressed;
    }
    // A later non-delegated aggregate row explicitly reopens this student's
    // realtime stream. Its binding and revision become the new baseline.
    if (oldRow._realtimeSuppressed) return serverRow;

    const oldBinding = normalizedRealtimeBinding(oldRow.realtimeBinding);
    const serverBinding = normalizedRealtimeBinding(serverRow.realtimeBinding);
    const retired = new Set(retiredRealtimeBindings(oldRow));

    if (serverBinding && oldBinding && serverBinding !== oldBinding) {
      if (isNewerRealtimeObservation(serverRow, oldRow)) {
        // A current aggregate response can recover from a reordered socket
        // binding, including one that was temporarily marked retired.
        retired.add(oldBinding);
        retired.delete(serverBinding);
        const merged = {
          ...serverRow,
          _retiredRealtimeBindings: [...retired].slice(-8),
        };
        return shallowEqual(oldRow, merged) ? oldRow : merged;
      }

      // An older aggregate response was already in flight when the browser
      // switched. Keep its roster fields, but never restore retired telemetry.
      const merged = { ...serverRow };
      for (const field of REALTIME_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(oldRow, field)) merged[field] = oldRow[field];
      }
      if (oldRow._realtimeSignedOut) merged._realtimeSignedOut = true;
      if (retired.size > 0) merged._retiredRealtimeBindings = [...retired].slice(-8);
      return shallowEqual(oldRow, merged) ? oldRow : merged;
    }

    const missingServerBinding = Boolean(oldBinding && !serverBinding);
    if (missingServerBinding) {
      const merged = { ...serverRow };
      for (const field of REALTIME_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(oldRow, field)) merged[field] = oldRow[field];
      }
      if (oldRow._realtimeSignedOut) merged._realtimeSignedOut = true;
      if (retired.size > 0) merged._retiredRealtimeBindings = [...retired].slice(-8);
      return shallowEqual(oldRow, merged) ? oldRow : merged;
    }

    if (!oldBinding && !serverBinding
      && String(oldRow.primaryDeviceId || '') !== String(serverRow.primaryDeviceId || '')) {
      return serverRow;
    }

    const oldRevision = finiteRevision(oldRow.realtimeRevision);
    const serverRevision = finiteRevision(serverRow.realtimeRevision);
    let merged = serverRow;
    if (oldRevision !== null && (serverRevision === null || oldRevision > serverRevision)) {
      merged = { ...serverRow };
      for (const field of REALTIME_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(oldRow, field)) merged[field] = oldRow[field];
      }
      if (oldRow._realtimeSignedOut) {
        merged._realtimeSignedOut = true;
      }
    }
    if (retired.size > 0) {
      if (merged === serverRow) merged = { ...serverRow };
      merged._retiredRealtimeBindings = [...retired].slice(-8);
    }
    return shallowEqual(oldRow, merged) ? oldRow : merged;
  });

  if (
    mergedRows.length === oldRows.length
    && mergedRows.every((row, index) => row === oldRows[index])
  ) {
    return oldData;
  }
  return withRows(newData, mergedRows);
}

export function makeAggregatedStudentsQueryKey(schoolId, effectiveSessionId, adminSchoolMode = false) {
  return [
    '/api/students-aggregated',
    schoolId || 'no-school',
    effectiveSessionId || (adminSchoolMode ? 'admin-school' : 'no-session'),
  ];
}

export function deriveAggregatedStudentsPresentation({
  studentsSnapshot,
  isError = false,
  studentView = 'class',
}) {
  const hasSuccessfulStudentSnapshot = studentsSnapshot !== undefined;
  const classStudentTargetsUnavailable = studentView === 'class'
    && !hasSuccessfulStudentSnapshot;

  return {
    hasSuccessfulStudentSnapshot,
    classStudentTargetsUnavailable,
    classStudentDataUnavailable: classStudentTargetsUnavailable && isError,
    classStudentRefreshFailed: studentView === 'class'
      && hasSuccessfulStudentSnapshot
      && isError,
    classStudentCountsKnown: studentView !== 'class' || hasSuccessfulStudentSnapshot,
  };
}
