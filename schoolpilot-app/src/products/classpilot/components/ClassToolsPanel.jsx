import { useCallback, useEffect, useRef, useState } from 'react';
import { GraduationCap, Hand, MessageSquare, ClipboardList, Wrench, X, Pin, PinOff, GripHorizontal, RotateCcw } from 'lucide-react';
import { useResizablePanelWidth } from '../hooks/useResizablePanelWidth';
import { cn } from '../../../lib/utils';

const TABS = [['help', 'Help', Hand], ['messages', 'Messages', MessageSquare], ['activities', 'Activities', ClipboardList], ['tools', 'Tools', Wrench]];
const DEFAULT_POSITION = { x: 20, y: 20 };

function readPreferences(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return { pinned: value?.pinned === true, position: Number.isFinite(value?.position?.x) && Number.isFinite(value?.position?.y) ? value.position : DEFAULT_POSITION };
  } catch { return { pinned: false, position: DEFAULT_POSITION }; }
}

/** Only this component ticks: a countdown must not rerender the student grid. */
export function ClassTimerCountdown({ timer, className }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timer || timer.pausedRemainingMs != null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [timer]);
  if (!timer) return null;
  const remaining = Math.max(0, Math.ceil((timer.pausedRemainingMs ?? (Date.parse(timer.endsAt || timer.deadline) - now)) / 1000));
  if (!Number.isFinite(remaining)) return null;
  return <span className={cn('tabular-nums', className)} data-testid="class-tools-countdown" aria-label={`${remaining} seconds ${timer.pausedRemainingMs != null ? 'paused' : 'remaining'}`}>
    {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}{timer.pausedRemainingMs != null ? ' paused' : ''}
  </span>;
}

