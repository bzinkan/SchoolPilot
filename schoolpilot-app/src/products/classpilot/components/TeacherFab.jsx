import { useState, useRef, useEffect, useCallback } from "react";
import { Eye, EyeOff, Timer, Clock, BarChart3, Hand, MessageSquare, X, GraduationCap } from "lucide-react";
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
  unreadMessageCount = 0,
  onOpenChat,
  studentMessagingEnabled = true,
  messagesPaused = false,
  fabSettingsPending = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [activePanel, setActivePanel] = useState(null);

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
    setExpanded((prev) => {
      if (prev) setActivePanel(null);
      return !prev;
    });
  }, [setExpanded, setActivePanel]);

  const unreadCount = unreadMessageCount;
  const handsCount = raisedHands.size;
  const totalNotifications = unreadCount + handsCount;

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
                  data-testid="hands-switch"
                  checked={handRaisingEnabled}
                  onCheckedChange={(checked) => onToggleHandRaising(checked)}
                  disabled={fabSettingsPending}
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

      {/* FAB Menu Items */}
      {expanded && (
        <div className="flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-200">
          {/* Messages */}
          <button
            data-testid="chat-open"
            onClick={(event) => {
              onOpenChat?.(event.currentTarget);
              setExpanded(false);
              setActivePanel(null);
            }}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              !studentMessagingEnabled
                ? "bg-gray-400 text-white/70"
                : unreadCount > 0
                  ? "bg-blue-500 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <MessageSquare className="h-5 w-5" />
            <span className="font-medium">Messages{!studentMessagingEnabled ? " (Off)" : messagesPaused ? " (Paused)" : ""}</span>
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
              pollPending
                ? "bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                : activePoll
                ? "bg-violet-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <BarChart3 className="h-5 w-5" />
            <span className="font-medium">{pollPending ? "Poll pending" : activePoll ? `Poll (${pollTotalResponses})` : "Poll"}</span>
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
              timerPending
                ? "bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                : timerActive
                ? "bg-teal-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            {timerActive || timerPending ? <Clock className="h-5 w-5" /> : <Timer className="h-5 w-5" />}
            <span className="font-medium">{timerPending ? "Timer pending" : timerActive ? "Stop Timer" : "Timer"}</span>
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
        aria-label="Quick Classroom Tools"
        title="Quick Classroom Tools"
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
