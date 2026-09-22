import { useMemo, useState } from 'react';
import { MessageSquare, MoreHorizontal, PauseCircle, Send } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { deriveStudentMonitoringDisplay } from '../lib/studentMonitoringDisplay';
import { describeChatDeviceReadiness, describeChatPause } from '../lib/chatThreads';
import ChatConversationList from './ChatConversationList';
import ChatThread from './ChatThread';
import ChatComposer from './ChatComposer';

const SINGLE_PANE_BELOW = 640;

/**
 * Reusable inbox content. Keep mounted across tool tabs; remount only at the
 * authenticated classroom boundary. Hidden threads never mark arrivals read.
 */
export default function ChatWorkspace({
  visible = true,
  width = 640,
  onOpenStudentDetails,
  conversations,
  totalUnread,
  selectedStudentId,
  onSelectConversation,
  onClearThread,
  onEndChat,
  onReplyToMessage,
  pendingReplyStudentIds,
  onMarkThreadRead,
  students,
  freshnessNowMs,
  authority = null,
  studentMessagingEnabled = true,
  onToggleStudentMessaging,
  fabState = null,
  onTogglePause,
  fabSettingsPending = false,
  onSendMessage,
}) {
  const pause = describeChatPause(fabState);
  const [drafts, setDrafts] = useState({});
  const singlePane = width < SINGLE_PANE_BELOW;
  const selected = useMemo(
    () => conversations.find((conversation) => conversation.studentId === selectedStudentId) || null,
    [conversations, selectedStudentId]
  );
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
  const showList = !singlePane || !selected;
  const showThread = !singlePane || Boolean(selected);

  return (
    <section hidden={!visible} className={visible ? "flex flex-1 min-h-[360px] flex-col" : "hidden"} data-testid="chat-drawer" aria-label="Messages">
        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-3 pr-12 flex items-center justify-between shrink-0">
          <h3 className="text-white font-semibold text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            <span>Messages (<span data-testid="chat-drawer-unread-count">{totalUnread}</span> new)</span>
          </h3>
          <div className="flex items-center gap-3">
            {onSendMessage && (
              <button
                type="button"
                onClick={onSendMessage}
                className="text-white/80 hover:text-white"
                title="Send a message to the class"
                aria-label="Send a message to the class"
                data-testid="chat-broadcast"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
            {onTogglePause && studentMessagingEnabled && (
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
        {pause && studentMessagingEnabled && (
          <div className="px-4 py-2 text-xs bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 border-b border-amber-100 dark:border-amber-900 flex items-start gap-2 shrink-0" data-testid="chat-pause-banner" data-pause-reason={pause.reason}>
            <PauseCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span><span className="font-semibold">{pause.title}.</span> {pause.detail}</span>
          </div>
        )}
        {!studentMessagingEnabled && (
          <div className="px-4 py-2 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 shrink-0" data-testid="chat-off-banner">
            Messaging is turned off for this class. Students do not see a chat.
          </div>
        )}
        <div className={cn('flex flex-1 min-h-0', !studentMessagingEnabled && 'opacity-60')}>
          {showList && (
            <div className={cn('min-h-0 overflow-y-auto', singlePane ? 'flex-1' : 'w-72 shrink-0 border-r border-gray-200 dark:border-gray-700')}>
              <ChatConversationList
                conversations={conversations}
                selectedStudentId={selectedStudentId}
                onSelect={onSelectConversation}
                monitoringByStudent={monitoringByStudent}
                readinessByStudent={readinessByStudent}
              />
            </div>
          )}
          {showThread && (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {selected ? (
                <ChatThread
                  visible={visible}
                  onOpenStudentDetails={onOpenStudentDetails}
                  conversation={selected}
                  monitoring={monitoringByStudent.get(selected.studentId) || null}
                  readiness={readinessByStudent.get(selected.studentId) || null}
                  onClearThread={onClearThread}
                  onEndChat={onEndChat}
                  onMarkThreadRead={onMarkThreadRead}
                  onBack={singlePane ? () => onSelectConversation(null) : undefined}
                >
                  <ChatComposer
                    studentId={selected.studentId}
                    value={drafts[selected.studentId] || ''}
                    onChange={(text) => setDrafts((current) => ({ ...current, [selected.studentId]: text }))}
                    onReplyToMessage={onReplyToMessage}
                    disabled={pendingReplyStudentIds?.has(selected.studentId) || !studentMessagingEnabled}
                  />
                </ChatThread>
              ) : (
                <div data-testid="chat-no-selection" className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 px-6 text-center">
                  {conversations.length === 0 ? 'Student messages will appear here' : 'Select a conversation'}
                </div>
              )}
            </div>
          )}
        </div>
    </section>
  );
}
