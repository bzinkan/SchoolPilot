import { chatStudentName } from './chatThreads.js';
import { SELECTION_CLEARED_TARGET_LABEL, signOutOnlySelectionLabel } from './dashboardCommandContext.js';
import { compareStudentsByLastName } from './studentOrder.js';

// The Messages tab's class roster: the whole class in the student grid's order,
// one quiet line per student. A row carries primitives only (name, presence,
// unread count), never what anyone wrote, so the column is safe on a projector.

/**
 * Presence marks differ by shape, never by colour alone:
 * dot (on now), ring (not reporting), dash (not signed in), cross (absent),
 * diamond (with another staff member).
 */
export const ROSTER_MARK = Object.freeze({
  ON_NOW: 'dot',
  NOT_REPORTING: 'ring',
  NOT_SIGNED_IN: 'dash',
  ABSENT: 'cross',
  WITH_STAFF: 'diamond',
});

const FALLBACK_STAFF_NAME = 'another teacher';

/**
 * One student's roster status. Precedence: with another staff member > on now
 * > absent > not signed in > not reporting. A student marked absent whose
 * device is reporting shows On now. Only "with {staff}" stops the teacher from
 * messaging: that student's classroom authority is elsewhere, and the server
 * refuses the reply. On now and Not reporting have no visible word; `srStatus`
 * always spells the status out for screen readers.
 *
 * `coveredByStaffName` is the supervising staff member's display name when the
 * student is supervised elsewhere ('' when the name is unknown), else null.
 */
export function describeRosterPresence({ monitoring = null, absent = false, coveredByStaffName = null, isLoggedIn } = {}) {
  if (typeof coveredByStaffName === 'string') {
    const word = `With ${coveredByStaffName.trim() || FALLBACK_STAFF_NAME}`;
    return { mark: ROSTER_MARK.WITH_STAFF, word, srStatus: word, canMessage: false };
  }
  if (monitoring?.telemetryCurrent === true) {
    return { mark: ROSTER_MARK.ON_NOW, word: '', srStatus: 'On now', canMessage: true };
  }
  if (absent) return { mark: ROSTER_MARK.ABSENT, word: 'Absent', srStatus: 'Absent', canMessage: true };
  if (isLoggedIn === false || monitoring?.kind === 'signed_out') {
    return { mark: ROSTER_MARK.NOT_SIGNED_IN, word: 'Not signed in', srStatus: 'Not signed in', canMessage: true };
  }
  return { mark: ROSTER_MARK.NOT_REPORTING, word: '', srStatus: 'Not reporting', canMessage: true };
}

