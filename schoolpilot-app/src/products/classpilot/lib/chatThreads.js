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
