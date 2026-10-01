export const CHAT_REPLY_MAX_CHARS = 500;

/**
 * Teacher replies that cost one tap. `ack` marks the reply that is sent
 * immediately from its own button; the others fill the composer so the teacher
 * can adjust before sending. `replyOnly` marks an answer that reads oddly as a
 * first message.
 */
export const CANNED_REPLIES = Object.freeze([
  Object.freeze({ id: 'got-it', text: 'Got it', ack: true }),
  Object.freeze({ id: 'yes', text: 'Yes', replyOnly: true }),
  Object.freeze({ id: 'one-moment', text: 'One moment', replyOnly: true }),
  Object.freeze({ id: 'come-see-me', text: 'Come see me' }),
  Object.freeze({ id: 'not-now', text: 'Not right now', replyOnly: true }),
  Object.freeze({ id: 'check-board', text: 'Check the board' }),
]);

/**
 * The one-tap replies a thread offers. Until the student has written, only
 * openers fit: no acknowledgement and no answers.
 */
export function cannedRepliesFor(studentHasWritten) {
  return studentHasWritten ? CANNED_REPLIES : CANNED_REPLIES.filter((reply) => !reply.ack && !reply.replyOnly);
}

/**
 * The server never distinguishes questions from other messages, so the
 * dashboard flags a question from its text: it ends with a question mark.
 * A false positive only adds a subtle accent, so the heuristic stays simple.
 */
export function looksLikeQuestion(text) {
  return typeof text === 'string' && /\?\s*$/.test(text.trim());
}

/** Unread student messages per student id, for tile badges. */
export function countUnreadByStudent(studentMessages) {
  const counts = new Map();
  for (const message of studentMessages || []) {
    if (!message || message.read || !message.studentId) continue;
    counts.set(message.studentId, (counts.get(message.studentId) || 0) + 1);
  }
  return counts;
}

/**
 * Delivery only moves forward on the dashboard: a stray "delivered" after
 * "seen", or a history re-read carrying an older status, never regresses a
 * bubble. Sent and failed share a rank so the latest of the two wins.
 */
export const DELIVERY_RANK = Object.freeze({ sent: 1, failed: 1, delivered: 2, seen: 3 });

export function mergeDeliveryStatus(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  return (DELIVERY_RANK[incoming] || 0) < (DELIVERY_RANK[current] || 0) ? current : incoming;
}

/**
 * The server holds a message for a signed-out student until their device
 * connects, so an undelivered message to them names the wait instead of
 * reading as a stuck "Sending". `waitingFor` is that student's display name.
 */
export function deliveryLabel(status, errorMessage, options) {
  if (status === 'seen') return 'Seen';
  if (status === 'delivered') return 'Delivered';
  if (status === 'failed') return errorMessage || 'Failed';
  if (options?.waitingFor) return `Waits until ${options.waitingFor} signs in`;
  return 'Sending';
}

