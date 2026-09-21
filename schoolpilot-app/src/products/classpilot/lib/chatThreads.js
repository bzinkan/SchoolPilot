export const CHAT_REPLY_MAX_CHARS = 500;

/**
 * Teacher replies that cost one tap. `ack` marks the reply that is sent
 * immediately from its own button; the others fill the composer so the teacher
 * can adjust before sending.
 */
export const CANNED_REPLIES = Object.freeze([
  Object.freeze({ id: 'got-it', text: 'Got it', ack: true }),
  Object.freeze({ id: 'yes', text: 'Yes' }),
  Object.freeze({ id: 'one-moment', text: 'One moment' }),
  Object.freeze({ id: 'come-see-me', text: 'Come see me' }),
  Object.freeze({ id: 'not-now', text: 'Not right now' }),
  Object.freeze({ id: 'check-board', text: 'Check the board' }),
]);

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

export function deliveryLabel(status, errorMessage) {
  if (status === 'seen') return 'Seen';
  if (status === 'delivered') return 'Delivered';
  if (status === 'failed') return errorMessage || 'Failed';
  return 'Sending';
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

/**
 * One inbox row per student: the merged timeline of their messages and the
 * teacher's replies (oldest first), the unread count, and the last item for the
 * preview line. Rows are ordered unread first, then newest activity.
 */
export function deriveChatConversations(studentMessages, chatReplies) {
  const byStudent = new Map();
  const conversationFor = (studentId, studentName, studentEmail) => {
    let conversation = byStudent.get(studentId);
    if (!conversation) {
      conversation = { studentId, studentName: studentName || 'Unknown', studentEmail: studentEmail || '', items: [], unreadCount: 0 };
      byStudent.set(studentId, conversation);
    } else if (conversation.studentName === 'Unknown' && studentName) {
      conversation.studentName = studentName;
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
    return { kind: 'offline', label: OFFLINE_NOTE, detail: null, testId: 'chat-thread-offline-note' };
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
