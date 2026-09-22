import { useEffect, useRef } from 'react';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { cn } from '../../../lib/utils';
import { formatChatTimestamp } from '../lib/chatTimestamp';
import { deliveryLabel, looksLikeQuestion } from '../lib/chatThreads';
import LastSeenTime from './LastSeenTime';

export function ChatMessageBubble({ item }) {
  const question = item.sender === 'student' && looksLikeQuestion(item.message);
  return (
    <div className={cn('flex', item.sender === 'teacher' ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[80%]">
        <div
          data-testid={question ? `chat-question-${item.id}` : `chat-bubble-${item.id}`}
          className={cn(
            'px-3 py-1.5 rounded-2xl text-sm break-words whitespace-pre-wrap',
            item.sender === 'teacher'
              ? 'bg-blue-500 text-white rounded-br-md'
              : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-bl-md',
            question && 'border-l-2 border-amber-400'
          )}
        >
          {item.message}
        </div>
        <div
          data-testid="chat-message-time"
          className={cn(
            'mt-0.5 text-[10px]',
            item.sender === 'teacher' ? 'text-right' : 'text-left',
            item.sender === 'teacher' && item.status === 'failed' ? 'text-red-500' : 'text-gray-400 dark:text-gray-500'
          )}
        >
          <time dateTime={item.timestamp}>{formatChatTimestamp(item.timestamp)}</time>
          {item.sender === 'teacher' && item.status && (
            <>
              <span aria-hidden="true"> · </span>
              <span data-testid={`chat-delivery-${item.id}`}>{deliveryLabel(item.status, item.errorMessage)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One student's conversation. Selecting it, and any message that arrives while
 * it is open on a visible tab, marks the student's messages read. Only this
 * thread auto-scrolls.
 */
function ChatThread({ visible = true, onOpenStudentDetails, conversation, monitoring = null, readiness = null, onClearThread, onEndChat, onMarkThreadRead, onBack, children }) {
  const endRef = useRef(null);
  const { studentId, studentName, items } = conversation;
  const itemCount = items.length;
  const lastItemId = items[itemCount - 1]?.id ?? null;
  const unreadCount = conversation.unreadCount;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [studentId, lastItemId]);

  useEffect(() => {
    const markVisible = () => {
      if (visible && unreadCount > 0 && document.visibilityState === 'visible') onMarkThreadRead(studentId);
    };
    markVisible();
    document.addEventListener('visibilitychange', markVisible);
    return () => document.removeEventListener('visibilitychange', markVisible);
  }, [visible, studentId, unreadCount, lastItemId, onMarkThreadRead]);

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="chat-thread" data-student-id={studentId}>
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1 rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
              aria-label="Back to conversations"
              data-testid="chat-thread-back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <span className="min-w-0">
            <span className="block font-semibold text-sm text-gray-800 dark:text-gray-200 truncate">{studentName}</span>
            {monitoring && (
              <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid="chat-thread-status">
                <span
                  className={cn('w-2 h-2 rounded-full', monitoring.status === 'online' ? 'bg-green-500' : monitoring.status === 'reconnecting' || monitoring.status === 'idle' ? 'bg-amber-400' : 'bg-gray-400')}
                  aria-hidden="true"
                />
                <span>{monitoring.label}</span>
                {monitoring.observedAtMs !== null && monitoring.observedAtMs !== undefined && (
                  <>
                    <span aria-hidden="true">·</span>
                    <LastSeenTime observedAt={new Date(monitoring.observedAtMs).toISOString()} />
                  </>
                )}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onOpenStudentDetails && <button type="button" className="text-xs px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" onClick={(event) => onOpenStudentDetails(studentId, event.currentTarget)}>Details</button>}
          <button
            type="button"
            onClick={() => onClearThread(studentId)}
            className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700 font-medium transition-colors"
            title="Hide this conversation here. Message history is kept and the student's chat is not affected."
            data-testid="chat-thread-clear"
          >
            Clear thread
          </button>
          {onEndChat && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="p-1 rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700 transition-colors"
                  aria-label={`More actions for ${studentName}`}
                  data-testid="chat-thread-menu"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600 dark:text-red-400"
                  title="Tells the student the chat has ended and clears it on their device. History is kept on the server."
                  data-testid="chat-thread-end"
                  onSelect={() => onEndChat(studentId)}
                >
                  End chat for student
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {readiness && (
        <div
          className="px-3 py-1.5 text-xs bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-b border-amber-100 dark:border-amber-900 shrink-0"
          data-testid={readiness.testId}
          data-kind={readiness.kind}
        >
          {readiness.label}{readiness.detail ? ` ${readiness.detail}` : ''}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5" data-testid="chat-thread-messages">
        {items.map((item) => <ChatMessageBubble key={item.id} item={item} />)}
        <div ref={endRef} />
      </div>
      {children}
    </div>
  );
}

export default ChatThread;
