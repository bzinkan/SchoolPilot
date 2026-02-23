import { useState, useRef, useEffect, useCallback } from "react";
import { Eye, EyeOff, Timer, Clock, BarChart3, Hand, MessageSquare, X, Send, GraduationCap } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { cn } from "../../../lib/utils";

const FAB_POSITION_KEY = "classpilot-fab-position";

function TeacherFab({
  attentionActive,
  onAttentionClick,
  attentionPending,
  timerActive,
  onTimerClick,
  timerPending,
  activePoll,
  pollTotalResponses,
  onPollClick,
  pollPending,
  raisedHands,
  onDismissHand,
  handRaisingEnabled = true,
  onToggleHandRaising,
  studentMessages,
  onMarkMessageRead,
  onDismissMessage,
  onReplyToMessage,
  replyPending,
  studentMessagingEnabled = true,
  onToggleStudentMessaging,
  chatReplies = {},
  onCloseChat,
}) {
  const [expanded, setExpanded] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [replyTexts, setReplyTexts] = useState({});

  // Draggable FAB state
  const [position, setPosition] = useState({ x: 24, y: 24 }); // bottom-right offset
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef(null);
  const fabRef = useRef(null);
  const hasDraggedRef = useRef(false);

  // Load saved position from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(FAB_POSITION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setPosition(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save position to localStorage when it changes
  const savePosition = useCallback((pos) => {
    try {
      localStorage.setItem(FAB_POSITION_KEY, JSON.stringify(pos));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Handle drag start (mouse)
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y,
    };
    setIsDragging(true);
  }, [position]);

  // Handle drag start (touch)
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      posX: position.x,
      posY: position.y,
    };
    setIsDragging(true);
  }, [position]);

  // Handle drag move and end
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      if (!dragStartRef.current) return;
      const deltaX = dragStartRef.current.x - e.clientX;
      const deltaY = dragStartRef.current.y - e.clientY;

      // Only count as drag if moved more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedRef.current = true;
      }

      const newX = Math.max(10, Math.min(window.innerWidth - 70, dragStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 70, dragStartRef.current.posY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const handleTouchMove = (e) => {
      if (!dragStartRef.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaX = dragStartRef.current.x - touch.clientX;
      const deltaY = dragStartRef.current.y - touch.clientY;

      // Only count as drag if moved more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedRef.current = true;
      }

      const newX = Math.max(10, Math.min(window.innerWidth - 70, dragStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 70, dragStartRef.current.posY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const handleEnd = () => {
      if (dragStartRef.current) {
        savePosition(position);
      }
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, position, savePosition]);

  // Handle FAB click - only toggle if not dragging
  const handleFabClick = useCallback(() => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return; // Don't toggle if we just finished dragging
    }
    setExpanded(!expanded);
    if (expanded) setActivePanel(null);
  }, [expanded]);

  const chatEndRefs = useRef({});
  const unreadCount = studentMessages.filter(m => !m.read).length;
  const handsCount = raisedHands.size;
  const totalNotifications = unreadCount + handsCount;

  const handleReply = (studentId) => {
    const text = (replyTexts[studentId] || "").trim();
    if (text) {
      onReplyToMessage(studentId, text);
      setReplyTexts(prev => ({ ...prev, [studentId]: "" }));
    }
  };

  // Auto-scroll chat threads when messages change
  useEffect(() => {
    Object.keys(chatEndRefs.current).forEach(sid => {
      chatEndRefs.current[sid]?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [studentMessages, chatReplies]);

  return (
    <div
      ref={fabRef}
      className="fixed z-50 flex flex-col items-end gap-3"
      style={{
        right: `${position.x}px`,
        bottom: `${position.y}px`,
      }}
    >
      {/* Hands Panel */}
      {activePanel === 'hands' && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-80 max-h-96 overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 flex items-center justify-between">
            <span className="text-white font-semibold flex items-center gap-2">
              <Hand className="h-4 w-4" />
              Raised Hands ({handsCount})
            </span>
            <div className="flex items-center gap-2">
              {onToggleHandRaising && (
                <Switch
                  checked={handRaisingEnabled}
                  onCheckedChange={(checked) => onToggleHandRaising(checked)}
                  className="data-[state=checked]:bg-white/40 data-[state=unchecked]:bg-white/20"
                />
              )}
              <button
                onClick={() => setActivePanel(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className={cn("max-h-72 overflow-y-auto", !handRaisingEnabled && "opacity-50 pointer-events-none")}>
            {handsCount === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                No raised hands
              </div>
            ) : (
              Array.from(raisedHands.values()).map((hand) => (
                <div
                  key={hand.studentId}
                  className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                      <Hand className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">{hand.studentName}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(hand.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => onDismissHand(hand.studentId)}
                    className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Messages Panel — Chat Thread */}
      {activePanel === 'messages' && (() => {
        // Group messages by student
        const grouped = {};
        studentMessages.forEach(msg => {
          const key = msg.studentId || 'unknown';
          if (!grouped[key]) grouped[key] = { studentName: msg.studentName || 'Unknown', messages: [] };
          grouped[key].messages.push(msg);
        });
        const studentIds = Object.keys(grouped);

        return (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-80 max-h-[500px] overflow-hidden animate-in slide-in-from-bottom-2 duration-200 flex flex-col">
          <div className="bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-3 flex items-center justify-between shrink-0">
            <span className="text-white font-semibold flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Messages ({unreadCount} new)
            </span>
            <div className="flex items-center gap-2">
              {onToggleStudentMessaging && (
                <Switch
                  checked={studentMessagingEnabled}
                  onCheckedChange={(checked) => onToggleStudentMessaging(checked)}
                  className="data-[state=checked]:bg-white/40 data-[state=unchecked]:bg-white/20"
                />
              )}
              <button
                onClick={() => setActivePanel(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className={cn("overflow-y-auto flex-1", !studentMessagingEnabled && "opacity-50 pointer-events-none")}>
            {studentMessages.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                No messages from students
              </div>
            ) : (
              studentIds.map((sid) => {
                const group = grouped[sid];
                // Merge student messages + teacher replies into a timeline
                const thread = [
                  ...group.messages.map(m => ({ id: m.id, message: m.message, timestamp: m.timestamp, sender: 'student' })),
                  ...(chatReplies[sid] || []).map((r, i) => ({ id: `reply-${sid}-${i}`, message: r.message, timestamp: r.timestamp, sender: 'teacher' })),
                ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                return (
                  <div key={sid} className="border-b border-gray-200 dark:border-gray-600 last:border-b-0 flex flex-col">
                    {/* Student header with Close Chat */}
                    <div className="px-4 py-2 bg-gray-50 dark:bg-gray-750 flex items-center justify-between shrink-0">
                      <span className="font-semibold text-sm text-gray-800 dark:text-gray-200">{group.studentName}</span>
                      <button
                        onClick={() => onCloseChat ? onCloseChat(sid) : group.messages.forEach(m => onDismissMessage(m.id))}
                        className="text-xs px-2 py-1 rounded bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 font-medium transition-colors"
                        title="Close chat and erase all messages from this student"
                      >
                        Close Chat
                      </button>
                    </div>
                    {/* Chat thread */}
                    <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-1.5" onClick={() => group.messages.forEach(m => { if (!m.read) onMarkMessageRead(m.id); })}>
                      {thread.map((item) => (
                        <div
                          key={item.id}
                          className={cn(
                            "flex",
                            item.sender === 'teacher' ? "justify-end" : "justify-start"
                          )}
                        >
                          <div
                            className={cn(
                              "max-w-[80%] px-3 py-1.5 rounded-2xl text-sm break-words",
                              item.sender === 'teacher'
                                ? "bg-blue-500 text-white rounded-br-md"
                                : "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-bl-md"
                            )}
                          >
                            {item.message}
                          </div>
                        </div>
                      ))}
                      <div ref={el => { chatEndRefs.current[sid] = el; }} />
                    </div>
                    {/* Reply input — always visible */}
                    <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 flex gap-2 shrink-0">
                      <Input
                        value={replyTexts[sid] || ""}
                        onChange={(e) => setReplyTexts(prev => ({ ...prev, [sid]: e.target.value }))}
                        placeholder="Type reply..."
                        className="h-8 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (replyTexts[sid] || "").trim()) {
                            handleReply(sid);
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        className="h-8 px-3"
                        disabled={!(replyTexts[sid] || "").trim() || replyPending}
                        onClick={() => handleReply(sid)}
                      >
                        <Send className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        );
      })()}

      {/* FAB Menu Items */}
      {expanded && (
        <div className="flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-200">
          {/* Messages */}
          <button
            onClick={() => setActivePanel(activePanel === 'messages' ? null : 'messages')}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              !studentMessagingEnabled
                ? "bg-gray-400 text-white/70"
                : activePanel === 'messages' || unreadCount > 0
                  ? "bg-blue-500 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <MessageSquare className="h-5 w-5" />
            <span className="font-medium">Messages{!studentMessagingEnabled ? " (Off)" : ""}</span>
            {unreadCount > 0 && studentMessagingEnabled && (
              <span className="bg-white text-blue-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Raised Hands */}
          <button
            onClick={() => setActivePanel(activePanel === 'hands' ? null : 'hands')}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              !handRaisingEnabled
                ? "bg-gray-400 text-white/70"
                : activePanel === 'hands' || handsCount > 0
                  ? "bg-amber-500 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700",
              handsCount > 0 && handRaisingEnabled && activePanel !== 'hands' && "animate-pulse"
            )}
          >
            <Hand className="h-5 w-5" />
            <span className="font-medium">Hands{!handRaisingEnabled ? " (Off)" : ""}</span>
            {handsCount > 0 && handRaisingEnabled && (
              <span className="bg-white text-amber-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {handsCount}
              </span>
            )}
          </button>

          {/* Poll */}
          <button
            onClick={() => {
              onPollClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={pollPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              activePoll
                ? "bg-violet-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <BarChart3 className="h-5 w-5" />
            <span className="font-medium">{activePoll ? `Poll (${pollTotalResponses})` : "Poll"}</span>
          </button>

          {/* Timer */}
          <button
            onClick={() => {
              onTimerClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={timerPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              timerActive
                ? "bg-teal-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            {timerActive ? <Clock className="h-5 w-5" /> : <Timer className="h-5 w-5" />}
            <span className="font-medium">{timerActive ? "Stop Timer" : "Timer"}</span>
          </button>

          {/* Attention */}
          <button
            onClick={() => {
              onAttentionClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={attentionPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              attentionActive
                ? "bg-indigo-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            {attentionActive ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            <span className="font-medium">{attentionActive ? "Release" : "Attention"}</span>
          </button>
        </div>
      )}

      {/* Main FAB Button */}
      <button
        onClick={handleFabClick}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className={cn(
          "w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 relative select-none",
          expanded
            ? "bg-gray-600 dark:bg-gray-700 rotate-45"
            : "bg-[#E9A31E]",
          isDragging ? "cursor-grabbing scale-110" : "cursor-grab hover:scale-110"
        )}
      >
        {expanded ? (
          <X className="h-6 w-6 text-white -rotate-45" />
        ) : (
          <GraduationCap className="h-6 w-6 text-white" />
        )}

        {/* Notification Badge */}
        {!expanded && totalNotifications > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center animate-pulse">
            {totalNotifications > 9 ? '9+' : totalNotifications}
          </span>
        )}
      </button>
    </div>
  );
}

export default TeacherFab;
