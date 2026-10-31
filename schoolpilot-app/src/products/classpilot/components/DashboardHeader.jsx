import { useLayoutEffect, useRef, useState } from 'react';
import './dashboardHeader.css';

function scrollWithKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  const viewport = event.currentTarget;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    viewport.scrollBy({ left: event.key === 'ArrowLeft' ? -80 : 80 });
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    viewport.scrollTo({ left: event.key === 'Home' ? 0 : viewport.scrollWidth });
  }
}

function revealFocusedControl(event) {
  const viewport = event.currentTarget;
  if (event.target === viewport) return;
  const control = event.target.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  if (control.left < bounds.left) viewport.scrollLeft += control.left - bounds.left - 4;
  else if (control.right > bounds.right) viewport.scrollLeft += control.right - bounds.right + 4;
}

// Header contract: every future control belongs in one of these four slots.
// Keep one 72px row; overflow belongs to the middle, never another header row.
export default function DashboardHeader({ brand, controls, primaryActions, utilities }) {
  const middleRef = useRef(null);
  const outerRef = useRef(null);
  const controlsRef = useRef(null);
  const contentRef = useRef(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false, outer: false });
  useLayoutEffect(() => {
    const viewport = controlsRef.current;
    const update = () => {
      const next = {
        overflow: contentRef.current.scrollWidth > middleRef.current.clientWidth + 1,
        left: viewport.scrollLeft > 1,
        right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
        outer: outerRef.current.scrollWidth > outerRef.current.clientWidth + 1,
      };
      setScroll(previous => Object.keys(next).every(key => next[key] === previous[key]) ? previous : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(middleRef.current);
    observer.observe(contentRef.current);
    observer.observe(outerRef.current);
    viewport.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', update); };
  }, []);
  const move = direction => controlsRef.current.scrollBy({ left: direction * Math.max(80, controlsRef.current.clientWidth * 0.7) });
  return (
    <header data-class-tools-navigation className="classpilot-dashboard-header chrome-surface sticky top-0 z-40 bg-chrome border-b border-chrome-border">
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-brand to-brand-strong" />
      <div ref={outerRef} className="dashboard-header-viewport" data-testid="dashboard-header-viewport" role="region" aria-label="Dashboard header" tabIndex={scroll.outer ? 0 : undefined} onKeyDown={scrollWithKeyboard}>
        <div className="dashboard-header-row" data-testid="dashboard-header-row">
          <div className="dashboard-header-brand" data-testid="dashboard-header-brand">{brand}</div>
          <div ref={middleRef} className="dashboard-header-middle">
            {scroll.overflow ? <button type="button" className="dashboard-header-scroll-button" data-testid="button-scroll-header-left" aria-label="Scroll header controls left" title="Scroll header controls left" disabled={!scroll.left} onClick={() => move(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button> : null}
            <div ref={controlsRef} className="dashboard-header-controls" data-testid="dashboard-header-controls" role="region" aria-label="Class and activity controls" tabIndex={0} onKeyDown={scrollWithKeyboard} onFocusCapture={revealFocusedControl}>
              <div ref={contentRef} className="dashboard-header-controls-row">{controls}</div>
            </div>
            {scroll.overflow ? <button type="button" className="dashboard-header-scroll-button" data-testid="button-scroll-header-right" aria-label="Scroll header controls right" title="Scroll header controls right" disabled={!scroll.right} onClick={() => move(1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button> : null}
          </div>
          <div className="dashboard-header-primary-actions" data-testid="dashboard-header-primary-actions">{primaryActions}</div>
          <div className="dashboard-header-utilities" data-testid="dashboard-header-utilities">{utilities}</div>
        </div>
      </div>
    </header>
  );
}
