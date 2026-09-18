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
