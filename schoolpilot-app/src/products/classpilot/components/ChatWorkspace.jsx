import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, MoreHorizontal, PauseCircle } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { deriveStudentMonitoringDisplay } from '../lib/studentMonitoringDisplay';
import { describeChatDeviceReadiness, describeChatPause, emptyConversation } from '../lib/chatThreads';
import { answerableConversations, longestWaitingUnreadId, readOnlyReplyNote, splitOffRoster } from '../lib/chatRoster';
import ChatRosterList from './ChatRosterList';
import ChatThread from './ChatThread';
import ChatComposer from './ChatComposer';

const SINGLE_PANE_BELOW = 640;
const NO_ROSTER = Object.freeze([]);

// A thread whose student is not on the roster. With a roster known, the
// teacher can read it but not reply: the server refuses a reply to a student
// outside this class.
function otherConversationRow(conversation, canMessage) {
  return {
    studentId: conversation.studentId,
    name: conversation.studentName,
    mark: null,
    word: '',
    srStatus: canMessage ? '' : 'Not in this class',
    canMessage,
    unreadCount: conversation.unreadCount,
    hasThread: true,
  };
}

function rosterRowButton(container, studentId) {
  if (!container || !studentId) return null;
  return [...container.querySelectorAll('[data-roster-id]')]
    .find((node) => node.getAttribute('data-roster-id') === studentId) || null;
}

/**
 * Reusable inbox content. Keep mounted across tool tabs; remount only at the
 * authenticated classroom boundary. Hidden threads never mark arrivals read.
 *
 * The list column is the class roster (`roster`: the Dashboard's whole class,
 * in grid order, as primitive rows). Choosing a student opens their thread, or
 * an empty one to start the conversation, through `onOpenThread`, which moves
 * focus to the reply box once (`focusSignal`). Threads with students who are no
 * longer on the roster follow under "Other conversations". Teachers can write
 * only while both the class switch (`studentMessagingEnabled`, which the menu
 * toggles) and the school-wide switch (`schoolMessagingEnabled`) are on; a
 * pause still lets them write. While either switch is off, or the class chat
 * is unavailable, nothing new can start: the list shows existing threads only,
 * to read. While a switch is off the reply box, Send and quick replies are off
 * too. A switch turned off while Messages is on screen is announced, and a
 * conversation that has not started closes (its draft stays); focus the switch
 * takes from the workspace moves to the open conversation or the note in its
 * place, never to the page, to another conversation, or to a control that acts
 * on Space or Enter. Focus the teacher has put outside Messages stays there,
 * and turning messaging back on moves no focus. A thread the server would
 * refuse a reply to is read-only: an existing thread opens to read, with no
 * reply box. That covers a student with another staff member ("With {staff}")
 * and one no longer on the roster. Without a `roster` the list is a plain
 * inbox.
 */
