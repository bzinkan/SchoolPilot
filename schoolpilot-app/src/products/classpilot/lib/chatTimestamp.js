const TIME = { hour: 'numeric', minute: '2-digit' };
const DATE = { month: 'short', day: 'numeric' };

/**
 * Render a chat message's server timestamp for the teacher: the local time, prefixed
 * by the date when the message was not sent today. Returns '' for anything that is
 * not a valid instant so a malformed row never breaks the thread.
 */
export function formatChatTimestamp(value, now = new Date()) {
  const sent = value instanceof Date ? value : new Date(value ?? NaN);
  if (Number.isNaN(sent.getTime())) return '';
  const time = sent.toLocaleTimeString([], TIME);
  const sameDay = sent.getFullYear() === now.getFullYear()
    && sent.getMonth() === now.getMonth() && sent.getDate() === now.getDate();
  return sameDay ? time : `${sent.toLocaleDateString([], DATE)} ${time}`;
}
