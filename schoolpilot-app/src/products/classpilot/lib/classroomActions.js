import { restrictionResourceUrl } from './restrictionResourceMatcher.js';

const terminal = new Set(['completed', 'failed', 'unavailable', 'expired']);

export function classroomCanFocus(students) {
  return students.some(student => {
    const accepted = student.acceptedCapabilities ?? student.capabilities;
    const has = capability => Array.isArray(accepted) ? accepted.includes(capability) : accepted?.[capability] === true;
    return has('scopedAuthorityChecksV1') && has('focusTabV1');
  });
}

export function classroomLinks(resource) {
  const seen = new Set();
  return (Array.isArray(resource?.links) ? resource.links : []).flatMap((link, index) => {
    try {
      const url = new URL(link.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ id: `${resource.id}:${index}`, url: url.href, title: link.title || url.hostname }];
    } catch { return []; }
  });
}

const canonicalSet = values => JSON.stringify([...new Set(values)].sort());
export function classroomLessonStarts(preview, selectedLinks) {
  if (!preview?.scopes?.length) return [];
  if (preview.boundary !== 'website') return preview.scopes;
  return selectedLinks.filter(link => {
    const hostname = new URL(link.url).hostname;
    return preview.authoring.allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  }).map(link => ({ url: link.url, label: link.title }));
}

export function reviewedFlightPathMatches(flightPath, authoring) {
  return flightPath && Array.isArray(flightPath.allowedDomains) && (flightPath.resources == null || Array.isArray(flightPath.resources))
    && Array.isArray(flightPath.blockedDomains) && flightPath.blockedDomains.length === 0
    && canonicalSet(flightPath.allowedDomains) === canonicalSet(authoring.allowedDomains)
    && canonicalSet((flightPath.resources || []).map(restrictionResourceUrl)) === canonicalSet(authoring.resources.map(value => value.url));
}

export function classroomCommands(data) {
  const commands = data?.commands?.length ? data.commands : [data?.command];
  return commands.filter(command => command?.id && Array.isArray(command.targets));
}

function abortCheck(signal) {
  if (signal?.aborted) throw new DOMException('Classroom action cancelled', 'AbortError');
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    abortCheck(signal);
    const done = () => { signal?.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(new DOMException('Classroom action cancelled', 'AbortError')); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

// HTTP receipt and server-created continuation are not browser confirmation.
// Keep the precise source command and target when polling; never find by URL.
export async function waitForClassroomTargets(command, studentIds, {
  readCommand, signal, onUpdate = () => {}, assertCurrent = () => {},
  now = Date.now, sleep = pause, timeoutMs = 60_000,
}) {
  const deadline = now() + timeoutMs;
  let current = command;
  while (true) {
    abortCheck(signal); assertCurrent();
    if (current.id !== command.id) throw new Error('The command status did not match the requested action.');
    const rows = studentIds.map(studentId => current.targets?.find(target => target.studentId === studentId)
      || { studentId, status: 'unavailable', error: 'The student was not included in this command.' });
    onUpdate(rows);
    if (rows.every(row => terminal.has(row.status)) || now() >= deadline) return rows;
    await sleep(750, signal);
    abortCheck(signal); assertCurrent();
    const data = await readCommand(command, signal);
    abortCheck(signal); assertCurrent();
    if (!data?.command || !Array.isArray(data.command.targets)) throw new Error('The command status was incomplete.');
    current = data.command;
  }
}

export function restrictionApplicationConfirmed(target) {
  return target?.status === 'completed' && target.result?.outcome === 'applied';
}

export async function runClassroomAction({ action, url, studentIds, flightPath, postCommand, readCommand,
  signal, assertCurrent = () => {}, onUpdate = () => {}, waitOptions = {} }) {
  if (!['open', 'open-focus', 'lesson'].includes(action) || !studentIds?.length
    || new Set(studentIds).size !== studentIds.length) throw new Error('Choose explicit students for this action.');
  const safeUrl = classroomLinks({ id: 'open', links: [{ url }] })[0]?.url;
  if (!safeUrl) throw new Error('Choose a valid Classroom resource link.');
  const outcomes = new Map(studentIds.map(studentId => [studentId, { studentId, restriction: 'not requested', open: 'not requested', focus: 'not requested' }]));
  const update = (studentId, fields) => { outcomes.set(studentId, { ...outcomes.get(studentId), ...fields }); onUpdate([...outcomes.values()]); };
  const guard = () => { abortCheck(signal); assertCurrent(); };
  const wait = (command, ids, field) => waitForClassroomTargets(command, ids, { ...waitOptions, readCommand, signal, assertCurrent,
    onUpdate: rows => rows.forEach(row => update(row.studentId, { [field]: row.status, error: row.error || null })) });
  async function open(ids, prerequisite) {
    guard();
    ids.forEach(id => update(id, { open: 'requesting' }));
    const data = await postCommand('open-tab', { url: safeUrl,
      ...(action === 'open-focus' ? { focusAfterOpen: true } : {}),
      ...(prerequisite ? { afterRestrictionCommandId: prerequisite } : {}),
    }, ids);
    guard();
    const commands = classroomCommands(data);
    for (const id of ids) if (!commands.some(command => command.targets.some(target => target.studentId === id)))
      update(id, { open: 'unavailable', error: 'The student was not included in the open command.' });
    await Promise.all(commands.map(async command => {
      const commandIds = ids.filter(id => command.targets.some(target => target.studentId === id));
      const rows = await wait(command, commandIds, 'open');
      if (action !== 'open-focus') return;
      await Promise.all(rows.map(async row => {
        const followUp = row.result?.followUp;
        if (row.status !== 'completed' || followUp?.state !== 'committed' || !followUp.commandId) {
          update(row.studentId, { focus: followUp?.state || 'not confirmed' }); return;
        }
        guard();
        update(row.studentId, { focus: 'pending' });
        const child = await readCommand({ ...command, id: followUp.commandId }, signal);
        guard();
        if (!child?.command || child.command.id !== followUp.commandId || child.command.commandType !== 'focus-tab') throw new Error('The Focus continuation was incomplete.');
        await wait(child.command, [row.studentId], 'focus');
      }));
    }));
  }
  if (action !== 'lesson') await open(studentIds);
  else {
    if (!flightPath?.id || !Number.isFinite(Date.parse(flightPath.updatedAt))) throw new Error('Review the lesson Flight Path again.');
    guard();
    studentIds.forEach(id => update(id, { restriction: 'requesting' }));
    const data = await postCommand('apply-flight-path', { flightPathId: flightPath.id, expectedFlightPathUpdatedAt: flightPath.updatedAt }, studentIds);
    guard();
    const commands = classroomCommands(data);
    for (const id of studentIds) if (!commands.some(command => command.targets.some(target => target.studentId === id)))
      update(id, { restriction: 'unavailable', open: 'not opened', error: 'The student was not included in the restriction command.' });
    await Promise.all(commands.map(async command => {
      const ids = studentIds.filter(id => command.targets.some(target => target.studentId === id));
      const rows = await wait(command, ids, 'restriction');
      // Partial success opens only confirmed students. The server repeats the
      // exact prerequisite, binding and current-authority checks atomically.
      await Promise.all(rows.map(async row => {
        if (restrictionApplicationConfirmed(row)) await open([row.studentId], command.id);
        else update(row.studentId, { open: 'not opened', error: row.error || 'Restriction application was not confirmed.' });
      }));
    }));
  }
  return [...outcomes.values()];
}
