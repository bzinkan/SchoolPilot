import { cn } from '../../../lib/utils';
import { formatChatTimestamp } from '../lib/chatTimestamp';

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}

function statusDotClass(status) {
  if (status === 'online') return 'bg-green-500';
  if (status === 'reconnecting' || status === 'idle') return 'bg-amber-400';
  return 'bg-gray-400';
}

/** Inbox rows: unread first, then newest. `monitoringByStudent` supplies the presence dot. */
function ChatConversationList({ conversations, selectedStudentId, onSelect, monitoringByStudent }) {
  if (conversations.length === 0) {
    return (
      <div data-testid="chat-empty" className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No messages from students
      </div>
    );
  }
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700" data-testid="chat-conversations">
      {conversations.map((conversation) => {
        const { studentId, studentName, lastItem, lastAt, unreadCount } = conversation;
        const monitoring = monitoringByStudent?.get(studentId);
        const selected = studentId === selectedStudentId;
        return (
          <li key={studentId}>
            <button
              type="button"
              onClick={() => onSelect(studentId)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors',
                selected ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
              )}
              data-testid={`chat-conversation-${studentId}`}
            >
              <span className="relative shrink-0">
                <span className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-semibold flex items-center justify-center">
                  {initials(studentName)}
                </span>
                <span
                  className={cn('absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-gray-800', statusDotClass(monitoring?.status))}
                  title={monitoring?.label || ''}
                  aria-hidden="true"
                />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('truncate text-sm', unreadCount > 0 ? 'font-semibold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-800 dark:text-gray-200')}>
                    {studentName}
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                    <time dateTime={lastAt || undefined}>{formatChatTimestamp(lastAt)}</time>
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('truncate text-xs', unreadCount > 0 ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400')}>
                    {lastItem?.sender === 'teacher' && <span className="text-gray-400 dark:text-gray-500">You: </span>}
                    <span>{lastItem?.message || ''}</span>
                  </span>
                  {unreadCount > 0 && (
                    <span
                      className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-blue-500 text-white text-[11px] font-bold flex items-center justify-center"
                      data-testid={`chat-conversation-unread-${studentId}`}
                    >
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default ChatConversationList;