/** The display name a dashboard student row carries, or '' when it has none. */
export function chatStudentName(student) {
  if (!student) return '';
  const name = student.studentName || student.name
    || [student.firstName, student.lastName].filter(Boolean).join(' ');
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * A thread the teacher is about to start: the student has no messages yet,
 * so it renders the reply box with nothing above it.
 */
export function emptyConversation(studentId, studentName) {
  return { studentId, studentName: studentName || 'Unknown', studentEmail: '', items: [], unreadCount: 0 };
}

/**
 * Plain words for a reply the server refused, from the error code the API
 * returns. The dashboard shows it under "Message not sent", so each sentence
 * says only why. Anything unrecognised keeps the server's own message.
 */
export function describeChatReplyError(error, studentName) {
  const name = (typeof studentName === 'string' && studentName.trim()) || 'This student';
  const response = error?.response;
  switch (response?.data?.code) {
    case 'chat_authority_stale':
      return `${name} is with another teacher right now.`;
    case 'ACTIVE_SESSION_NOT_FOUND':
    case 'CLASSROOM_ACTIVITY_UNAVAILABLE':
      return 'This class has ended.';
    case 'FAB_FEATURE_DISABLED':
      return 'Messaging is turned off for this class.';
    case 'CHAT_STUDENT_NOT_IN_SESSION':
    case 'CLASSROOM_ACTIVITY_STALE':
      return `${name} isn\u2019t in this class right now.`;
    case 'MESSAGE_TOO_LONG':
    case 'MESSAGE_INVALID':
    case 'teacher_reply_invalid':
      return `Messages can be up to ${CHAT_REPLY_MAX_CHARS} characters.`;
    case 'CLASSROOM_AUTHORITY_CHANGED':
      return 'This class changed. Refresh the page and try again.';
    default:
      break;
  }
  // A bare 404 comes from either the class session check (the class ended or
  // is no longer yours) or the roster check, so the sentence names both.
  if (response?.status === 404 && !response?.data?.code) {
    return `${name} isn\u2019t in this class, or the class has ended. Refresh the page to check.`;
  }
  const serverMessage = response?.data?.error;
  return (typeof serverMessage === 'string' && serverMessage) || error?.message || 'Something went wrong.';
}

/** What the drawer should say about a paused channel, or null when it is not paused. */
export function describeChatPause(fabState) {
  if (!fabState?.messagesPaused) return null;
  if (fabState.pauseReason === 'testing') {
    return {
      reason: 'testing',
      title: 'Paused for testing',
      detail: 'Student messages pause automatically during a testing block. You can still message students.',
      locked: true,
    };
  }
  return {
    reason: 'teacher',
    title: 'Messages paused',
    detail: 'Students cannot send messages until you resume. You can still message them.',
    locked: false,
  };
}

function timeValue(timestamp) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function knownStudentName(nameById, studentId) {
  const name = nameById instanceof Map
    ? nameById.get(studentId)
    : nameById && Object.prototype.hasOwnProperty.call(nameById, studentId) ? nameById[studentId] : '';
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * One inbox row per student: the merged timeline of their messages and the
 * teacher's replies (oldest first), the unread count, and the last item for the
 * preview line. Rows are ordered unread first, then newest activity.
 * `nameById` (a Map or plain object of studentId to display name) names a
 * thread only the teacher has written in; 'Unknown' means no name is known.
 */
export function deriveChatConversations(studentMessages, chatReplies, nameById) {
  const byStudent = new Map();
  const conversationFor = (studentId, studentName, studentEmail) => {
    const name = studentName || knownStudentName(nameById, studentId);
    let conversation = byStudent.get(studentId);
    if (!conversation) {
      conversation = { studentId, studentName: name || 'Unknown', studentEmail: studentEmail || '', items: [], unreadCount: 0 };
      byStudent.set(studentId, conversation);
    } else if (conversation.studentName === 'Unknown' && name) {
      conversation.studentName = name;
    }
    return conversation;
  };
  for (const message of studentMessages || []) {
    if (!message?.id || !message.studentId) continue;
    const conversation = conversationFor(message.studentId, message.studentName, message.studentEmail);
    conversation.items.push({
      id: message.id, message: message.message, timestamp: message.timestamp, sender: 'student',
      messageType: message.messageType || 'message', read: message.read !== false,
    });
    if (!message.read) conversation.unreadCount += 1;
  }
  for (const [studentId, replies] of Object.entries(chatReplies || {})) {
    if (!Array.isArray(replies) || replies.length === 0) continue;
    const conversation = conversationFor(studentId);
    replies.forEach((reply, index) => {
      conversation.items.push({
        id: reply.id || `reply-${studentId}-${index}`, message: reply.message, timestamp: reply.timestamp, sender: 'teacher',
        status: reply.status, errorMessage: reply.errorMessage, read: true,
      });
    });
  }
  const conversations = [...byStudent.values()].map((conversation) => {
    conversation.items.sort((a, b) => timeValue(a.timestamp) - timeValue(b.timestamp));
    const lastItem = conversation.items[conversation.items.length - 1] || null;
    return { ...conversation, lastItem, lastAt: lastItem?.timestamp || null };
  });
  conversations.sort((a, b) => (b.unreadCount > 0) - (a.unreadCount > 0)
    || timeValue(b.lastAt) - timeValue(a.lastAt)
    || a.studentName.localeCompare(b.studentName));
  return { conversations, totalUnread: conversations.reduce((total, conversation) => total + conversation.unreadCount, 0) };
}

const OFFLINE_NOTE = 'Device isn\u2019t reporting \u2014 replies deliver when it reconnects.';
// The server holds a message for a signed-out student until they sign in, and
// only while this class lasts: the delivery expires when the class ends.
const SIGNED_OUT_NOTE = 'Messages wait until the student signs in during this class.';

/**
 * Why a student's device may not be able to chat right now, from data the
 * dashboard already holds. The class-level switch says what the teacher
 * allows; this says what the device has actually received. Precedence:
 * not reporting > no drawer authority (never guess) > not under this class's
 * control > still applying the class settings > FAB re-sent on the last
 * check-in. Returns null when nothing is known to be in the way; it never
 * claims the student can send.
 */
export function describeChatDeviceReadiness({ student, monitoring, authority } = {}) {
  if (monitoring && !monitoring.telemetryCurrent) {
    // A signed-out student is reached by signing in, not by a device reconnecting.
    const label = monitoring.kind === 'signed_out' ? SIGNED_OUT_NOTE : OFFLINE_NOTE;
    return { kind: 'offline', label, detail: null, testId: 'chat-thread-offline-note' };
  }
  if (!authority || !student) return null;
  const classroomState = student.classroomState;
  if (!classroomState || typeof classroomState !== 'object') {
    return {
      kind: 'not_in_class',
      label: 'This device isn\u2019t under this class\u2019s control yet.',
      detail: 'Chat and hand raise stay unavailable on it until it joins.',
      testId: 'chat-thread-readiness-note',
    };
  }
  const sessionMismatch = authority.teachingSessionId
    && classroomState.teachingSessionId !== authority.teachingSessionId;
  const contextMismatch = authority.supervisionContextId
    && classroomState.supervisionContextId !== authority.supervisionContextId;
  if (sessionMismatch || contextMismatch) {
    return {
      kind: 'other_authority',
      label: 'Another class or coverage controls this device right now.',
      detail: 'Messages from here will not reach it until that ends.',
      testId: 'chat-thread-readiness-note',
    };
  }
  if (student.enforcementHealth === 'pending') {
    return {
      kind: 'applying',
      label: 'Device is still applying this class\u2019s settings.',
      detail: null,
      testId: 'chat-thread-readiness-note',
    };
  }
  if (student.fabSyncPending === true) {
    return {
      kind: 'fab_syncing',
      label: 'Chat controls are syncing to this device.',
      detail: 'Re-sent on its last check-in.',
      testId: 'chat-thread-readiness-note',
    };
  }
  return null;
}