function lookup(source, key) {
  if (!source || key === undefined || key === null) return undefined;
  if (typeof source.get === 'function') return source.get(key);
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function idSet(ids) {
  if (!ids) return new Set();
  if (typeof ids.has === 'function') return ids;
  return new Set(Array.isArray(ids) ? ids : [...ids]);
}

/**
 * The roster rows for the Messages list: every student in `students`, in the
 * grid's last-name order (compareStudentsByLastName), once each.
 * `monitoringByStudent` is the grid's presence projection (a Map by student
 * id), `absentIds` today's absences, `coverageByStudent` the staff name for each
 * student supervised elsewhere, and `conversations` the chat threads that
 * supply unread counts. Each row is primitives only:
 * { studentId, name, mark, word, srStatus, canMessage, unreadCount, hasThread }.
 */
export function buildMessagingRoster({ students = [], monitoringByStudent = null, absentIds = null, coverageByStudent = null, conversations = [] } = {}) {
  const absent = idSet(absentIds);
  const threads = new Map();
  for (const conversation of conversations || []) {
    if (conversation?.studentId) threads.set(conversation.studentId, conversation);
  }
  const seen = new Set();
  const rows = [];
  for (const student of [...(students || [])].sort(compareStudentsByLastName)) {
    const studentId = student?.studentId;
    if (!studentId || seen.has(studentId)) continue;
    seen.add(studentId);
    const covered = lookup(coverageByStudent, studentId);
    const presence = describeRosterPresence({
      monitoring: lookup(monitoringByStudent, studentId) || null,
      absent: absent.has(studentId),
      coveredByStaffName: typeof covered === 'string' ? covered : null,
      isLoggedIn: student.isLoggedIn,
    });
    const thread = threads.get(studentId);
    const unreadCount = Number(thread?.unreadCount);
    rows.push({
      studentId,
      name: chatStudentName(student) || 'Unknown',
      mark: presence.mark,
      word: presence.word,
      srStatus: presence.srStatus,
      canMessage: presence.canMessage,
      unreadCount: Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0,
      hasThread: Boolean(thread),
    });
  }
  return rows;
}

function foldedName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Rows whose name contains `query`, ignoring case and accents. A blank query keeps every row. */
export function filterRoster(rows, query) {
  const needle = foldedName(query);
  const list = Array.isArray(rows) ? rows : [];
  if (!needle) return list;
  return list.filter((row) => foldedName(row?.name).includes(needle));
}

/** The row Enter in Find opens: the only row that can be messaged, else null. */
export function enterTarget(rows) {
  let target = null;
  for (const row of rows || []) {
    if (!row?.canMessage) continue;
    if (target) return null;
    target = row;
  }
  return target;
}

function oldestUnreadAt(conversation) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const item of conversation?.items || []) {
    if (item?.sender !== 'student' || item.read !== false) continue;
    const at = Date.parse(item.timestamp);
    if (Number.isFinite(at) && at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * The student who has waited longest for a reply: the thread whose oldest
 * unread student message is the oldest. Ties keep the first thread. Null when
 * nothing is unread.
 */
export function longestWaitingUnreadId(conversations) {
  let bestId = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const conversation of conversations || []) {
    if (!conversation?.studentId || !(conversation.unreadCount > 0)) continue;
    const waitingSince = oldestUnreadAt(conversation);
    if (bestId === null || waitingSince < bestAt) {
      bestId = conversation.studentId;
      bestAt = waitingSince;
    }
  }
  return bestId;
}

/**
 * The conversations the teacher can answer now, which are the ones "need
 * reply" counts and opens. Nothing qualifies while messaging is off or the
 * chat is unavailable (`canStart` false). Otherwise only students on the
 * roster who are not with another staff member qualify, because the server
 * refuses a reply to anyone else. With no roster known (`rosterById` null),
 * every thread can be answered.
 */
export function answerableConversations(conversations, { rosterById = null, canStart = true } = {}) {
  if (!canStart) return [];
  const list = Array.isArray(conversations) ? conversations : [];
  if (!rosterById) return list;
  return list.filter((conversation) => lookup(rosterById, conversation?.studentId)?.canMessage === true);
}

/**
 * Why a read-only thread has no reply box. `word` is the roster row's
 * "With {staff}" status for a student supervised elsewhere. Without one, the
 * student is not on this class's roster (Other conversations).
 */
export function readOnlyReplyNote({ name = '', word = '' } = {}) {
  const who = String(name || '').trim() || 'This student';
  const status = String(word || '').trim();
  if (status) {
    return `${who} is ${status.charAt(0).toLowerCase()}${status.slice(1)} right now. You can reply when they’re back in this class.`;
  }
  return `${who} isn’t in this class right now. You can read this conversation but not reply.`;
}

/**
 * Threads with students who are not on the roster (they left the class or
 * another class now holds them), in last-name order. `rosterIds` is a Set or
 * Map keyed by student id, or an array of ids. The teacher can read these
 * threads but not reply: the server refuses a reply to these students.
 */
export function splitOffRoster(conversations, rosterIds) {
  const roster = idSet(rosterIds);
  return (conversations || [])
    .filter((conversation) => conversation?.studentId && !roster.has(conversation.studentId))
    .sort(compareStudentsByLastName);
}

/**
 * The announce button names who the Send Message dialog will open for: the
 * ticked students, else the selected subgroup, else the class. Where the
 * dialog refuses instead, the button uses the Target badge's wording, and a
 * click explains the refusal. Students ticked only for Student Sign Out
 * (`signOutOnlyCount`) block it whatever else is ticked or lost. While a
 * selection the Dashboard cleared by itself stands with nothing ticked
 * (`selectionLost`), it refuses the subgroup or class rather than widening
 * to it, so the button names neither.
 */
export function broadcastButtonLabel({ selectedCount = 0, subgroupName = null, selectionLost = false, signOutOnlyCount = 0 } = {}) {
  const signOutOnly = Number(signOutOnlyCount);
  if (Number.isSafeInteger(signOutOnly) && signOutOnly > 0) return signOutOnlySelectionLabel(signOutOnly);
  const selected = Number(selectedCount);
  if (Number.isSafeInteger(selected) && selected > 0) {
    return `Message ${selected} selected student${selected === 1 ? '' : 's'}`;
  }
  if (selectionLost === true) return SELECTION_CLEARED_TARGET_LABEL;
  const group = typeof subgroupName === 'string' ? subgroupName.trim() : '';
  if (group) return `Message ${group}`;
  return 'Announce to class';
}

/** "1 needs reply", "3 need reply": how many threads have unread student messages. */
export function needReplyLabel(count) {
  const total = Number(count);
  const n = Number.isSafeInteger(total) && total > 0 ? total : 0;
  return `${n} need${n === 1 ? 's' : ''} reply`;
}
