import { useMemo, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../components/ui/sheet';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { deriveStudentMonitoringDisplay } from '../lib/studentMonitoringDisplay';
import { useResizablePanelWidth } from '../hooks/useResizablePanelWidth';
import ChatConversationList from './ChatConversationList';
import ChatThread from './ChatThread';
import ChatComposer from './ChatComposer';

const SINGLE_PANE_BELOW = 640;

/**
 * The class inbox. A non-modal right sheet, so the tile grid stays clickable
 * (a tile badge can switch threads without closing it). Drafts are kept per
 * student while the drawer is mounted; the message store itself lives in the
 * chat hook on the Dashboard.
 */
function ChatDrawer({
  open,
  onClose,
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
  studentMessagingEnabled = true,
  onToggleStudentMessaging,
  fabSettingsPending = false,
  onSendMessage,
}) {
  const { width, onResizeStart } = useResizablePanelWidth({ initial: 640, min: 400, storageKey: 'classpilot-chat-drawer-width' });
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
  const showList = !singlePane || !selected;
  const showThread = !singlePane || Boolean(selected);

  return (
    <Sheet open={open} modal={false} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        overlay={false}
        className="p-0 flex flex-col gap-0 sm:max-w-none"
        style={{ width: `${width}px`, maxWidth: '90vw' }}
        data-testid="chat-drawer"
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/40 z-10"
          onMouseDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize messages panel"
        />
        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-3 pr-12 flex items-center justify-between shrink-0">
          <SheetTitle className="text-white font-semibold text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            <span>Messages (<span data-testid="chat-drawer-unread-count">{totalUnread}</span> new)</span>
          </SheetTitle>
          <SheetDescription className="sr-only">Conversations with students in this class</SheetDescription>
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
            {onToggleStudentMessaging && (
              <Switch
                data-testid="chat-messaging-switch"
                checked={studentMessagingEnabled}
                onCheckedChange={(checked) => onToggleStudentMessaging(checked)}
                disabled={fabSettingsPending}
                aria-label="Student messaging"
                className="data-[state=checked]:bg-white/40 data-[state=unchecked]:bg-white/20"
              />
            )}
          </div>
        </div>
        <div className={cn('flex flex-1 min-h-0', !studentMessagingEnabled && 'opacity-60')}>
          {showList && (
            <div className={cn('min-h-0 overflow-y-auto', singlePane ? 'flex-1' : 'w-72 shrink-0 border-r border-gray-200 dark:border-gray-700')}>
              <ChatConversationList
                conversations={conversations}
                selectedStudentId={selectedStudentId}
                onSelect={onSelectConversation}
                monitoringByStudent={monitoringByStudent}
              />
            </div>
          )}
          {showThread && (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {selected ? (
                <ChatThread
                  conversation={selected}
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
      </SheetContent>
    </Sheet>
  );
}

export default ChatDrawer;
