import { memo, useId, useMemo, useRef, useState } from 'react';
import { Megaphone, Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { enterTarget, filterRoster, needReplyLabel } from '../lib/chatRoster';

// Every mark keeps at least 3:1 contrast against the panel (WCAG 1.4.11).
const MARK_TONE = {
  dot: 'text-green-600 dark:text-green-400',
  ring: 'text-gray-500 dark:text-gray-400',
  dash: 'text-gray-500 dark:text-gray-400',
  cross: 'text-gray-500 dark:text-gray-400',
  diamond: 'text-slate-500 dark:text-slate-400',
};

// Decorative: the row spells its status out in text. Each mark has its own
// shape, so presence never depends on telling colours apart. The tooltip names
// the wordless marks (on now, not reporting) for a mouse user; it is hidden
// from screen readers, which already hear the status in the row.
function RosterMark({ mark, label }) {
  if (!MARK_TONE[mark]) return <span className="w-2.5 shrink-0" aria-hidden="true" />;
  return (
    <span className="flex shrink-0" title={label || undefined} aria-hidden="true">
      <svg viewBox="0 0 10 10" className={cn('h-2.5 w-2.5', MARK_TONE[mark])} aria-hidden="true" focusable="false" data-mark={mark}>
        {mark === 'dot' && <circle cx="5" cy="5" r="4" fill="currentColor" />}
        {mark === 'ring' && <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        {mark === 'dash' && <rect x="1" y="4.2" width="8" height="1.6" rx="0.8" fill="currentColor" />}
        {mark === 'cross' && <path d="M2 2 8 8M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
        {mark === 'diamond' && <path d="M5 1 9 5 5 9 1 5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />}
      </svg>
    </span>
  );
}

/**
 * One line: mark, name (bold while unread), at most one status word, unread
 * count. No message text, times or avatars: the roster may be on a projector.
 * A row that can neither start a conversation nor open one (a student with
 * another staff member and no thread) stays in the list, marked unavailable.
 */
const RosterRow = memo(function RosterRow({
  studentId, name, mark, word, srStatus, canMessage, unreadCount, hasThread,
  current, focusable, readinessKind, readinessLabel, onOpen,
}) {
  const opens = canMessage || hasThread;
  const unread = unreadCount > 0;
  return (
    <li>
      <button
        type="button"
        tabIndex={focusable ? 0 : -1}
        onClick={opens ? () => onOpen(studentId) : undefined}
        aria-current={current ? 'true' : undefined}
        aria-disabled={opens ? undefined : 'true'}
        data-roster-id={studentId}
        data-has-thread={hasThread ? 'true' : undefined}
        data-testid={`chat-conversation-${studentId}`}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500',
          current ? 'bg-blue-50 dark:bg-blue-950/40' : opens ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50' : 'cursor-default',
        )}
      >
        <RosterMark mark={mark} label={srStatus} />
        <span className={cn(
          'min-w-0 flex-1 truncate',
          unread ? 'font-semibold text-gray-900 dark:text-gray-100' : opens ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400',
        )}>
          {name}
        </span>
        {word ? (
          <>
            <span className="sr-only">, </span>
            <span className="max-w-[55%] shrink-0 truncate text-xs text-gray-500 dark:text-gray-400">{word}</span>
          </>
        ) : srStatus ? <span className="sr-only">, {srStatus}</span> : null}
        {readinessKind && (
          <span
            className="shrink-0 text-amber-500 dark:text-amber-400"
            title={readinessLabel}
            data-testid={`chat-conversation-readiness-${studentId}`}
            data-kind={readinessKind}
          >
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true" focusable="false">
              <path d="M5 1 9.2 8.6H0.8Z" fill="currentColor" />
            </svg>
            <span className="sr-only">, {readinessLabel.replace(/\.$/, '')}</span>
          </span>
        )}
        {unread && (
          <>
            <span className="sr-only">, </span>
            <span
              className="min-w-5 h-5 shrink-0 rounded-full bg-blue-500 px-1.5 text-[11px] font-bold text-white flex items-center justify-center"
              data-testid={`chat-conversation-unread-${studentId}`}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
            <span className="sr-only"> unread</span>
          </>
        )}
      </button>
    </li>
  );
});

const ROW_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * The Messages list column: a labelled announce button, Find, the "need
 * reply" jump, then the class roster and "Other conversations" (threads with
 * students who are not on the roster, to read). The rows are one Tab stop:
 * arrow keys, Home and End move between them. Opening a row goes through
 * `onOpenThread`, which also moves focus to the reply box once. "Need reply"
 * counts only conversations the teacher can answer (`needReplyCount`).
 */
export default function ChatRosterList({
  rows,
  otherRows,
  rosterLabel = 'Class roster',
  selectedStudentId = null,
  onOpenThread,
  readinessByStudent = null,
  needReplyCount = 0,
  needReplyStudentId = null,
  onSendMessage,
  broadcastLabel = 'Announce to class',
  emptyText = 'No students to message yet',
  dimmed = false,
}) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const findRef = useRef(null);
  const listRef = useRef(null);
  const otherHeadingId = useId();
  const matches = useMemo(() => filterRoster(rows, query), [rows, query]);
  const otherMatches = useMemo(() => filterRoster(otherRows, query), [otherRows, query]);
  const visibleIds = useMemo(
    () => new Set([...matches, ...otherMatches].map((row) => row.studentId)),
    [matches, otherMatches],
  );
  // The row that holds the list's single Tab stop: the last row focused, else
  // the open thread, else the first row shown.
  const focusId = visibleIds.has(activeId) ? activeId
    : visibleIds.has(selectedStudentId) ? selectedStudentId
      : matches[0]?.studentId ?? otherMatches[0]?.studentId ?? null;
  const hasRows = rows.length > 0 || otherRows.length > 0;
  const searching = query.trim() !== '';
  const matchCount = matches.length + otherMatches.length;

  const rowButtons = () => [...(listRef.current?.querySelectorAll('[data-roster-id]') || [])];

  const onListKeyDown = (event) => {
    if (!ROW_KEYS.includes(event.key)) return;
    const buttons = rowButtons();
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) {
      findRef.current?.focus();
      return;
    }
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  };

  const onListFocus = (event) => {
    const id = event.target?.getAttribute?.('data-roster-id');
    if (id) setActiveId(id);
  };

  const onFindKeyDown = (event) => {
    if (event.key === 'Escape') {
      // Clearing Find is all Escape does here: it must not also close Class
      // tools, whose handlers skip a handled (defaultPrevented) Escape.
      if (!query) return;
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
      return;
    }
    if (event.key === 'ArrowDown') {
      const buttons = rowButtons();
      const target = buttons.find((button) => button.tabIndex === 0) || buttons[0];
      if (!target) return;
      event.preventDefault();
      target.focus();
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const target = enterTarget([...matches, ...otherMatches]);
    if (!target) return;
    event.preventDefault();
    // Find has done its job: the whole roster returns behind the open thread.
    setQuery('');
    onOpenThread(target.studentId);
  };

  const renderRow = (row) => {
    // A device that reports but cannot chat yet gets a small warning; a
    // read-only row already says where the student is.
    const readiness = row.canMessage ? readinessByStudent?.get?.(row.studentId) : null;
    const blocked = readiness && readiness.kind !== 'offline' ? readiness : null;
    return (
      <RosterRow
        key={row.studentId}
        studentId={row.studentId}
        name={row.name}
        mark={row.mark}
        word={row.word}
        srStatus={row.srStatus}
        canMessage={row.canMessage}
        unreadCount={row.unreadCount}
        hasThread={row.hasThread}
        current={row.studentId === selectedStudentId}
        focusable={row.studentId === focusId}
        readinessKind={blocked?.kind || null}
        readinessLabel={blocked?.label || ''}
        onOpen={onOpenThread}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        {onSendMessage && (
          <button
            type="button"
            onClick={onSendMessage}
            aria-label={broadcastLabel}
            title={broadcastLabel}
            data-testid="chat-broadcast"
            className="flex w-full items-center justify-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/50"
          >
            <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{broadcastLabel}</span>
          </button>
        )}
        {hasRows && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              ref={findRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onFindKeyDown}
              placeholder="Find a student"
              aria-label="Find a student"
              autoComplete="off"
              spellCheck={false}
              data-testid="chat-roster-find"
              className="h-8 w-full rounded-md border border-gray-200 bg-white pl-7 pr-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        )}
        {needReplyCount > 0 ? (
          <button
            type="button"
            onClick={() => { if (needReplyStudentId) onOpenThread(needReplyStudentId); }}
            title="Open the student who has waited longest"
            data-testid="chat-need-reply"
            className="w-full rounded-md bg-blue-600 px-3 py-1 text-left text-xs font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
          >
            {needReplyLabel(needReplyCount)}
          </button>
        ) : !hasRows ? (
          <p data-testid="chat-empty" className="px-1 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {emptyText}
          </p>
        ) : null}
      </div>
      <div
        ref={listRef}
        className={cn('min-h-0 flex-1 overflow-y-auto', dimmed && 'opacity-60')}
        onKeyDown={onListKeyDown}
        onFocus={onListFocus}
        data-testid="chat-conversations"
      >
        {matches.length > 0 && (
          // An explicit role: Safari drops list semantics from unstyled lists.
          <ul role="list" aria-label={rosterLabel} className="py-1">
            {matches.map(renderRow)}
          </ul>
        )}
        {otherMatches.length > 0 && (
          <>
            <h4 id={otherHeadingId} className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Other conversations
            </h4>
            <ul role="list" aria-labelledby={otherHeadingId} className="pb-1">
              {otherMatches.map(renderRow)}
            </ul>
          </>
        )}
        {searching && matchCount === 0 && (
          <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">No students match</p>
        )}
        <p className="sr-only" role="status">
          {searching ? `${matchCount} student${matchCount === 1 ? '' : 's'} found` : ''}
        </p>
      </div>
    </div>
  );
}
