import { useLayoutEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLicenses } from '../../../contexts/LicenseContext';
import PassPilotMiniView from './sidebar/PassPilotMiniView';
import GoPilotMiniView from './sidebar/GoPilotMiniView';

// My Desk is shelved; its sidebar entry (sidebar/MyDeskMiniView) is not mounted.
export default function ClassPilotSidebar({ isOpen, onToggle }) {
  const { hasPassPilot, hasGoPilot } = useLicenses();
  const showSidebar = hasPassPilot || hasGoPilot;
  const [navigationBottom, setNavigationBottom] = useState(64);

  useLayoutEffect(() => {
    if (!showSidebar) return;
    const navigation = document.querySelector('[data-class-tools-navigation]');
    if (!navigation) return;
    const measure = () => setNavigationBottom(Math.max(0, navigation.getBoundingClientRect().bottom));
    const observer = new ResizeObserver(measure);
    // Class/activity notices and responsive wrapping can change the complete
    // sticky header without a window resize.
    observer.observe(navigation, { box: 'border-box' });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [showSidebar]);

  if (!showSidebar) return null;

  return (
    <>
      {/* Sidebar panel */}
      <aside
        id="classpilot-product-sidebar"
        aria-label="Connected products"
        aria-hidden={!isOpen}
        data-testid="classpilot-sidebar"
        style={{ top: navigationBottom }}
        className={`fixed left-0 bottom-0 z-30 hidden lg:flex flex-col
          bg-white dark:bg-slate-900/95 border-r border-slate-200 dark:border-slate-700
          transition-[width] duration-300 overflow-hidden
          ${isOpen ? 'w-80' : 'w-0 border-r-0'}`}
      >
        {isOpen ? (
          <div className="min-h-0 flex-1 overflow-y-auto w-80" data-testid="classpilot-sidebar-content">
            {hasPassPilot && <PassPilotMiniView />}
            {hasGoPilot && <GoPilotMiniView />}
          </div>
        ) : null}
      </aside>

      {/* Toggle button - always visible on lg+ screens */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-expanded={isOpen}
        aria-controls="classpilot-product-sidebar"
        data-testid="button-classpilot-sidebar"
        style={{ top: navigationBottom + 16 }}
        className={`fixed z-40 hidden lg:flex items-center justify-center
          w-6 h-12 rounded-r-lg
          bg-sidetab hover:bg-sidetab-hover text-chrome-fg/80 hover:text-chrome-fg
          transition-[left,background-color,color] duration-300 cursor-pointer
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
