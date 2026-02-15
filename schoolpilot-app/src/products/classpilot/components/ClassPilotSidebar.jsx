import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLicenses } from '../../../contexts/LicenseContext';
import PassPilotMiniView from './sidebar/PassPilotMiniView';
import GoPilotMiniView from './sidebar/GoPilotMiniView';

export default function ClassPilotSidebar({ isOpen, onToggle }) {
  const { hasPassPilot, hasGoPilot } = useLicenses();
  const showSidebar = hasPassPilot || hasGoPilot;

  if (!showSidebar) return null;

  return (
    <>
      {/* Sidebar panel */}
      <aside
        className={`fixed left-0 top-[64px] h-[calc(100vh-64px)] z-30 hidden lg:flex flex-col
          bg-white dark:bg-slate-900/95 border-r border-slate-200 dark:border-slate-700
          transition-all duration-300 overflow-hidden
          ${isOpen ? 'w-80' : 'w-0 border-r-0'}`}
      >
        <div className="flex-1 overflow-y-auto w-80">
          {hasPassPilot && <PassPilotMiniView />}
          {hasGoPilot && <GoPilotMiniView />}
        </div>
      </aside>

      {/* Toggle button - always visible on lg+ screens */}
      <button
        onClick={onToggle}
        className={`fixed z-40 hidden lg:flex items-center justify-center
          w-6 h-12 rounded-r-lg
          bg-slate-800 hover:bg-slate-700 text-white/80 hover:text-white
          transition-all duration-300 top-[calc(64px+1rem)] cursor-pointer
          ${isOpen ? 'left-80' : 'left-0'}`}
        title={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        {isOpen ? (
          <ChevronLeft className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
    </>
  );
}
