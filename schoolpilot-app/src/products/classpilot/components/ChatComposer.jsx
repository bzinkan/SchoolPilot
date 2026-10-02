import { useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { cn } from '../../../lib/utils';
import { CHAT_REPLY_MAX_CHARS, cannedRepliesFor } from '../lib/chatThreads';

const COUNTER_FROM = 400;

/**
 * Reply box for one thread. Enter sends, Shift+Enter adds a line. One-tap
 * replies fill the draft; "Got it" sends at once. Until the student has
 * written, only openers are offered. `disabled` is true only while this
 * student's own reply is in flight, so other threads stay usable. The box is
 * named for its recipient, so focus landing here says who will receive it.
 *
 * A new `focusSignal` (an open request from a student tile) moves focus here
 * when `claimFocusSignal` says it has not been handled yet, so a composer that
 * remounts later never takes focus for an old request.
 */
function ChatComposer({ studentId, studentName = '', value, onChange, onReplyToMessage, disabled = false, studentHasWritten = true, focusSignal = 0, claimFocusSignal }) {
  const inputRef = useRef(null);
  const draft = value || '';
  const canSend = draft.trim().length > 0 && !disabled;
  const recipient = typeof studentName === 'string' ? studentName.trim() : '';
  const inputLabel = studentHasWritten
    ? (recipient ? `Reply to ${recipient}` : 'Reply')
    : (recipient ? `Message ${recipient}` : 'Message');

  useEffect(() => {
    if (!claimFocusSignal) return undefined;
    // Class tools focuses its active tab in the same commit that opens the
    // thread; one frame later the reply box takes focus from it.
    const frame = requestAnimationFrame(() => {
      if (claimFocusSignal(focusSignal)) inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSignal, claimFocusSignal]);

  const send = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    try {
      await onReplyToMessage(studentId, text);
      onChange('');
    } catch {
      // Keep the draft; the parent mutation surfaces the error toast.
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 px-3 pt-2 pb-3 shrink-0 space-y-2" data-testid="chat-composer">
      <div className="flex gap-1.5 overflow-x-auto">
        {cannedRepliesFor(studentHasWritten).map((reply) => reply.ack ? (
          <button
            key={reply.id}
            type="button"
            disabled={disabled}
            onClick={() => onReplyToMessage(studentId, reply.text).catch(() => {})}
            className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 font-medium transition-colors"
            title={'Send "Got it" right away'}
            data-testid="chat-ack"
          >
            {reply.text}
          </button>
        ) : (
          <button
            key={reply.id}
            type="button"
            onClick={() => { onChange(reply.text); inputRef.current?.focus(); }}
            className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 transition-colors"
            data-testid={`chat-canned-${reply.id}`}
          >
            {reply.text}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <Textarea
            ref={inputRef}
            value={draft}
            rows={1}
            onChange={(event) => onChange(event.target.value)}
            placeholder={studentHasWritten ? 'Type a reply…' : 'Type a message…'}
            className="min-h-[38px] max-h-32 resize-none text-sm py-2"
            maxLength={CHAT_REPLY_MAX_CHARS}
            disabled={disabled}
            aria-label={inputLabel}
            data-testid="chat-composer-input"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {draft.length >= COUNTER_FROM && (
            <span
              className={cn('absolute right-2 bottom-1 text-[10px]', draft.length >= CHAT_REPLY_MAX_CHARS ? 'text-red-500' : 'text-gray-400')}
              data-testid="chat-composer-counter"
            >
              {draft.length}/{CHAT_REPLY_MAX_CHARS}
            </span>
          )}
        </div>
        <Button
          size="sm"
          className="h-9 px-3"
          disabled={!canSend}
          onClick={() => void send()}
          data-testid="chat-composer-send"
          aria-label={studentHasWritten ? 'Send reply' : 'Send message'}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default ChatComposer;
