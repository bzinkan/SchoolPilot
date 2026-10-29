import { createDesktopMetadataRequests } from './nativeDesktop.js';

export const WINDOWS_TILES_PATH = '/classpilot/windows/tiles';
export const WINDOWS_POLICY_COMMANDS = new Set(['lock-screen', 'unlock-screen', 'apply-flight-path', 'remove-flight-path',
  'apply-block-list', 'remove-block-list', 'attention-mode', 'limit-tabs', 'temp-unblock', 'stop-focus', 'student-sign-out']);
export const WINDOWS_TAB_COMMANDS = new Set(['open-tab', 'close-tabs', 'activate-tab', 'focus-tab']);
export const WINDOWS_SHARED_TOOLS = new Set(['timer', 'poll', 'lesson-activity', 'teacher-message']);
export function pendingWindowsCommandOutcomes(entries, finalReads) {
  return [...entries.values()].filter(entry => entry.command?.transport === 'windows'
    && !finalReads.has(entry.command.id)
    && entry.command.targets?.some(target => ['requested', 'sent', 'received'].includes(target.status)));
}

export async function readWindowsCommandOutcome(entry, { read, finalReads, signal, now = Date.now() }) {
  const terminalRead = Number.isFinite(entry.expiresAtMs) && entry.expiresAtMs <= now;
  try { return await read(); }
  finally {
    // The server owns persistent-policy expiry. Read it once after the deadline,
    // including after a hidden tab resumes; a failed final read must not poll forever.
    // A cancelled view has not completed that attempt and may retry when visible.
    if (terminalRead && !signal?.aborted) finalReads.add(entry.command.id);
  }
}
export const WINDOWS_BROWSER_FIELDS = Object.freeze(['isLoggedIn', 'loginState', 'lastSeenAt', 'extensionVersion',
  'clientProtocolVersion', 'acceptedCapabilities', 'extensionCapabilities', 'capabilities', 'activeTabUrl', 'activeTabTitle',
  'activeTabRef', 'allOpenTabs', 'tabSnapshot', 'tabSnapshotRevision', 'openTabCount', 'tabsTruncated', 'classroomState',
  'classroomControls', 'focus', 'screenLocked', 'flightPathActive', 'activeFlightPathName', 'enforcementHealth', 'status',
  'activityFresh', 'activityState', 'monitoringState', 'monitoringLostAt', 'realtimeRevision', 'realtimeObservedAt',
  'screenshotHealth', 'isSharing', 'cameraActive', 'favicon']);

export function windowsBrowserSourceKey(source) {
  return typeof source?.sourceRef === 'string' && source.sourceRef.trim()
    && Number.isSafeInteger(source.bindingRevision) && source.bindingRevision > 0
    ? JSON.stringify([source.sourceRef, source.bindingRevision]) : '';
}

export function windowsBrowserSources(value) {
  if (!Array.isArray(value)) return [];
  // Duplicate family rows cannot identify the supported single profile.
  return ['chrome', 'edge'].flatMap(family => {
    const sources = value.filter(source => source?.browserFamily === family && windowsBrowserSourceKey(source));
    return sources.length === 1 ? sources : [];
  });
}

export function windowsBrowserLabel(source) {
  return source?.browserFamily === 'chrome' ? 'Chrome' : source?.browserFamily === 'edge' ? 'Edge' : 'Browser';
}

export function selectWindowsBrowserSource(sources, selection) {
  const rows = windowsBrowserSources(sources);
  if (selection) return rows.find(row => windowsBrowserSourceKey(row) === windowsBrowserSourceKey(selection)) || null;
  return rows.length === 1 ? rows[0] : null;
}

export function windowsBrowserTarget(student) {
  const source = student?.selectedWindowsBrowser;
  return windowsBrowserSourceKey(source) ? { studentId: student.studentId, sourceRef: source.sourceRef,
    bindingRevision: source.bindingRevision } : null;
}

export function windowsBrowserScopeKey(contextKey, studentId) { return JSON.stringify([contextKey, studentId]); }