export default function ClassToolsPanel({ storageKey, open, tab, onOpen, onClose, onTabChange, suspended = false, helpCount, unreadConversationCount,
  contextLabel, recipientLabel, timer, onReserveWidth, renderMessages, help, activities, tools }) {
  const preferencesKey = `${storageKey}:layout:v1`;
  const [preferences, setPreferences] = useState(() => readPreferences(preferencesKey));
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [toolbarBottom, setToolbarBottom] = useState(200);
  const [navigationBottom, setNavigationBottom] = useState(72);
  const launcherRef = useRef(null);
  const panelRef = useRef(null);
  const tabRefs = useRef({});
  const dragRef = useRef(null);
  const returnFocusRef = useRef(null);
  const narrow = viewport.width < 1024;
  const visible = open && !suspended;
  const pinned = preferences.pinned && !narrow;
  const { width, onResizeStart, onResizeKeyDown, resetWidth } = useResizablePanelWidth({
    initial: tab === 'messages' ? 640 : 440, min: 360, maxFraction: Math.min(pinned ? 0.55 : 0.75, (viewport.width - 420) / viewport.width),
    rightOffset: pinned || narrow ? 0 : preferences.position.x,
    storageKey: `${storageKey}:width:${tab === 'messages' ? 'messages' : 'tools'}`,
  });
  const actualWidth = narrow ? Math.min(viewport.width, 640) : width;
  const x = Math.max(8, Math.min(preferences.position.x, viewport.width - actualWidth - 420));
  const y = Math.max(8, Math.min(preferences.position.y, viewport.height - toolbarBottom - 200));

  const close = useCallback(() => { onClose(); requestAnimationFrame(() => (returnFocusRef.current?.isConnected ? returnFocusRef.current : launcherRef.current)?.focus()); }, [onClose]);
  useEffect(() => {
    if (!visible) return;
    const dismiss = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const dialog = event.target instanceof Element ? event.target.closest('[role="dialog"], [role="alertdialog"]') : null;
      if (dialog && !panelRef.current?.contains(dialog)) return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [visible, close]);

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const toolbar = document.querySelector('[data-class-tools-toolbar]');
    if (!toolbar) return;
    const measure = () => {
      setToolbarBottom(Math.max(8, toolbar.getBoundingClientRect().bottom + 8));
      setNavigationBottom(Math.max(8, document.querySelector('[data-class-tools-navigation]')?.getBoundingClientRect().bottom + 8 || 72));
    };
    const observer = new ResizeObserver(measure); observer.observe(toolbar);
    window.addEventListener('scroll', measure, true); window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [visible, pinned]);
  useEffect(() => {
    const toolbar = document.querySelector('[data-class-tools-toolbar]');
    if (!toolbar) return;
    // Floating tools may cover tiles, but command buttons always reflow into
    // the remaining space. Pinning also reserves space for the tiles.
    toolbar.style.marginRight = visible && !narrow ? `${actualWidth + (pinned ? 16 : x + 8)}px` : '';
    return () => { toolbar.style.marginRight = ''; };
  }, [visible, narrow, actualWidth, pinned, x]);
  useEffect(() => {
    try { localStorage.setItem(preferencesKey, JSON.stringify(preferences)); } catch { /* Storage is optional. */ }
  }, [preferences, preferencesKey]);
  useEffect(() => {
    onReserveWidth(visible && pinned ? actualWidth + 16 : 0);
    return () => onReserveWidth(0);
  }, [visible, pinned, actualWidth, onReserveWidth]);
  useEffect(() => {
    if (!visible) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement && !panelRef.current?.contains(document.activeElement) ? document.activeElement : returnFocusRef.current;
    tabRefs.current[tab]?.focus({ preventScroll: true });
  // Preserve the opener across changes between tabs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    tabRefs.current[tab]?.focus({ preventScroll: true });
  }, [visible, tab]);

  const reset = () => { setPreferences({ pinned: false, position: DEFAULT_POSITION }); try { localStorage.removeItem(`${storageKey}:width:messages`); localStorage.removeItem(`${storageKey}:width:tools`); } catch { /* optional */ } resetWidth(); };
  const tabKeys = TABS.map(([key]) => key);
  const panelStyle = narrow
    ? { right: 0, bottom: 0, top: toolbarBottom, width: actualWidth }
    : pinned ? { right: 8, top: navigationBottom, bottom: 16, width: actualWidth }
      : { right: x, bottom: y + 54, width: actualWidth, height: Math.max(120, Math.min(620, viewport.height - navigationBottom - y - 54)) };

  return <>
    <section ref={panelRef} hidden={!visible} style={panelStyle} role={narrow ? 'dialog' : 'region'} aria-label="Class tools"
      data-testid="class-tools-panel" data-docked={pinned} className={cn('fixed z-40 flex flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-slate-900 dark:text-slate-100 overflow-hidden', !visible && 'hidden')}
      onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } }}>
      {!narrow && <div role="separator" tabIndex={0} aria-label="Resize Class tools" aria-orientation="vertical" aria-valuenow={Math.round(actualWidth)} aria-valuemin={360} aria-valuemax={Math.round(Math.min(viewport.width * (pinned ? 0.55 : 0.75), viewport.width - 420))}
        onMouseDown={onResizeStart} onKeyDown={onResizeKeyDown} className="absolute left-0 top-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-blue-400/40 focus-visible:bg-blue-400/40" />}
      <header className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 px-4 py-3 shrink-0">
        <GraduationCap className="h-5 w-5 text-amber-600 shrink-0" />
        <div className="min-w-0 flex-1"><h2 className="font-semibold">Class tools</h2><p className="text-xs text-slate-500 dark:text-slate-400 truncate">{contextLabel}</p></div>
        {!pinned && !narrow && <button type="button" aria-label="Move Class tools" className="p-1.5 cursor-move touch-none rounded focus-visible:ring-2" onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, position: { x, y } };
        }} onPointerMove={(event) => {
          const drag = dragRef.current; if (!drag) return;
          setPreferences(current => ({ ...current, position: { x: Math.max(8, Math.min(viewport.width - actualWidth - 420, drag.position.x + drag.x - event.clientX)), y: Math.max(8, Math.min(viewport.height - 250, drag.position.y + drag.y - event.clientY)) } }));
        }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onKeyDown={(event) => {
          const moves = { ArrowLeft: [20, 0], ArrowRight: [-20, 0], ArrowUp: [0, 20], ArrowDown: [0, -20] };
          if (!moves[event.key]) return; event.preventDefault(); const [dx, dy] = moves[event.key];
          setPreferences(current => ({ ...current, position: { x: Math.max(8, x + dx), y: Math.max(8, y + dy) } }));
        }}><GripHorizontal className="h-4 w-4" /></button>}
        {!narrow && <button type="button" aria-label={pinned ? 'Unpin Class tools' : 'Pin Class tools'} onClick={() => setPreferences(current => ({ ...current, pinned: !current.pinned }))} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800">{pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>}
        <button type="button" aria-label="Reset position" title="Reset position and width" onClick={reset} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"><RotateCcw className="h-4 w-4" /></button>
        <button type="button" aria-label="Close Class tools" onClick={close} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
      </header>
      {timer && <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-sm flex justify-between"><span>{timer.message || 'Class timer'}</span><ClassTimerCountdown timer={timer} /></div>}
      <div role="tablist" aria-label="Class tools" className="grid grid-cols-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
        {TABS.map(([key, label, Icon]) => <button key={key} ref={(node) => { tabRefs.current[key] = node; }} id={`class-tools-tab-${key}`} role="tab" type="button" aria-selected={tab === key} aria-controls={`class-tools-content-${key}`} tabIndex={tab === key ? 0 : -1}
          data-testid={key === 'messages' ? 'chat-open' : `class-tools-tab-${key}`} onClick={() => onTabChange(key)} onKeyDown={(event) => {
            let index = tabKeys.indexOf(tab);
            if (event.key === 'ArrowRight') index = (index + 1) % tabKeys.length;
            else if (event.key === 'ArrowLeft') index = (index + tabKeys.length - 1) % tabKeys.length;
            else if (event.key === 'Home') index = 0;
            else if (event.key === 'End') index = tabKeys.length - 1;
            else return;
            event.preventDefault(); onTabChange(tabKeys[index]);
          }} className={cn('flex items-center justify-center gap-1.5 py-3 text-xs font-medium border-b-2 focus-visible:ring-2 focus-visible:ring-inset', tab === key ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800')}>
          <Icon className="h-3.5 w-3.5 shrink-0" />{label}{key === 'help' && helpCount > 0 ? <span>{helpCount}</span> : key === 'messages' && unreadConversationCount > 0 ? <span>{unreadConversationCount}</span> : null}
        </button>)}
      </div>
      {TABS.map(([key]) => <div key={key} id={`class-tools-content-${key}`} role="tabpanel" aria-labelledby={`class-tools-tab-${key}`} hidden={tab !== key} className={tab === key ? 'flex flex-1 min-h-0 flex-col overflow-auto' : 'hidden'}>
        {key === 'messages' ? renderMessages({ width: actualWidth, visible: visible && tab === key }) : key === 'help' ? help : key === 'activities' ? activities : tools}
      </div>)}
      <footer className="border-t border-slate-200 dark:border-slate-700 px-4 py-2 text-xs text-slate-500 shrink-0">New actions for {recipientLabel}. Active tools keep their original recipients.</footer>
    </section>
    {!suspended && !(narrow && visible) && <button ref={launcherRef} type="button" data-testid="teacher-fab" aria-expanded={visible} aria-label="Class tools" onClick={(event) => visible ? close() : onOpen(event.currentTarget)}
      style={{ right: narrow ? 16 : x, bottom: narrow ? 16 : y }} className="fixed z-40 rounded-full bg-slate-900 dark:bg-amber-500 text-white dark:text-slate-950 px-4 py-3 shadow-lg flex items-center gap-3 border border-white/20 focus-visible:ring-2 focus-visible:ring-amber-400">
      <GraduationCap className="h-5 w-5" /><span className="text-sm font-semibold">Class tools</span>
      <span className="text-xs" aria-label={`${helpCount} help requests`}>Help {helpCount}</span><span className="text-xs" aria-label={`${unreadConversationCount} unread conversations`}>Messages {unreadConversationCount}</span>
      <ClassTimerCountdown timer={timer} className="text-sm" />
    </button>}
  </>;
}