export default function ChatWorkspace({
  visible = true,
  width = 640,
  onOpenStudentDetails,
  conversations,
  totalUnread,
  selectedStudentId,
  onSelectConversation,
  onOpenThread = onSelectConversation,
  roster = null,
  broadcastLabel = 'Announce to class',
  onClearThread,
  onEndChat,
  onReplyToMessage,
  pendingReplyStudentIds,
  onMarkThreadRead,
  students,
  freshnessNowMs,
  authority = null,
  studentMessagingEnabled = true,
  schoolMessagingEnabled = true,
  onToggleStudentMessaging,
  fabState = null,
  onTogglePause,
  fabSettingsPending = false,
  onSendMessage,
  focusSignal = 0,
  chatAvailable = true,
}) {
  const pause = describeChatPause(fabState);
  const messagingEnabled = studentMessagingEnabled && schoolMessagingEnabled;
  const [drafts, setDrafts] = useState({});
  const singlePane = width < SINGLE_PANE_BELOW;
  // A pause still lets the teacher write; messaging off (for the class or the
  // school) or an unavailable chat cannot send, so none of them offers a way to
  // start a conversation.
  const canStartConversations = messagingEnabled && chatAvailable;
  const rosterKnown = Array.isArray(roster);
  const rosterRows = rosterKnown ? roster : NO_ROSTER;
  const rosterById = useMemo(() => new Map(rosterRows.map((row) => [row.studentId, row])), [rosterRows]);
  const selected = useMemo(() => {
    const conversation = conversations.find((row) => row.studentId === selectedStudentId);
    if (conversation || !selectedStudentId || !canStartConversations) return conversation || null;
    const row = rosterById.get(selectedStudentId);
    return row?.canMessage ? emptyConversation(selectedStudentId, row.name) : null;
  }, [conversations, selectedStudentId, rosterById, canStartConversations]);
  const selectedId = selected?.studentId ?? null;
  const selectedRosterRow = selectedId ? rosterById.get(selectedId) || null : null;
  // Read-only: the student is with another staff member, or no longer on the
  // roster. The server refuses either reply, so there is no reply box.
  const readOnly = Boolean(selected) && rosterKnown && !selectedRosterRow?.canMessage;
  const offersComposer = Boolean(selected) && !readOnly;
  const composerDisabled = !messagingEnabled || Boolean(selectedId && pendingReplyStudentIds?.has(selectedId));
  // Only a reply box that is on screen and enabled can take focus.
  const composerTakesFocus = offersComposer && !composerDisabled;
  const sectionRef = useRef(null);
  const headingRef = useRef(null);
  const listColumnRef = useRef(null);
  const backButtonRef = useRef(null);
  const noSelectionRef = useRef(null);
  // The control in this workspace that has focus, or had it until the
  // workspace itself removed or disabled it (a switch turned off elsewhere
  // takes the reply box, "need reply", a roster row, the pause switch). Cleared
  // once the teacher puts focus anywhere else, so a later switch change never
  // pulls focus back into Messages.
  const lastFocusedRef = useRef(null);
  const rememberFocus = useCallback((event) => { lastFocusedRef.current = event.target; }, []);
  const forgetFocusTheTeacherMoved = useCallback((event) => {
    const next = event.relatedTarget;
    if (next) {
      // Within the workspace, or into a menu it opened (portaled, so outside
      // this section), onFocus records the new control.
      if (!event.currentTarget.contains(next)) lastFocusedRef.current = null;
      return;
    }
    // Focus went to the page: a click on something that takes no focus, or the
    // workspace removed or disabled the control. While this event runs, a
    // removed control is still connected and enabled, so decide a moment later.
    // A control that still has focus lost only the window's.
    const blurred = event.target;
    queueMicrotask(() => {
      if (lastFocusedRef.current === blurred && blurred.isConnected && !blurred.disabled
        && document.activeElement !== blurred) lastFocusedRef.current = null;
    });
  }, []);
  // A click outside Messages also puts the teacher elsewhere, even when focus
  // was already on the page and so has nothing to leave.
  useEffect(() => {
    if (!visible) return undefined;
    const forgetOnOutsidePointer = (event) => {
      if (!sectionRef.current?.contains(event.target)) lastFocusedRef.current = null;
    };
    document.addEventListener('pointerdown', forgetOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', forgetOnOutsidePointer, true);
  }, [visible]);
  // The record of the last handled open request lives here, not in the
  // composer, so it survives the composer unmounting between threads.
  const handledFocusSignalRef = useRef(focusSignal);
  const claimFocusSignal = useCallback((signal) => {
    if (signal === handledFocusSignalRef.current) return false;
    handledFocusSignalRef.current = signal;
    return true;
  }, []);
  useEffect(() => {
    // With no reply box that can take focus (no thread, a read-only one,
    // messaging off, or a reply in flight), the request is spent here rather
    // than waiting to take focus from whatever comes next. When opening the
    // thread removed the focused control (one pane swaps the roster for the
    // thread), focus moves to the open conversation, not to the page.
    if (composerTakesFocus || !claimFocusSignal(focusSignal) || !selectedId) return undefined;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      (rosterRowButton(listColumnRef.current, selectedId) || backButtonRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [composerTakesFocus, focusSignal, claimFocusSignal, selectedId]);
  // Nothing new can start while messaging is off, so a conversation that has
  // not started (an empty thread, perhaps with a draft) closes rather than
  // waiting hidden: it would come back the moment messaging did and, in one
  // pane, replace the list the teacher is on. Its draft stays. Only while the
  // tab is on screen, where choosing no conversation changes nothing else, and
  // the chat is available, so the conversations are known.
  const unstartedConversationHidden = visible && chatAvailable && !messagingEnabled
    && Boolean(selectedStudentId) && !selected;
  useEffect(() => {
    if (unstartedConversationHidden) onSelectConversation(null);
  }, [unstartedConversationHidden, onSelectConversation]);
  // A switch turned off elsewhere can take focus from the workspace by
  // removing or disabling the focused control. Focus then moves to the open
  // conversation (its row, or Back in one pane), else to the note in its place:
  // the empty conversation pane, or in one pane the Messages heading. Never to
  // a control that acts by itself or opens another conversation: on the
  // announce button the rest of a private message would open a message to the
  // whole class, and on another student's row it would open their reply box if
  // messaging came straight back. Focus the teacher has put anywhere else stays
  // there. Turning messaging on removes and disables nothing, so it moves no
  // focus.
  const previousMessagingEnabledRef = useRef(messagingEnabled);
  useEffect(() => {
    const turnedOff = previousMessagingEnabledRef.current && !messagingEnabled;
    previousMessagingEnabledRef.current = messagingEnabled;
    if (!turnedOff || !visible) return undefined;
    const frame = requestAnimationFrame(() => {
      const last = lastFocusedRef.current;
      if (!last || (last.isConnected && !last.disabled)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== last) return;
      const list = listColumnRef.current;
      (list?.querySelector('[data-roster-id][aria-current="true"]')
        || backButtonRef.current
        || noSelectionRef.current
        || headingRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [messagingEnabled, visible]);
  // In one pane, Back swaps the thread for the roster: focus returns to the
  // student's row, or to the list's Tab stop when that row is gone.
  const backToRoster = () => {
    const returnTo = selectedId;
    onSelectConversation(null);
    requestAnimationFrame(() => {
      const list = listColumnRef.current;
      (rosterRowButton(list, returnTo)
        || list?.querySelector('[data-roster-id][tabindex="0"]')
        || list?.querySelector('input'))?.focus();
    });
  };
  const monitoringByStudent = useMemo(() => {
    const map = new Map();
    for (const student of students || []) {
      const id = student.studentId || student.id;
      if (id) map.set(id, deriveStudentMonitoringDisplay(student, freshnessNowMs));
    }
    return map;
  }, [students, freshnessNowMs]);
  const readinessByStudent = useMemo(() => {
    const map = new Map();
    for (const student of students || []) {
      const id = student.studentId || student.id;
      if (!id) continue;
      const readiness = describeChatDeviceReadiness({ student, monitoring: monitoringByStudent.get(id) || null, authority });
      if (readiness) map.set(id, readiness);
    }
    return map;
  }, [students, monitoringByStudent, authority]);
  const listRoster = useMemo(
    () => (canStartConversations ? rosterRows : rosterRows.filter((row) => row.hasThread)),
    [canStartConversations, rosterRows],
  );
  const otherRows = useMemo(
    () => splitOffRoster(conversations, rosterById).map((conversation) => otherConversationRow(conversation, !rosterKnown)),
    [conversations, rosterById, rosterKnown],
  );
  // "Need reply" counts and opens only conversations the teacher can answer.
  const answerable = useMemo(
    () => answerableConversations(conversations, { rosterById: rosterKnown ? rosterById : null, canStart: canStartConversations }),
    [conversations, rosterById, rosterKnown, canStartConversations],
  );
  const needReplyCount = useMemo(
    () => answerable.filter((conversation) => conversation.unreadCount > 0).length,
    [answerable],
  );
  const needReplyStudentId = useMemo(() => longestWaitingUnreadId(answerable), [answerable]);
  const showList = !singlePane || !selected;
  const showThread = !singlePane || Boolean(selected);
  const selectedMonitoring = selected ? monitoringByStudent.get(selected.studentId) || null : null;
  // Signed out, not merely stale: the server holds the message until the
  // student signs in, so say so instead of "Sending".
  const waitingFor = selectedMonitoring?.kind === 'signed_out' ? selected.studentName : null;
  // Announcements are a separate channel, so an unavailable chat names what it
  // cannot show: conversations.
  const emptyText = !chatAvailable
    ? 'Conversations aren’t available in this class right now.'
    : !messagingEnabled ? 'No messages from students' : 'No students to message yet';
  // With messaging off students cannot write, so nothing promises new messages.
  const noSelectionText = !chatAvailable ? emptyText
    : !messagingEnabled ? (conversations.length === 0 ? 'No conversations to read' : 'Select a conversation to read it')
    : canStartConversations && rosterRows.length > 0 ? 'Choose a student to message'
      : conversations.length === 0 ? 'Student messages will appear here' : 'Select a conversation';

  return (
    <section ref={sectionRef} hidden={!visible} className={visible ? "flex flex-1 min-h-[360px] flex-col" : "hidden"} data-testid="chat-drawer" aria-label="Messages"
      onFocus={rememberFocus} onBlur={forgetFocusTheTeacherMoved}>
        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-3 pr-12 flex items-center justify-between shrink-0">
          {/* Out of the Tab order: where focus a switch took lands in one pane
              when no conversation is open. */}
          <h3 ref={headingRef} tabIndex={-1} data-testid="chat-drawer-heading"
            className="text-white font-semibold text-base flex items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/80">
            <MessageSquare className="h-4 w-4" />
            <span>Messages (<span data-testid="chat-drawer-unread-count">{totalUnread}</span> new)</span>
          </h3>
          <div className="flex items-center gap-3">
            {onTogglePause && messagingEnabled && (
              <label className="flex items-center gap-2 text-xs text-white/90">
                <span data-testid="chat-pause-label">{pause ? (pause.locked ? 'Paused for testing' : 'Messages: Paused') : 'Messages: On'}</span>
                <Switch
                  data-testid="chat-messaging-switch"
                  checked={!pause}
                  onCheckedChange={(checked) => onTogglePause(!checked)}
                  disabled={fabSettingsPending || Boolean(pause?.locked)}
                  aria-label={pause?.locked ? 'Student messages are paused for testing' : 'Pause student messages'}
                  className="data-[state=checked]:bg-white/40 data-[state=unchecked]:bg-white/20"
                />
              </label>
            )}
            {onToggleStudentMessaging && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="text-white/80 hover:text-white" aria-label="More messaging options" data-testid="chat-drawer-menu">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={fabSettingsPending}
                    data-testid="chat-channel-toggle"
                    onSelect={() => onToggleStudentMessaging(!studentMessagingEnabled)}
                  >
                    {studentMessagingEnabled ? 'Turn off messaging for this class' : 'Turn on messaging for this class'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {pause && messagingEnabled && (
          <div className="px-4 py-2 text-xs bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 border-b border-amber-100 dark:border-amber-900 flex items-start gap-2 shrink-0" data-testid="chat-pause-banner" data-pause-reason={pause.reason}>
            <PauseCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span><span className="font-semibold">{pause.title}.</span> {pause.detail}</span>
          </div>
        )}
        {/* Always present, so a switch turned off elsewhere is announced. */}
        <div role="status" className="shrink-0" data-testid="chat-off-region">
          {!schoolMessagingEnabled ? (
            <div className="px-4 py-2 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700" data-testid="chat-school-off-banner">
              Messaging is turned off for your school. Students do not see a chat.
            </div>
          ) : !studentMessagingEnabled && (
            <div className="px-4 py-2 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700" data-testid="chat-off-banner">
              Messaging is turned off for this class. Students do not see a chat.
            </div>
          )}
        </div>
        <div className="flex flex-1 min-h-0">
          {showList && (
            <div ref={listColumnRef} className={cn('flex min-h-0 flex-col', singlePane ? 'flex-1' : 'w-72 shrink-0 border-r border-gray-200 dark:border-gray-700')}>
              {/* The roster renders only while the Messages tab is on screen. */}
              {visible && (
                <ChatRosterList
                  rows={listRoster}
                  otherRows={otherRows}
                  rosterLabel={canStartConversations ? 'Class roster' : 'Conversations'}
                  selectedStudentId={selectedId}
                  onOpenThread={onOpenThread}
                  readinessByStudent={readinessByStudent}
                  needReplyCount={needReplyCount}
                  needReplyStudentId={needReplyStudentId}
                  onSendMessage={onSendMessage}
                  broadcastLabel={broadcastLabel}
                  emptyText={emptyText}
                  dimmed={!messagingEnabled}
                />
              )}
            </div>
          )}
          {showThread && (
            <div className={cn('flex-1 min-w-0 min-h-0 flex flex-col', !messagingEnabled && 'opacity-60')}>
              {selected ? (
                <ChatThread
                  visible={visible}
                  // Details is revoked for a student this class does not hold,
                  // and ending a chat reaches the device: read-only offers neither.
                  onOpenStudentDetails={readOnly ? undefined : onOpenStudentDetails}
                  conversation={selected}
                  monitoring={selectedMonitoring}
                  readiness={readOnly ? null : readinessByStudent.get(selected.studentId) || null}
                  waitingFor={waitingFor}
                  onClearThread={onClearThread}
                  onEndChat={readOnly ? undefined : onEndChat}
                  onMarkThreadRead={onMarkThreadRead}
                  onBack={singlePane ? backToRoster : undefined}
                  backButtonRef={backButtonRef}
                >
                  {readOnly ? (
                    <p className="border-t border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 shrink-0" data-testid="chat-thread-read-only">
                      {readOnlyReplyNote({ name: selected.studentName, word: selectedRosterRow?.word })}
                    </p>
                  ) : (
                    <ChatComposer
                      studentId={selected.studentId}
                      studentName={selected.studentName}
                      value={drafts[selected.studentId] || ''}
                      onChange={(text) => setDrafts((current) => ({ ...current, [selected.studentId]: text }))}
                      onReplyToMessage={onReplyToMessage}
                      disabled={composerDisabled}
                      studentHasWritten={selected.items.some((item) => item.sender === 'student')}
                      focusSignal={focusSignal}
                      // A disabled box cannot take focus; the workspace spends
                      // the request instead.
                      claimFocusSignal={composerTakesFocus ? claimFocusSignal : undefined}
                    />
                  )}
                </ChatThread>
              ) : (
                // Out of the Tab order, like the heading: in two panes, where
                // focus a switch took lands when no conversation is open.
                <div ref={noSelectionRef} tabIndex={-1} data-testid="chat-no-selection"
                  className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 px-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
                  {noSelectionText}
                </div>
              )}
            </div>
          )}
        </div>
    </section>
  );
}