export function windowsLegacyOwner(value) {
  return value?.transport === 'legacy' && typeof value.realtimeBinding === 'string' && value.realtimeBinding.length > 0
    ? { transport: 'legacy', realtimeBinding: value.realtimeBinding } : null;
}

export function createWindowsBrowserRequests(students, context, selections, visibilityEpoch = 0) {
  return createDesktopMetadataRequests(students, context).map(request => {
    const selectedSources = request.body.studentIds.flatMap(studentId => {
      const selection = selections?.[studentId];
      return selection?.active !== false && selection?.scopeKey === windowsBrowserScopeKey(request.contextKey, studentId)
        && windowsBrowserSourceKey(selection)
        ? [{ studentId, sourceRef: selection.sourceRef, bindingRevision: selection.bindingRevision }] : [];
    });
    return { ...request, queryKey: ['classpilot-windows-browsers', request.contextKey, request.body.studentIds,
      selectedSources, visibilityEpoch], body: { ...request.body, ...(selectedSources.length ? { selectedSources } : {}) },
    selectedSources };
  });
}

export function windowsBrowserMetadata(response) {
  return { ...response, tiles: (response?.tiles || []).map(tile => ({ studentId: tile.studentId,
    platform: tile.platform, windowsSession: tile.windowsSession, browserCoverage: tile.browserCoverage, browserOwner: tile.browserOwner,
    browserSources: windowsBrowserSources(tile.browserSources).map(source => {
      const { sourceRef, bindingRevision, browserFamily, isLoggedIn, lastSeenAt, extensionVersion, acceptedCapabilities,
        extensionCapabilities, clientProtocolVersion, classroomState, classroomControls, focus, screenLocked } = source;
      return { sourceRef, bindingRevision, browserFamily, isLoggedIn, lastSeenAt, extensionVersion, acceptedCapabilities,
        extensionCapabilities, clientProtocolVersion, classroomState, classroomControls, focus, screenLocked };
    }) })) };
}

export function projectWindowsBrowserStudent(student, entry, selection) {
  if (entry?.pending) {
    const pending = { ...student };
    for (const field of WINDOWS_BROWSER_FIELDS) delete pending[field];
    return { ...pending, windowsDiscoveryPending: true, windowsDiscoveryUnavailable: entry.unavailable === true,
      isLoggedIn: false, loginState: 'unknown', status: 'offline', activityFresh: false, allOpenTabs: [], acceptedCapabilities: {} };
  }
  const scopeKey = entry ? windowsBrowserScopeKey(entry.contextKey, student.studentId) : '';
  const choice = selection?.scopeKey === scopeKey ? selection : null;
  const legacyOwner = windowsLegacyOwner(entry?.browserOwner);
  const legacyOwnerCurrent = legacyOwner && !entry.unavailable && student.realtimeBinding === legacyOwner.realtimeBinding;
  if (legacyOwnerCurrent && (!choice || (choice.transport === 'legacy' && choice.realtimeBinding === legacyOwner.realtimeBinding))) return student;
  const sources = windowsBrowserSources(entry?.browserSources);
  if (!entry || (!legacyOwner && entry.platform !== 'windows' && !sources.length && !choice)) return student;
  const selected = selectWindowsBrowserSource(sources, choice);
  const current = selected && !entry.unavailable ? selected : null;
  const projected = { ...student };
  for (const field of WINDOWS_BROWSER_FIELDS) delete projected[field];
  Object.assign(projected, { windowsBrowserMode: true, windowsBrowserSources: sources, windowsBrowserContextKey: entry.contextKey,
    windowsSession: entry.windowsSession, windowsBrowserCoverage: entry.browserCoverage,
    windowsLegacyHandoff: legacyOwnerCurrent ? legacyOwner : null, windowsLegacyOwnerPending: Boolean(legacyOwner && !legacyOwnerCurrent),
    windowsBrowserScopeKey: scopeKey, selectedWindowsBrowser: current,
    windowsBrowserSelection: choice, windowsBrowserUnavailable: entry.unavailable === true,
    windowsBrowserPreviewKey: JSON.stringify([scopeKey, windowsBrowserSourceKey(selected), entry.visibilityEpoch]),
    realtimeBinding: `windows:${windowsBrowserSourceKey(selected) || 'unselected'}`,
    isLoggedIn: false, loginState: 'not_logged_in', status: 'offline', allOpenTabs: [], activeTabUrl: '',
    activeTabTitle: '', activeTabRef: null, acceptedCapabilities: {}, capabilities: {}, openTabCount: 0,
    activityFresh: false, _realtimeSignedOut: false, _realtimeSuppressed: false });
  if (!current) {
    // Student selection and student-wide policies remain available without
    // guessing which browser should receive a tab action. No capabilities or
    // tab observations are merged between children.
    const live = entry.unavailable ? [] : sources.filter(source => source.isLoggedIn);
    const lastSeen = live.map(source => source.lastSeenAt).filter(value => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    return { ...projected, isLoggedIn: live.length > 0, loginState: live.length ? 'logged_in' : 'not_logged_in',
      status: live.length ? 'online' : 'offline', lastSeenAt: lastSeen || null, activityFresh: live.length > 0 };
  }
  for (const field of WINDOWS_BROWSER_FIELDS) if (Object.hasOwn(current, field)) projected[field] = current[field];
  projected.loginState = current.isLoggedIn ? 'logged_in' : 'not_logged_in';
  projected.status = current.status || (current.isLoggedIn ? 'online' : 'offline');
  projected.activityFresh = current.activityFresh ?? current.isLoggedIn === true;
  projected.realtimeObservedAt = current.realtimeObservedAt || current.lastSeenAt;
  projected.allOpenTabs = current.allOpenTabs || current.tabSnapshot?.tabs || [];
  return projected;
}

export function windowsCommandTargets(students, commandType) {
  if (!WINDOWS_TAB_COMMANDS.has(commandType)) return undefined;
  return students.map(student => {
    const target = windowsBrowserTarget(student);
    if (!target || student.windowsBrowserUnavailable) throw new Error('Choose a current Chrome or Edge session for every selected student.');
    return target;
  });
}

export function partitionWindowsBrowserCommand({ request, students, authority, legacyEndpoint, preferWindowsTools = false }) {
  const windows = students.filter(student => student.windowsBrowserMode);
  if ((windows.length || preferWindowsTools) && WINDOWS_SHARED_TOOLS.has(request.commandType)) return [{ endpoint: '/classpilot/windows/commands', windows: true,
    targetStudentIds: students.map(row => row.studentId), body: { ...authority, targetScope: 'students', targetStudentIds: students.map(row => row.studentId),
      commandType: request.commandType, commandPayload: request.commandPayload } }];
  if (!windows.length) return [{ endpoint: legacyEndpoint, body: request, windows: false, targetStudentIds: students.map(row => row.studentId) }];
  const legacy = students.filter(student => !student.windowsBrowserMode);
  const payloadFor = rows => {
    const ids = new Set(rows.map(row => row.studentId));
    const payload = { ...request.commandPayload };
    for (const field of ['tabTargets', 'tabsToClose']) if (Array.isArray(payload[field])) payload[field] = payload[field].filter(row => ids.has(row.studentId));
    return payload;
  };
  const requests = [];
  if (legacy.length) {
    const { subgroupId: _subgroupId, ...body } = request;
    requests.push({ endpoint: legacyEndpoint, windows: false, targetStudentIds: legacy.map(row => row.studentId),
      body: { ...body, targetScope: 'students', targetStudentIds: legacy.map(row => row.studentId), commandPayload: payloadFor(legacy) } });
  }
  const browserTargets = windowsCommandTargets(windows, request.commandType);
  requests.push({ endpoint: '/classpilot/windows/commands', windows: true, targetStudentIds: windows.map(row => row.studentId),
    body: { ...authority, targetScope: 'students', targetStudentIds: windows.map(row => row.studentId),
      commandType: request.commandType, commandPayload: payloadFor(windows), ...(browserTargets ? { browserTargets } : {}) } });
  return requests;
}
